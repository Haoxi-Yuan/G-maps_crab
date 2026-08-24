"""Rotate per-pano plane equations from pano-local frame to world (gravity) frame.

For each kept pano (filter_log.csv: kept=True):
  1. Re-decode blob1 from photometa, extract N plane equations (nx, ny, nz, d).
  2. Build R(heading, pitch, roll) — same convention as indexmap rectification.
  3. Apply n_world = R @ n_local. d is invariant under pure rotation about origin.
  4. Save <panoid>_planes_world.json with both local and world copies for audit.

Validation plot (ground_normal_validation.png):
  Per-pano dominant ground plane (= biggest non-sky plane with nz_local < -0.5).
  Left:  scatter of (nx, ny) of those normals in pano-local frame; tilt off (0,0,-1).
  Right: scatter of (nx, ny) of those normals in world frame; should all collapse
         within a few degrees of (0,0,-1).

Output:
  TEST/data/intermediate/<workspace-id>/03_planes_world/
    <panoid>_planes_world.json
    summary.csv
    ground_normal_validation.png
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

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "diagnostics"))
from filter_and_rectify import build_rotation, parse_one  # noqa
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sv3d_paths import add_spatial_args, resolve_spatial_paths  # noqa: E402


def b64lenient(s):
    s = s + "=" * ((4 - len(s) % 4) % 4)
    return base64.urlsafe_b64decode(s)


def parse_planes_and_indexmap(parsed_json_path):
    """Return (panoid, pose, planes (Nx4 float64), idxmap (256x512 uint8))."""
    d = json.loads(parsed_json_path.read_text())
    panoid = d[1][0][1][1]
    pose = d[1][0][5][0][1][2]
    node = d[1][0][5][0][5]
    blob1 = b64lenient(node[1][2])
    n_planes = struct.unpack_from("<H", blob1, 1)[0]
    map_w, map_h = node[3][0]
    idxmap = np.frombuffer(blob1[8:8 + map_w * map_h], dtype=np.uint8).reshape(map_w, map_h)
    plane_off = 8 + map_w * map_h
    planes = np.empty((n_planes, 4), dtype=np.float64)
    for i in range(n_planes):
        nx, ny, nz, dd = struct.unpack_from("<ffff", blob1, plane_off + 16 * i)
        planes[i] = (nx, ny, nz, dd)
    return panoid, pose, planes, idxmap


def find_photometa_path(panoid, capture: Path):
    nb = capture / "neighbor_photometas" / f"{panoid}.parsed.json"
    if nb.exists():
        return nb
    for fp in sorted(capture.glob("photometa_*_parsed.json")):
        try:
            d = json.loads(fp.read_text())
            if d[1][0][1][1] == panoid:
                return fp
        except Exception:
            continue
    return None


def main():
    ap = argparse.ArgumentParser(description="Rotate per-pano plane equations into world/gravity frame.")
    add_spatial_args(ap)
    args = ap.parse_args()
    paths = resolve_spatial_paths(args)

    capture = paths.run_dir
    rect_dir = paths.indexmap_rectified_dir
    out = paths.planes_world_dir
    out.mkdir(exist_ok=True, parents=True)

    log = list(csv.DictReader(open(rect_dir / "filter_log.csv")))
    kept = [r for r in log if r.get("kept") == "True"]
    print(f"Rotating planes for {len(kept)} panos...")

    summary_rows = []
    ground_local = []  # (nx, ny, nz) per pano dominant ground in local frame
    ground_world = []  # same in world frame
    ground_pano_ids = []

    for k, r in enumerate(kept):
        panoid = r["panoid"]
        fp = find_photometa_path(panoid, capture)
        if fp is None:
            print(f"  {panoid}: photometa not found, skipping")
            continue
        try:
            pid, pose, planes_local, idxmap = parse_planes_and_indexmap(fp)
        except Exception as e:
            print(f"  {panoid}: parse failed ({e})")
            continue
        rec = parse_one(fp)
        R = build_rotation(rec["heading_deg"], rec["pitch_deg"], rec["roll_deg"])

        # rotate normals: n_world = R @ n_local. d unchanged (camera at origin, rotation only)
        n_local = planes_local[:, :3]
        n_world = n_local @ R.T  # (N,3): same as (R @ n_local.T).T
        planes_world = np.column_stack([n_world, planes_local[:, 3]])

        # save audit JSON
        out_json = out / f"{panoid}_planes_world.json"
        out_json.write_text(json.dumps({
            "panoid": panoid,
            "pose": {
                "heading_deg": rec["heading_deg"],
                "pitch_deg": rec["pitch_deg"],
                "pitch_off_deg": rec["pitch_deg"] - 90,
                "roll_deg": rec["roll_deg"],
            },
            "rotation_matrix_local_to_world": R.tolist(),
            "n_planes": int(planes_local.shape[0]),
            "planes_local": planes_local.tolist(),
            "planes_world": planes_world.tolist(),
        }, indent=2))

        # find dominant ground plane in pano-local frame: biggest non-sky with nz<-0.5
        counts = np.bincount(idxmap.ravel(), minlength=planes_local.shape[0] + 1)
        ground_idx = None
        ground_pix = 0
        for i in range(1, planes_local.shape[0]):
            n = planes_local[i, :3]
            mag = np.linalg.norm(n)
            if mag < 1e-6:
                continue
            if (n[2] / mag) < -0.5 and counts[i] > ground_pix:
                ground_idx = i
                ground_pix = counts[i]
        if ground_idx is not None:
            n_l = planes_local[ground_idx, :3]
            n_l = n_l / np.linalg.norm(n_l)
            n_w = n_world[ground_idx]
            n_w = n_w / np.linalg.norm(n_w)
            ground_local.append(n_l)
            ground_world.append(n_w)
            ground_pano_ids.append(panoid)
            tilt_local = math.degrees(math.acos(min(1.0, max(-1.0, -n_l[2]))))
            tilt_world = math.degrees(math.acos(min(1.0, max(-1.0, -n_w[2]))))
        else:
            tilt_local = float("nan")
            tilt_world = float("nan")

        summary_rows.append({
            "panoid": panoid,
            "n_planes": int(planes_local.shape[0]),
            "heading_deg": f"{rec['heading_deg']:.2f}",
            "pitch_off_deg": f"{rec['pitch_deg']-90:+.2f}",
            "roll_deg": f"{rec['roll_deg']:+.2f}",
            "ground_idx": ground_idx if ground_idx is not None else "",
            "ground_tilt_local_deg": f"{tilt_local:.2f}",
            "ground_tilt_world_deg": f"{tilt_world:.2f}",
        })

        if (k + 1) % 10 == 0 or k == len(kept) - 1:
            print(f"  [{k+1}/{len(kept)}] done")

    # save summary
    keys = list(summary_rows[0].keys())
    with (out / "summary.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        w.writerows(summary_rows)

    # plot: dominant ground normals before vs after rotation
    if ground_local:
        gl = np.array(ground_local)
        gw = np.array(ground_world)

        fig, axes = plt.subplots(1, 2, figsize=(14, 7), dpi=140)
        for ax, data, label in [
            (axes[0], gl, "pano-local frame"),
            (axes[1], gw, "world (gravity-aligned) frame"),
        ]:
            # plot (nx, ny) of the normal, color = tilt magnitude
            tilt = np.degrees(np.arccos(np.clip(-data[:, 2], -1.0, 1.0)))
            sc = ax.scatter(data[:, 0], data[:, 1], c=tilt, cmap="plasma",
                            s=70, edgecolors="black", linewidths=0.5, vmin=0, vmax=12)
            # reference circles at 1°, 5°, 10° tilt
            for deg, style in [(1, ":"), (5, "--"), (10, "-")]:
                r = math.sin(math.radians(deg))
                th = np.linspace(0, 2 * math.pi, 200)
                ax.plot(r * np.cos(th), r * np.sin(th), color="gray", lw=0.6, ls=style, alpha=0.5)
                ax.text(0, r, f"{deg}°", color="gray", fontsize=8, ha="center", va="bottom")
            ax.set_title(f"Dominant ground plane normal — {label}\n(N={len(data)} panos, ideal: cluster at origin = (0,0,-1))",
                         fontsize=10)
            ax.set_xlabel("nx (east component)"); ax.set_ylabel("ny (north component)")
            ax.set_xlim(-0.3, 0.3); ax.set_ylim(-0.3, 0.3); ax.set_aspect("equal")
            ax.axhline(0, color="black", lw=0.3); ax.axvline(0, color="black", lw=0.3)
            cbar = plt.colorbar(sc, ax=ax, label="tilt off (0,0,-1) [deg]")

        # stats annotations
        tilt_local_arr = np.degrees(np.arccos(np.clip(-gl[:, 2], -1.0, 1.0)))
        tilt_world_arr = np.degrees(np.arccos(np.clip(-gw[:, 2], -1.0, 1.0)))
        axes[0].text(0.02, 0.98,
                     f"tilt mean={tilt_local_arr.mean():.2f}°\n"
                     f"tilt median={np.median(tilt_local_arr):.2f}°\n"
                     f"tilt max={tilt_local_arr.max():.2f}°",
                     transform=axes[0].transAxes, fontsize=10, va="top",
                     bbox=dict(facecolor="white", alpha=0.85, edgecolor="gray"))
        axes[1].text(0.02, 0.98,
                     f"tilt mean={tilt_world_arr.mean():.2f}°\n"
                     f"tilt median={np.median(tilt_world_arr):.2f}°\n"
                     f"tilt max={tilt_world_arr.max():.2f}°\n"
                     f"reduction: {tilt_local_arr.mean()/max(tilt_world_arr.mean(), 1e-6):.1f}× tighter",
                     transform=axes[1].transAxes, fontsize=10, va="top",
                     bbox=dict(facecolor="white", alpha=0.85, edgecolor="gray"))

        fig.suptitle("Plane-equation rotation to world frame: dominant ground normal validation\n"
                     "(if R is correct, right plot collapses to origin)",
                     fontsize=12)
        fig.tight_layout(rect=(0, 0, 1, 0.94))
        fig.savefig(out / "ground_normal_validation.png", bbox_inches="tight")
        plt.close(fig)

        print()
        print(f"Ground tilt off (0,0,-1):")
        print(f"  pano-local:  mean={tilt_local_arr.mean():.2f}°  median={np.median(tilt_local_arr):.2f}°  max={tilt_local_arr.max():.2f}°")
        print(f"  world frame: mean={tilt_world_arr.mean():.2f}°  median={np.median(tilt_world_arr):.2f}°  max={tilt_world_arr.max():.2f}°")
        print(f"\nWrote: {out}/ground_normal_validation.png")
        print(f"       {out}/<panoid>_planes_world.json  ({len(summary_rows)} files)")
        print(f"       {out}/summary.csv")


if __name__ == "__main__":
    main()
