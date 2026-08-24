"""For each kept pano, build a 4-panel comparison image:

  panel 1: panorama JPG, raw pano-local frame  (1024x512)
  panel 2: panorama JPG, gravity-aligned       (1024x512, bilinear resample)
  panel 3: indexmap, raw pano-local frame      (256x512, upscaled for display)
  panel 4: indexmap, gravity-aligned           (256x512, upscaled for display)

JPG resampling uses the SAME rotation matrix R(heading,pitch,roll) as the indexmap
rectification, with bilinear interpolation (valid for RGB unlike categorical labels).

Output: TEST/data/intermediate/<workspace-id>/02_indexmap_rectified/<panoid>_with_pano.png
"""

import argparse
import csv
import math
from pathlib import Path

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.colors import ListedColormap
from PIL import Image

import sys
sys.path.insert(0, str(Path(__file__).parent))
from filter_and_rectify import build_rotation, parse_one  # noqa: E402
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sv3d_paths import add_spatial_args, resolve_spatial_paths  # noqa: E402


def rectify_rgb(jpg_arr, R_local_to_world, out_size=None, chunk_rows=64):
    """Resample RGB pano-local equirect onto gravity-aligned equirect grid (bilinear).

    Memory-friendly chunked version: processes `chunk_rows` rows at a time.
    Peak memory ~ chunk_rows * W_out * 32 bytes for ray arrays + 4 RGB samples.

    out_size: (H_out, W_out). If None, defaults to input shape (1:1 resample).
    """
    H_in, W_in = jpg_arr.shape[:2]
    if out_size is None:
        H_out, W_out = H_in, W_in
    else:
        H_out, W_out = out_size
    R_inv = R_local_to_world.T

    out = np.empty((H_out, W_out, 3), dtype=np.uint8)
    j_out = np.arange(W_out, dtype=np.float64).reshape(1, W_out)
    az_w = (j_out + 0.5 - W_out / 2) * (2 * math.pi / W_out)

    for r0 in range(0, H_out, chunk_rows):
        r1 = min(r0 + chunk_rows, H_out)
        i_chunk = np.arange(r0, r1, dtype=np.float64).reshape(-1, 1)
        el_w = math.pi / 2 - (i_chunk + 0.5) * (math.pi / H_out)
        cos_el = np.cos(el_w)
        rx = np.sin(az_w) * cos_el
        ry = np.cos(az_w) * cos_el
        rz = np.sin(el_w) + np.zeros_like(rx)
        m = R_inv.T
        rx_f = rx.reshape(-1)
        ry_f = ry.reshape(-1)
        rz_f = rz.reshape(-1)
        lx = rx_f * m[0, 0] + ry_f * m[1, 0] + rz_f * m[2, 0]
        ly = rx_f * m[0, 1] + ry_f * m[1, 1] + rz_f * m[2, 1]
        lz = rx_f * m[0, 2] + ry_f * m[1, 2] + rz_f * m[2, 2]
        az_l = np.arctan2(lx, ly)
        el_l = np.arcsin(np.clip(lz, -1.0, 1.0))

        j_in = ((az_l + math.pi) % (2 * math.pi)) * (W_in / (2 * math.pi))
        i_in = (math.pi / 2 - el_l) * (H_in / math.pi)
        j_in = np.clip(j_in, 0, W_in - 1.0001)
        i_in = np.clip(i_in, 0, H_in - 1.0001)
        j0 = j_in.astype(np.int32)
        i0 = i_in.astype(np.int32)
        j1 = (j0 + 1) % W_in
        i1 = np.minimum(i0 + 1, H_in - 1)
        fj = (j_in - j0)[:, None]
        fi = (i_in - i0)[:, None]
        a = jpg_arr[i0, j0].astype(np.float32)
        b = jpg_arr[i0, j1].astype(np.float32)
        c = jpg_arr[i1, j0].astype(np.float32)
        d = jpg_arr[i1, j1].astype(np.float32)
        chunk_out = (a * (1 - fj) * (1 - fi) + b * fj * (1 - fi)
                     + c * (1 - fj) * fi + d * fj * fi)
        out[r0:r1] = chunk_out.reshape(r1 - r0, W_out, 3).astype(np.uint8)
    return out


def main():
    ap = argparse.ArgumentParser(description="Pair rectified indexmaps with rectified panoramas.")
    add_spatial_args(ap)
    args = ap.parse_args()
    paths = resolve_spatial_paths(args)

    capture = paths.run_dir
    rect_dir = paths.indexmap_rectified_dir
    pano_dir = capture / "panoramas"
    out = rect_dir

    rng = np.random.default_rng(7)
    colors = rng.random((256, 3))
    colors[0] = [0, 0, 0]
    cmap = ListedColormap(colors)

    log = list(csv.DictReader(open(rect_dir / "filter_log.csv")))
    kept = [r for r in log if r.get("kept") == "True"]

    n_paired = 0
    n_missing = 0

    for r in kept:
        panoid = r["panoid"]
        local_bin = rect_dir / f"{panoid}_indexmap_local.bin"
        grav_bin = rect_dir / f"{panoid}_indexmap_gravity.bin"
        pano_jpg = pano_dir / f"{panoid}.jpg"
        if not (local_bin.exists() and grav_bin.exists() and pano_jpg.exists()):
            n_missing += 1
            continue

        idx_local = np.frombuffer(local_bin.read_bytes(), dtype=np.uint8).reshape(256, 512)
        idx_grav = np.frombuffer(grav_bin.read_bytes(), dtype=np.uint8).reshape(256, 512)

        with Image.open(pano_jpg) as im:
            im = im.convert("RGB").resize((1024, 512), Image.LANCZOS)
            jpg_local = np.array(im)

        # need (heading, pitch, roll) — re-parse from photometa for full precision
        # search both focal and neighbor JSONs
        candidate_jsons = list(capture.glob("photometa_*_parsed.json")) + [
            capture / "neighbor_photometas" / f"{panoid}.parsed.json"
        ]
        rec = None
        for fp in candidate_jsons:
            if not fp.exists():
                continue
            try:
                rec_try = parse_one(fp)
                if rec_try["panoid"] == panoid:
                    rec = rec_try
                    break
            except Exception:
                continue
        if rec is None:
            print(f"  pose lookup failed for {panoid}")
            continue

        R = build_rotation(rec["heading_deg"], rec["pitch_deg"], rec["roll_deg"])
        jpg_grav = rectify_rgb(jpg_local, R)

        fig, axes = plt.subplots(4, 1, figsize=(12, 13), dpi=140)
        for ax, im, title in [
            (axes[0], jpg_local, f"JPG (raw pano-local)  pitch_off={rec['pitch_deg']-90:+.2f}° roll={rec['roll_deg']:+.2f}° heading={rec['heading_deg']:.1f}°"),
            (axes[1], jpg_grav, "JPG (gravity-aligned, bilinear resample)"),
            (axes[2], idx_local, "indexmap (raw pano-local)"),
            (axes[3], idx_grav, "indexmap (gravity-aligned, 4x4 supersampled)"),
        ]:
            if im.dtype == np.uint8 and im.ndim == 3:
                ax.imshow(im, aspect="auto")
            else:
                ax.imshow(im, cmap=cmap, vmin=0, vmax=255, interpolation="nearest", aspect="auto")
            mid = im.shape[0] // 2
            ax.axhline(mid, color="white", lw=0.6, ls="--", alpha=0.6)
            ax.set_title(title, fontsize=10)
            ax.set_xticks([0, im.shape[1] // 4, im.shape[1] // 2, 3 * im.shape[1] // 4, im.shape[1] - 1])
            ax.set_yticks([0, mid // 2, mid, mid + mid // 2, im.shape[0] - 1])

        fig.suptitle(f"{panoid}  numPlanes={rec['n_planes']}  (white dashed = horizon row)", fontsize=11)
        fig.tight_layout(rect=(0, 0, 1, 0.985))
        fig.savefig(out / f"{panoid}_with_pano.png", bbox_inches="tight")
        plt.close(fig)
        n_paired += 1

    print(f"Paired: {n_paired}    Missing: {n_missing}")


if __name__ == "__main__":
    main()
