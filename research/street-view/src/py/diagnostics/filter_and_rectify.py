"""Filter Photo Sphere panos + gravity-align rectify the survivors.

Step 1: drop panos with numPlanes <= MIN_PLANES (default 5).
        These are typically user-uploaded Photo Sphere with placeholder geometry.

Step 2: for each survivor, build rotation R(heading, pitch, roll) that maps
        pano-local frame -> world (gravity-aligned) frame, then resample the
        indexmap into a gravity-aligned 256x512 grid.

Output: TEST/data/intermediate/<workspace-id>/02_indexmap_rectified/
        <panoid>_indexmap_local.bin       original 256x512
        <panoid>_indexmap_gravity.bin     rectified 256x512
        <panoid>_compare.png              before/after side-by-side
        filter_log.csv                    pano | numPlanes | kept? | reason
"""

import argparse
import base64
import csv
import json
import math
import struct
import sys
from pathlib import Path

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.colors import ListedColormap

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sv3d_paths import add_spatial_args, resolve_spatial_paths  # noqa: E402

MIN_PLANES = 5


def b64lenient(s):
    s = s + "=" * ((4 - len(s) % 4) % 4)
    return base64.urlsafe_b64decode(s)


def wrap_signed_deg(x):
    x = x % 360.0
    return x - 360.0 if x > 180.0 else x


def parse_one(parsed_json_path):
    d = json.loads(parsed_json_path.read_text())
    panoid = d[1][0][1][1]
    h, p, r_raw = d[1][0][5][0][1][2]
    r = wrap_signed_deg(r_raw)
    node = d[1][0][5][0][5]
    blob1 = b64lenient(node[1][2])
    n_planes = struct.unpack_from("<H", blob1, 1)[0]
    map_w, map_h = node[3][0]
    idxmap = np.frombuffer(blob1[8 : 8 + map_w * map_h], dtype=np.uint8).reshape(map_w, map_h)
    return {
        "panoid": panoid,
        "heading_deg": h,
        "pitch_deg": p,
        "roll_deg": r,
        "n_planes": n_planes,
        "idxmap": idxmap,
    }


def rot_x(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def rot_y(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rot_z(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def build_rotation(heading_deg, pitch_deg, roll_deg, apply_heading=True):
    """Build R: pano-local -> world (gravity-aligned).

      pano-local axes:  +x = right, +y = front (camera optical axis), +z = up
      world axes:       +x = east,  +y = north,                       +z = up_gravity

      Google pose convention:
        heading: compass bearing of pano-local +y, measured CW from +y_world (north)
        pitch:   90 = level horizon (pano +y in world horizontal plane);
                 pitch < 90 means pano +y points BELOW horizon by (90-pitch)
        roll:    rotation about pano-local +y axis

      Heading is CW from north, but standard R_z(α) is CCW. So use R_z(-heading).
      pitch_offset = pitch_deg - 90 (negative pitch_off => front below horizon).

      R_local_to_world = R_z(-heading) * R_x(pitch_offset) * R_y(roll)

      For horizon-flatness validation we can disable heading: apply_heading=False
      keeps the cylinder at its raw azimuthal layout.
    """
    h = math.radians(heading_deg) if apply_heading else 0.0
    pitch_off = math.radians(pitch_deg - 90.0)
    roll = math.radians(roll_deg)
    return rot_z(-h) @ rot_x(pitch_off) @ rot_y(roll)


def rectify_indexmap(idxmap_local, R_local_to_world, supersample=4):
    """Resample pano-local indexmap onto gravity-aligned equirect grid.

    Output grid convention:
      i' in [0, 256): elevation_world = pi/2 - i'*pi/256  (i'=0 zenith, 128 horizon, 255 nadir)
      j' in [0, 512): azimuth_world  = (j' - 256)*2pi/512 (j'=256 north/front, 0 south/back)

    Supersample N: sample NxN sub-pixel points per output pixel, take per-pixel mode.
    Reduces nearest-neighbor aliasing on categorical labels.
    """
    H, W = idxmap_local.shape
    R_inv = R_local_to_world.T

    # build sub-pixel offset grid in output coords
    if supersample <= 1:
        offsets = [(0.5, 0.5)]
    else:
        ss = np.linspace(0.5 / supersample, 1 - 0.5 / supersample, supersample)
        offsets = [(di, dj) for di in ss for dj in ss]

    # sample at each sub-pixel offset, accumulate as (NxN, H, W) stack
    samples = np.empty((len(offsets), H, W), dtype=np.uint8)
    i_out = np.arange(H, dtype=np.float64).reshape(H, 1)
    j_out = np.arange(W, dtype=np.float64).reshape(1, W)
    for k, (di, dj) in enumerate(offsets):
        el_w = math.pi / 2 - (i_out + di) * (math.pi / H)
        az_w = (j_out + dj - W / 2) * (2 * math.pi / W)
        cos_el = np.cos(el_w)
        rx = np.sin(az_w) * cos_el
        ry = np.cos(az_w) * cos_el
        rz = np.sin(el_w) + np.zeros_like(rx)
        rays_w = np.stack([rx, ry, rz], axis=-1).reshape(-1, 3)
        rays_l = rays_w @ R_inv.T
        lx, ly, lz = rays_l[:, 0], rays_l[:, 1], rays_l[:, 2]
        az_l = np.arctan2(lx, ly)
        el_l = np.arcsin(np.clip(lz, -1.0, 1.0))
        j_in = ((az_l + math.pi) % (2 * math.pi)) * (W / (2 * math.pi))
        i_in = (math.pi / 2 - el_l) * (H / math.pi)
        i_in_int = np.clip(np.round(i_in).astype(int), 0, H - 1)
        j_in_int = np.clip(np.round(j_in).astype(int), 0, W - 1) % W
        samples[k] = idxmap_local[i_in_int, j_in_int].reshape(H, W)

    if supersample <= 1:
        return samples[0]

    # per-pixel mode: along axis 0 of samples (NxN, H, W)
    # for uint8 labels in [0, 255], use bincount per pixel via np.argmax
    flat = samples.reshape(len(offsets), -1)              # (N*N, H*W)
    out = np.empty(flat.shape[1], dtype=np.uint8)
    # vectorized mode using one-hot bincount along axis 0
    # flat has values in [0..255]; build counts (256, H*W) and argmax
    counts = np.zeros((256, flat.shape[1]), dtype=np.int32)
    for k in range(flat.shape[0]):
        np.add.at(counts, (flat[k], np.arange(flat.shape[1])), 1)
    out = counts.argmax(axis=0).astype(np.uint8)
    return out.reshape(H, W)


def measure_sky_bottom_amplitude(idxmap):
    """Sky boundary metric: for each column find the LOWEST i where sky (idx 0)
    still exists (= bottom of the sky region in that column). Fit sinusoid.

    Buildings poke up INTO the sky, but the lowest sky pixel per column is a good
    proxy for the apparent horizon height. Smaller sinusoidal amplitude = flatter
    horizon = better gravity alignment.
    """
    sky = idxmap == 0
    H, W = idxmap.shape
    bot = np.full(W, -1, dtype=int)
    for j in range(W):
        wh = np.where(sky[:, j])[0]
        if len(wh):
            bot[j] = wh[-1]
    use = bot >= 0
    if use.sum() < 50:
        return None, None
    j = np.arange(W)[use].astype(float)
    y = bot[use].astype(float)
    omega = 2 * math.pi / W
    M = np.stack([np.ones_like(j), np.cos(omega * j), np.sin(omega * j)], axis=1)
    coef, *_ = np.linalg.lstsq(M, y, rcond=None)
    b, A, B = coef
    amp = math.sqrt(A * A + B * B)
    return amp, b


def main():
    ap = argparse.ArgumentParser(description="Filter and gravity-align photometa indexmaps.")
    add_spatial_args(ap)
    ap.add_argument("--min-planes", type=int, default=MIN_PLANES)
    args = ap.parse_args()

    paths = resolve_spatial_paths(args)
    capture = paths.run_dir
    out = paths.indexmap_rectified_dir
    out.mkdir(exist_ok=True, parents=True)

    focal = sorted(capture.glob("photometa_*_parsed.json"))
    nb = sorted((capture / "neighbor_photometas").glob("*.parsed.json"))
    all_jsons = focal + nb

    rng = np.random.default_rng(7)
    colors = rng.random((256, 3))
    colors[0] = [0, 0, 0]
    cmap = ListedColormap(colors)

    seen = set()
    log_rows = []
    for fp in all_jsons:
        try:
            rec = parse_one(fp)
        except Exception as e:
            log_rows.append({"src": fp.name, "panoid": "", "n_planes": -1, "kept": False, "reason": f"parse_error:{e}"})
            continue
        if rec["panoid"] in seen:
            continue
        seen.add(rec["panoid"])

        if rec["n_planes"] <= args.min_planes:
            log_rows.append({"src": fp.name, "panoid": rec["panoid"], "n_planes": rec["n_planes"],
                              "kept": False, "reason": f"placeholder_geom (numPlanes<={args.min_planes})"})
            continue

        # save local indexmap
        (out / f"{rec['panoid']}_indexmap_local.bin").write_bytes(rec["idxmap"].tobytes())

        # rectify
        R = build_rotation(rec["heading_deg"], rec["pitch_deg"], rec["roll_deg"])
        idx_g = rectify_indexmap(rec["idxmap"], R)
        (out / f"{rec['panoid']}_indexmap_gravity.bin").write_bytes(idx_g.tobytes())

        # measure horizon amplitude
        amp_local, mean_local = measure_sky_bottom_amplitude(rec["idxmap"])
        amp_grav, mean_grav = measure_sky_bottom_amplitude(idx_g)

        # before/after panel
        fig, axes = plt.subplots(2, 1, figsize=(10, 6), dpi=160)
        for ax, im, title in [
            (axes[0], rec["idxmap"], f"local (pano-frame)  pitch_off={rec['pitch_deg']-90:+.2f}° roll={rec['roll_deg']:+.2f}°  horizon_amp={amp_local:.2f}px" if amp_local is not None else "local"),
            (axes[1], idx_g, f"gravity-aligned (after rotation)  horizon_amp={amp_grav:.2f}px" if amp_grav is not None else "gravity-aligned"),
        ]:
            ax.imshow(im, cmap=cmap, vmin=0, vmax=255, interpolation="nearest", aspect="auto")
            ax.axhline(128, color="white", lw=0.6, ls="--", alpha=0.6)
            ax.set_title(title, fontsize=9)
            ax.set_xticks([0, 128, 256, 384, 512])
            ax.set_yticks([0, 64, 128, 192, 255])
        fig.suptitle(f"{rec['panoid']}  heading={rec['heading_deg']:.1f}°  numPlanes={rec['n_planes']}", fontsize=10)
        fig.tight_layout(rect=(0, 0, 1, 0.97))
        fig.savefig(out / f"{rec['panoid']}_compare.png", bbox_inches="tight")
        plt.close(fig)

        log_rows.append({
            "src": fp.name, "panoid": rec["panoid"], "n_planes": rec["n_planes"],
            "kept": True, "reason": "",
            "pitch_off_deg": f"{rec['pitch_deg'] - 90:+.4f}",
            "roll_deg": f"{rec['roll_deg']:+.4f}",
            "horizon_amp_local_px": f"{amp_local:.2f}" if amp_local is not None else "",
            "horizon_amp_gravity_px": f"{amp_grav:.2f}" if amp_grav is not None else "",
        })

    # write log
    keys = ["src", "panoid", "n_planes", "kept", "reason", "pitch_off_deg", "roll_deg", "horizon_amp_local_px", "horizon_amp_gravity_px"]
    with (out / "filter_log.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        for row in log_rows:
            w.writerow({k: row.get(k, "") for k in keys})

    kept = [r for r in log_rows if r.get("kept")]
    drop = [r for r in log_rows if not r.get("kept")]
    print(f"\nKept: {len(kept)}  Dropped: {len(drop)}")
    print(f"Drop reasons:")
    drop_reasons = {}
    for r in drop:
        drop_reasons[r["reason"]] = drop_reasons.get(r["reason"], 0) + 1
    for r, c in drop_reasons.items():
        print(f"  {c:3d}  {r}")

    # summary of horizon amplitude reduction
    amp_pairs = [(float(r["horizon_amp_local_px"]), float(r["horizon_amp_gravity_px"]))
                 for r in kept
                 if r["horizon_amp_local_px"] and r["horizon_amp_gravity_px"]]
    if amp_pairs:
        loc = np.array([a for a, _ in amp_pairs])
        grv = np.array([b for _, b in amp_pairs])
        print(f"\nHorizon sinusoid amplitude (lower = flatter horizon):")
        print(f"  before  (local):    mean={loc.mean():.2f} px  median={np.median(loc):.2f} px  max={loc.max():.2f} px")
        print(f"  after   (gravity):  mean={grv.mean():.2f} px  median={np.median(grv):.2f} px  max={grv.max():.2f} px")
        improved = (grv < loc).sum()
        print(f"  improved (after < before): {improved}/{len(amp_pairs)}")


if __name__ == "__main__":
    main()
