#!/usr/bin/env python3
"""Rectify temporal captures onto existing world-factor atlases.

This stage uses the factor atlases from ``06_surface_stitching`` as canonical
surface coordinates. For each factor, it looks at the current panoids that
already observe that factor, finds their temporal captures, projects the atlas
grid into each historical panorama, and records the best matching local plane.

Outputs are lightweight manifests plus diagnostic grids. Heavy raster outputs
stay as files and can be indexed by the DuckDB catalog.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFont

THIS_DIR = Path(__file__).resolve().parent
PY_ROOT = THIS_DIR.parents[0]
sys.path.insert(0, str(PY_ROOT))
sys.path.insert(0, str(THIS_DIR))

from sv3d_paths import add_spatial_args, resolve_spatial_paths  # noqa: E402
import derive_factor_surfaces as dfs  # noqa: E402


IDX_H = 256
IDX_W = 512
DATE_CAPTURE_RE = re.compile(r"^(\d{4})-(\d{2})-\d{2}_(.+)$")
CAPTURE_COLUMNS = [
    "temporal_observation_id", "workspace_id", "batch_id", "gid", "factor_class",
    "anchor_panoid", "stack_id", "capture_id", "year_month", "capture_panoid",
    "capture_lat", "capture_lng", "camera_east_m", "camera_north_m",
    "dominant_local_plane_id", "temporal_plane_class", "valid_pixel_count",
    "valid_fraction", "dominant_fraction", "normal_angle_deg",
    "offset_residual_m", "distance_m", "keep", "status", "reason",
    "rectified_path", "mask_path", "atlas_json_path",
]
CORRESPONDENCE_COLUMNS = [
    "correspondence_id", "workspace_id", "gid", "factor_local_plane_id",
    "anchor_panoid", "stack_id", "year_month", "source_panoid", "matched_panoid",
    "transform_json", "residual_m", "residual_px", "keep", "status", "reason",
    "crop_path", "overlay_path", "correspondence_path",
]


def read_json(path: Path) -> Any:
    return json.loads(path.read_text())


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open(newline="") as f:
        return list(csv.DictReader(f))


def write_csv(path: Path, rows: list[dict[str, Any]], columns: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=columns)
        writer.writeheader()
        for row in rows:
            writer.writerow({col: "" if row.get(col) is None else row.get(col) for col in columns})


def rel_path(path: Path, test_root: Path) -> str:
    return path.resolve(strict=False).relative_to(test_root.resolve(strict=False)).as_posix()


def to_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(float(str(value)))
    except ValueError:
        return None


def to_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(str(value))
    except ValueError:
        return None


def latlng_to_local(ref_lat: float, ref_lng: float, lat: float, lng: float) -> tuple[float, float]:
    meters_per_deg_lat = 110540.0
    meters_per_deg_lng = 111320.0 * math.cos(math.radians(ref_lat))
    return (lng - ref_lng) * meters_per_deg_lng, (lat - ref_lat) * meters_per_deg_lat


def rot_x(angle: float) -> np.ndarray:
    c, s = math.cos(angle), math.sin(angle)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]], dtype=np.float64)


def rot_y(angle: float) -> np.ndarray:
    c, s = math.cos(angle), math.sin(angle)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], dtype=np.float64)


def rot_z(angle: float) -> np.ndarray:
    c, s = math.cos(angle), math.sin(angle)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]], dtype=np.float64)


def build_rotation(heading_deg: float, pitch_deg: float, roll_deg: float) -> np.ndarray:
    """Return pano-local to world rotation, matching diagnostics.filter_and_rectify."""
    heading = math.radians(heading_deg)
    pitch_off = math.radians(pitch_deg - 90.0)
    roll = math.radians(roll_deg)
    return rot_z(-heading) @ rot_x(pitch_off) @ rot_y(roll)


def extract_lat_lng(parsed_json: Path) -> tuple[float | None, float | None]:
    try:
        data = read_json(parsed_json)
        lat = data[1][0][5][0][1][0][2]
        lng = data[1][0][5][0][1][0][3]
        return float(lat), float(lng)
    except Exception:
        return None, None


def load_spatial_reference(paths: Any) -> tuple[float, float]:
    meta = read_json(paths.depth_pointcloud_dir / "pointcloud_meta.json")
    return float(meta["reference_lat"]), float(meta["reference_lng"])


def load_factor_geometries(paths: Any) -> dict[int, dict[str, Any]]:
    rows = read_csv_rows(paths.derived_root / "04b_factor_geometry" / "factor_geometries.csv")
    out: dict[int, dict[str, Any]] = {}
    for row in rows:
        gid = to_int(row.get("gid"))
        if gid is not None and row.get("status") == "ok":
            out[gid] = row
    return out


def load_sources_by_gid(paths: Any, max_source_panos: int) -> dict[int, list[dict[str, Any]]]:
    rows = read_csv_rows(paths.derived_root / "04_global_factors_refined" / "sources.csv")
    grouped: dict[int, dict[str, dict[str, Any]]] = defaultdict(dict)
    for row in rows:
        gid = to_int(row.get("gid"))
        panoid = row.get("panoid")
        if gid is None or not panoid:
            continue
        current = grouped[gid].get(panoid)
        pixels = to_int(row.get("n_pixels")) or 0
        if current is None or pixels > (to_int(current.get("n_pixels")) or 0):
            grouped[gid][panoid] = row

    out: dict[int, list[dict[str, Any]]] = {}
    for gid, by_panoid in grouped.items():
        values = sorted(
            by_panoid.values(),
            key=lambda r: (to_int(r.get("n_pixels")) or 0),
            reverse=True,
        )
        out[gid] = values[:max_source_panos] if max_source_panos > 0 else values
    return out


def load_batch_rows(test_root: Path, site: str, batch_id: str) -> dict[str, dict[str, Any]]:
    manifest_path = test_root / "data/raw/google_maps/temporal_batches" / site / batch_id / "manifest.json"
    if not manifest_path.exists():
        raise FileNotFoundError(f"Temporal batch manifest not found: {manifest_path}")
    manifest = read_json(manifest_path)
    rows = manifest.get("rows") or manifest.get("stacks") or []
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        panoid = row.get("panoid") or (row.get("target") or {}).get("panoid")
        stack_dir = row.get("stack_dir")
        if panoid and stack_dir:
            out[panoid] = row
    return out


def capture_year_month(capture_dir: Path) -> tuple[str | None, str | None]:
    match = DATE_CAPTURE_RE.match(capture_dir.name)
    if match:
        return f"{match.group(1)}-{match.group(2)}", match.group(3)
    meta_path = capture_dir / "meta.json"
    if meta_path.exists():
        try:
            meta = read_json(meta_path)
            ym = meta.get("capture_year_month")
            if isinstance(ym, list) and len(ym) >= 2:
                year_month = f"{int(ym[0]):04d}-{int(ym[1]):02d}"
            else:
                year_month = None
            panoid = meta.get("panoid_returned")
            return year_month, panoid
        except Exception:
            pass
    return None, None


def capture_jpg_path(capture_dir: Path, panoid: str) -> Path | None:
    direct = capture_dir / "panoramas" / f"{panoid}.jpg"
    if direct.exists():
        return direct
    jpgs = sorted((capture_dir / "panoramas").glob("*.jpg"))
    return jpgs[0] if jpgs else None


def load_capture_records(
    test_root: Path,
    spatial_ref: tuple[float, float],
    batch_rows: dict[str, dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    ref_lat, ref_lng = spatial_ref
    by_anchor: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for anchor_panoid, row in batch_rows.items():
        stack_rel = row.get("stack_dir")
        if not stack_rel:
            continue
        stack_dir = test_root / stack_rel
        if not stack_dir.exists():
            continue
        stack_id = stack_dir.name
        for capture_dir in sorted((stack_dir / "captures").glob("*")):
            if not capture_dir.is_dir():
                continue
            parsed_path = capture_dir / "parsed.json"
            if not parsed_path.exists():
                continue
            year_month, capture_panoid = capture_year_month(capture_dir)
            if not capture_panoid:
                rec = dfs.parse_temporal_photometa(parsed_path)
                capture_panoid = rec.get("panoid") if rec else None
            if not year_month or not capture_panoid:
                continue
            jpg_path = capture_jpg_path(capture_dir, capture_panoid)
            if jpg_path is None:
                continue
            lat = lng = None
            meta_path = capture_dir / "pointcloud_meta.json"
            if meta_path.exists():
                try:
                    meta = read_json(meta_path)
                    panos = meta.get("panos") or []
                    if panos:
                        lat = to_float(panos[0].get("lat"))
                        lng = to_float(panos[0].get("lng"))
                except Exception:
                    pass
            if lat is None or lng is None:
                lat, lng = extract_lat_lng(parsed_path)
            if lat is None or lng is None:
                continue
            east, north = latlng_to_local(ref_lat, ref_lng, float(lat), float(lng))
            by_anchor[anchor_panoid].append(
                {
                    "anchor_panoid": anchor_panoid,
                    "stack_id": stack_id,
                    "stack_dir": stack_dir,
                    "capture_dir": capture_dir,
                    "capture_id": capture_dir.name,
                    "year_month": year_month,
                    "capture_panoid": capture_panoid,
                    "parsed_path": parsed_path,
                    "jpg_path": jpg_path,
                    "lat": float(lat),
                    "lng": float(lng),
                    "camera_pos": np.array([east, north, 0.0], dtype=np.float64),
                }
            )
    return by_anchor


def load_atlas(paths: Any, gid: int) -> dict[str, Any] | None:
    path = paths.derived_root / "06_surface_stitching" / "atlases" / f"gid_{gid:04d}_pixel_fusion_atlas.json"
    if not path.exists():
        return None
    data = read_json(path)
    data["_path"] = path
    return data


def atlas_world_grid(atlas: dict[str, Any], max_side: int) -> tuple[np.ndarray, dict[str, Any]]:
    basis = atlas["basis"]
    bbox = atlas["atlas_bbox_m"]
    texture_w, texture_h = [int(v) for v in atlas["texture_size"]]
    scale = min(1.0, max_side / max(texture_w, texture_h)) if max_side > 0 else 1.0
    tex_w = max(24, int(round(texture_w * scale)))
    tex_h = max(24, int(round(texture_h * scale)))

    u_axis = np.array(basis["u_axis"], dtype=np.float64)
    v_axis = np.array(basis["v_axis"], dtype=np.float64)
    n_axis = np.array(basis["normal"], dtype=np.float64)
    n_axis = n_axis / max(np.linalg.norm(n_axis), 1e-8)
    plane_offset = float(basis["normal_offset_m"])
    u_min = float(bbox["u_min"])
    u_max = float(bbox["u_max"])
    v_min = float(bbox["v_min"])
    v_max = float(bbox["v_max"])

    u_coords = u_min + (np.arange(tex_w, dtype=np.float64) + 0.5) / tex_w * (u_max - u_min)
    v_coords = v_max - (np.arange(tex_h, dtype=np.float64) + 0.5) / tex_h * (v_max - v_min)
    uu, vv = np.meshgrid(u_coords, v_coords)
    world_grid = (
        uu[..., None] * u_axis[None, None, :]
        + vv[..., None] * v_axis[None, None, :]
        + plane_offset * n_axis[None, None, :]
    )
    meta = {
        "texture_width": tex_w,
        "texture_height": tex_h,
        "u_axis": u_axis,
        "v_axis": v_axis,
        "normal": n_axis,
        "normal_offset_m": plane_offset,
        "u_min": u_min,
        "u_max": u_max,
        "v_min": v_min,
        "v_max": v_max,
    }
    return world_grid, meta


def plane_class_from_normal(normal: np.ndarray) -> str:
    return dfs.classify_from_normal(float(normal[0]), float(normal[1]), float(normal[2]))


def evaluate_temporal_capture(
    *,
    factor: dict[str, Any],
    atlas: dict[str, Any],
    atlas_meta: dict[str, Any],
    world_grid: np.ndarray,
    capture: dict[str, Any],
    out_dirs: dict[str, Path],
    paths: Any,
    test_root: Path,
    batch_id: str,
    thresholds: dict[str, float],
    save_image: bool,
) -> dict[str, Any]:
    gid = int(factor["gid"])
    rec = dfs.parse_temporal_photometa(capture["parsed_path"])
    if rec is None:
        return empty_observation(factor, capture, paths, batch_id, "missing_geometry", "photometa_parse_failed")
    image = Image.open(capture["jpg_path"]).convert("RGB")
    image_arr = np.asarray(image)
    image_w, image_h = image.size

    rotation = build_rotation(rec["heading_deg"], rec["pitch_deg"], rec["roll_deg"])
    local_vecs = np.einsum(
        "ij,hwj->hwi",
        rotation.T,
        world_grid - capture["camera_pos"][None, None, :],
        optimize=True,
    )
    idx_col, idx_row, x_img, y_img = dfs.local_vectors_to_equirect(local_vecs, (image_w, image_h))
    row_ok = (idx_row >= 0) & (idx_row < IDX_H)
    if not row_ok.any():
        return empty_observation(factor, capture, paths, batch_id, "outside_projection", "atlas_projects_outside_indexmap")

    idx_map = rec["idxmap"]
    row_clip = np.clip(idx_row, 0, IDX_H - 1)
    visible_planes = idx_map[row_clip[row_ok], idx_col[row_ok]]
    visible_planes = visible_planes[visible_planes > 0]
    if visible_planes.size == 0:
        return empty_observation(factor, capture, paths, batch_id, "no_support", "no_positive_indexmap_plane")

    values, counts = np.unique(visible_planes, return_counts=True)
    best_i = int(np.argmax(counts))
    local_idx = int(values[best_i])
    support_ok = row_ok & (idx_map[row_clip, idx_col] == local_idx)
    valid_pixels = int(support_ok.sum())
    valid_fraction = float(valid_pixels / support_ok.size)
    dominant_fraction = float(counts[best_i] / max(1, visible_planes.size))

    temporal_plane = np.asarray(rec["planes"][local_idx], dtype=np.float64)
    temporal_normal_world = temporal_plane[:3] @ rotation.T
    temporal_normal_world = temporal_normal_world / max(float(np.linalg.norm(temporal_normal_world)), 1e-8)
    temporal_d_global = float(temporal_plane[3] + np.dot(temporal_normal_world, capture["camera_pos"]))
    factor_normal = np.array(
        [float(factor.get("nx") or 0.0), float(factor.get("ny") or 0.0), float(factor.get("nz") or 0.0)],
        dtype=np.float64,
    )
    factor_normal = factor_normal / max(float(np.linalg.norm(factor_normal)), 1e-8)
    normal_angle = dfs.vector_angle_deg(factor_normal, temporal_normal_world, use_abs=True)
    offset_residual = abs(float(factor.get("d_global") or 0.0) - temporal_d_global)
    centroid = np.array(
        [
            float(factor.get("centroid_x") or 0.0),
            float(factor.get("centroid_y") or 0.0),
            float(factor.get("centroid_z") or 0.0),
        ],
        dtype=np.float64,
    )
    distance_m = float(np.linalg.norm(centroid - capture["camera_pos"]))
    temporal_class = plane_class_from_normal(temporal_normal_world)

    reasons: list[str] = []
    if valid_fraction < thresholds["min_valid_fraction"]:
        reasons.append("low_coverage")
    if dominant_fraction < thresholds["min_dominance"]:
        reasons.append("weak_dominant_plane")
    if normal_angle is None or normal_angle > thresholds["max_normal_angle_deg"]:
        reasons.append("normal_mismatch")
    if offset_residual > thresholds["max_offset_residual_m"]:
        reasons.append("offset_mismatch")
    factor_class = factor.get("class")
    if factor_class in {"ground", "facade", "roof"} and temporal_class != factor_class:
        reasons.append("class_mismatch")
    keep = not reasons
    status = "ok" if keep else "reject"
    reason = ";".join(reasons) if reasons else "accepted"

    rectified_rel = None
    mask_rel = None
    if save_image and (keep or valid_fraction >= thresholds["save_min_valid_fraction"]):
        sampled = dfs.image_sample_rgb(image_arr, x_img, y_img).astype(np.uint8)
        rectified = np.full((*support_ok.shape, 3), 238, dtype=np.uint8)
        rectified[support_ok] = sampled[support_ok]
        if not keep:
            tint = np.array([245, 232, 214], dtype=np.uint8)
            rectified[~support_ok] = tint
        observation_id = temporal_observation_id(gid, capture, local_idx)
        factor_dir = out_dirs["rectified"] / f"gid_{gid:04d}"
        mask_dir = factor_dir / "masks"
        factor_dir.mkdir(parents=True, exist_ok=True)
        mask_dir.mkdir(parents=True, exist_ok=True)
        rectified_path = factor_dir / f"{observation_id}.jpg"
        mask_path = mask_dir / f"{observation_id}_mask.png"
        Image.fromarray(rectified).save(rectified_path, quality=92)
        Image.fromarray((support_ok.astype(np.uint8) * 255)).save(mask_path)
        rectified_rel = rel_path(rectified_path, test_root)
        mask_rel = rel_path(mask_path, test_root)

    return {
        "temporal_observation_id": temporal_observation_id(gid, capture, local_idx),
        "workspace_id": paths.workspace_id,
        "batch_id": batch_id,
        "gid": gid,
        "factor_class": factor_class,
        "anchor_panoid": capture["anchor_panoid"],
        "stack_id": capture["stack_id"],
        "capture_id": capture["capture_id"],
        "year_month": capture["year_month"],
        "capture_panoid": capture["capture_panoid"],
        "capture_lat": capture["lat"],
        "capture_lng": capture["lng"],
        "camera_east_m": float(capture["camera_pos"][0]),
        "camera_north_m": float(capture["camera_pos"][1]),
        "dominant_local_plane_id": local_idx,
        "temporal_plane_class": temporal_class,
        "valid_pixel_count": valid_pixels,
        "valid_fraction": valid_fraction,
        "dominant_fraction": dominant_fraction,
        "normal_angle_deg": normal_angle,
        "offset_residual_m": offset_residual,
        "distance_m": distance_m,
        "keep": keep,
        "status": status,
        "reason": reason,
        "rectified_path": rectified_rel,
        "mask_path": mask_rel,
        "atlas_json_path": rel_path(Path(atlas["_path"]), test_root),
        "atlas_width": atlas_meta["texture_width"],
        "atlas_height": atlas_meta["texture_height"],
    }


def temporal_observation_id(gid: int, capture: dict[str, Any], local_idx: int | None) -> str:
    plane_part = "none" if local_idx is None else str(local_idx)
    return f"gid_{gid:04d}_{capture['anchor_panoid']}_{capture['year_month']}_{capture['capture_panoid']}_{plane_part}"


def empty_observation(
    factor: dict[str, Any],
    capture: dict[str, Any],
    paths: Any,
    batch_id: str,
    status: str,
    reason: str,
) -> dict[str, Any]:
    gid = int(factor["gid"])
    return {
        "temporal_observation_id": temporal_observation_id(gid, capture, None),
        "workspace_id": paths.workspace_id,
        "batch_id": batch_id,
        "gid": gid,
        "factor_class": factor.get("class"),
        "anchor_panoid": capture["anchor_panoid"],
        "stack_id": capture["stack_id"],
        "capture_id": capture["capture_id"],
        "year_month": capture["year_month"],
        "capture_panoid": capture["capture_panoid"],
        "capture_lat": capture["lat"],
        "capture_lng": capture["lng"],
        "camera_east_m": float(capture["camera_pos"][0]),
        "camera_north_m": float(capture["camera_pos"][1]),
        "dominant_local_plane_id": None,
        "temporal_plane_class": None,
        "valid_pixel_count": 0,
        "valid_fraction": 0.0,
        "dominant_fraction": 0.0,
        "normal_angle_deg": None,
        "offset_residual_m": None,
        "distance_m": None,
        "keep": False,
        "status": status,
        "reason": reason,
        "rectified_path": None,
        "mask_path": None,
        "atlas_json_path": None,
    }


def correspondence_row(row: dict[str, Any], out_csv: Path, test_root: Path) -> dict[str, Any]:
    transform = {
        "method": "world_factor_atlas_to_temporal_pano_plane_projection",
        "dominant_local_plane_id": row.get("dominant_local_plane_id"),
        "normal_angle_deg": row.get("normal_angle_deg"),
        "offset_residual_m": row.get("offset_residual_m"),
        "valid_fraction": row.get("valid_fraction"),
        "dominant_fraction": row.get("dominant_fraction"),
        "atlas_json_path": row.get("atlas_json_path"),
    }
    return {
        "correspondence_id": row["temporal_observation_id"],
        "workspace_id": row["workspace_id"],
        "gid": row["gid"],
        "factor_local_plane_id": row.get("dominant_local_plane_id"),
        "anchor_panoid": row["anchor_panoid"],
        "stack_id": row["stack_id"],
        "year_month": row["year_month"],
        "source_panoid": row["anchor_panoid"],
        "matched_panoid": row["capture_panoid"],
        "transform_json": json.dumps(transform, sort_keys=True),
        "residual_m": row.get("offset_residual_m"),
        "residual_px": None,
        "keep": row.get("keep"),
        "status": row.get("status"),
        "reason": row.get("reason"),
        "crop_path": row.get("rectified_path"),
        "overlay_path": row.get("mask_path"),
        "correspondence_path": rel_path(out_csv, test_root),
    }


def select_factors(
    factors: dict[int, dict[str, Any]],
    sources_by_gid: dict[int, list[dict[str, Any]]],
    class_filter: set[str],
    max_factors: int,
    gid_list: list[int] | None = None,
) -> list[dict[str, Any]]:
    if gid_list:
        order = {gid: index for index, gid in enumerate(gid_list)}
        candidates = [
            factors[gid] for gid in gid_list
            if gid in factors and sources_by_gid.get(gid) and (not class_filter or factors[gid].get("class") in class_filter)
        ]
        candidates.sort(key=lambda r: order.get(int(r["gid"]), len(order)))
    else:
        candidates = [
            row for gid, row in factors.items()
            if sources_by_gid.get(gid) and (not class_filter or row.get("class") in class_filter)
        ]
        candidates.sort(
            key=lambda r: (
                0 if r.get("class") == "ground" else 1,
                to_int(r.get("source_count")) or 0,
                to_float(r.get("area_estimate_m2")) or 0.0,
            ),
            reverse=True,
        )
    if max_factors > 0:
        candidates = candidates[:max_factors]
    return candidates


def parse_gid_list(value: str | None) -> list[int] | None:
    if not value:
        return None
    path = Path(value)
    if path.exists():
        text = path.read_text()
    else:
        text = value
    gids: list[int] = []
    for part in re.split(r"[\s,]+", text.strip()):
        if not part:
            continue
        gid = to_int(part)
        if gid is not None:
            gids.append(gid)
    return gids or None


def make_spacetime_panels(
    *,
    rows: list[dict[str, Any]],
    factors: list[dict[str, Any]],
    sources_by_gid: dict[int, list[dict[str, Any]]],
    test_root: Path,
    out_dir: Path,
    overview_factor_count: int,
    cell_size: tuple[int, int],
) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    years = sorted({str(r["year_month"])[:4] for r in rows if r.get("year_month")})
    rows_by_key: dict[tuple[int, str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        gid = to_int(row.get("gid"))
        if gid is None:
            continue
        year = str(row.get("year_month") or "")[:4]
        anchor = str(row.get("anchor_panoid") or "")
        rows_by_key[(gid, anchor, year)].append(row)

    paths: list[Path] = []
    for factor in factors[:overview_factor_count]:
        gid = int(factor["gid"])
        source_panos = [str(r.get("panoid")) for r in sources_by_gid.get(gid, []) if r.get("panoid")]
        if not source_panos or not years:
            continue
        path = draw_spacetime_panel(
            gid=gid,
            factor=factor,
            source_panos=source_panos,
            years=years,
            rows_by_key=rows_by_key,
            test_root=test_root,
            out_dir=out_dir,
            cell_size=cell_size,
        )
        paths.append(path)
    return paths


def best_row_for_cell(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not rows:
        return None
    return sorted(
        rows,
        key=lambda r: (
            bool_value(r.get("keep")),
            to_float(r.get("valid_fraction")) or 0.0,
            -(to_float(r.get("offset_residual_m")) or 999.0),
        ),
        reverse=True,
    )[0]


def bool_value(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).lower() in {"true", "1", "yes", "y"}


def draw_spacetime_panel(
    *,
    gid: int,
    factor: dict[str, Any],
    source_panos: list[str],
    years: list[str],
    rows_by_key: dict[tuple[int, str, str], list[dict[str, Any]]],
    test_root: Path,
    out_dir: Path,
    cell_size: tuple[int, int],
) -> Path:
    cell_w, cell_h = cell_size
    label_w = 150
    header_h = 56
    title_h = 44
    pad = 8
    width = label_w + len(years) * cell_w + pad * 2
    height = title_h + header_h + len(source_panos) * cell_h + pad * 2
    canvas = Image.new("RGB", (width, height), (250, 250, 250))
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.load_default()
    draw.text((pad, pad), f"gid {gid:04d} | {factor.get('class')} | space x time rectified candidates", fill=(20, 20, 20), font=font)

    for col, year in enumerate(years):
        x = label_w + col * cell_w + pad
        draw.text((x + 4, title_h + 18), year, fill=(45, 45, 45), font=font)
    for row_i, panoid in enumerate(source_panos):
        y = title_h + header_h + row_i * cell_h + pad
        draw.text((pad, y + 6), panoid[:18], fill=(45, 45, 45), font=font)
        for col, year in enumerate(years):
            x = label_w + col * cell_w + pad
            cell_box = (x, y, x + cell_w - 4, y + cell_h - 4)
            draw.rectangle(cell_box, outline=(210, 210, 210), fill=(236, 236, 236))
            row = best_row_for_cell(rows_by_key.get((gid, panoid, year), []))
            if row is None:
                draw.text((x + 5, y + 5), "missing", fill=(150, 150, 150), font=font)
                continue
            rect_path = row.get("rectified_path")
            if rect_path:
                img_path = test_root / str(rect_path)
                if img_path.exists():
                    thumb = Image.open(img_path).convert("RGB")
                    thumb.thumbnail((cell_w - 8, cell_h - 24), Image.Resampling.LANCZOS)
                    px = x + max(4, (cell_w - thumb.width) // 2)
                    py = y + 4
                    canvas.paste(thumb, (px, py))
            status_color = (18, 130, 72) if bool_value(row.get("keep")) else (187, 94, 36)
            draw.rectangle((x, y + cell_h - 18, x + cell_w - 4, y + cell_h - 4), fill=(255, 255, 255))
            vf = to_float(row.get("valid_fraction")) or 0.0
            off = to_float(row.get("offset_residual_m"))
            label = f"{'ok' if bool_value(row.get('keep')) else 'rej'} v={vf:.2f}"
            if off is not None:
                label += f" d={off:.1f}"
            draw.text((x + 4, y + cell_h - 17), label, fill=status_color, font=font)

    path = out_dir / f"gid_{gid:04d}_spacetime_grid.png"
    canvas.save(path)
    return path


def write_index(
    out_root: Path,
    rows: list[dict[str, Any]],
    panel_paths: list[Path],
    test_root: Path,
    args: argparse.Namespace,
) -> None:
    kept = sum(1 for r in rows if bool_value(r.get("keep")))
    text = [
        "# Temporal Factor Surface Candidates",
        "",
        "This diagnostic projects historical panorama JPGs onto the existing world-factor atlas.",
        "",
        f"- batch_id: `{args.temporal_batch_id}`",
        f"- candidate rows: {len(rows)}",
        f"- accepted rows: {kept}",
        f"- atlas max side: {args.atlas_max_side}px",
        f"- max source panos per factor: {args.max_source_panos_per_factor}",
        "",
        "## Files",
        "",
        "- `temporal_rectified_observations.csv`: one row per projected temporal candidate.",
        "- `temporal_factor_correspondences.csv`: catalog-compatible correspondence manifest.",
        "- `spacetime_grids/`: row = current source pano, column = capture year.",
        "",
        "## Example Panels",
        "",
    ]
    for path in panel_paths:
        text.append(f"- [{path.name}]({rel_path(path, test_root)})")
    (out_root / "index.md").write_text("\n".join(text) + "\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    add_spatial_args(parser)
    parser.add_argument("--temporal-batch-id", required=True, help="Batch id under data/raw/google_maps/temporal_batches/<site>/")
    parser.add_argument("--out-root", type=Path, default=None, help="Output root for 07 temporal surface comparison")
    parser.add_argument("--max-factors", type=int, default=80, help="Limit factors for a first pass; 0 means all")
    parser.add_argument("--gid-list", default=None, help="Comma-separated gid list, or a text file with one gid per line")
    parser.add_argument("--class-filter", default="facade,oblique", help="Comma-separated factor classes; empty means all")
    parser.add_argument("--max-source-panos-per-factor", type=int, default=4)
    parser.add_argument("--atlas-max-side", type=int, default=192)
    parser.add_argument("--overview-factors", type=int, default=24)
    parser.add_argument("--max-distance-m", type=float, default=90.0)
    parser.add_argument("--min-valid-fraction", type=float, default=0.015)
    parser.add_argument("--save-min-valid-fraction", type=float, default=0.006)
    parser.add_argument("--min-dominance", type=float, default=0.35)
    parser.add_argument("--max-normal-angle-deg", type=float, default=22.0)
    parser.add_argument("--max-offset-residual-m", type=float, default=7.0)
    parser.add_argument("--panel-cell-width", type=int, default=126)
    parser.add_argument("--panel-cell-height", type=int, default=100)
    parser.add_argument("--no-images", action="store_true", help="Write manifests only")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    paths = resolve_spatial_paths(args)
    test_root = Path(args.test_root).resolve()
    out_root = (
        Path(args.out_root).resolve()
        if args.out_root
        else paths.derived_root / "07_temporal_surface_comparison" / "batches" / args.temporal_batch_id
    )
    rectified_dir = out_root / "rectified_observations"
    panel_dir = out_root / "spacetime_grids"
    out_root.mkdir(parents=True, exist_ok=True)

    class_filter = {v.strip() for v in args.class_filter.split(",") if v.strip()}
    factors_by_gid = load_factor_geometries(paths)
    sources_by_gid = load_sources_by_gid(paths, args.max_source_panos_per_factor)
    factors = select_factors(factors_by_gid, sources_by_gid, class_filter, args.max_factors, parse_gid_list(args.gid_list))
    batch_rows = load_batch_rows(test_root, paths.site, args.temporal_batch_id)
    capture_by_anchor = load_capture_records(test_root, load_spatial_reference(paths), batch_rows)
    thresholds = {
        "min_valid_fraction": float(args.min_valid_fraction),
        "save_min_valid_fraction": float(args.save_min_valid_fraction),
        "min_dominance": float(args.min_dominance),
        "max_normal_angle_deg": float(args.max_normal_angle_deg),
        "max_offset_residual_m": float(args.max_offset_residual_m),
    }

    print(f"Factors selected: {len(factors)}")
    print(f"Temporal anchors with captures: {sum(1 for v in capture_by_anchor.values() if v)}")
    all_rows: list[dict[str, Any]] = []
    out_dirs = {"rectified": rectified_dir}

    for index, factor in enumerate(factors, 1):
        gid = int(factor["gid"])
        atlas = load_atlas(paths, gid)
        if atlas is None:
            continue
        world_grid, atlas_meta = atlas_world_grid(atlas, args.atlas_max_side)
        source_panos = [row.get("panoid") for row in sources_by_gid.get(gid, []) if row.get("panoid")]
        factor_rows = 0
        centroid = np.array(
            [
                float(factor.get("centroid_x") or 0.0),
                float(factor.get("centroid_y") or 0.0),
                float(factor.get("centroid_z") or 0.0),
            ],
            dtype=np.float64,
        )
        for anchor in source_panos:
            for capture in capture_by_anchor.get(str(anchor), []):
                distance = float(np.linalg.norm(centroid - capture["camera_pos"]))
                if args.max_distance_m > 0 and distance > args.max_distance_m:
                    continue
                row = evaluate_temporal_capture(
                    factor=factor,
                    atlas=atlas,
                    atlas_meta=atlas_meta,
                    world_grid=world_grid,
                    capture=capture,
                    out_dirs=out_dirs,
                    paths=paths,
                    test_root=test_root,
                    batch_id=args.temporal_batch_id,
                    thresholds=thresholds,
                    save_image=not args.no_images,
                )
                all_rows.append(row)
                factor_rows += 1
        if index == 1 or index % 10 == 0:
            print(f"  processed {index}/{len(factors)} factors; rows={len(all_rows)}")
        if factor_rows == 0:
            continue

    observations_csv = out_root / "temporal_rectified_observations.csv"
    correspondences_csv = out_root / "temporal_factor_correspondences.csv"
    write_csv(observations_csv, all_rows, CAPTURE_COLUMNS)
    correspondence_rows = [correspondence_row(row, correspondences_csv, test_root) for row in all_rows]
    write_csv(correspondences_csv, correspondence_rows, CORRESPONDENCE_COLUMNS)

    panel_paths = make_spacetime_panels(
        rows=all_rows,
        factors=factors,
        sources_by_gid=sources_by_gid,
        test_root=test_root,
        out_dir=panel_dir,
        overview_factor_count=args.overview_factors,
        cell_size=(args.panel_cell_width, args.panel_cell_height),
    )
    write_index(out_root, all_rows, panel_paths, test_root, args)
    summary = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "workspace_id": paths.workspace_id,
        "batch_id": args.temporal_batch_id,
        "factor_count": len(factors),
        "candidate_rows": len(all_rows),
        "accepted_rows": sum(1 for row in all_rows if bool_value(row.get("keep"))),
        "observation_csv": rel_path(observations_csv, test_root),
        "correspondence_csv": rel_path(correspondences_csv, test_root),
        "panel_count": len(panel_paths),
        "thresholds": thresholds,
    }
    (out_root / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True))
    print(json.dumps(summary, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
