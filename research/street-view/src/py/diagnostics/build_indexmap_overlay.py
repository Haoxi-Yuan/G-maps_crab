"""Overlay each pano's gravity-aligned indexmap on its gravity-aligned JPG.

For each kept pano:
  1. Load source JPG, rectify to 1024x512 gravity frame (chunked, bilinear).
  2. Load gravity indexmap (256x512), upsample 4x via nearest-neighbor.
  3. Render colored indexmap (random colormap, sky=fully transparent).
  4. Composite: alpha-blend at multiple alphas for inspection.

Output: TEST/data/diagnostics/<workspace-id>/indexmap_overlay/
  <panoid>_overlay.png       3-panel: JPG only | indexmap only | overlay alpha=0.5
"""

import argparse
import csv
import math
import sys
from pathlib import Path

import numpy as np
import matplotlib.pyplot as plt
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from filter_and_rectify import build_rotation, parse_one  # noqa
from pair_indexmap_with_pano import rectify_rgb  # noqa
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sv3d_paths import add_spatial_args, resolve_spatial_paths  # noqa: E402

JPG_OUT_W, JPG_OUT_H = 1024, 512
ALPHA = 0.5


def jpg_sky_mask(jpg_grav, H):
    """Sky pixels: bright + low saturation, in top half of image."""
    rgb = jpg_grav.astype(np.float32) / 255.0
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    sat = (mx - mn) / (mx + 1e-6)
    sky = (mx > 0.65) & (sat < 0.20)
    sky[H // 2:] = False
    return sky


def jpg_black_column_mask(jpg_grav, brightness_thresh=10.0, frac_thresh=0.5):
    """Return per-column bool: True if this column is mostly black filler.

    Black-filler columns appear when stitching used a wrong fixed grid OR when
    Google's pano has a bottom blackout zone that, after rectification, dominates
    a column. We exclude these from cross-correlation.
    """
    brightness = jpg_grav.astype(np.float32).mean(axis=2)  # (H, W)
    is_black = brightness < brightness_thresh
    frac_black = is_black.mean(axis=0)                      # (W,)
    return frac_black > frac_thresh


def _column_lowest_true(mask):
    out = np.full(mask.shape[1], -1, dtype=np.int32)
    for j in range(mask.shape[1]):
        wh = np.where(mask[:, j])[0]
        if len(wh):
            out[j] = wh[-1]
    return out


def measure_sky_shift(jpg_grav, idx_up_2d):
    """Diagnostic only: sky-boundary FFT shift.

    This was the original alignment method. It is kept in the log because it is
    useful for spotting false peaks, but it is not used to roll the overlay.
    Tree canopies, repeated building skylines and clouds make this global metric
    choose shifts hundreds of pixels away from the real image edges.
    """
    H, W = jpg_grav.shape[:2]
    jpg_sky = jpg_sky_mask(jpg_grav, H)
    jpg_prof = _column_lowest_true(jpg_sky).astype(np.float32)
    idx_prof = _column_lowest_true(idx_up_2d == 0).astype(np.float32)

    # exclude black-filler columns from JPG (corrupted stitch padding or car blackout)
    black_cols = jpg_black_column_mask(jpg_grav)
    valid_jpg = (jpg_prof >= 0) & ~black_cols
    valid_idx = idx_prof >= 0
    if valid_jpg.sum() < 100 or valid_idx.sum() < 100:
        return 0, 0.0

    # zero out invalid columns in both profiles BEFORE FFT (so they contribute nothing)
    jpg_clean = np.where(valid_jpg, jpg_prof - jpg_prof[valid_jpg].mean(), 0)
    idx_clean = np.where(valid_idx, idx_prof - idx_prof[valid_idx].mean(), 0)
    corr = np.fft.irfft(np.fft.rfft(jpg_clean) * np.conj(np.fft.rfft(idx_clean)))
    shifts = np.arange(W); shifts[shifts > W // 2] -= W
    best_idx = int(np.argmax(corr))
    # caller rolls idx LEFT by this many cols to align with jpg.
    return int(shifts[best_idx]), float(corr[best_idx])


def jpg_edge_magnitude(jpg_grav):
    """Return robustly normalized grayscale edge magnitude in [0, 1]."""
    gray = np.dot(jpg_grav[..., :3], [0.299, 0.587, 0.114]).astype(np.float32)
    gx = np.zeros_like(gray)
    gy = np.zeros_like(gray)
    gx[:, 1:-1] = gray[:, 2:] - gray[:, :-2]
    gy[1:-1, :] = gray[2:, :] - gray[:-2, :]
    mag = np.hypot(gx, gy)
    q = np.percentile(mag, 99)
    if q > 0:
        mag = np.clip(mag / q, 0, 1)

    # Do not let black filler bands become artificial image edges.
    brightness = jpg_grav.astype(np.float32).mean(axis=2)
    mag[brightness < 10] = 0
    return mag


def indexmap_boundary_mask(idx_up_2d):
    """Boundary pixels for non-sky plane labels, excluding the nadir/car zone."""
    H, W = idx_up_2d.shape
    boundary = np.zeros((H, W), dtype=bool)
    boundary[:, 1:] |= idx_up_2d[:, 1:] != idx_up_2d[:, :-1]
    boundary[1:, :] |= idx_up_2d[1:, :] != idx_up_2d[:-1, :]
    boundary &= idx_up_2d != 0
    boundary &= np.arange(H)[:, None] < int(H * 0.65)
    return boundary


def measure_edge_shift(jpg_grav, idx_up_2d, search_radius=64):
    """Return shift from local image-edge agreement.

    shift_px means the same thing as the old metric: how many columns the
    indexmap is right of the JPG, so callers roll the indexmap left by shift_px.
    The search is intentionally local; both the JPG and indexmap are already in
    the same pano-local frame before gravity rectification, so a real correction
    should be small. Larger shifts are usually repeated facade/tree false peaks.
    """
    edge_mag = jpg_edge_magnitude(jpg_grav)
    boundary = indexmap_boundary_mask(idx_up_2d)
    rr, cc = np.where(boundary)
    if rr.size < 500:
        zero_score = float(edge_mag[boundary].mean()) if rr.size else 0.0
        return 0, zero_score, zero_score, rr.size

    W = idx_up_2d.shape[1]
    shifts = np.arange(-search_radius, search_radius + 1)
    scores = np.empty(len(shifts), dtype=np.float32)
    for i, shift in enumerate(shifts):
        scores[i] = edge_mag[rr, (cc - shift) % W].mean()

    best_i = int(np.argmax(scores))
    zero_i = int(np.where(shifts == 0)[0][0])
    return int(shifts[best_i]), float(scores[best_i]), float(scores[zero_i]), int(rr.size)


def main():
    ap = argparse.ArgumentParser(description="Build gravity-aligned pano/indexmap overlay diagnostics.")
    add_spatial_args(ap)
    args = ap.parse_args()
    paths = resolve_spatial_paths(args)

    capture = paths.run_dir
    rect_dir = paths.indexmap_rectified_dir
    out = paths.indexmap_overlay_dir
    out.mkdir(exist_ok=True, parents=True)

    rng = np.random.default_rng(7)
    palette = (rng.random((256, 3)) * 255).astype(np.uint8)
    palette[0] = [0, 0, 0]  # sky placeholder; we mask it out via alpha

    log = list(csv.DictReader(open(rect_dir / "filter_log.csv")))
    kept = [r for r in log if r.get("kept") == "True"]
    print(f"Building overlays for {len(kept)} panos...")
    shift_log = []

    for k, r in enumerate(kept):
        panoid = r["panoid"]
        jpg_fp = capture / "panoramas" / f"{panoid}.jpg"
        idx_fp = rect_dir / f"{panoid}_indexmap_gravity.bin"
        if not (jpg_fp.exists() and idx_fp.exists()):
            print(f"  [{k+1}/{len(kept)}] {panoid}: missing source, skipping")
            continue

        # find pose for this panoid
        rec = None
        for cand in [capture / "neighbor_photometas" / f"{panoid}.parsed.json"] + list(capture.glob("photometa_*_parsed.json")):
            if not cand.exists():
                continue
            try:
                rec_try = parse_one(cand)
                if rec_try["panoid"] == panoid:
                    rec = rec_try
                    break
            except Exception:
                continue
        if rec is None:
            print(f"  [{k+1}/{len(kept)}] {panoid}: pose lookup failed")
            continue

        # rectify JPG to display size
        with Image.open(jpg_fp) as im:
            jpg_arr = np.array(im.convert("RGB"))
        R = build_rotation(rec["heading_deg"], rec["pitch_deg"], rec["roll_deg"])
        jpg_grav = rectify_rgb(jpg_arr, R, out_size=(JPG_OUT_H, JPG_OUT_W), chunk_rows=64)

        # load gravity indexmap, upsample to (JPG_OUT_H, JPG_OUT_W) via nearest-neighbor
        idx_g = np.frombuffer(idx_fp.read_bytes(), dtype=np.uint8).reshape(256, 512)
        scale_h = JPG_OUT_H / 256
        scale_w = JPG_OUT_W / 512
        # nearest-neighbor upsample
        i_up = (np.arange(JPG_OUT_H) / scale_h).astype(np.int32)
        j_up = (np.arange(JPG_OUT_W) / scale_w).astype(np.int32)
        idx_up = idx_g[i_up[:, None], j_up[None, :]]

        # JPG and indexmap are already in the same pano-local equirect frame and
        # are rectified with the same pose transform. Do not roll the indexmap:
        # both sky-boundary and edge-local auto shifts can lock onto repeated
        # facade/road/tree edges and create visible left-right misalignment.
        edge_shift_px, edge_align_score, zero_score, n_edge_pixels = measure_edge_shift(jpg_grav, idx_up)
        sky_shift_px, sky_corr_strength = measure_sky_shift(jpg_grav, idx_up)
        shift_px = 0
        idx_up_aligned = np.roll(idx_up, -shift_px, axis=1)
        shift_log.append({
            "panoid": panoid,
            "heading_deg": f"{rec['heading_deg']:.2f}",
            "pitch_off_deg": f"{rec['pitch_deg']-90:+.2f}",
            "roll_deg": f"{rec['roll_deg']:+.2f}",
            "shift_px": shift_px,
            "align_score": f"{zero_score:.6f}",
            "zero_shift_score": f"{zero_score:.6f}",
            "n_edge_pixels": n_edge_pixels,
            "edge_shift_px": edge_shift_px,
            "edge_align_score": f"{edge_align_score:.6f}",
            "sky_shift_px": sky_shift_px,
            "sky_corr_strength": f"{sky_corr_strength:.0f}",
            "method": "no_roll",
        })

        # color the (post-shift) indexmap; sky -> alpha=0
        idx_rgb = palette[idx_up_aligned]                                   # (H, W, 3) uint8
        idx_alpha = np.where(idx_up_aligned == 0, 0.0, ALPHA).astype(np.float32)[..., None]

        # alpha blend
        composite = (jpg_grav.astype(np.float32) * (1 - idx_alpha)
                     + idx_rgb.astype(np.float32) * idx_alpha).astype(np.uint8)

        # 3-panel figure
        fig, axes = plt.subplots(3, 1, figsize=(13, 9), dpi=140)
        axes[0].imshow(jpg_grav, aspect="auto")
        axes[0].set_title(f"JPG (gravity-aligned)  pitch_off={rec['pitch_deg']-90:+.2f}° roll={rec['roll_deg']:+.2f}° heading={rec['heading_deg']:.1f}°", fontsize=10)
        axes[1].imshow(idx_rgb, aspect="auto")
        axes[1].set_title(f"indexmap (gravity-aligned, upsampled to {JPG_OUT_W}x{JPG_OUT_H}, sky=black)", fontsize=10)
        axes[2].imshow(composite, aspect="auto")
        axes[2].set_title(
            f"overlay (alpha={ALPHA}, no horizontal roll; "
            f"edge diagnostic={edge_shift_px}px/{edge_align_score:.3f}, "
            f"zero={zero_score:.3f}; sky diagnostic={sky_shift_px}px)",
            fontsize=10,
        )
        for ax in axes:
            ax.axhline(JPG_OUT_H // 2, color="white", lw=0.6, ls="--", alpha=0.5)
            ax.set_xticks([0, JPG_OUT_W//4, JPG_OUT_W//2, 3*JPG_OUT_W//4, JPG_OUT_W-1])
            ax.set_yticks([0, JPG_OUT_H//2, JPG_OUT_H-1])

        fig.suptitle(f"{panoid}  numPlanes={rec['n_planes']}  (white dashed = horizon row {JPG_OUT_H//2})", fontsize=11)
        fig.tight_layout(rect=(0, 0, 1, 0.97))
        fig.savefig(out / f"{panoid}_overlay.png", bbox_inches="tight")
        plt.close(fig)
        if (k + 1) % 5 == 0 or k == len(kept) - 1:
            print(f"  [{k+1}/{len(kept)}] done")

    # save shift log
    if shift_log:
        keys = list(shift_log[0].keys())
        with (out / "shift_log.csv").open("w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=keys)
            w.writeheader()
            w.writerows(shift_log)
        shifts = [r["shift_px"] for r in shift_log]
        print(f"\nshift summary: n={len(shifts)} mean={np.mean(shifts):+.1f} px std={np.std(shifts):.1f} median={np.median(shifts):+.1f}")
        print(f"applied shifts >100 px: {sum(1 for s in shifts if abs(s) > 100)}/{len(shifts)} panos")


if __name__ == "__main__":
    main()
