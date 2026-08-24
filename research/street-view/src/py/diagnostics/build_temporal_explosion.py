"""Temporal x spatial factor-aligned explosion plot for one anchor pano point.

This diagnostic uses one anchor pano as the example, picks a representative
facade plane ("factor") from that anchor, then renders a time x space matrix:

  columns = nearby pano viewpoints in the anchor capture month
  rows    = historical capture months
  cells   = gravity-aligned streetview JPG, horizontally rolled so the anchor
            factor's world bearing is centered, with indexmap overlay

It also writes a perspective 3D "exploded" version of the same matrix.

Outputs:
  TEST/data/diagnostics/temporal/factor_explosion/<anchor_panoid>/
    grid.png
    explosion_3d.png
    viewpoint_index.json
    index.md
"""

import argparse
import base64
import json
import math
import struct
import sys
import time
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from filter_and_rectify import build_rotation, rectify_indexmap  # noqa: E402
from pair_indexmap_with_pano import rectify_rgb  # noqa: E402

RAW_DIR = Path(__file__).resolve().parents[1] / "raw"
sys.path.insert(0, str(RAW_DIR))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sv3d_paths import add_temporal_args, resolve_temporal_paths  # noqa: E402

JPG_OUT_W, JPG_OUT_H = 1280, 640
PANEL_W, PANEL_H = 760, 380
ALPHA = 0.42
MAX_MATCH_DIST_M = 6.0
BAD_BLACK_FRACTION = 0.18


def b64lenient(s):
    s += "=" * ((4 - len(s) % 4) % 4)
    return base64.urlsafe_b64decode(s)


def parse_photometa(parsed_json_path):
    """Return pano pose, date, planes and indexmap from a parsed photometa JSON."""
    d = json.loads(parsed_json_path.read_text())
    panoid = d[1][0][1][1]
    lat = d[1][0][5][0][1][0][2]
    lng = d[1][0][5][0][1][0][3]
    pose = d[1][0][5][0][1][2]
    capture_year = capture_month = None
    try:
        date_block = d[1][0][6][7]
        capture_year, capture_month = int(date_block[0]), int(date_block[1])
    except Exception:
        pass

    node = d[1][0][5][0][5]
    if node is None:
        return None
    blob1 = b64lenient(node[1][2])
    n_planes = struct.unpack_from("<H", blob1, 1)[0]
    map_w, map_h = node[3][0]
    idxmap = np.frombuffer(blob1[8:8 + map_w * map_h], dtype=np.uint8).reshape(map_w, map_h)
    plane_off = 8 + map_w * map_h
    planes = np.empty((n_planes, 4), dtype=np.float64)
    for i in range(n_planes):
        planes[i] = struct.unpack_from("<ffff", blob1, plane_off + 16 * i)

    roll = pose[2] if abs(pose[2]) < 180 else (pose[2] - 360)
    return {
        "panoid": panoid,
        "lat": float(lat),
        "lng": float(lng),
        "heading_deg": float(pose[0]),
        "pitch_deg": float(pose[1]),
        "roll_deg": float(roll),
        "capture_year": capture_year,
        "capture_month": capture_month,
        "n_planes": int(n_planes),
        "idxmap": idxmap,
        "planes": planes,
    }


def get_capture_date(parsed_json_path):
    try:
        d = json.loads(parsed_json_path.read_text())
        date_block = d[1][0][6][7]
        return int(date_block[0]), int(date_block[1])
    except Exception:
        return None, None


def get_pid_lat_lng(parsed_json_path):
    d = json.loads(parsed_json_path.read_text())
    return (
        d[1][0][1][1],
        float(d[1][0][5][0][1][0][2]),
        float(d[1][0][5][0][1][0][3]),
    )


def latlng_to_enu(lat, lng, lat_ref, lng_ref):
    radius_m = 6371000.0
    east = math.radians(lng - lng_ref) * radius_m * math.cos(math.radians(lat_ref))
    north = math.radians(lat - lat_ref) * radius_m
    return east, north


def normalize_equirect_array(arr):
    """Return RGB array with exact 2:1 aspect by cropping or padding height."""
    h, w = arr.shape[:2]
    target_h = max(1, w // 2)
    if h == target_h:
        return arr, "unchanged"
    if h > target_h:
        return arr[:target_h], f"cropped_height_{h}_to_{target_h}"
    out = np.zeros((target_h, w, 3), dtype=arr.dtype)
    out[:h] = arr
    return out, f"padded_height_{h}_to_{target_h}"


def estimate_black_fraction(jpg_path):
    if jpg_path is None or not jpg_path.exists():
        return 1.0
    try:
        with Image.open(jpg_path) as im:
            arr = np.array(im.convert("RGB").resize((512, 256), Image.BILINEAR))
        return float(((arr[:, :, 0] < 8) & (arr[:, :, 1] < 8) & (arr[:, :, 2] < 8)).mean())
    except Exception:
        return 1.0


def build_master_inventory(temporal_root, anchor_lat, anchor_lng):
    """Collect all focal and neighbor panos, keeping the cleanest JPG per panoid."""
    occurrences = {}

    def add_occurrence(json_path, jpg_path, capture_dir):
        try:
            pid, lat, lng = get_pid_lat_lng(json_path)
            yr, mo = get_capture_date(json_path)
        except Exception:
            return
        exists = jpg_path.exists() if jpg_path is not None else False
        occurrences.setdefault(pid, []).append({
            "panoid": pid,
            "lat": lat,
            "lng": lng,
            "capture_year": yr,
            "capture_month": mo,
            "json_path": json_path,
            "jpg_path": jpg_path if exists else None,
            "capture_dir": capture_dir,
            "jpg_black_fraction": estimate_black_fraction(jpg_path) if exists else 1.0,
        })

    for cap in sorted((temporal_root / "captures").glob("*")):
        focal_json = next(cap.glob("photometa_*_parsed.json"), None)
        if focal_json is None:
            focal_json = cap / "parsed.json"
        if focal_json.exists():
            try:
                pid, _, _ = get_pid_lat_lng(focal_json)
                add_occurrence(focal_json, cap / "panoramas" / f"{pid}.jpg", cap)
            except Exception:
                pass

        nb_dir = cap / "neighbor_photometas"
        if not nb_dir.exists():
            continue
        for fp in sorted(nb_dir.glob("*.parsed.json")):
            pid = fp.name[:-len(".parsed.json")]
            add_occurrence(fp, cap / "panoramas" / f"{pid}.jpg", cap)

    inv = {}
    for pid, occs in occurrences.items():
        # Prefer an existing, low-black, exact-aspect JPG. The same panoid often
        # appears in several capture folders; earlier cached versions may contain
        # black tile-grid gaps from the old fixed-grid stitcher.
        def score(o):
            jpg_exists = 0 if o["jpg_path"] is not None else 1
            return (jpg_exists, o["jpg_black_fraction"], str(o["capture_dir"]))

        best = sorted(occs, key=score)[0]
        best = dict(best)
        best["all_occurrences"] = [
            {
                "capture": str(o["capture_dir"].name),
                "jpg_path": str(o["jpg_path"]) if o["jpg_path"] else None,
                "jpg_black_fraction": round(o["jpg_black_fraction"], 4),
            }
            for o in sorted(occs, key=score)
        ]
        best["e"], best["n"] = latlng_to_enu(best["lat"], best["lng"], anchor_lat, anchor_lng)
        inv[pid] = best
    return inv


def classify_plane(n):
    norm = float(np.linalg.norm(n))
    if norm < 1e-8:
        return "sky"
    nz = n[2] / norm
    if nz < -0.5:
        return "ground"
    if nz > 0.5:
        return "ceiling"
    return "facade"


def choose_anchor_factor(anchor_rec, requested_idx=None):
    """Pick a visible anchor facade plane as the factor to align across cells."""
    idxmap = anchor_rec["idxmap"]
    planes = anchor_rec["planes"]
    counts = np.bincount(idxmap.ravel(), minlength=planes.shape[0])
    rows, cols = np.indices(idxmap.shape)
    h, w = idxmap.shape

    candidates = []
    for i in range(1, planes.shape[0]):
        if requested_idx is not None and i != requested_idx:
            continue
        cls = classify_plane(planes[i, :3])
        if cls != "facade" or counts[i] < 250:
            continue
        mask = idxmap == i
        col_mean = float(cols[mask].mean())
        row_mean = float(rows[mask].mean())
        center_score = 1.0 - min(1.0, abs(col_mean - w / 2) / (w / 2))
        horizon_score = 1.0 - min(1.0, abs(row_mean - h / 2) / (h / 2))
        score = float(counts[i]) * (0.55 + 0.45 * center_score) * (0.75 + 0.25 * horizon_score)
        candidates.append((score, i, col_mean, row_mean))
    if not candidates:
        raise RuntimeError("No usable facade factor plane found in anchor pano")

    _, plane_idx, col_mean, row_mean = max(candidates)
    plane = planes[plane_idx]
    norm = plane[:3] / np.linalg.norm(plane[:3])
    return {
        "plane_idx": int(plane_idx),
        "class": "facade",
        "pixel_count": int(counts[plane_idx]),
        "support_col_mean": round(col_mean, 2),
        "support_row_mean": round(row_mean, 2),
        "normal_local": [float(x) for x in norm],
        "d_local": float(plane[3]),
    }


def factor_world_point(anchor_rec, factor, anchor_e, anchor_n):
    """Estimate a world point on the selected anchor plane from support pixels."""
    idxmap = anchor_rec["idxmap"]
    planes = anchor_rec["planes"]
    k = factor["plane_idx"]
    mask = idxmap == k
    h, w = idxmap.shape
    rr, cc = np.where(mask)
    if rr.size == 0:
        raise RuntimeError(f"Factor plane {k} has no support pixels")

    theta = (cc.astype(np.float64) + 0.5) / w * 2 * math.pi - math.pi
    phi = math.pi / 2 - (rr.astype(np.float64) + 0.5) / h * math.pi
    rays = np.column_stack([
        np.sin(theta) * np.cos(phi),
        np.cos(theta) * np.cos(phi),
        np.sin(phi),
    ])
    plane = planes[k]
    with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
        denom = rays @ plane[:3]
    with np.errstate(divide="ignore", invalid="ignore"):
        t = plane[3] / denom
    valid = np.isfinite(t) & (t > 0) & (t < 90)
    if valid.sum() < 10:
        raise RuntimeError(f"Factor plane {k} cannot be intersected robustly")

    local_pts = rays[valid] * t[valid, None]
    local_med = np.median(local_pts, axis=0)
    R = build_rotation(anchor_rec["heading_deg"], anchor_rec["pitch_deg"], anchor_rec["roll_deg"])
    world = R @ local_med + np.array([anchor_e, anchor_n, 0.0])
    factor["target_local_median"] = [float(x) for x in local_med]
    factor["target_world_enu"] = [float(x) for x in world]
    return world


def maybe_repair_jpg(panoid, jpg_path, repaired_dir, repair_bad_panos, workers):
    """Use current probed tile stitcher to repair old black-gap cached panos."""
    original_black = estimate_black_fraction(jpg_path)
    if not repair_bad_panos or original_black <= BAD_BLACK_FRACTION:
        return jpg_path, {
            "repair_attempted": False,
            "black_fraction": round(original_black, 4),
            "used_repaired": False,
        }

    repaired_dir.mkdir(parents=True, exist_ok=True)
    repaired_path = repaired_dir / f"{panoid}.jpg"
    repaired_black = estimate_black_fraction(repaired_path) if repaired_path.exists() else 1.0
    if repaired_path.exists() and repaired_black < original_black - 0.03:
        return repaired_path, {
            "repair_attempted": True,
            "black_fraction": round(repaired_black, 4),
            "original_black_fraction": round(original_black, 4),
            "used_repaired": True,
            "repair_status": "cached_repaired",
        }

    try:
        from stitch_panoramas import stitch_pano  # noqa: E402
        started = time.time()
        result = stitch_pano(panoid, repaired_path, zoom=4, workers=workers)
        if isinstance(result, tuple) and len(result) == 2:
            failed, meta = result
        else:
            failed, meta = result, {}
        repaired_black = estimate_black_fraction(repaired_path)
        use_repaired = repaired_path.exists() and repaired_black < original_black - 0.03
        return (repaired_path if use_repaired else jpg_path), {
            "repair_attempted": True,
            "black_fraction": round(repaired_black if use_repaired else original_black, 4),
            "original_black_fraction": round(original_black, 4),
            "repaired_black_fraction": round(repaired_black, 4),
            "used_repaired": bool(use_repaired),
            "repair_status": "ok" if use_repaired else "not_improved",
            "repair_failed_tiles": len(failed),
            "repair_meta": meta if isinstance(meta, dict) else {},
            "repair_duration_s": round(time.time() - started, 2),
        }
    except Exception as exc:
        return jpg_path, {
            "repair_attempted": True,
            "black_fraction": round(original_black, 4),
            "original_black_fraction": round(original_black, 4),
            "used_repaired": False,
            "repair_status": f"failed:{type(exc).__name__}:{exc}",
        }


def render_factor_aligned_panel(rec, palette, target_world, repaired_dir, repair_bad_panos, workers):
    jpg_path = rec["jpg_path"]
    if jpg_path is None or not jpg_path.exists():
        return None, {"reason": "no_jpg"}

    use_path, repair_meta = maybe_repair_jpg(
        rec["panoid"], jpg_path, repaired_dir, repair_bad_panos, workers
    )
    with Image.open(use_path) as im:
        jpg_arr = np.array(im.convert("RGB"))
    jpg_arr, aspect_action = normalize_equirect_array(jpg_arr)

    R = build_rotation(rec["heading_deg"], rec["pitch_deg"], rec["roll_deg"])
    jpg_grav = rectify_rgb(jpg_arr, R, out_size=(JPG_OUT_H, JPG_OUT_W), chunk_rows=64)

    idx_grav = rectify_indexmap(rec["idxmap"], R, supersample=2)
    scale_h = JPG_OUT_H / idx_grav.shape[0]
    scale_w = JPG_OUT_W / idx_grav.shape[1]
    i_up = (np.arange(JPG_OUT_H) / scale_h).astype(np.int32)
    j_up = (np.arange(JPG_OUT_W) / scale_w).astype(np.int32)
    idx_up = idx_grav[i_up[:, None], j_up[None, :]]

    idx_rgb = palette[idx_up]
    idx_alpha = np.where(idx_up == 0, 0.0, ALPHA).astype(np.float32)[..., None]
    composite = (
        jpg_grav.astype(np.float32) * (1 - idx_alpha)
        + idx_rgb.astype(np.float32) * idx_alpha
    ).astype(np.uint8)

    black_mask = (
        (jpg_grav[:, :, 0] < 8)
        & (jpg_grav[:, :, 1] < 8)
        & (jpg_grav[:, :, 2] < 8)
    )
    black_after_rectify = float(black_mask.mean())
    if black_after_rectify > 0.03:
        # Do not show missing tile gaps as valid imagery.
        composite[black_mask] = np.array([235, 235, 235], dtype=np.uint8)

    cam = np.array([rec["e"], rec["n"], 0.0])
    vec = target_world - cam
    az = math.atan2(float(vec[0]), float(vec[1]))
    shift_px = int(round(-az / (2 * math.pi) * JPG_OUT_W))
    composite = np.roll(composite, shift_px, axis=1)

    x0 = JPG_OUT_W // 2 - PANEL_W // 2
    y0 = JPG_OUT_H // 2 - PANEL_H // 2
    panel = composite[y0:y0 + PANEL_H, x0:x0 + PANEL_W].copy()

    # Thin center marker: after horizontal roll, this is the target factor bearing.
    cx = PANEL_W // 2
    panel[:, max(0, cx - 1):min(PANEL_W, cx + 1)] = (
        panel[:, max(0, cx - 1):min(PANEL_W, cx + 1)].astype(np.float32) * 0.30
        + np.array([255, 25, 25], dtype=np.float32) * 0.70
    ).astype(np.uint8)

    return panel, {
        **repair_meta,
        "aspect_action": aspect_action,
        "black_after_rectify": round(black_after_rectify, 4),
        "target_azimuth_deg": round(math.degrees(az), 2),
        "target_roll_shift_px": int(shift_px),
        "render_jpg_path": str(use_path),
    }


def choose_reference_columns(inv, anchor, target_world, n_cols):
    anchor_year = anchor["capture_year"]
    anchor_month = anchor["capture_month"]
    anchor_month_panos = [
        p for p in inv.values()
        if p["capture_year"] == anchor_year
        and p["capture_month"] == anchor_month
        and p["jpg_path"] is not None
    ]
    for p in anchor_month_panos:
        p["dist_to_anchor"] = math.hypot(p["e"] - anchor["e"], p["n"] - anchor["n"])
        p["dist_to_factor"] = math.hypot(p["e"] - target_world[0], p["n"] - target_world[1])

    anchor_first = [p for p in anchor_month_panos if p["panoid"] == anchor["panoid"]]
    others = [p for p in anchor_month_panos if p["panoid"] != anchor["panoid"]]
    # Use spatial viewpoints close to the factor, but keep a spread around anchor.
    others.sort(key=lambda p: (p["dist_to_factor"], p["dist_to_anchor"]))
    refs = anchor_first + others[:max(0, n_cols - len(anchor_first))]
    return refs[:n_cols]


def build_cells(inv, refs, years_in_data, palette, target_world, out_dir, repair_bad_panos, workers):
    repaired_dir = out_dir / "repaired_panoramas"
    grid_cells = {}
    grid_meta = []

    for year, month in years_in_data:
        ym_panos = [
            p for p in inv.values()
            if p["capture_year"] == year and p["capture_month"] == month and p["jpg_path"] is not None
        ]
        for col, ref in enumerate(refs):
            if not ym_panos:
                grid_meta.append({
                    "year": year, "month": month, "col": col,
                    "ref_panoid": ref["panoid"], "kept": False,
                    "reason": "no_panos_in_yearmonth",
                })
                continue
            best = min(ym_panos, key=lambda p: math.hypot(p["e"] - ref["e"], p["n"] - ref["n"]))
            dist = math.hypot(best["e"] - ref["e"], best["n"] - ref["n"])
            cell_meta = {
                "year": year,
                "month": month,
                "col": col,
                "ref_panoid": ref["panoid"],
                "matched_panoid": best["panoid"],
                "matched_dist_m": round(dist, 3),
                "matched_e": round(best["e"], 3),
                "matched_n": round(best["n"], 3),
                "kept": dist <= MAX_MATCH_DIST_M,
            }
            if not cell_meta["kept"]:
                cell_meta["reason"] = f"no_pano_within_{MAX_MATCH_DIST_M}m"
                grid_meta.append(cell_meta)
                continue

            parsed = parse_photometa(best["json_path"])
            if parsed is None:
                cell_meta["kept"] = False
                cell_meta["reason"] = "no_geom_blob"
                grid_meta.append(cell_meta)
                continue
            rec = {**parsed, **best}
            panel, render_meta = render_factor_aligned_panel(
                rec, palette, target_world, repaired_dir, repair_bad_panos, workers
            )
            if panel is None:
                cell_meta["kept"] = False
                cell_meta["reason"] = render_meta.get("reason", "render_failed")
                grid_meta.append(cell_meta)
                continue

            grid_cells[(year, month, col)] = panel
            cell_meta.update({
                "heading_deg": round(rec["heading_deg"], 2),
                "pitch_deg": round(rec["pitch_deg"], 2),
                "roll_deg": round(rec["roll_deg"], 2),
                "n_planes": rec["n_planes"],
                "render": render_meta,
            })
            grid_meta.append(cell_meta)
            print(
                f"  [{year}-{month:02d} col {col}] -> {best['panoid'][:14]} "
                f"d={dist:.2f}m shift={render_meta.get('target_roll_shift_px')} "
                f"black={render_meta.get('black_fraction')}"
            )
    return grid_cells, grid_meta


def save_2d_grid(out_fp, grid_cells, grid_meta, refs, years_in_data, factor, anchor_panoid):
    n_rows = len(years_in_data)
    n_cols = len(refs)
    fig, axes = plt.subplots(n_rows, n_cols, figsize=(n_cols * 4.1, n_rows * 2.15), dpi=150)
    if n_rows == 1:
        axes = np.array([axes])
    if n_cols == 1:
        axes = axes[:, None]

    for r, (year, month) in enumerate(years_in_data):
        for c in range(n_cols):
            ax = axes[r, c]
            ax.set_xticks([])
            ax.set_yticks([])
            cell = grid_cells.get((year, month, c))
            meta = next(
                (m for m in grid_meta if m["year"] == year and m["month"] == month and m["col"] == c),
                None,
            )
            if cell is not None:
                ax.imshow(cell, aspect="auto")
                title = f"{meta['matched_panoid'][:10]} d={meta['matched_dist_m']}m"
                if meta.get("render", {}).get("used_repaired"):
                    title += " repaired"
                ax.set_title(title, fontsize=7)
            else:
                reason = meta.get("reason", "?") if meta else "?"
                ax.text(0.5, 0.5, f"no pano\n({reason})", ha="center", va="center",
                        transform=ax.transAxes, fontsize=8, color="gray")
                ax.set_facecolor("#f4f4f4")
            if c == 0:
                ax.set_ylabel(f"{year}-{month:02d}", fontsize=10, rotation=0,
                              ha="right", va="center", labelpad=42)
            if r == 0:
                ref = refs[c]
                tag = " anchor" if ref["panoid"] == anchor_panoid else ""
                ax.text(
                    0.5, 1.22,
                    f"view {c}{tag}\nref={ref['panoid'][:10]}\n"
                    f"ENU=({ref['e']:+.1f},{ref['n']:+.1f})",
                    ha="center", transform=ax.transAxes, fontsize=7,
                )

    fig.suptitle(
        f"Factor-aligned temporal x spatial grid — anchor {anchor_panoid}, "
        f"factor local plane {factor['plane_idx']}\n"
        "columns = different pano viewpoints, rows = capture months, red center line = anchor factor bearing",
        fontsize=11,
    )
    fig.tight_layout(rect=(0.03, 0, 1, 0.93))
    fig.savefig(out_fp, bbox_inches="tight")
    plt.close(fig)


def save_3d_explosion(out_fp, grid_cells, grid_meta, refs, years_in_data, factor, anchor_panoid):
    fig = plt.figure(figsize=(15, 10), dpi=170)
    ax = fig.add_subplot(111, projection="3d")
    n_rows = len(years_in_data)
    n_cols = len(refs)

    tile_w, tile_h = 1.55, 0.78
    step_x, step_z = 1.85, 1.02
    for r, (year, month) in enumerate(years_in_data):
        z0 = (n_rows - 1 - r) * step_z
        for c in range(n_cols):
            x0 = c * step_x
            y0 = -r * 0.14 + c * 0.035
            panel = grid_cells.get((year, month, c))
            if panel is None:
                panel = np.full((PANEL_H, PANEL_W, 3), 238, dtype=np.uint8)
                meta = next(
                    (m for m in grid_meta if m["year"] == year and m["month"] == month and m["col"] == c),
                    {},
                )
                reason = meta.get("reason", "no pano")
                panel = annotate_panel(panel, reason)
            texture = Image.fromarray(panel).resize((100, 50), Image.BILINEAR)
            rgb = np.asarray(texture).astype(np.float32) / 255.0
            rgba = np.dstack([rgb, np.ones(rgb.shape[:2], dtype=np.float32)])
            th, tw = rgb.shape[:2]
            xs = np.linspace(x0, x0 + tile_w, tw)
            # Image row 0 is the visual top; map it to the top edge in Z.
            zs = np.linspace(z0 + tile_h, z0, th)
            X, Z = np.meshgrid(xs, zs)
            Y = np.full_like(X, y0)
            ax.plot_surface(X, Y, Z, facecolors=rgba, rstride=1, cstride=1,
                            linewidth=0, antialiased=False, shade=False)
            ax.plot([x0, x0 + tile_w, x0 + tile_w, x0, x0],
                    [y0] * 5,
                    [z0, z0, z0 + tile_h, z0 + tile_h, z0],
                    color="black", lw=0.25, alpha=0.7)

    for c, ref in enumerate(refs):
        ax.text(c * step_x + tile_w / 2, 0.25, n_rows * step_z + 0.05,
                f"view {c}\n{ref['panoid'][:8]}", ha="center", fontsize=8)
    for r, (year, month) in enumerate(years_in_data):
        ax.text(-0.85, -r * 0.14, (n_rows - 1 - r) * step_z + tile_h / 2,
                f"{year}-{month:02d}", ha="right", va="center", fontsize=8)

    ax.set_title(
        f"3D temporal x spatial explosion — anchor {anchor_panoid}, factor plane {factor['plane_idx']}\n"
        "X = pano viewpoints, Z = years, each panel is target-bearing aligned streetview + indexmap",
        fontsize=11,
        pad=18,
    )
    ax.set_xlim(-0.8, (n_cols - 1) * step_x + tile_w + 0.4)
    ax.set_ylim(-n_rows * 0.18 - 0.3, 0.45)
    ax.set_zlim(-0.2, n_rows * step_z + 0.8)
    ax.view_init(elev=18, azim=-64)
    ax.set_box_aspect((n_cols * 1.6, 1.4, n_rows * 0.75))
    ax.set_axis_off()
    fig.savefig(out_fp, bbox_inches="tight")
    plt.close(fig)


def annotate_panel(panel, text):
    out = Image.fromarray(panel)
    # Keep this deliberately simple to avoid relying on platform font paths.
    import matplotlib
    from matplotlib.backends.backend_agg import FigureCanvasAgg

    fig = plt.figure(figsize=(PANEL_W / 100, PANEL_H / 100), dpi=100)
    canvas = FigureCanvasAgg(fig)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.imshow(out)
    ax.text(0.5, 0.5, text, ha="center", va="center", color="gray",
            fontsize=16, transform=ax.transAxes)
    ax.axis("off")
    canvas.draw()
    arr = np.asarray(canvas.buffer_rgba())[:, :, :3].copy()
    plt.close(fig)
    return arr


def write_index(out_dir, anchor_panoid):
    (out_dir / "index.md").write_text(
        f"""# Temporal factor explosion: `{anchor_panoid}`

Main outputs:

- `grid.png`: 2D matrix. Columns are nearby pano viewpoints; rows are capture months.
- `explosion_3d.png`: perspective exploded version of the same matrix.
- `viewpoint_index.json`: exact panoid, year, distance, target-bearing shift and repair metadata for every cell.

Interpretation:

- The chosen anchor factor is a facade-like Google photometa plane from the anchor pano.
- Every rendered panel is gravity-aligned and horizontally rolled so the world bearing to that anchor factor is centered.
- The red vertical line marks that aligned factor bearing.
- The color overlay is the Google photometa indexmap, not an instance-accurate building mask.
- If a cached pano had old black tile-grid gaps, the script attempted to restitch it into `repaired_panoramas/` when run with `--repair-bad-panos`.
""",
        encoding="utf-8",
    )


def main():
    global MAX_MATCH_DIST_M
    ap = argparse.ArgumentParser(description="Build factor-aligned temporal/spatial explosion diagnostics.")
    add_temporal_args(ap)
    ap.add_argument("--n-cols", type=int, default=4)
    ap.add_argument("--max-match-dist", type=float, default=MAX_MATCH_DIST_M)
    ap.add_argument("--factor-plane-idx", type=int, default=None)
    ap.add_argument("--repair-bad-panos", action="store_true",
                    help="Restitch black-gap cached panos into repaired_panoramas/ before rendering.")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()
    paths = resolve_temporal_paths(args)

    MAX_MATCH_DIST_M = args.max_match_dist

    out_dir = paths.factor_explosion_root / paths.anchor
    out_dir.mkdir(parents=True, exist_ok=True)

    rng = np.random.default_rng(7)
    palette = (rng.random((256, 3)) * 255).astype(np.uint8)
    palette[0] = [0, 0, 0]

    # Locate anchor photometa first to set the ENU origin.
    anchor_jsons = list(paths.stack_dir.glob(f"captures/*/neighbor_photometas/{paths.anchor}.parsed.json"))
    anchor_jsons += list(paths.stack_dir.glob("captures/*/parsed.json"))
    anchor_rec = None
    anchor_json = None
    for fp in anchor_jsons:
        try:
            rec = parse_photometa(fp)
        except Exception:
            continue
        if rec and rec["panoid"] == paths.anchor:
            anchor_rec = rec
            anchor_json = fp
            break
    if anchor_rec is None:
        raise RuntimeError(f"Anchor {paths.anchor} was not found under {paths.stack_dir}")

    anchor_lat = anchor_rec["lat"]
    anchor_lng = anchor_rec["lng"]
    inv = build_master_inventory(paths.stack_dir, anchor_lat, anchor_lng)
    if paths.anchor not in inv:
        raise RuntimeError(f"Anchor {paths.anchor} is not in the temporal inventory")
    anchor = inv[paths.anchor]
    anchor_rec = {**anchor_rec, **anchor}

    factor = choose_anchor_factor(anchor_rec, args.factor_plane_idx)
    target_world = factor_world_point(anchor_rec, factor, anchor["e"], anchor["n"])

    print(f"Anchor: {paths.anchor}  {anchor['capture_year']}-{anchor['capture_month']:02d}")
    print(f"Anchor JSON: {anchor_json}")
    print(f"Inventory: {len(inv)} unique panoids")
    print(f"Chosen factor: local plane {factor['plane_idx']}  pixels={factor['pixel_count']}  "
          f"target ENU=({target_world[0]:+.2f},{target_world[1]:+.2f},{target_world[2]:+.2f})")

    years_in_data = sorted({
        (p["capture_year"], p["capture_month"])
        for p in inv.values()
        if p["capture_year"] is not None and p["capture_month"] is not None
    })
    refs = choose_reference_columns(inv, anchor, target_world, args.n_cols)
    print("Reference spatial columns:")
    for c, p in enumerate(refs):
        print(f"  col {c}: {p['panoid'][:14]} ENU=({p['e']:+.2f},{p['n']:+.2f}) "
              f"dist_to_factor={p.get('dist_to_factor', 0):.2f}m")

    grid_cells, grid_meta = build_cells(
        inv, refs, years_in_data, palette, target_world, out_dir,
        args.repair_bad_panos, args.workers,
    )

    save_2d_grid(out_dir / "grid.png", grid_cells, grid_meta, refs, years_in_data, factor, paths.anchor)
    save_3d_explosion(out_dir / "explosion_3d.png", grid_cells, grid_meta, refs, years_in_data, factor, paths.anchor)
    write_index(out_dir, paths.anchor)

    metadata = {
        "anchor_panoid": paths.anchor,
        "anchor_year_month": f"{anchor['capture_year']}-{anchor['capture_month']:02d}",
        "anchor_lat": anchor_lat,
        "anchor_lng": anchor_lng,
        "anchor_json": str(anchor_json),
        "max_match_dist_m": MAX_MATCH_DIST_M,
        "n_cols": len(refs),
        "n_rows": len(years_in_data),
        "years_in_data": [f"{y}-{m:02d}" for y, m in years_in_data],
        "factor": factor,
        "render_outputs": {
            "grid": str(out_dir / "grid.png"),
            "explosion_3d": str(out_dir / "explosion_3d.png"),
            "index": str(out_dir / "index.md"),
        },
        "ref_columns": [
            {
                "col": k,
                "ref_panoid": p["panoid"],
                "e": p["e"],
                "n": p["n"],
                "is_focal_anchor": p["panoid"] == paths.anchor,
                "dist_to_factor_m": p.get("dist_to_factor"),
                "jpg_black_fraction": p.get("jpg_black_fraction"),
            }
            for k, p in enumerate(refs)
        ],
        "cells": grid_meta,
    }
    (out_dir / "viewpoint_index.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    filled = sum(1 for m in grid_meta if m.get("kept"))
    repaired = sum(1 for m in grid_meta if m.get("render", {}).get("used_repaired"))
    print(f"\nWrote {out_dir / 'grid.png'}")
    print(f"Wrote {out_dir / 'explosion_3d.png'}")
    print(f"Wrote {out_dir / 'viewpoint_index.json'}")
    print(f"Cells filled: {filled}/{len(years_in_data) * len(refs)}; repaired panos used: {repaired}")


if __name__ == "__main__":
    main()
