#!/usr/bin/env python3
"""Derive reusable world-factor geometry and first-pass surface products.

This stage turns the refined plane registry into geometry objects with
traceable local supports, 3D boundary summaries, visibility/completeness rows,
surface crop examples, stitch contact sheets, and temporal correspondence rows.
Large raster/array data is written as files; DuckDB later indexes the manifest
CSVs produced here.
"""

from __future__ import annotations

import argparse
import base64
import csv
import json
import math
import struct
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw

try:
    import cv2  # type: ignore
except Exception:  # pragma: no cover - fallback is used only in minimal envs.
    cv2 = None

try:
    from scipy.spatial import ConvexHull  # type: ignore
except Exception:  # pragma: no cover
    ConvexHull = None

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sv3d_paths import add_spatial_args, resolve_spatial_paths  # noqa: E402


IDX_H = 256
IDX_W = 512


def read_json(path: Path) -> Any:
    return json.loads(path.read_text())


def b64decode_lenient(text: str) -> bytes:
    text += "=" * ((4 - len(text) % 4) % 4)
    return base64.urlsafe_b64decode(text)


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


def rel_path(path: Path, root: Path) -> str:
    return path.resolve(strict=False).relative_to(root.resolve(strict=False)).as_posix()


def json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


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


def classify_from_normal(nx: float, ny: float, nz: float) -> str:
    norm = math.sqrt(nx * nx + ny * ny + nz * nz)
    if norm < 1e-6:
        return "sky"
    z = nz / norm
    if abs(z) > 0.85:
        return "ground" if z < 0 else "roof"
    if abs(z) < 0.2:
        return "facade"
    return "oblique"


def load_pointcloud_meta(paths: Any) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    meta_path = paths.depth_pointcloud_dir / "pointcloud_meta.json"
    meta = read_json(meta_path)
    panos: dict[str, dict[str, Any]] = {}
    for pano in meta.get("panos", []):
        panoid = pano.get("panoid")
        if panoid:
            panos[panoid] = pano
    return panos, meta


def load_indexmap(path: Path) -> np.ndarray | None:
    if not path.exists():
        return None
    arr = np.frombuffer(path.read_bytes(), dtype=np.uint8)
    if arr.size != IDX_H * IDX_W:
        return None
    return arr.reshape(IDX_H, IDX_W)


def plane_ray_points(cols: np.ndarray, rows: np.ndarray, plane: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    nx, ny, nz, d = [float(v) for v in plane]
    theta = (cols + 0.5) / IDX_W * 2.0 * math.pi - math.pi
    phi = math.pi / 2.0 - (rows + 0.5) / IDX_H * math.pi
    dirs = np.stack(
        [np.sin(theta) * np.cos(phi), np.cos(theta) * np.cos(phi), np.sin(phi)],
        axis=1,
    )
    denom = dirs @ np.array([nx, ny, nz], dtype=np.float64)
    with np.errstate(divide="ignore", invalid="ignore"):
        t = d / denom
    valid = np.isfinite(t) & (t > 0.0) & (t < 250.0)
    points = dirs[valid] * t[valid, None]
    return points, t[valid]


def contour_and_components(mask: np.ndarray, max_points: int) -> tuple[list[list[int]], int, int, float]:
    count = int(mask.sum())
    if count == 0:
        return [], 0, 0, 0.0
    if cv2 is None:
        ys, xs = np.where(mask)
        contour = [[int(xs.min()), int(ys.min())], [int(xs.max()), int(ys.min())],
                   [int(xs.max()), int(ys.max())], [int(xs.min()), int(ys.max())]]
        return contour, 1, count, 1.0

    mask_u8 = mask.astype(np.uint8)
    n_labels, _, stats, _ = cv2.connectedComponentsWithStats(mask_u8, 8)
    if n_labels <= 1:
        components = 0
        dominant = 0
    else:
        component_areas = stats[1:, cv2.CC_STAT_AREA]
        components = int(n_labels - 1)
        dominant = int(component_areas.max())

    contours, _ = cv2.findContours(mask_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        ys, xs = np.where(mask)
        contour = [[int(xs.min()), int(ys.min())], [int(xs.max()), int(ys.min())],
                   [int(xs.max()), int(ys.max())], [int(xs.min()), int(ys.max())]]
    else:
        largest = max(contours, key=cv2.contourArea).reshape(-1, 2)
        if largest.shape[0] > max_points:
            pick = np.linspace(0, largest.shape[0] - 1, max_points).astype(int)
            largest = largest[pick]
        contour = [[int(x), int(y)] for x, y in largest]
    ratio = float(dominant / count) if count else 0.0
    return contour, components, dominant, ratio


def projected_area(points: np.ndarray, normal: np.ndarray) -> float | None:
    if points.shape[0] < 3:
        return None
    axis = int(np.argmax(np.abs(normal)))
    projected = np.delete(points, axis, axis=1)
    if projected.shape[0] < 3:
        return None
    if ConvexHull is not None:
        try:
            return float(ConvexHull(projected).volume)
        except Exception:
            pass
    mins = projected.min(axis=0)
    maxs = projected.max(axis=0)
    return float(np.prod(maxs - mins))


def angular_error(a: float, b: float) -> float:
    return min((a - b) % 360.0, (b - a) % 360.0)


def vector_angle_deg(a: np.ndarray, b: np.ndarray, use_abs: bool = True) -> float | None:
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na < 1e-6 or nb < 1e-6:
        return None
    dot = float(np.dot(a, b) / (na * nb))
    if use_abs:
        dot = abs(dot)
    dot = max(-1.0, min(1.0, dot))
    return float(math.degrees(math.acos(dot)))


def scale_bbox_to_image(bbox: tuple[int, int, int, int], image_size: tuple[int, int], pad: int = 2) -> tuple[int, int, int, int]:
    c0, r0, c1, r1 = bbox
    w, h = image_size
    x0 = max(0, int(math.floor((c0 - pad) / IDX_W * w)))
    x1 = min(w, int(math.ceil((c1 + 1 + pad) / IDX_W * w)))
    y0 = max(0, int(math.floor((r0 - pad) / IDX_H * h)))
    y1 = min(h, int(math.ceil((r1 + 1 + pad) / IDX_H * h)))
    if x1 <= x0:
        x1 = min(w, x0 + 1)
    if y1 <= y0:
        y1 = min(h, y0 + 1)
    return x0, y0, x1, y1


def normalize_vec(vec: np.ndarray, fallback: np.ndarray | None = None) -> np.ndarray:
    norm = float(np.linalg.norm(vec))
    if norm < 1e-8:
        return np.array(fallback if fallback is not None else [1.0, 0.0, 0.0], dtype=np.float64)
    return vec.astype(np.float64) / norm


def factor_plane_basis(normal: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    n = normalize_vec(normal, np.array([0.0, 0.0, 1.0]))
    z = np.array([0.0, 0.0, 1.0], dtype=np.float64)
    if abs(float(np.dot(n, z))) > 0.85:
        u = np.array([1.0, 0.0, 0.0], dtype=np.float64)
    else:
        u = normalize_vec(np.cross(z, n), np.array([1.0, 0.0, 0.0]))
    v = normalize_vec(np.cross(n, u), np.array([0.0, 1.0, 0.0]))
    return u, v, n


def image_sample_rgb(image_arr: np.ndarray, x_map: np.ndarray, y_map: np.ndarray) -> np.ndarray:
    if cv2 is not None:
        return cv2.remap(
            image_arr,
            x_map.astype(np.float32),
            y_map.astype(np.float32),
            cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_WRAP,
        )
    h, w = image_arr.shape[:2]
    x = np.mod(np.rint(x_map).astype(np.int64), w)
    y = np.clip(np.rint(y_map).astype(np.int64), 0, h - 1)
    return image_arr[y, x]


def local_vectors_to_equirect(local_vecs: np.ndarray, image_size: tuple[int, int]) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    image_w, image_h = image_size
    x = local_vecs[..., 0]
    y = local_vecs[..., 1]
    z = local_vecs[..., 2]
    horiz = np.sqrt(x * x + y * y)
    theta = np.arctan2(x, y)
    phi = np.arctan2(z, horiz)
    idx_col = np.floor((theta + math.pi) / (2.0 * math.pi) * IDX_W).astype(np.int64) % IDX_W
    idx_row = np.floor((math.pi / 2.0 - phi) / math.pi * IDX_H).astype(np.int64)
    x_img = np.mod((theta + math.pi) / (2.0 * math.pi) * image_w, image_w).astype(np.float32)
    y_img = np.clip((math.pi / 2.0 - phi) / math.pi * image_h, 0, image_h - 1).astype(np.float32)
    return idx_col, idx_row, x_img, y_img


def alpha_bbox(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.where(mask)
    if xs.size == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def component_bbox_near(mask: np.ndarray, row: int, col: int, pad: int = 2) -> tuple[int, int, int, int] | None:
    if not mask.any():
        return None
    if cv2 is None:
        return alpha_bbox(mask)
    n_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    if n_labels <= 1:
        return None
    row = max(0, min(mask.shape[0] - 1, row))
    col = max(0, min(mask.shape[1] - 1, col))
    label = int(labels[row, col])
    if label == 0:
        ys, xs = np.where(mask)
        d2 = (ys - row) ** 2 + (xs - col) ** 2
        if d2.size == 0:
            return None
        nearest_idx = int(np.argmin(d2))
        label = int(labels[int(ys[nearest_idx]), int(xs[nearest_idx])])
    if label == 0:
        return alpha_bbox(mask)
    x = int(stats[label, cv2.CC_STAT_LEFT])
    y = int(stats[label, cv2.CC_STAT_TOP])
    w = int(stats[label, cv2.CC_STAT_WIDTH])
    h = int(stats[label, cv2.CC_STAT_HEIGHT])
    return (
        max(0, x - pad),
        max(0, y - pad),
        min(mask.shape[1] - 1, x + w - 1 + pad),
        min(mask.shape[0] - 1, y + h - 1 + pad),
    )


def derive_local_geometry(paths: Any, test_root: Path, max_boundary_points: int) -> dict[str, Any]:
    panos, _ = load_pointcloud_meta(paths)
    factor_geom_root = paths.derived_root / "04b_factor_geometry"
    support_dir = factor_geom_root / "supports"
    boundary_dir = factor_geom_root / "boundaries"
    support_dir.mkdir(parents=True, exist_ok=True)
    boundary_dir.mkdir(parents=True, exist_ok=True)

    support_rows: list[dict[str, Any]] = []
    boundary_rows: list[dict[str, Any]] = []
    support_by_key: dict[tuple[str, int], dict[str, Any]] = {}
    boundary_by_key: dict[tuple[str, int], dict[str, Any]] = {}
    boundary_points_by_key: dict[tuple[str, int], np.ndarray] = {}
    idx_by_panoid: dict[str, np.ndarray] = {}
    pano_geom_by_panoid: dict[str, dict[str, Any]] = {}

    for world_path in sorted(paths.planes_world_dir.glob("*_planes_world.json")):
        data = read_json(world_path)
        panoid = data["panoid"]
        pano = panos.get(panoid, {})
        pano_pos_raw = pano.get("world_pos") or [0.0, 0.0, 0.0]
        pano_pos = np.array([float(pano_pos_raw[0]), float(pano_pos_raw[1]), float(pano_pos_raw[2])], dtype=np.float64)
        rotation = np.array(data.get("rotation_matrix_local_to_world"), dtype=np.float64)
        local_planes = np.array(data.get("planes_local") or [], dtype=np.float64)
        world_planes = np.array(data.get("planes_world") or [], dtype=np.float64)
        pano_geom_by_panoid[panoid] = {
            "pano_pos": pano_pos,
            "rotation": rotation,
            "local_planes": local_planes,
            "world_planes": world_planes,
            "pose": data.get("pose") or {},
        }

        idx_path = paths.indexmap_rectified_dir / f"{panoid}_indexmap_local.bin"
        idx_map = load_indexmap(idx_path)
        if idx_map is None:
            continue
        idx_by_panoid[panoid] = idx_map

        mask_pack_path = support_dir / f"{panoid}_indexmap_masks.npz"
        np.savez_compressed(mask_pack_path, indexmap=idx_map)
        support_json_path = support_dir / f"{panoid}_support_summary.json"
        boundary_json_path = boundary_dir / f"{panoid}_boundary_points.json"

        support_json: dict[str, Any] = {"panoid": panoid, "planes": {}}
        boundary_json: dict[str, Any] = {"panoid": panoid, "planes": {}}

        for local_idx in range(local_planes.shape[0]):
            mask = idx_map == local_idx
            cell_count = int(mask.sum())
            if cell_count:
                ys, xs = np.where(mask)
                c0, c1 = int(xs.min()), int(xs.max())
                r0, r1 = int(ys.min()), int(ys.max())
                centroid_col = float(xs.mean())
                centroid_row = float(ys.mean())
            else:
                xs = ys = np.array([], dtype=np.int64)
                c0 = c1 = r0 = r1 = None
                centroid_col = centroid_row = None

            contour, components, dominant_cells, dominant_ratio = contour_and_components(mask, max_boundary_points)
            support_payload = {
                "local_plane_id": local_idx,
                "cell_count": cell_count,
                "bbox": [c0, r0, c1, r1],
                "centroid": [centroid_col, centroid_row],
                "connected_components": components,
                "dominant_component_cells": dominant_cells,
                "dominant_component_ratio": dominant_ratio,
                "contour": contour,
            }
            support_json["planes"][str(local_idx)] = support_payload

            support_row = {
                "workspace_id": paths.workspace_id,
                "site_id": paths.site,
                "run_id": paths.run_id,
                "panoid": panoid,
                "local_plane_id": local_idx,
                "cell_count": cell_count,
                "bbox_col_min": c0,
                "bbox_row_min": r0,
                "bbox_col_max": c1,
                "bbox_row_max": r1,
                "centroid_col": centroid_col,
                "centroid_row": centroid_row,
                "connected_components": components,
                "dominant_component_cells": dominant_cells,
                "dominant_component_ratio": dominant_ratio,
                "support_area_px": cell_count,
                "mask_path": rel_path(mask_pack_path, test_root),
                "contour_path": rel_path(support_json_path, test_root),
                "indexmap_path": rel_path(idx_path, test_root),
                "stage_path": rel_path(factor_geom_root, test_root),
            }
            support_rows.append(support_row)
            support_by_key[(panoid, local_idx)] = support_row

            local_plane = local_planes[local_idx]
            world_plane = world_planes[local_idx] if local_idx < world_planes.shape[0] else local_plane
            reason = None
            status = "ok"
            boundary_world = np.empty((0, 3), dtype=np.float64)
            distances = np.array([], dtype=np.float64)
            if cell_count == 0:
                status = "no_support"
                reason = "plane_id_not_present_in_indexmap"
            elif float(np.linalg.norm(local_plane[:3])) < 1e-6:
                status = "invalid_plane"
                reason = "zero_normal"
            else:
                if contour:
                    pts = np.array(contour, dtype=np.float64)
                    cols = pts[:, 0]
                    rows = pts[:, 1]
                else:
                    cols = xs.astype(np.float64)
                    rows = ys.astype(np.float64)
                    if cols.size > max_boundary_points:
                        pick = np.linspace(0, cols.size - 1, max_boundary_points).astype(int)
                        cols = cols[pick]
                        rows = rows[pick]
                local_points, distances = plane_ray_points(cols, rows, local_plane)
                if local_points.size:
                    boundary_world = (rotation @ local_points.T).T + pano_pos
                else:
                    status = "invalid_intersection"
                    reason = "no_positive_ray_plane_intersections"

            if boundary_world.shape[0]:
                centroid = boundary_world.mean(axis=0)
                mins = boundary_world.min(axis=0)
                maxs = boundary_world.max(axis=0)
                normal = np.array(world_plane[:3], dtype=np.float64)
                area = projected_area(boundary_world, normal)
                dist_min = float(np.min(distances)) if distances.size else None
                dist_med = float(np.median(distances)) if distances.size else None
                dist_max = float(np.max(distances)) if distances.size else None
                boundary_points_by_key[(panoid, local_idx)] = boundary_world
                boundary_json["planes"][str(local_idx)] = {
                    "local_plane_id": local_idx,
                    "points_world": boundary_world.round(4).tolist(),
                }
            else:
                centroid = np.array([None, None, None], dtype=object)
                mins = maxs = np.array([None, None, None], dtype=object)
                area = dist_min = dist_med = dist_max = None
                boundary_json["planes"][str(local_idx)] = {
                    "local_plane_id": local_idx,
                    "points_world": [],
                }

            boundary_row = {
                "workspace_id": paths.workspace_id,
                "site_id": paths.site,
                "run_id": paths.run_id,
                "panoid": panoid,
                "local_plane_id": local_idx,
                "valid_boundary_points": int(boundary_world.shape[0]),
                "centroid_x": None if centroid[0] is None else float(centroid[0]),
                "centroid_y": None if centroid[1] is None else float(centroid[1]),
                "centroid_z": None if centroid[2] is None else float(centroid[2]),
                "bbox_x_min": None if mins[0] is None else float(mins[0]),
                "bbox_y_min": None if mins[1] is None else float(mins[1]),
                "bbox_z_min": None if mins[2] is None else float(mins[2]),
                "bbox_x_max": None if maxs[0] is None else float(maxs[0]),
                "bbox_y_max": None if maxs[1] is None else float(maxs[1]),
                "bbox_z_max": None if maxs[2] is None else float(maxs[2]),
                "area_estimate_m2": area,
                "distance_min_m": dist_min,
                "distance_median_m": dist_med,
                "distance_max_m": dist_max,
                "boundary_points_path": rel_path(boundary_json_path, test_root),
                "support_path": rel_path(support_json_path, test_root),
                "status": status,
                "reason": reason,
            }
            boundary_rows.append(boundary_row)
            boundary_by_key[(panoid, local_idx)] = boundary_row

        support_json_path.write_text(json.dumps(support_json, indent=2, ensure_ascii=False))
        boundary_json_path.write_text(json.dumps(boundary_json, indent=2, ensure_ascii=False))

    columns_support = [
        "workspace_id", "site_id", "run_id", "panoid", "local_plane_id", "cell_count",
        "bbox_col_min", "bbox_row_min", "bbox_col_max", "bbox_row_max", "centroid_col",
        "centroid_row", "connected_components", "dominant_component_cells",
        "dominant_component_ratio", "support_area_px", "mask_path", "contour_path",
        "indexmap_path", "stage_path",
    ]
    columns_boundary = [
        "workspace_id", "site_id", "run_id", "panoid", "local_plane_id",
        "valid_boundary_points", "centroid_x", "centroid_y", "centroid_z",
        "bbox_x_min", "bbox_y_min", "bbox_z_min", "bbox_x_max", "bbox_y_max",
        "bbox_z_max", "area_estimate_m2", "distance_min_m", "distance_median_m",
        "distance_max_m", "boundary_points_path", "support_path", "status", "reason",
    ]
    write_csv(factor_geom_root / "local_plane_supports.csv", support_rows, columns_support)
    write_csv(factor_geom_root / "local_plane_boundaries_3d.csv", boundary_rows, columns_boundary)
    return {
        "panos": panos,
        "support_by_key": support_by_key,
        "boundary_by_key": boundary_by_key,
        "boundary_points_by_key": boundary_points_by_key,
        "idx_by_panoid": idx_by_panoid,
        "pano_geom_by_panoid": pano_geom_by_panoid,
        "factor_geom_root": factor_geom_root,
    }


def derive_factor_geometry_and_visibility(paths: Any, test_root: Path, local: dict[str, Any], max_visibility_distance: float) -> dict[str, Any]:
    factor_geom_root = local["factor_geom_root"]
    visibility_root = paths.derived_root / "04c_factor_visibility"
    visibility_root.mkdir(parents=True, exist_ok=True)
    geometry_dir = factor_geom_root / "factors"
    geometry_dir.mkdir(parents=True, exist_ok=True)

    registry = read_json(paths.global_factors_dir / "registry.json")
    registry_by_gid = {int(row["gid"]): row for row in registry.get("registry", [])}
    sources = read_csv_rows(paths.global_factors_dir / "sources.csv")
    sources_by_gid: dict[int, list[dict[str, str]]] = defaultdict(list)
    for source in sources:
        gid = to_int(source.get("gid"))
        if gid is not None:
            sources_by_gid[gid].append(source)

    panos = local["panos"]
    boundary_by_key = local["boundary_by_key"]
    support_by_key = local["support_by_key"]
    boundary_points_by_key = local["boundary_points_by_key"]

    factor_rows: list[dict[str, Any]] = []
    visibility_rows: list[dict[str, Any]] = []
    quality_rows: list[dict[str, Any]] = []
    factor_by_gid: dict[int, dict[str, Any]] = {}

    for gid, reg in sorted(registry_by_gid.items()):
        srcs = sources_by_gid.get(gid, [])
        points_parts: list[np.ndarray] = []
        source_centroids: list[np.ndarray] = []
        source_areas: list[float] = []
        for src in srcs:
            key = (src.get("panoid"), to_int(src.get("local_idx")) or -1)
            pts = boundary_points_by_key.get(key)
            b = boundary_by_key.get(key)
            if pts is not None and pts.size:
                points_parts.append(pts)
            if b and b.get("centroid_x") is not None and b.get("status") == "ok":
                source_centroids.append(np.array([b["centroid_x"], b["centroid_y"], b["centroid_z"]], dtype=np.float64))
                if b.get("area_estimate_m2") is not None:
                    source_areas.append(float(b["area_estimate_m2"]))

        cls = reg.get("classification")
        normal = np.array([float(reg.get("nx", 0.0)), float(reg.get("ny", 0.0)), float(reg.get("nz", 0.0))], dtype=np.float64)
        if points_parts:
            all_points = np.concatenate(points_parts, axis=0)
            centroid = all_points.mean(axis=0)
            mins = all_points.min(axis=0)
            maxs = all_points.max(axis=0)
            dims = np.sort(maxs - mins)[::-1]
            area = projected_area(all_points, normal)
            boundary_spread = float(np.max(np.linalg.norm(all_points - centroid[None, :], axis=1)))
            status = "ok"
        elif source_centroids:
            all_points = np.stack(source_centroids)
            centroid = all_points.mean(axis=0)
            mins = all_points.min(axis=0)
            maxs = all_points.max(axis=0)
            dims = np.sort(maxs - mins)[::-1]
            area = float(np.nanmax(source_areas)) if source_areas else None
            boundary_spread = float(np.max(np.linalg.norm(all_points - centroid[None, :], axis=1)))
            status = "centroid_only"
        else:
            centroid = np.array([None, None, None], dtype=object)
            mins = maxs = np.array([None, None, None], dtype=object)
            dims = np.array([None, None, None], dtype=object)
            area = boundary_spread = None
            status = "no_valid_boundary"

        geometry_type = "surface_polygon"
        if cls == "ground":
            geometry_type = "footprint"
        elif cls == "facade":
            geometry_type = "facade_segment"

        geom_path = geometry_dir / f"gid_{gid:04d}_geometry.json"
        geom_payload = {
            "gid": gid,
            "geometry_type": geometry_type,
            "class": cls,
            "centroid_world": [None if v is None else float(v) for v in centroid],
            "bbox_world": {
                "min": [None if v is None else float(v) for v in mins],
                "max": [None if v is None else float(v) for v in maxs],
            },
            "source_count": len(srcs),
            "status": status,
        }
        geom_path.write_text(json.dumps(geom_payload, indent=2, ensure_ascii=False))

        normal_spread_deg = None
        if reg.get("normal_consistency_min") is not None:
            c = max(-1.0, min(1.0, float(reg.get("normal_consistency_min"))))
            normal_spread_deg = float(math.degrees(math.acos(c)))
        uncertainty = None
        if reg.get("offset_std_m") is not None or reg.get("offset_spread_m") is not None:
            uncertainty = max(float(reg.get("offset_std_m") or 0.0), float(reg.get("offset_spread_m") or 0.0) / 2.0)

        factor_row = {
            "workspace_id": paths.workspace_id,
            "gid": gid,
            "geometry_type": geometry_type,
            "class": cls,
            "quality": reg.get("quality"),
            "source_count": len(srcs),
            "unique_pano_count": to_int(reg.get("n_unique_panos")),
            "centroid_x": None if centroid[0] is None else float(centroid[0]),
            "centroid_y": None if centroid[1] is None else float(centroid[1]),
            "centroid_z": None if centroid[2] is None else float(centroid[2]),
            "bbox_x_min": None if mins[0] is None else float(mins[0]),
            "bbox_y_min": None if mins[1] is None else float(mins[1]),
            "bbox_z_min": None if mins[2] is None else float(mins[2]),
            "bbox_x_max": None if maxs[0] is None else float(maxs[0]),
            "bbox_y_max": None if maxs[1] is None else float(maxs[1]),
            "bbox_z_max": None if maxs[2] is None else float(maxs[2]),
            "extent_major_m": None if dims[0] is None else float(dims[0]),
            "extent_minor_m": None if dims[1] is None else float(dims[1]),
            "area_estimate_m2": area,
            "nx": float(reg.get("nx")),
            "ny": float(reg.get("ny")),
            "nz": float(reg.get("nz")),
            "d_global": float(reg.get("d_global")),
            "uncertainty_m": uncertainty,
            "normal_spread_deg": normal_spread_deg,
            "offset_spread_m": to_float(reg.get("offset_spread_m")),
            "boundary_spread_m": boundary_spread,
            "geometry_path": rel_path(geom_path, test_root),
            "status": status,
        }
        factor_rows.append(factor_row)
        factor_by_gid[gid] = factor_row

        max_pixels = max((to_int(s.get("n_pixels")) or 0 for s in srcs), default=0)
        observed_by_pano = {s.get("panoid"): s for s in srcs}
        for source in srcs:
            panoid = source.get("panoid")
            local_idx = to_int(source.get("local_idx"))
            support = support_by_key.get((panoid, local_idx or -1), {})
            boundary = boundary_by_key.get((panoid, local_idx or -1), {})
            n_pixels = to_int(source.get("n_pixels")) or 0
            completeness = float(n_pixels / max_pixels) if max_pixels else 0.0
            pano_pos = np.array((panos.get(panoid, {}).get("world_pos") or [0.0, 0.0, 0.0]), dtype=np.float64)
            if factor_row["centroid_x"] is None:
                distance = view_angle = None
            else:
                vec = pano_pos - np.array([factor_row["centroid_x"], factor_row["centroid_y"], factor_row["centroid_z"]], dtype=np.float64)
                distance = float(np.linalg.norm(vec))
                view_angle = vector_angle_deg(normal, vec)
            purity = support.get("dominant_component_ratio")
            occlusion = max(0.0, 1.0 - completeness)
            usable = bool(completeness >= 0.15 and (purity is None or float(purity) >= 0.5) and (view_angle is None or view_angle <= 85.0))
            quality_rows.append(
                {
                    "workspace_id": paths.workspace_id,
                    "gid": gid,
                    "panoid": panoid,
                    "local_plane_id": local_idx,
                    "n_pixels": n_pixels,
                    "completeness_score": completeness,
                    "mask_purity_score": purity,
                    "view_angle_deg": view_angle,
                    "distance_m": distance,
                    "occlusion_score": occlusion,
                    "usable_for_completion": usable,
                    "quality_status": "usable" if usable else "low_quality",
                    "support_path": support.get("contour_path"),
                    "boundary_path": boundary.get("boundary_points_path"),
                }
            )

        visibility_json_path = visibility_root / "factor_visibility_candidates.csv"
        for panoid, pano in panos.items():
            pano_pos = np.array((pano.get("world_pos") or [0.0, 0.0, 0.0]), dtype=np.float64)
            observed = panoid in observed_by_pano
            source = observed_by_pano.get(panoid)
            if factor_row["centroid_x"] is None:
                distance = view_angle = None
                expected = False
                status_v = "unknown_geometry"
                reason = "factor_geometry_missing"
            else:
                centroid_vec = np.array([factor_row["centroid_x"], factor_row["centroid_y"], factor_row["centroid_z"]], dtype=np.float64)
                vec = pano_pos - centroid_vec
                distance = float(np.linalg.norm(vec))
                view_angle = vector_angle_deg(normal, vec)
                good_distance = distance <= max_visibility_distance
                good_angle = cls != "facade" or view_angle is None or view_angle <= 80.0
                expected = bool(good_distance and good_angle)
                if observed:
                    status_v = "observed"
                    reason = "source_observation_exists"
                elif not good_distance:
                    status_v = "too_far"
                    reason = "distance_threshold"
                elif not good_angle:
                    status_v = "bad_angle"
                    reason = "surface_normal_view_angle"
                else:
                    status_v = "expected_but_missing"
                    reason = "no_matching_local_plane"
            source_pixels = to_int(source.get("n_pixels")) if source else None
            source_local = to_int(source.get("local_idx")) if source else None
            completeness = float((source_pixels or 0) / max_pixels) if max_pixels and source_pixels is not None else None
            visibility_rows.append(
                {
                    "workspace_id": paths.workspace_id,
                    "gid": gid,
                    "panoid": panoid,
                    "status": status_v,
                    "reason": reason,
                    "is_observed": observed,
                    "expected_visible": expected,
                    "distance_m": distance,
                    "view_angle_deg": view_angle,
                    "source_local_plane_id": source_local,
                    "source_pixels": source_pixels,
                    "completeness_score": completeness,
                    "occlusion_score": None if completeness is None else max(0.0, 1.0 - completeness),
                    "visibility_path": rel_path(visibility_json_path, test_root),
                }
            )

    factor_columns = [
        "workspace_id", "gid", "geometry_type", "class", "quality", "source_count",
        "unique_pano_count", "centroid_x", "centroid_y", "centroid_z", "bbox_x_min",
        "bbox_y_min", "bbox_z_min", "bbox_x_max", "bbox_y_max", "bbox_z_max",
        "extent_major_m", "extent_minor_m", "area_estimate_m2", "nx", "ny", "nz",
        "d_global", "uncertainty_m", "normal_spread_deg", "offset_spread_m",
        "boundary_spread_m", "geometry_path", "status",
    ]
    visibility_columns = [
        "workspace_id", "gid", "panoid", "status", "reason", "is_observed",
        "expected_visible", "distance_m", "view_angle_deg", "source_local_plane_id",
        "source_pixels", "completeness_score", "occlusion_score", "visibility_path",
    ]
    quality_columns = [
        "workspace_id", "gid", "panoid", "local_plane_id", "n_pixels",
        "completeness_score", "mask_purity_score", "view_angle_deg", "distance_m",
        "occlusion_score", "usable_for_completion", "quality_status", "support_path",
        "boundary_path",
    ]
    write_csv(factor_geom_root / "factor_geometries.csv", factor_rows, factor_columns)
    write_csv(visibility_root / "factor_visibility_candidates.csv", visibility_rows, visibility_columns)
    write_csv(visibility_root / "factor_observation_quality.csv", quality_rows, quality_columns)
    return {
        "factor_by_gid": factor_by_gid,
        "visibility_rows": visibility_rows,
        "quality_rows": quality_rows,
        "sources_by_gid": sources_by_gid,
    }


def write_topdown_diagnostic(paths: Any, test_root: Path, local: dict[str, Any], factors: dict[str, Any]) -> Path | None:
    try:
        import matplotlib.pyplot as plt
    except Exception:
        return None

    factor_by_gid = factors["factor_by_gid"]
    visibility_by_gid: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in factors["visibility_rows"]:
        gid = to_int(row.get("gid"))
        if gid is not None:
            visibility_by_gid[gid].append(row)

    candidates = [
        row for row in factor_by_gid.values()
        if row.get("class") in {"facade", "ground"} and row.get("centroid_x") is not None
    ]
    candidates = sorted(candidates, key=lambda r: (int(r.get("source_count") or 0), float(r.get("area_estimate_m2") or 0.0)), reverse=True)[:10]
    if not candidates:
        return None

    out_dir = paths.diagnostics_root / "factor_geometry"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "topdown_factor_geometry_sample.png"
    panos = local["panos"]

    fig, axes = plt.subplots(5, 2, figsize=(12, 18), squeeze=False)
    for ax, factor in zip(axes.ravel(), candidates):
        gid = int(factor["gid"])
        px = [float(p.get("world_pos", [0, 0, 0])[0]) for p in panos.values()]
        py = [float(p.get("world_pos", [0, 0, 0])[1]) for p in panos.values()]
        ax.scatter(px, py, s=8, c="#b8b8b8", label="pano")

        vis = visibility_by_gid.get(gid, [])
        observed = [v for v in vis if str(v.get("status")) == "observed"]
        missing = [v for v in vis if str(v.get("status")) == "expected_but_missing"]
        too_far = [v for v in vis if str(v.get("status")) == "too_far"]
        for rows, color, label, size in [
            (too_far, "#d5d5d5", "too far", 7),
            (missing, "#f0a12a", "expected missing", 14),
            (observed, "#1b8a5a", "observed", 20),
        ]:
            xs = []
            ys = []
            for row in rows:
                pano = panos.get(row.get("panoid"))
                if pano:
                    pos = pano.get("world_pos", [0, 0, 0])
                    xs.append(float(pos[0]))
                    ys.append(float(pos[1]))
            if xs:
                ax.scatter(xs, ys, s=size, c=color, label=label)

        x0 = float(factor["bbox_x_min"])
        y0 = float(factor["bbox_y_min"])
        x1 = float(factor["bbox_x_max"])
        y1 = float(factor["bbox_y_max"])
        ax.plot([x0, x1, x1, x0, x0], [y0, y0, y1, y1, y0], c="#cc2f2f", lw=1.4)
        ax.scatter([float(factor["centroid_x"])], [float(factor["centroid_y"])], marker="x", c="#cc2f2f", s=35)
        ax.set_title(f"gid {gid} | {factor.get('class')} | sources {factor.get('source_count')}", fontsize=10)
        ax.set_aspect("equal", adjustable="box")
        ax.grid(alpha=0.2)
    for ax in axes.ravel()[len(candidates):]:
        ax.axis("off")
    handles, labels = axes.ravel()[0].get_legend_handles_labels()
    if handles:
        fig.legend(handles, labels, loc="lower center", ncol=4)
    fig.tight_layout(rect=(0, 0.03, 1, 1))
    fig.savefig(out_path, dpi=160)
    plt.close(fig)
    index_path = out_dir / "index.md"
    index_path.write_text(
        "# Factor Geometry Diagnostics\n\n"
        f"- `topdown_factor_geometry_sample.png`: sampled facade/ground factors with pano visibility status.\n"
    )
    return out_path


def fuse_factor_texture(
    paths: Any,
    test_root: Path,
    local: dict[str, Any],
    factor_row: dict[str, Any],
    gid: int,
    crops: list[dict[str, Any]],
    texture_dir: Path,
    contrib_dir: Path,
    atlas_dir: Path,
    rectified_dir: Path,
    stack_dir: Path,
    rectified_rows: list[dict[str, Any]],
    max_texture_side: int,
    px_per_meter: float,
) -> dict[str, Any] | None:
    boundary_points_by_key = local["boundary_points_by_key"]
    pano_geom_by_panoid = local["pano_geom_by_panoid"]
    idx_by_panoid = local["idx_by_panoid"]

    sources: list[dict[str, Any]] = []
    point_parts: list[np.ndarray] = []
    for crop in crops:
        panoid = crop.get("panoid")
        local_idx = to_int(crop.get("local_plane_id"))
        if panoid is None or local_idx is None:
            continue
        key = (panoid, local_idx)
        pts = boundary_points_by_key.get(key)
        geom = pano_geom_by_panoid.get(panoid)
        idx_map = idx_by_panoid.get(panoid)
        pano_path = paths.run_dir / "panoramas" / f"{panoid}.jpg"
        if pts is None or pts.size == 0 or geom is None or idx_map is None or not pano_path.exists():
            continue
        point_parts.append(pts)
        sources.append(
            {
                "crop": crop,
                "panoid": panoid,
                "local_plane_id": local_idx,
                "points": pts,
                "geom": geom,
                "idx_map": idx_map,
                "pano_path": pano_path,
            }
        )
    if not sources or not point_parts:
        return None

    normal = np.array(
        [
            float(factor_row.get("nx") or 0.0),
            float(factor_row.get("ny") or 0.0),
            float(factor_row.get("nz") or 0.0),
        ],
        dtype=np.float64,
    )
    u_axis, v_axis, n_axis = factor_plane_basis(normal)
    all_points = np.concatenate(point_parts, axis=0)
    u_vals = all_points @ u_axis
    v_vals = all_points @ v_axis
    plane_offset = float(np.median(all_points @ n_axis))
    pad_m = 0.15
    u_min, u_max = float(u_vals.min() - pad_m), float(u_vals.max() + pad_m)
    v_min, v_max = float(v_vals.min() - pad_m), float(v_vals.max() + pad_m)
    width_m = max(0.25, u_max - u_min)
    height_m = max(0.25, v_max - v_min)
    scale = min(px_per_meter, max_texture_side / max(width_m, height_m))
    scale = max(8.0, scale)
    tex_w = max(32, min(max_texture_side, int(math.ceil(width_m * scale))))
    tex_h = max(32, min(max_texture_side, int(math.ceil(height_m * scale))))

    u_coords = u_min + (np.arange(tex_w, dtype=np.float64) + 0.5) / scale
    v_coords = v_max - (np.arange(tex_h, dtype=np.float64) + 0.5) / scale
    uu, vv = np.meshgrid(u_coords, v_coords)
    world_grid = (
        uu[..., None] * u_axis[None, None, :]
        + vv[..., None] * v_axis[None, None, :]
        + plane_offset * n_axis[None, None, :]
    )

    rectified_images: list[np.ndarray] = []
    valid_masks: list[np.ndarray] = []
    source_weights: list[float] = []
    source_summaries: list[dict[str, Any]] = []
    stitch_id = f"gid_{gid:04d}_pixel_fusion"
    atlas_path = atlas_dir / f"{stitch_id}_atlas.json"
    rectified_factor_dir = rectified_dir / f"gid_{gid:04d}"
    rectified_mask_dir = rectified_factor_dir / "masks"
    rectified_factor_dir.mkdir(parents=True, exist_ok=True)
    rectified_mask_dir.mkdir(parents=True, exist_ok=True)
    created_at = datetime.now(timezone.utc).isoformat()

    for source_idx, source in enumerate(sources):
        crop = source["crop"]
        panoid = source["panoid"]
        local_idx = source["local_plane_id"]
        geom = source["geom"]
        idx_map = source["idx_map"]
        image = Image.open(source["pano_path"]).convert("RGB")
        image_arr = np.asarray(image)
        image_w, image_h = image.size

        local_vecs = np.einsum(
            "ij,hwj->hwi",
            np.asarray(geom["rotation"], dtype=np.float64).T,
            world_grid - np.asarray(geom["pano_pos"], dtype=np.float64)[None, None, :],
            optimize=True,
        )
        idx_col, idx_row, x_img, y_img = local_vectors_to_equirect(local_vecs, (image_w, image_h))
        row_ok = (idx_row >= 0) & (idx_row < IDX_H)
        row_clip = np.clip(idx_row, 0, IDX_H - 1)
        support_ok = row_ok & (idx_map[row_clip, idx_col] == local_idx)
        if not support_ok.any():
            source_summaries.append(
                {
                    "crop_id": crop["crop_id"],
                    "panoid": panoid,
                    "local_plane_id": local_idx,
                    "valid_pixels": 0,
                    "winning_pixels": 0,
                    "weight": 0.0,
                    "source_path": crop.get("crop_path"),
                }
            )
            continue

        sampled = image_sample_rgb(image_arr, x_img, y_img).astype(np.float32)
        purity = float(crop.get("purity_score") or 0.0)
        completeness = float(crop.get("completeness_score") or 0.0)
        base_weight = max(0.02, purity * completeness)

        rectified = np.full((tex_h, tex_w, 3), 238, dtype=np.uint8)
        rectified[support_ok] = np.clip(sampled[support_ok], 0, 255).astype(np.uint8)
        rectified_id = f"gid_{gid:04d}_{panoid}_{local_idx}_rectified"
        rectified_path = rectified_factor_dir / f"{rectified_id}.jpg"
        rectified_mask_path = rectified_mask_dir / f"{rectified_id}_mask.png"
        Image.fromarray(rectified).save(rectified_path, quality=92)
        Image.fromarray((support_ok.astype(np.uint8) * 255)).save(rectified_mask_path)

        rectified_images.append(rectified)
        valid_masks.append(support_ok)
        source_weights.append(float(base_weight))
        valid_fraction = float(support_ok.mean())
        rectified_rows.append(
            {
                "rectified_id": rectified_id,
                "workspace_id": paths.workspace_id,
                "gid": gid,
                "panoid": panoid,
                "local_plane_id": local_idx,
                "source_crop_id": crop["crop_id"],
                "rectified_path": rel_path(rectified_path, test_root),
                "mask_path": rel_path(rectified_mask_path, test_root),
                "atlas_json_path": rel_path(atlas_path, test_root),
                "source_crop_path": crop.get("crop_path"),
                "texture_width": tex_w,
                "texture_height": tex_h,
                "valid_pixel_count": int(support_ok.sum()),
                "valid_fraction": valid_fraction,
                "source_weight": float(base_weight),
                "status": "ok" if valid_fraction > 0.0 else "empty",
                "created_at": created_at,
            }
        )
        source_summaries.append(
            {
                "crop_id": crop["crop_id"],
                "panoid": panoid,
                "local_plane_id": local_idx,
                "valid_pixels": int(support_ok.sum()),
                "valid_fraction": valid_fraction,
                "winning_pixels": 0,
                "weight": float(base_weight),
                "source_path": crop.get("crop_path"),
                "rectified_path": rel_path(rectified_path, test_root),
                "rectified_mask_path": rel_path(rectified_mask_path, test_root),
            }
        )

    if not rectified_images:
        return None
    weight_stack = np.stack(
        [mask.astype(np.float32) * weight for mask, weight in zip(valid_masks, source_weights)],
        axis=0,
    )
    best_weight = weight_stack.max(axis=0)
    winner = weight_stack.argmax(axis=0).astype(np.int16)
    valid = best_weight > 0
    if not valid.any():
        return None
    texture = np.full((tex_h, tex_w, 3), 238, dtype=np.uint8)
    stack_rgb = np.stack(rectified_images, axis=0)
    yy, xx = np.indices((tex_h, tex_w))
    texture[valid] = stack_rgb[winner[valid], yy[valid], xx[valid]]
    coverage = float(valid.mean())
    for source_idx, summary in enumerate(source_summaries):
        summary["winning_pixels"] = int(((winner == source_idx) & valid).sum())
        summary["winning_fraction"] = float(summary["winning_pixels"] / max(1, int(valid.sum())))

    texture_path = texture_dir / f"{stitch_id}.jpg"
    contribution_path = contrib_dir / f"{stitch_id}.json"
    Image.fromarray(texture).save(texture_path, quality=94)

    stack_dir.mkdir(parents=True, exist_ok=True)
    stack_path = stack_dir / f"{stitch_id}_rectified_stack.jpg"
    thumbs: list[tuple[str, Image.Image]] = []
    for summary, rectified in zip(source_summaries, rectified_images):
        im = Image.fromarray(rectified)
        im.thumbnail((220, 160), Image.Resampling.LANCZOS)
        thumbs.append((f"{summary['panoid'][:10]} p{summary['local_plane_id']}", im.copy()))
    fused_thumb = Image.fromarray(texture)
    fused_thumb.thumbnail((220, 160), Image.Resampling.LANCZOS)
    thumbs.append(("fused best-source", fused_thumb.copy()))
    cell_w, cell_h, label_h = 240, 170, 24
    stack_gallery = Image.new("RGB", (cell_w * len(thumbs), cell_h + label_h), (248, 248, 248))
    draw = ImageDraw.Draw(stack_gallery)
    for i, (label, im) in enumerate(thumbs):
        x = i * cell_w
        stack_gallery.paste(im, (x + (cell_w - im.width) // 2, (cell_h - im.height) // 2))
        draw.text((x + 8, cell_h + 4), label, fill=(30, 30, 30))
    stack_gallery.save(stack_path, quality=92)

    atlas_payload = {
        "gid": gid,
        "basis": {
            "u_axis": u_axis.round(6).tolist(),
            "v_axis": v_axis.round(6).tolist(),
            "normal": n_axis.round(6).tolist(),
            "normal_offset_m": plane_offset,
        },
        "atlas_bbox_m": {"u_min": u_min, "u_max": u_max, "v_min": v_min, "v_max": v_max},
        "texture_size": [tex_w, tex_h],
        "px_per_meter": scale,
        "method": "world_plane_atlas_rectified_observation_stack",
    }
    atlas_path.write_text(json.dumps(atlas_payload, indent=2, ensure_ascii=False))
    contribution_path.write_text(
        json.dumps(
            {
                "gid": gid,
                "texture_path": rel_path(texture_path, test_root),
                "coverage_score": coverage,
                "valid_pixel_count": int(valid.sum()),
                "source_count": len(sources),
                "fusion_strategy": "winner_take_best_source_per_pixel",
                "sources": source_summaries,
            },
            indent=2,
            ensure_ascii=False,
        )
    )

    quality = float(np.mean([s["weight"] for s in source_summaries if s["valid_pixels"] > 0])) if source_summaries else 0.0
    status = "ok" if len(sources) > 1 and coverage >= 0.05 else "single_source_texture" if len(sources) == 1 else "low_coverage"
    return {
        "stitch_id": stitch_id,
        "workspace_id": paths.workspace_id,
        "gid": gid,
        "texture_path": rel_path(texture_path, test_root),
        "contribution_map_path": rel_path(contribution_path, test_root),
        "source_crop_ids": json_text([c["crop_id"] for c in crops]),
        "method": "plane_rectified_stack_best_source",
        "source_count": len(sources),
        "texture_width": tex_w,
        "texture_height": tex_h,
        "coverage_score": coverage,
        "atlas_json_path": rel_path(atlas_path, test_root),
        "preview_path": rel_path(texture_path, test_root),
        "rectified_stack_path": rel_path(stack_path, test_root),
        "quality_score": quality,
        "completeness_score": coverage,
        "status": status,
        "created_at": created_at,
    }


def write_fusion_gallery(paths: Any, test_root: Path, stitch_rows: list[dict[str, Any]], max_items: int = 24) -> Path | None:
    candidates = [
        row for row in stitch_rows
        if row.get("texture_path") and int(row.get("source_count") or 0) >= 2
    ]
    candidates.sort(
        key=lambda r: (
            float(r.get("coverage_score") or 0.0),
            float(r.get("quality_score") or 0.0),
            int(r.get("source_count") or 0),
        ),
        reverse=True,
    )
    candidates = candidates[:max_items]
    if not candidates:
        return None

    diag_dir = paths.diagnostics_root / "surface_fusion"
    diag_dir.mkdir(parents=True, exist_ok=True)
    thumb_w, thumb_h = 220, 160
    label_h = 28
    cols = 4
    rows = int(math.ceil(len(candidates) / cols))
    gallery = Image.new("RGB", (cols * thumb_w, rows * (thumb_h + label_h)), (248, 248, 248))
    draw = ImageDraw.Draw(gallery)
    for i, row in enumerate(candidates):
        src = test_root / str(row["texture_path"])
        im = Image.open(src).convert("RGB")
        im.thumbnail((thumb_w, thumb_h), Image.Resampling.LANCZOS)
        x = (i % cols) * thumb_w
        y = (i // cols) * (thumb_h + label_h)
        gallery.paste(im, (x + (thumb_w - im.width) // 2, y + (thumb_h - im.height) // 2))
        label = f"gid {row.get('gid')} | src {row.get('source_count')} | cov {float(row.get('coverage_score') or 0):.2f}"
        draw.text((x + 6, y + thumb_h + 6), label, fill=(30, 30, 30))
    out_path = diag_dir / "fused_texture_gallery.png"
    gallery.save(out_path)

    index_lines = [
        "# Surface Fusion Diagnostics",
        "",
        "- `fused_texture_gallery.png`: highest-coverage fused textures.",
        "- `surface_stitches.csv` links each fused texture to its rectified observation stack.",
        "- `../../derived/<workspace>/06_surface_stitching/surface_stitches.csv`: complete fused texture manifest.",
        "",
        "## Displayed Textures",
        "",
    ]
    for row in candidates:
        index_lines.append(
            f"- gid {row.get('gid')}: `{row.get('texture_path')}` "
            f"(sources={row.get('source_count')}, coverage={float(row.get('coverage_score') or 0):.3f}, "
            f"stack=`{row.get('rectified_stack_path')}`)"
        )
    (diag_dir / "index.md").write_text("\n".join(index_lines) + "\n")
    return out_path


def derive_surface_crops_and_stitches(
    paths: Any,
    test_root: Path,
    local: dict[str, Any],
    factors: dict[str, Any],
    max_crops_per_factor: int,
    max_crop_side: int,
    max_texture_side: int,
    texture_px_per_meter: float,
) -> dict[str, Any]:
    crop_root = paths.derived_root / "05_surface_crops"
    stitch_root = paths.derived_root / "06_surface_stitching"
    crop_dir = crop_root / "crops"
    mask_dir = crop_root / "masks"
    texture_dir = stitch_root / "textures"
    contrib_dir = stitch_root / "contribution_maps"
    atlas_dir = stitch_root / "atlases"
    rectified_dir = stitch_root / "rectified_observations"
    stack_dir = stitch_root / "rectified_stacks"
    for d in (crop_dir, mask_dir, texture_dir, contrib_dir, atlas_dir, rectified_dir, stack_dir):
        d.mkdir(parents=True, exist_ok=True)

    support_by_key = local["support_by_key"]
    boundary_by_key = local["boundary_by_key"]
    idx_by_panoid = local["idx_by_panoid"]
    quality_rows = factors["quality_rows"]
    factor_by_gid = factors["factor_by_gid"]

    by_gid: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in quality_rows:
        gid = to_int(row.get("gid"))
        if gid is not None and row.get("quality_status") == "usable":
            by_gid[gid].append(row)

    crop_rows: list[dict[str, Any]] = []
    crops_by_gid: dict[int, list[dict[str, Any]]] = defaultdict(list)
    now = datetime.now(timezone.utc).isoformat()

    for gid, rows in sorted(by_gid.items()):
        rows_sorted = sorted(rows, key=lambda r: (float(r.get("completeness_score") or 0.0), int(r.get("n_pixels") or 0)), reverse=True)
        for row in rows_sorted[:max_crops_per_factor]:
            panoid = row["panoid"]
            local_idx = to_int(row.get("local_plane_id"))
            support = support_by_key.get((panoid, local_idx or -1))
            boundary = boundary_by_key.get((panoid, local_idx or -1), {})
            idx_map = idx_by_panoid.get(panoid)
            if not support or idx_map is None or local_idx is None:
                continue
            bbox_vals = [support.get("bbox_col_min"), support.get("bbox_row_min"), support.get("bbox_col_max"), support.get("bbox_row_max")]
            if any(v is None for v in bbox_vals):
                continue
            bbox = tuple(int(v) for v in bbox_vals)  # type: ignore[arg-type]
            pano_path = paths.run_dir / "panoramas" / f"{panoid}.jpg"
            if not pano_path.exists():
                continue
            image = Image.open(pano_path).convert("RGB")
            x0, y0, x1, y1 = scale_bbox_to_image(bbox, image.size)
            crop = image.crop((x0, y0, x1, y1))
            if max(crop.size) > max_crop_side:
                scale = max_crop_side / max(crop.size)
                crop = crop.resize((max(1, int(crop.width * scale)), max(1, int(crop.height * scale))), Image.Resampling.LANCZOS)

            mask_small = (idx_map[bbox[1]: bbox[3] + 1, bbox[0]: bbox[2] + 1] == local_idx).astype(np.uint8) * 255
            mask_img = Image.fromarray(mask_small).resize(crop.size, Image.Resampling.NEAREST)
            crop_id = f"gid_{gid:04d}_{panoid}_{local_idx}"
            crop_path = crop_dir / f"{crop_id}.jpg"
            mask_path = mask_dir / f"{crop_id}_mask.png"
            crop.save(crop_path, quality=92)
            mask_img.save(mask_path)
            crop_row = {
                "crop_id": crop_id,
                "workspace_id": paths.workspace_id,
                "gid": gid,
                "panoid": panoid,
                "local_plane_id": local_idx,
                "source_type": "global_factor_source",
                "anchor_panoid": None,
                "stack_id": None,
                "year_month": None,
                "correspondence_id": None,
                "bbox_col_min": bbox[0],
                "bbox_row_min": bbox[1],
                "bbox_col_max": bbox[2],
                "bbox_row_max": bbox[3],
                "crop_path": rel_path(crop_path, test_root),
                "mask_path": rel_path(mask_path, test_root),
                "support_path": support.get("contour_path"),
                "boundary_path": boundary.get("boundary_points_path"),
                "uv_transform_json": json_text({"indexmap_bbox": bbox, "image_bbox": [x0, y0, x1, y1], "crop_size": list(crop.size)}),
                "projection_json": json_text({"method": "equirectangular_bbox_from_indexmap_support"}),
                "purity_score": row.get("mask_purity_score"),
                "completeness_score": row.get("completeness_score"),
                "visibility_status": "observed",
                "status": "ok",
                "created_at": now,
            }
            crop_rows.append(crop_row)
            crops_by_gid[gid].append(crop_row)

    stitch_rows: list[dict[str, Any]] = []
    rectified_rows: list[dict[str, Any]] = []
    for gid, crops in sorted(crops_by_gid.items()):
        if not crops:
            continue
        factor_row = factor_by_gid.get(gid)
        if not factor_row:
            continue
        stitch_row = fuse_factor_texture(
            paths,
            test_root,
            local,
            factor_row,
            gid,
            crops,
            texture_dir,
            contrib_dir,
            atlas_dir,
            rectified_dir,
            stack_dir,
            rectified_rows,
            max_texture_side,
            texture_px_per_meter,
        )
        if stitch_row:
            stitch_rows.append(stitch_row)

    crop_columns = [
        "crop_id", "workspace_id", "gid", "panoid", "local_plane_id", "source_type",
        "anchor_panoid", "stack_id", "year_month", "correspondence_id",
        "bbox_col_min", "bbox_row_min", "bbox_col_max", "bbox_row_max", "crop_path",
        "mask_path", "support_path", "boundary_path", "uv_transform_json",
        "projection_json", "purity_score", "completeness_score", "visibility_status",
        "status", "created_at",
    ]
    stitch_columns = [
        "stitch_id", "workspace_id", "gid", "texture_path", "contribution_map_path",
        "source_crop_ids", "method", "source_count", "texture_width", "texture_height",
        "coverage_score", "atlas_json_path", "preview_path", "rectified_stack_path",
        "quality_score", "completeness_score", "status", "created_at",
    ]
    rectified_columns = [
        "rectified_id", "workspace_id", "gid", "panoid", "local_plane_id",
        "source_crop_id", "rectified_path", "mask_path", "atlas_json_path",
        "source_crop_path", "texture_width", "texture_height", "valid_pixel_count",
        "valid_fraction", "source_weight", "status", "created_at",
    ]
    write_csv(crop_root / "surface_crops.csv", crop_rows, crop_columns)
    write_csv(stitch_root / "surface_rectified_observations.csv", rectified_rows, rectified_columns)
    write_csv(stitch_root / "surface_stitches.csv", stitch_rows, stitch_columns)
    write_fusion_gallery(paths, test_root, stitch_rows)
    return {"crop_rows": crop_rows, "stitch_rows": stitch_rows, "rectified_rows": rectified_rows}


def derive_temporal_correspondence(paths: Any, test_root: Path, anchor: str | None, stack_id: str | None) -> None:
    temporal_root = test_root / "data/diagnostics/temporal/factor_explosion"
    if not anchor:
        anchors = sorted([p.name for p in temporal_root.iterdir() if p.is_dir()]) if temporal_root.exists() else []
        anchor = anchors[-1] if anchors else None
    if not anchor:
        return
    viewpoint_path = temporal_root / anchor / "viewpoint_index.json"
    if not viewpoint_path.exists():
        return
    viewpoint = read_json(viewpoint_path)
    factor = viewpoint.get("factor") or {}
    out_root = test_root / "data/derived/temporal" / anchor / "factor_correspondences"
    out_root.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    for cell in viewpoint.get("cells") or []:
        year = to_int(cell.get("year"))
        month = to_int(cell.get("month"))
        ym = f"{year:04d}-{month:02d}" if year and month else None
        render = cell.get("render") or {}
        kept = bool(cell.get("kept"))
        status = "aligned" if kept else "rejected"
        reason = cell.get("reason") or ("kept" if kept else "rejected_by_temporal_explosion")
        correspondence_id = f"{anchor}_{ym}_c{cell.get('col')}_{cell.get('matched_panoid')}"
        rows.append(
            {
                "correspondence_id": correspondence_id,
                "workspace_id": "temporal",
                "gid": None,
                "factor_local_plane_id": factor.get("plane_idx"),
                "anchor_panoid": anchor,
                "stack_id": stack_id,
                "year_month": ym,
                "source_panoid": cell.get("ref_panoid"),
                "matched_panoid": cell.get("matched_panoid"),
                "transform_json": json_text(
                    {
                        "target_azimuth_deg": render.get("target_azimuth_deg"),
                        "target_roll_shift_px": render.get("target_roll_shift_px"),
                        "method": "factor_centering_roll",
                    }
                ),
                "residual_m": cell.get("matched_dist_m"),
                "residual_px": None,
                "keep": kept,
                "status": status,
                "reason": reason,
                "crop_path": None,
                "overlay_path": render.get("render_jpg_path") and rel_path(Path(render["render_jpg_path"]), test_root),
                "correspondence_path": rel_path(viewpoint_path, test_root),
            }
        )
    columns = [
        "correspondence_id", "workspace_id", "gid", "factor_local_plane_id",
        "anchor_panoid", "stack_id", "year_month", "source_panoid", "matched_panoid",
        "transform_json", "residual_m", "residual_px", "keep", "status", "reason",
        "crop_path", "overlay_path", "correspondence_path",
    ]
    write_csv(out_root / "temporal_factor_correspondences.csv", rows, columns)


def parse_temporal_photometa(parsed_json_path: Path) -> dict[str, Any] | None:
    try:
        data = read_json(parsed_json_path)
        root = data[1][0]
        panoid = root[1][1]
        pose = root[5][0][1][2]
        node = root[5][0][5]
        if node is None:
            return None
        blob = b64decode_lenient(node[1][2])
        n_planes = struct.unpack_from("<H", blob, 1)[0]
        map_w, map_h = node[3][0]
        idx = np.frombuffer(blob[8: 8 + map_w * map_h], dtype=np.uint8).reshape(map_w, map_h)
        plane_off = 8 + map_w * map_h
        planes = np.empty((n_planes, 4), dtype=np.float64)
        for i in range(n_planes):
            planes[i] = struct.unpack_from("<ffff", blob, plane_off + 16 * i)
        roll = float(pose[2])
        if abs(roll) >= 180.0:
            roll = roll - 360.0 if roll > 0 else roll + 360.0
        return {
            "panoid": panoid,
            "heading_deg": float(pose[0]),
            "pitch_deg": float(pose[1]),
            "roll_deg": roll,
            "idxmap": idx,
            "planes": planes,
        }
    except Exception:
        return None


def parsed_year_month(parsed_json_path: Path) -> str | None:
    try:
        data = read_json(parsed_json_path)
        date_block = data[1][0][6][7]
        year = to_int(date_block[0])
        month = to_int(date_block[1])
        if year and month:
            return f"{year:04d}-{month:02d}"
    except Exception:
        return None
    return None


def find_temporal_parsed_json(stack_dir: Path, year_month: str | None, panoid: str | None) -> Path | None:
    if not year_month or not panoid:
        return None
    prefix = f"{year_month}-"
    for capture_dir in sorted((stack_dir / "captures").glob(f"{prefix}*")):
        focal = capture_dir / "parsed.json"
        if focal.exists():
            try:
                parsed = read_json(focal)
                if parsed[1][0][1][1] == panoid:
                    return focal
            except Exception:
                pass
        focal_parsed = next(capture_dir.glob("photometa_*_parsed.json"), None)
        if focal_parsed and focal_parsed.exists():
            try:
                parsed = read_json(focal_parsed)
                if parsed[1][0][1][1] == panoid:
                    return focal_parsed
            except Exception:
                pass
        nb = capture_dir / "neighbor_photometas" / f"{panoid}.parsed.json"
        if nb.exists():
            return nb
    for parsed_path in sorted((stack_dir / "captures").glob(f"*/neighbor_photometas/{panoid}.parsed.json")):
        if parsed_year_month(parsed_path) == year_month:
            return parsed_path
    for parsed_path in sorted((stack_dir / "captures").glob("*/parsed.json")):
        try:
            parsed = read_json(parsed_path)
            if parsed[1][0][1][1] == panoid and parsed_year_month(parsed_path) == year_month:
                return parsed_path
        except Exception:
            pass
    for parsed_path in sorted((stack_dir / "captures").glob("*/photometa_*_parsed.json")):
        try:
            parsed = read_json(parsed_path)
            if parsed[1][0][1][1] == panoid and parsed_year_month(parsed_path) == year_month:
                return parsed_path
        except Exception:
            pass
    return None


def target_cell_from_world(rec: dict[str, Any], target_world: np.ndarray, pano_e: float, pano_n: float, image_size: tuple[int, int]) -> tuple[int, int, int, int]:
    from diagnostics.filter_and_rectify import build_rotation  # type: ignore

    rotation = build_rotation(rec["heading_deg"], rec["pitch_deg"], rec["roll_deg"])
    local_vec = rotation.T @ (target_world - np.array([pano_e, pano_n, 0.0], dtype=np.float64))
    idx_col, idx_row, x_img, y_img = local_vectors_to_equirect(local_vec.reshape(1, 1, 3), image_size)
    return int(idx_col[0, 0]), int(idx_row[0, 0]), int(round(float(x_img[0, 0]))), int(round(float(y_img[0, 0])))


def append_temporal_surface_crops(
    paths: Any,
    test_root: Path,
    anchor: str | None,
    stack_id: str | None,
    existing_rows: list[dict[str, Any]],
    max_crop_side: int,
) -> list[dict[str, Any]]:
    if not anchor or not stack_id:
        return []

    temporal_root = test_root / "data/diagnostics/temporal/factor_explosion" / anchor
    viewpoint_path = temporal_root / "viewpoint_index.json"
    if not viewpoint_path.exists():
        legacy_viewpoint = test_root / "data/streetview_3d/_temporal_explosion" / anchor / "viewpoint_index.json"
        viewpoint_path = legacy_viewpoint if legacy_viewpoint.exists() else viewpoint_path
    if not viewpoint_path.exists():
        return []

    stack_dir = test_root / "data/raw/google_maps/temporal" / anchor / stack_id
    if not stack_dir.exists():
        return []

    viewpoint = read_json(viewpoint_path)
    factor = viewpoint.get("factor") or {}
    target = factor.get("target_world_enu") or []
    if len(target) < 3:
        return []
    target_world = np.array([float(target[0]), float(target[1]), float(target[2])], dtype=np.float64)

    crop_root = paths.derived_root / "05_surface_crops"
    temporal_crop_dir = crop_root / "temporal" / anchor / stack_id / "crops"
    temporal_mask_dir = crop_root / "temporal" / anchor / stack_id / "masks"
    temporal_overlay_dir = crop_root / "temporal" / anchor / stack_id / "overlays"
    for directory in (temporal_crop_dir, temporal_mask_dir, temporal_overlay_dir):
        directory.mkdir(parents=True, exist_ok=True)

    rows: list[dict[str, Any]] = []
    now = datetime.now(timezone.utc).isoformat()
    for cell in viewpoint.get("cells") or []:
        if not bool(cell.get("kept")):
            continue
        year = to_int(cell.get("year"))
        month = to_int(cell.get("month"))
        year_month = f"{year:04d}-{month:02d}" if year and month else None
        matched = cell.get("matched_panoid")
        parsed_path = find_temporal_parsed_json(stack_dir, year_month, matched)
        if parsed_path is None:
            continue
        rec = parse_temporal_photometa(parsed_path)
        if rec is None:
            continue

        render = cell.get("render") or {}
        image_path = Path(render.get("render_jpg_path") or "")
        if not image_path.is_file():
            candidate = temporal_root / "repaired_panoramas" / f"{matched}.jpg"
            if not candidate.exists():
                candidate = stack_dir / "captures" / f"{year_month}-01_{matched}" / "panoramas" / f"{matched}.jpg"
            image_path = candidate
        if not image_path.is_file():
            continue
        image = Image.open(image_path).convert("RGB")
        idx_col, idx_row, _, _ = target_cell_from_world(
            rec,
            target_world,
            float(cell.get("matched_e") or 0.0),
            float(cell.get("matched_n") or 0.0),
            image.size,
        )
        if idx_row < 0 or idx_row >= IDX_H:
            continue
        local_idx = int(rec["idxmap"][idx_row, idx_col])
        if local_idx <= 0:
            window = 7
            r0 = max(0, idx_row - window)
            r1 = min(IDX_H, idx_row + window + 1)
            c0 = max(0, idx_col - window)
            c1 = min(IDX_W, idx_col + window + 1)
            patch = rec["idxmap"][r0:r1, c0:c1]
            values, counts = np.unique(patch[patch > 0], return_counts=True)
            if values.size == 0:
                continue
            local_idx = int(values[np.argmax(counts)])

        mask = rec["idxmap"] == local_idx
        bbox = component_bbox_near(mask, idx_row, idx_col, pad=2)
        if bbox is None:
            continue
        x0, y0, x1, y1 = scale_bbox_to_image(bbox, image.size, pad=1)
        crop = image.crop((x0, y0, x1, y1))
        if max(crop.size) > max_crop_side:
            scale = max_crop_side / max(crop.size)
            crop = crop.resize((max(1, int(crop.width * scale)), max(1, int(crop.height * scale))), Image.Resampling.LANCZOS)
        mask_small = (rec["idxmap"][bbox[1]: bbox[3] + 1, bbox[0]: bbox[2] + 1] == local_idx).astype(np.uint8) * 255
        mask_img = Image.fromarray(mask_small).resize(crop.size, Image.Resampling.NEAREST)
        overlay = crop.copy()
        overlay_arr = np.asarray(overlay).copy()
        mask_arr = np.asarray(mask_img) > 0
        overlay_arr[mask_arr] = (overlay_arr[mask_arr].astype(np.float32) * 0.55 + np.array([255, 64, 32]) * 0.45).astype(np.uint8)
        overlay = Image.fromarray(overlay_arr)

        correspondence_id = f"{anchor}_{year_month}_c{cell.get('col')}_{matched}"
        crop_id = f"temporal_{correspondence_id}_{local_idx}"
        crop_path = temporal_crop_dir / f"{crop_id}.jpg"
        mask_path = temporal_mask_dir / f"{crop_id}_mask.png"
        overlay_path = temporal_overlay_dir / f"{crop_id}_overlay.jpg"
        crop.save(crop_path, quality=92)
        mask_img.save(mask_path)
        overlay.save(overlay_path, quality=92)
        purity = float(mask_arr.mean()) if mask_arr.size else 0.0
        completeness = max(0.0, 1.0 - min(1.0, float(cell.get("matched_dist_m") or 0.0) / 6.0))
        row = {
            "crop_id": crop_id,
            "workspace_id": paths.workspace_id,
            "gid": None,
            "panoid": matched,
            "local_plane_id": local_idx,
            "source_type": "temporal_factor_correspondence",
            "anchor_panoid": anchor,
            "stack_id": stack_id,
            "year_month": year_month,
            "correspondence_id": correspondence_id,
            "bbox_col_min": bbox[0],
            "bbox_row_min": bbox[1],
            "bbox_col_max": bbox[2],
            "bbox_row_max": bbox[3],
            "crop_path": rel_path(crop_path, test_root),
            "mask_path": rel_path(mask_path, test_root),
            "support_path": rel_path(overlay_path, test_root),
            "boundary_path": None,
            "uv_transform_json": json_text({"indexmap_bbox": bbox, "image_bbox": [x0, y0, x1, y1], "crop_size": list(crop.size)}),
            "projection_json": json_text({"method": "temporal_target_world_component_crop", "target_world_enu": target}),
            "purity_score": purity,
            "completeness_score": completeness,
            "visibility_status": "aligned" if bool(cell.get("kept")) else "rejected",
            "status": "ok",
            "created_at": now,
        }
        rows.append(row)

    if rows:
        all_rows = existing_rows + rows
        crop_columns = [
            "crop_id", "workspace_id", "gid", "panoid", "local_plane_id", "source_type",
            "anchor_panoid", "stack_id", "year_month", "correspondence_id",
            "bbox_col_min", "bbox_row_min", "bbox_col_max", "bbox_row_max", "crop_path",
            "mask_path", "support_path", "boundary_path", "uv_transform_json",
            "projection_json", "purity_score", "completeness_score", "visibility_status",
            "status", "created_at",
        ]
        write_csv(crop_root / "surface_crops.csv", all_rows, crop_columns)
        crop_by_corr = {row["correspondence_id"]: row["crop_path"] for row in rows}
        corr_path = test_root / "data/derived/temporal" / anchor / "factor_correspondences" / "temporal_factor_correspondences.csv"
        corr_rows = read_csv_rows(corr_path)
        if corr_rows:
            for corr in corr_rows:
                if corr.get("correspondence_id") in crop_by_corr:
                    corr["crop_path"] = crop_by_corr[corr["correspondence_id"]]
            write_csv(corr_path, corr_rows, list(corr_rows[0].keys()))
        index_path = crop_root / "temporal" / anchor / stack_id / "index.md"
        gallery_path = crop_root / "temporal" / anchor / stack_id / "temporal_surface_crops_gallery.png"
        thumb_w, thumb_h = 220, 90
        label_h = 26
        cols = 4
        gallery_rows = int(math.ceil(len(rows) / cols))
        gallery = Image.new("RGB", (cols * thumb_w, gallery_rows * (thumb_h + label_h)), (248, 248, 248))
        draw = ImageDraw.Draw(gallery)
        for i, row in enumerate(sorted(rows, key=lambda r: (str(r.get("year_month")), str(r.get("panoid"))))):
            overlay_path = test_root / str(row["support_path"])
            crop_path = test_root / str(row["crop_path"])
            src_path = overlay_path if overlay_path.exists() else crop_path
            im = Image.open(src_path).convert("RGB")
            im.thumbnail((thumb_w, thumb_h), Image.Resampling.LANCZOS)
            x = (i % cols) * thumb_w
            y = (i // cols) * (thumb_h + label_h)
            gallery.paste(im, (x + (thumb_w - im.width) // 2, y + (thumb_h - im.height) // 2))
            draw.text(
                (x + 6, y + thumb_h + 6),
                f"{row.get('year_month')} c{str(row.get('correspondence_id')).split('_c')[-1].split('_')[0]} p{row.get('local_plane_id')}",
                fill=(30, 30, 30),
            )
        gallery.save(gallery_path)
        lines = [
            "# Temporal Surface Crops",
            "",
            f"- anchor panoid: `{anchor}`",
            f"- stack id: `{stack_id}`",
            f"- generated crops: {len(rows)}",
            f"- gallery: `{rel_path(gallery_path, test_root)}`",
            "",
        ]
        for row in rows[:40]:
            lines.append(
                f"- {row['year_month']} {row['panoid']}: `{row['crop_path']}` "
                f"(plane={row['local_plane_id']}, purity={float(row['purity_score']):.3f})"
            )
        index_path.write_text("\n".join(lines) + "\n")
    return rows


def derive_temporal_surface_comparisons(
    paths: Any,
    test_root: Path,
    stitch_rows: list[dict[str, Any]],
    temporal_crop_rows: list[dict[str, Any]],
) -> None:
    out_root = paths.derived_root / "07_temporal_surface_comparison"
    out_root.mkdir(parents=True, exist_ok=True)
    report_path = out_root / "temporal_surface_comparison_status.json"
    temporal_count = len(temporal_crop_rows)
    report_path.write_text(
        json.dumps(
            {
                "status": "temporal_surface_crops_ready" if temporal_count else "no_temporal_surface_inputs",
                "reason": "per-year surface crops generated from factor correspondences" if temporal_count else "temporal factor correspondences are available, but per-year surface crops are not generated yet",
                "stitch_count": len(stitch_rows),
                "temporal_surface_crop_count": temporal_count,
            },
            indent=2,
        )
    )
    rows: list[dict[str, Any]] = [
        {
            "comparison_id": "temporal_surface_inputs_pending",
            "workspace_id": paths.workspace_id,
            "gid": None,
            "time_a": None,
            "time_b": None,
            "source_stitch_id_a": None,
            "source_stitch_id_b": None,
            "metric_json": json_text({"stitch_count": len(stitch_rows), "temporal_surface_crop_count": temporal_count}),
            "diff_path": None,
            "report_path": rel_path(report_path, test_root),
            "status": "ready_for_temporal_diff" if temporal_count else "waiting_for_temporal_surface_crops",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
    ]
    write_csv(
        out_root / "temporal_surface_comparisons.csv",
        rows,
        [
            "comparison_id", "workspace_id", "gid", "time_a", "time_b",
            "source_stitch_id_a", "source_stitch_id_b", "metric_json", "diff_path",
            "report_path", "status", "created_at",
        ],
    )


def write_report(paths: Any, outputs: dict[str, int]) -> None:
    report_path = paths.derived_root / "04b_factor_geometry" / "report.md"
    lines = [
        "# Factor Geometry Surface Pipeline Report",
        "",
        "Generated stages:",
        "",
        f"- local plane supports: {outputs.get('local_plane_supports', 0)}",
        f"- local plane 3D boundaries: {outputs.get('local_plane_boundaries_3d', 0)}",
        f"- factor geometries: {outputs.get('factor_geometries', 0)}",
        f"- visibility candidates: {outputs.get('factor_visibility_candidates', 0)}",
        f"- observation quality rows: {outputs.get('factor_observation_quality', 0)}",
        f"- surface crops: {outputs.get('surface_crops', 0)}",
        f"- surface rectified observations: {outputs.get('surface_rectified_observations', 0)}",
        f"- surface stitches: {outputs.get('surface_stitches', 0)}",
        f"- temporal surface crops: {outputs.get('temporal_surface_crops', 0)}",
        f"- topdown diagnostic plots: {outputs.get('topdown_diagnostic', 0)}",
        "",
        "This stage writes heavy masks, contours, boundaries, crops, and textures as files.",
        "The catalog indexes the manifests and project-relative paths.",
    ]
    report_path.write_text("\n".join(lines) + "\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Derive factor geometry, visibility, surface, and temporal manifests.")
    add_spatial_args(parser)
    parser.add_argument("--anchor", default=None, help="Optional temporal anchor panoid for correspondence export")
    parser.add_argument("--stack-id", default=None, help="Optional temporal stack id for correspondence export")
    parser.add_argument("--max-boundary-points", type=int, default=96)
    parser.add_argument("--max-visibility-distance", type=float, default=80.0)
    parser.add_argument("--max-crops-per-factor", type=int, default=3)
    parser.add_argument("--max-crop-side", type=int, default=512)
    parser.add_argument("--max-texture-side", type=int, default=768)
    parser.add_argument("--texture-px-per-meter", type=float, default=96.0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    paths = resolve_spatial_paths(args)
    test_root = paths.test_root
    local = derive_local_geometry(paths, test_root, args.max_boundary_points)
    factor_outputs = derive_factor_geometry_and_visibility(paths, test_root, local, args.max_visibility_distance)
    diagnostic_path = write_topdown_diagnostic(paths, test_root, local, factor_outputs)
    surface_outputs = derive_surface_crops_and_stitches(
        paths,
        test_root,
        local,
        factor_outputs,
        args.max_crops_per_factor,
        args.max_crop_side,
        args.max_texture_side,
        args.texture_px_per_meter,
    )
    derive_temporal_correspondence(paths, test_root, args.anchor, args.stack_id)
    temporal_crop_rows = append_temporal_surface_crops(
        paths,
        test_root,
        args.anchor,
        args.stack_id,
        surface_outputs["crop_rows"],
        args.max_crop_side,
    )
    derive_temporal_surface_comparisons(paths, test_root, surface_outputs["stitch_rows"], temporal_crop_rows)

    counts = {
        "local_plane_supports": len(read_csv_rows(paths.derived_root / "04b_factor_geometry/local_plane_supports.csv")),
        "local_plane_boundaries_3d": len(read_csv_rows(paths.derived_root / "04b_factor_geometry/local_plane_boundaries_3d.csv")),
        "factor_geometries": len(read_csv_rows(paths.derived_root / "04b_factor_geometry/factor_geometries.csv")),
        "factor_visibility_candidates": len(read_csv_rows(paths.derived_root / "04c_factor_visibility/factor_visibility_candidates.csv")),
        "factor_observation_quality": len(read_csv_rows(paths.derived_root / "04c_factor_visibility/factor_observation_quality.csv")),
        "surface_crops": len(surface_outputs["crop_rows"]) + len(temporal_crop_rows),
        "surface_rectified_observations": len(surface_outputs["rectified_rows"]),
        "surface_stitches": len(surface_outputs["stitch_rows"]),
        "temporal_surface_crops": len(temporal_crop_rows),
    }
    if diagnostic_path:
        counts["topdown_diagnostic"] = 1
    write_report(paths, counts)
    print(json.dumps({"derived_root": rel_path(paths.derived_root, test_root), "counts": counts}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
