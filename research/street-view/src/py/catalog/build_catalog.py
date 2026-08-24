#!/usr/bin/env python3
"""Build a DuckDB catalog for the Street View geometry workflow.

The catalog is a query index over the current project tree. It records metadata
and relative file paths; it does not move raw captures or recompute geometry
outputs.
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import json
import math
import os
import re
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sv3d_paths import resolve_spatial_paths, resolve_temporal_paths  # noqa: E402


SCHEMA_VERSION = "0.5.0"
DEFAULT_SMALL_HASH_MB = 64.0


def require_duckdb():
    try:
        import duckdb  # type: ignore
    except ModuleNotFoundError as exc:
        raise SystemExit(
            "Missing dependency: duckdb. Install with: python3 -m pip install -r requirements.txt"
        ) from exc
    return duckdb


def default_test_root() -> Path:
    return Path(__file__).resolve().parents[3]


def read_json(path: Path) -> Any | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open(newline="") as f:
        return list(csv.DictReader(f))


def read_manifest_rows(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for row in read_csv_rows(path):
        rows.append({key: (None if value == "" else value) for key, value in row.items()})
    return rows


def safe_get(obj: Any, *keys: Any) -> Any:
    cur = obj
    for key in keys:
        try:
            if isinstance(cur, dict):
                cur = cur[key]
            elif isinstance(cur, (list, tuple)):
                cur = cur[key]
            else:
                return None
        except (KeyError, IndexError, TypeError):
            return None
    return cur


def to_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(float(str(value).strip()))
    except (TypeError, ValueError):
        return None


def to_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


def to_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if value is None or value == "":
        return None
    text = str(value).strip().lower()
    if text in {"true", "1", "yes", "y"}:
        return True
    if text in {"false", "0", "no", "n"}:
        return False
    return None


def normalize_roll(value: Any) -> float | None:
    roll = to_float(value)
    if roll is None:
        return None
    if abs(roll) >= 180.0:
        roll = roll - 360.0 if roll > 0 else roll + 360.0
    return roll


def json_text(value: Any) -> str | None:
    if value is None:
        return None
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def rel_path(path: str | Path | None, root: Path) -> str | None:
    if not path:
        return None
    raw = Path(path)
    if raw.is_absolute():
        resolved = raw.resolve(strict=False)
    else:
        resolved = (root / raw).resolve(strict=False)
    root_resolved = root.resolve(strict=False)
    try:
        return resolved.relative_to(root_resolved).as_posix()
    except ValueError:
        text = str(path)
        root_text = str(root_resolved)
        if text.startswith(root_text):
            return text[len(root_text) :].lstrip("/").replace(os.sep, "/")
        return text


def existing_rel(path: str | Path | None, root: Path) -> str | None:
    if not path:
        return None
    p = Path(path)
    abs_path = p if p.is_absolute() else root / p
    if not abs_path.exists():
        return None
    return rel_path(abs_path, root)


def file_sha256(path: Path, mode: str, small_hash_bytes: int) -> str | None:
    if mode == "none" or not path.is_file():
        return None
    try:
        size = path.stat().st_size
    except OSError:
        return None
    if mode == "small" and size > small_hash_bytes:
        return None
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def infer_stage(path: Path, root: Path) -> str | None:
    rp = rel_path(path, root) or ""
    for stage in ("raw", "intermediate", "derived", "diagnostics", "catalog"):
        if rp.startswith(f"data/{stage}/"):
            return stage
    if rp.startswith("schema/"):
        return "schema"
    return None


def infer_asset_type(path: Path) -> str:
    name = path.name
    parent = path.parent.name
    if name.endswith("_parsed_depthmap.bin"):
        return "b2_grid_bin"
    if name.endswith("_parsed_indexmap.bin"):
        return "indexmap_bin"
    if name.endswith("_parsed_planes.json"):
        return "parsed_planes_json"
    if parent == "panoramas" and path.suffix.lower() in {".jpg", ".jpeg"}:
        return "panorama_jpg"
    if parent == "screenshots" and path.suffix.lower() == ".png":
        return "screenshot_png"
    if parent == "neighbor_photometas" and name.endswith(".parsed.json"):
        return "neighbor_photometa_parsed_json"
    if parent == "neighbor_photometas" and path.suffix == ".bin":
        return "neighbor_photometa_bin"
    if name.startswith("photometa_") and path.suffix == ".bin":
        return "photometa_bin"
    if name.endswith("_parsed.json"):
        return "parsed_photometa_json"
    if name.endswith("_indexmap_local.bin"):
        return "indexmap_local_bin"
    if name.endswith("_indexmap_gravity.bin"):
        return "indexmap_gravity_bin"
    if name.endswith("_planes_world.json"):
        return "planes_world_json"
    if name == "pointcloud_meta.json":
        return "pointcloud_meta_json"
    if name == "tile_inventory.json":
        return "tile_inventory_json"
    if name == "timeline.json":
        return "timeline_json"
    if name == "viewpoint_index.json":
        return "viewpoint_index_json"
    if name.endswith(".csv"):
        return "csv"
    if name.endswith(".json"):
        return "json"
    if name.endswith(".png"):
        return "png"
    if name.endswith(".jpg") or name.endswith(".jpeg"):
        return "jpg"
    if name.endswith(".ply"):
        return "ply"
    if name.endswith(".npz"):
        return "npz"
    return path.suffix.lstrip(".") or "file"


def infer_panoid(path: Path) -> str | None:
    name = path.name
    parent = path.parent.name
    if parent in {"panoramas", "neighbor_photometas", "repaired_panoramas"}:
        stem = path.stem
        return stem.replace(".parsed", "")
    for suffix in (
        "_indexmap_local.bin",
        "_indexmap_gravity.bin",
        "_planes_world.json",
        "_compare.png",
        "_with_pano.png",
        "_overlay.png",
    ):
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return None


def infer_temporal_context(path: Path, root: Path) -> tuple[str | None, str | None]:
    rel = rel_path(path, root)
    if not rel:
        return None, None
    parts = Path(rel).parts
    prefix = ("data", "raw", "google_maps", "temporal")
    if len(parts) >= len(prefix) + 2 and parts[: len(prefix)] == prefix:
        return parts[len(prefix)], parts[len(prefix) + 1]
    return None, None


def b64decode_lenient(text: str) -> bytes:
    text += "=" * ((4 - len(text) % 4) % 4)
    return base64.urlsafe_b64decode(text)


def parse_photometa_summary(path: Path, root: Path) -> dict[str, Any] | None:
    parsed = read_json(path)
    if parsed is None:
        return None
    panoid = safe_get(parsed, 1, 0, 1, 1)
    pose = safe_get(parsed, 1, 0, 5, 0, 1, 2)
    date_block = safe_get(parsed, 1, 0, 6, 7)
    node = safe_get(parsed, 1, 0, 5, 0, 5)

    heading = pitch = roll = None
    if isinstance(pose, list):
        heading = to_float(safe_get(pose, 0))
        pitch = to_float(safe_get(pose, 1))
        roll = normalize_roll(safe_get(pose, 2))

    capture_year = capture_month = None
    if isinstance(date_block, list) and len(date_block) >= 2:
        capture_year = to_int(date_block[0])
        capture_month = to_int(date_block[1])

    n_planes = map_width = map_height = None
    has_indexmap = False
    has_b2 = False
    if node is not None:
        dims = safe_get(node, 3, 0)
        if isinstance(dims, list) and len(dims) >= 2:
            map_width = to_int(dims[0])
            map_height = to_int(dims[1])
        blob1_text = safe_get(node, 1, 2)
        if isinstance(blob1_text, str):
            try:
                blob1 = b64decode_lenient(blob1_text)
                if len(blob1) >= 3:
                    n_planes = struct.unpack_from("<H", blob1, 1)[0]
                    has_indexmap = True
            except Exception:
                pass
        has_b2 = isinstance(safe_get(node, 3, 2), str)

    return {
        "panoid": str(panoid) if panoid else infer_panoid(path),
        "parsed_path": rel_path(path, root),
        "n_planes": n_planes,
        "map_width": map_width,
        "map_height": map_height,
        "has_indexmap": has_indexmap,
        "has_b2": has_b2,
        "heading_deg": heading,
        "pitch_deg": pitch,
        "roll_deg": roll,
        "capture_year": capture_year,
        "capture_month": capture_month,
    }


def parsed_photometa_candidates(paths: Any) -> list[Path]:
    candidates: list[Path] = []
    candidates.extend(sorted((paths.run_dir / "neighbor_photometas").glob("*.parsed.json")))
    candidates.extend(sorted(paths.parsed_photometa_dir.glob("*_parsed.json")))
    return candidates


def b2_grid_file_for(parsed_path: Path, paths: Any) -> Path | None:
    if parsed_path.parent != paths.parsed_photometa_dir:
        return None
    stem = parsed_path.name[: -len("_parsed.json")]
    return paths.parsed_photometa_dir / f"{stem}_parsed_depthmap.bin"


def angular_error(a: float, b: float) -> float:
    return min((a - b) % 360.0, (b - a) % 360.0)


def neighbour_rows_from_photometa(parsed: Any) -> tuple[float | None, float | None, list[dict[str, Any]]]:
    root = safe_get(parsed, 1, 0)
    focal_lat = to_float(safe_get(root, 5, 0, 1, 0, 2))
    focal_lng = to_float(safe_get(root, 5, 0, 1, 0, 3))
    neighbours: list[dict[str, Any]] = []
    if focal_lat is None or focal_lng is None:
        return focal_lat, focal_lng, neighbours

    meters_per_deg_lat = 110540.0
    meters_per_deg_lng = 111320.0 * math.cos(math.radians(focal_lat))
    for entry in safe_get(root, 5, 0, 3, 0) or []:
        pid = safe_get(entry, 0, 1)
        lat = to_float(safe_get(entry, 2, 0, 2))
        lng = to_float(safe_get(entry, 2, 0, 3))
        if not pid or lat is None or lng is None:
            continue
        east = (lng - focal_lng) * meters_per_deg_lng
        north = (lat - focal_lat) * meters_per_deg_lat
        dist = math.hypot(east, north)
        heading = math.degrees(math.atan2(east, north)) % 360.0
        neighbours.append(
            {
                "panoid": pid,
                "east_m": east,
                "north_m": north,
                "distance_m": dist,
                "heading_deg": heading,
            }
        )
    return focal_lat, focal_lng, neighbours


def build_b2_region_rows(paths: Any, test_root: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for parsed_path in parsed_photometa_candidates(paths):
        rel = rel_path(parsed_path, test_root)
        if rel in seen:
            continue
        seen.add(rel or str(parsed_path))
        parsed = read_json(parsed_path)
        if parsed is None:
            continue
        panoid = safe_get(parsed, 1, 0, 1, 1) or infer_panoid(parsed_path)
        node = safe_get(parsed, 1, 0, 5, 0, 5)
        b2_text = safe_get(node, 3, 2)
        dims = safe_get(node, 3, 0)
        if not isinstance(b2_text, str):
            continue
        try:
            blob = b64decode_lenient(b2_text)
        except Exception:
            continue
        rows_count = to_int(safe_get(dims, 0)) or 256
        cols_count = to_int(safe_get(dims, 1)) or 512
        if len(blob) != rows_count * cols_count:
            continue
        try:
            import numpy as np

            b2 = np.frombuffer(blob, dtype=np.uint8).reshape(rows_count, cols_count)
        except Exception:
            continue

        _, _, neighbours = neighbour_rows_from_photometa(parsed)
        b2_grid_path = b2_grid_file_for(parsed_path, paths)
        b2_grid_rel = existing_rel(b2_grid_path, test_root) if b2_grid_path else None
        for b2_id in sorted(int(v) for v in set(b2.flatten().tolist()) if int(v) > 0):
            ys, xs = np.where(b2 == b2_id)
            if ys.size == 0:
                continue
            thetas = (xs + 0.5) / cols_count * 2.0 * math.pi - math.pi
            cos_mean = float(np.mean(np.cos(thetas)))
            sin_mean = float(np.mean(np.sin(thetas)))
            centroid_heading = math.degrees(math.atan2(sin_mean, cos_mean)) % 360.0
            best = None
            for nb in neighbours:
                if nb["distance_m"] < 0.5:
                    continue
                err = angular_error(centroid_heading, nb["heading_deg"])
                if best is None or err < best["target_error_deg"]:
                    best = {
                        "target_panoid": nb["panoid"],
                        "target_east_m": nb["east_m"],
                        "target_north_m": nb["north_m"],
                        "target_heading_deg": nb["heading_deg"],
                        "target_distance_m": nb["distance_m"],
                        "target_error_deg": err,
                    }
            best = best or {
                "target_panoid": None,
                "target_east_m": None,
                "target_north_m": None,
                "target_heading_deg": None,
                "target_distance_m": None,
                "target_error_deg": None,
            }
            rows.append(
                {
                    "workspace_id": paths.workspace_id,
                    "site_id": paths.site,
                    "run_id": paths.run_id,
                    "panoid": panoid,
                    "b2_id": b2_id,
                    "cell_count": int(ys.size),
                    "centroid_col": float(xs.mean()),
                    "centroid_row": float(ys.mean()),
                    "centroid_heading_deg": centroid_heading,
                    **best,
                    "mapping_method": "nearest_neighbor_heading",
                    "b2_grid_path": b2_grid_rel,
                    "parsed_path": rel,
                }
            )
    return rows


def classify_plane(nx: Any, ny: Any, nz: Any) -> str | None:
    x = to_float(nx)
    y = to_float(ny)
    z = to_float(nz)
    if x is None or y is None or z is None:
        return None
    norm = math.sqrt(x * x + y * y + z * z)
    if norm < 1e-6:
        return "sky"
    z /= norm
    if abs(z) > 0.85:
        return "ground" if z < 0 else "roof"
    if abs(z) < 0.2:
        return "facade"
    return "oblique"


def source_url_from_summary(summary_path: Path) -> str | None:
    if not summary_path.exists():
        return None
    text = summary_path.read_text(errors="replace")
    match = re.search(r"- URL:\s*`([^`]+)`", text)
    if match:
        return match.group(1)
    match = re.search(r"https?://\S+", text)
    return match.group(0).rstrip("`") if match else None


def insert_rows(conn: Any, table: str, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    columns = list(rows[0].keys())
    placeholders = ", ".join(["?"] * len(columns))
    col_sql = ", ".join(columns)
    values = [[row.get(col) for col in columns] for row in rows]
    conn.executemany(f"INSERT INTO {table} ({col_sql}) VALUES ({placeholders})", values)


def extend_row_groups(target: dict[str, list[dict[str, Any]]], source: dict[str, list[dict[str, Any]]]) -> None:
    for table, rows in source.items():
        target.setdefault(table, []).extend(rows)


def collect_assets(
    roots: list[Path],
    test_root: Path,
    site_id: str | None,
    run_id: str | None,
    workspace_id: str | None,
    anchor_panoid: str | None,
    stack_id: str | None,
    source_urls_by_root: dict[Path, str | None],
    hash_mode: str,
    small_hash_bytes: int,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for root in roots:
        if not root.exists():
            continue
        root_source_url = source_urls_by_root.get(root.resolve(strict=False))
        files = [root] if root.is_file() else sorted(p for p in root.rglob("*") if p.is_file())
        for path in files:
            rel = rel_path(path, test_root)
            if not rel or rel in seen:
                continue
            seen.add(rel)
            stage = infer_stage(path, test_root)
            try:
                stat = path.stat()
                size = stat.st_size
                created = datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat()
            except OSError:
                size = None
                created = None
            path_anchor, path_stack = infer_temporal_context(path, test_root)
            rows.append(
                {
                    "asset_id": rel,
                    "stage": stage,
                    "site_id": site_id,
                    "run_id": run_id,
                    "workspace_id": workspace_id,
                    "anchor_panoid": path_anchor or anchor_panoid,
                    "stack_id": path_stack or stack_id,
                    "panoid": infer_panoid(path),
                    "asset_type": infer_asset_type(path),
                    "relative_path": rel,
                    "bytes": size,
                    "sha256": file_sha256(path, hash_mode, small_hash_bytes),
                    "source_url": root_source_url if stage == "raw" else None,
                    "created_at": created,
                }
            )
    return rows


def build_parsed_photometa(paths: Any, test_root: Path) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    candidates = parsed_photometa_candidates(paths)

    rows: list[dict[str, Any]] = []
    by_panoid: dict[str, dict[str, Any]] = {}
    seen: set[str] = set()
    for parsed_path in candidates:
        rel = rel_path(parsed_path, test_root)
        if rel in seen:
            continue
        seen.add(rel or str(parsed_path))
        summary = parse_photometa_summary(parsed_path, test_root)
        if not summary:
            continue
        panoid = summary.get("panoid")
        planes_path = depth_path = indexmap_path = None
        b2_grid_path = None
        if parsed_path.parent == paths.parsed_photometa_dir:
            stem = parsed_path.name[: -len("_parsed.json")]
            planes_path = existing_rel(paths.parsed_photometa_dir / f"{stem}_parsed_planes.json", test_root)
            indexmap_path = existing_rel(paths.parsed_photometa_dir / f"{stem}_parsed_indexmap.bin", test_root)
            b2_path = b2_grid_file_for(parsed_path, paths)
            b2_grid_path = existing_rel(b2_path, test_root) if b2_path else None
            depth_path = b2_grid_path

        row = {
            "site_id": paths.site,
            "run_id": paths.run_id,
            "workspace_id": paths.workspace_id,
            "panoid": panoid,
            "parsed_path": summary.get("parsed_path"),
            "planes_path": planes_path,
            "indexmap_path": indexmap_path,
            "depthmap_path": depth_path,
            "b2_grid_path": b2_grid_path,
            "n_planes": summary.get("n_planes"),
            "map_width": summary.get("map_width"),
            "map_height": summary.get("map_height"),
            "has_indexmap": summary.get("has_indexmap"),
            "has_depthmap": bool(depth_path) or bool(summary.get("has_indexmap")),
            "has_b2": summary.get("has_b2"),
            "heading_deg": summary.get("heading_deg"),
            "pitch_deg": summary.get("pitch_deg"),
            "roll_deg": summary.get("roll_deg"),
            "capture_year": summary.get("capture_year"),
            "capture_month": summary.get("capture_month"),
        }
        rows.append(row)
        if panoid:
            current = by_panoid.get(panoid)
            if current is None or "neighbor_photometas" in str(parsed_path):
                by_panoid[panoid] = row
    return rows, by_panoid


def build_spatial_rows(paths: Any, test_root: Path) -> dict[str, list[dict[str, Any]]]:
    pointcloud_meta_path = paths.depth_pointcloud_dir / "pointcloud_meta.json"
    pointcloud_meta = read_json(pointcloud_meta_path) or {}
    source_url = source_url_from_summary(paths.run_dir / "summary.md")
    parsed_rows, parsed_by_panoid = build_parsed_photometa(paths, test_root)

    panos = pointcloud_meta.get("panos") or []
    spatial_runs = [
        {
            "site_id": paths.site,
            "run_id": paths.run_id,
            "workspace_id": paths.workspace_id,
            "run_dir": rel_path(paths.run_dir, test_root),
            "source_url": source_url,
            "reference_panoid": pointcloud_meta.get("reference_panoid"),
            "reference_lat": to_float(pointcloud_meta.get("reference_lat")),
            "reference_lng": to_float(pointcloud_meta.get("reference_lng")),
            "pano_count": len(panos) if panos else None,
            "total_points": to_int(pointcloud_meta.get("total_points")),
            "distance_policy": json_text(pointcloud_meta.get("distance_policy")),
        }
    ]

    pano_rows: list[dict[str, Any]] = []
    for pano in panos:
        panoid = pano.get("panoid")
        world_pos = pano.get("world_pos") or []
        parsed = parsed_by_panoid.get(panoid, {})
        photometa_bin = paths.run_dir / "neighbor_photometas" / f"{panoid}.bin"
        pano_rows.append(
            {
                "site_id": paths.site,
                "run_id": paths.run_id,
                "workspace_id": paths.workspace_id,
                "panoid": panoid,
                "pano_idx": to_int(pano.get("pano_idx")),
                "lat": to_float(pano.get("lat")),
                "lng": to_float(pano.get("lng")),
                "east_m": to_float(safe_get(world_pos, 0)),
                "north_m": to_float(safe_get(world_pos, 1)),
                "up_m": to_float(safe_get(world_pos, 2)),
                "is_reference": panoid == pointcloud_meta.get("reference_panoid"),
                "n_planes": to_int(pano.get("n_planes")),
                "n_points": to_int(pano.get("n_points")),
                "effective_max_distance_m": to_float(pano.get("effective_max_distance_m")),
                "b2_unique_ids": json_text(pano.get("b2_unique_ids")),
                "panorama_path": existing_rel(paths.run_dir / "panoramas" / f"{panoid}.jpg", test_root),
                "photometa_path": existing_rel(photometa_bin, test_root),
                "parsed_path": parsed.get("parsed_path"),
                "pointcloud_meta_path": rel_path(pointcloud_meta_path, test_root) if pointcloud_meta_path.exists() else None,
            }
    )

    poi_rows: list[dict[str, Any]] = []
    for source_index, poi in enumerate(pointcloud_meta.get("poi_index") or []):
        ftid = poi.get("ftid") or []
        if not isinstance(ftid, list):
            ftid = [ftid]
        ftid_0 = str(ftid[0]) if len(ftid) > 0 and ftid[0] is not None else None
        ftid_1 = str(ftid[1]) if len(ftid) > 1 and ftid[1] is not None else None
        poi_rows.append(
            {
                "site_id": paths.site,
                "run_id": paths.run_id,
                "workspace_id": paths.workspace_id,
                "panoid": poi.get("panoid"),
                "poi_ref_type": "ftid_pair" if ftid_0 or ftid_1 else "unknown",
                "place_id": poi.get("place_id"),
                "ftid_0": ftid_0,
                "ftid_1": ftid_1,
                "name": poi.get("name"),
                "category": poi.get("type"),
                "icon_url": poi.get("icon"),
                "source_index": source_index,
                "source_field": "pointcloud_meta.poi_index",
            }
        )

    tile_rows: list[dict[str, Any]] = []
    for tile in read_json(paths.run_dir / "tile_inventory.json") or []:
        if not isinstance(tile, dict):
            continue
        tile_rows.append(
            {
                "site_id": paths.site,
                "run_id": paths.run_id,
                "workspace_id": paths.workspace_id,
                "panoid": tile.get("panoid"),
                "zoom": to_int(tile.get("zoom")),
                "x": to_int(tile.get("x")),
                "y": to_int(tile.get("y")),
                "url": tile.get("url"),
                "cb_client": tile.get("cb_client"),
                "nbt": str(tile.get("nbt")) if tile.get("nbt") is not None else None,
                "fover": str(tile.get("fover")) if tile.get("fover") is not None else None,
            }
        )

    return {
        "spatial_runs": spatial_runs,
        "pano_observations": pano_rows,
        "visible_pois": poi_rows,
        "b2_regions": build_b2_region_rows(paths, test_root),
        "tile_requests": tile_rows,
        "parsed_photometa": parsed_rows,
    }


def build_indexmap_rectification_rows(paths: Any, test_root: Path) -> list[dict[str, Any]]:
    filter_rows = read_csv_rows(paths.indexmap_rectified_dir / "filter_log.csv")
    shifts = {r.get("panoid"): r for r in read_csv_rows(paths.indexmap_overlay_dir / "shift_log.csv")}
    rows: list[dict[str, Any]] = []
    for row in filter_rows:
        panoid = row.get("panoid")
        shift = shifts.get(panoid, {})
        rows.append(
            {
                "workspace_id": paths.workspace_id,
                "site_id": paths.site,
                "run_id": paths.run_id,
                "panoid": panoid,
                "kept": to_bool(row.get("kept")),
                "reason": row.get("reason"),
                "n_planes": to_int(row.get("n_planes")),
                "pitch_off_deg": to_float(row.get("pitch_off_deg")),
                "roll_deg": to_float(row.get("roll_deg")),
                "horizon_amp_local_px": to_float(row.get("horizon_amp_local_px")),
                "horizon_amp_gravity_px": to_float(row.get("horizon_amp_gravity_px")),
                "shift_px": to_int(shift.get("shift_px")),
                "align_score": to_float(shift.get("align_score")),
                "zero_shift_score": to_float(shift.get("zero_shift_score")),
                "n_edge_pixels": to_int(shift.get("n_edge_pixels")),
                "edge_shift_px": to_int(shift.get("edge_shift_px")),
                "edge_align_score": to_float(shift.get("edge_align_score")),
                "sky_shift_px": to_int(shift.get("sky_shift_px")),
                "sky_corr_strength": to_float(shift.get("sky_corr_strength")),
                "method": shift.get("method"),
                "local_indexmap_path": existing_rel(paths.indexmap_rectified_dir / f"{panoid}_indexmap_local.bin", test_root),
                "gravity_indexmap_path": existing_rel(paths.indexmap_rectified_dir / f"{panoid}_indexmap_gravity.bin", test_root),
                "compare_path": existing_rel(paths.indexmap_rectified_dir / f"{panoid}_compare.png", test_root),
                "with_pano_path": existing_rel(paths.indexmap_rectified_dir / f"{panoid}_with_pano.png", test_root),
                "overlay_path": existing_rel(paths.indexmap_overlay_dir / f"{panoid}_overlay.png", test_root),
            }
        )
    return rows


def plane_pixel_counts(paths: Any) -> dict[tuple[str, int], int]:
    counts: dict[tuple[str, int], int] = {}
    support_manifest = paths.derived_root / "04b_factor_geometry/local_plane_supports.csv"
    for row in read_manifest_rows(support_manifest):
        panoid = row.get("panoid")
        local_idx = to_int(row.get("local_plane_id"))
        n_pixels = to_int(row.get("cell_count"))
        if panoid is not None and local_idx is not None and n_pixels is not None:
            counts[(panoid, local_idx)] = n_pixels
    if counts:
        return counts
    for planes_path in sorted(paths.parsed_photometa_dir.glob("*_parsed_planes.json")):
        data = read_json(planes_path) or {}
        panoid = data.get("panoid")
        pixels = data.get("pixelsPerPlane") or []
        for idx, n_pixels in enumerate(pixels):
            if panoid is not None and to_int(n_pixels) is not None:
                counts[(panoid, idx)] = to_int(n_pixels) or 0
    for row in read_csv_rows(paths.global_factors_dir / "sources.csv"):
        panoid = row.get("panoid")
        local_idx = to_int(row.get("local_idx"))
        n_pixels = to_int(row.get("n_pixels"))
        if panoid is not None and local_idx is not None and n_pixels is not None:
            counts.setdefault((panoid, local_idx), n_pixels)
    return counts


def build_plane_observation_rows(paths: Any, test_root: Path) -> list[dict[str, Any]]:
    pixels = plane_pixel_counts(paths)
    rows: list[dict[str, Any]] = []
    for source_path in sorted(paths.planes_world_dir.glob("*_planes_world.json")):
        data = read_json(source_path) or {}
        panoid = data.get("panoid") or infer_panoid(source_path)
        pose = data.get("pose") or {}
        local_planes = data.get("planes_local") or []
        world_planes = data.get("planes_world") or []
        for idx, local_plane in enumerate(local_planes):
            world_plane = world_planes[idx] if idx < len(world_planes) else []
            rows.append(
                {
                    "workspace_id": paths.workspace_id,
                    "site_id": paths.site,
                    "run_id": paths.run_id,
                    "panoid": panoid,
                    "local_plane_id": idx,
                    "n_pixels": pixels.get((panoid, idx)),
                    "class": classify_plane(safe_get(local_plane, 0), safe_get(local_plane, 1), safe_get(local_plane, 2)),
                    "local_nx": to_float(safe_get(local_plane, 0)),
                    "local_ny": to_float(safe_get(local_plane, 1)),
                    "local_nz": to_float(safe_get(local_plane, 2)),
                    "local_d": to_float(safe_get(local_plane, 3)),
                    "world_nx": to_float(safe_get(world_plane, 0)),
                    "world_ny": to_float(safe_get(world_plane, 1)),
                    "world_nz": to_float(safe_get(world_plane, 2)),
                    "world_d": to_float(safe_get(world_plane, 3)),
                    "heading_deg": to_float(pose.get("heading_deg")),
                    "pitch_deg": to_float(pose.get("pitch_deg")),
                    "pitch_off_deg": to_float(pose.get("pitch_off_deg")),
                    "roll_deg": to_float(pose.get("roll_deg")),
                    "source_json_path": rel_path(source_path, test_root),
                }
            )
    return rows


def build_global_factor_rows(paths: Any, test_root: Path) -> dict[str, list[dict[str, Any]]]:
    registry_path = paths.global_factors_dir / "registry.json"
    sources_path = paths.global_factors_dir / "sources.csv"
    registry = read_json(registry_path) or {}

    factor_rows: list[dict[str, Any]] = []
    for row in registry.get("registry") or []:
        factor_rows.append(
            {
                "workspace_id": paths.workspace_id,
                "gid": to_int(row.get("gid")),
                "class": row.get("classification"),
                "quality": row.get("quality"),
                "nx": to_float(row.get("nx")),
                "ny": to_float(row.get("ny")),
                "nz": to_float(row.get("nz")),
                "d_global": to_float(row.get("d_global")),
                "n_sources": to_int(row.get("n_sources")),
                "n_unique_panos": to_int(row.get("n_unique_panos")),
                "total_pixels": to_int(row.get("total_pixels")),
                "normal_consistency_min": to_float(row.get("normal_consistency_min")),
                "normal_consistency_mean": to_float(row.get("normal_consistency_mean")),
                "offset_spread_m": to_float(row.get("offset_spread_m")),
                "offset_std_m": to_float(row.get("offset_std_m")),
                "source_pixels_median": to_float(row.get("source_pixels_median")),
                "source_pixels_min": to_float(row.get("source_pixels_min")),
                "source_pixels_p10": to_float(row.get("source_pixels_p10")),
                "source_distance_median": to_float(row.get("source_distance_median")),
                "source_distance_p90": to_float(row.get("source_distance_p90")),
                "registry_path": rel_path(registry_path, test_root) if registry_path.exists() else None,
            }
        )

    source_rows: list[dict[str, Any]] = []
    for row in read_csv_rows(sources_path):
        source_rows.append(
            {
                "workspace_id": paths.workspace_id,
                "site_id": paths.site,
                "run_id": paths.run_id,
                "gid": to_int(row.get("gid")),
                "key": row.get("key"),
                "panoid": row.get("panoid"),
                "local_plane_id": to_int(row.get("local_idx")),
                "n_pixels": to_int(row.get("n_pixels")),
                "d_local": to_float(row.get("d_local")),
                "d_global": to_float(row.get("d_global")),
                "nx": to_float(row.get("n_x")),
                "ny": to_float(row.get("n_y")),
                "nz": to_float(row.get("n_z")),
                "class": row.get("classification"),
                "pano_east_m": to_float(row.get("pano_east_m")),
                "pano_north_m": to_float(row.get("pano_north_m")),
                "sources_path": rel_path(sources_path, test_root) if sources_path.exists() else None,
            }
        )
    return {"global_factors": factor_rows, "global_factor_sources": source_rows}


def build_temporal_stack_rows(
    *,
    test_root: Path,
    anchor: str,
    stack_id: str,
    stack_dir: Path,
    site_id: str | None = None,
    run_id: str | None = None,
    workspace_id: str | None = None,
    batch_id: str | None = None,
    stack_status: str | None = None,
    photometa_count: int | None = None,
) -> dict[str, list[dict[str, Any]]]:
    timeline_path = stack_dir / "timeline.json"
    timeline = read_json(timeline_path) or {}
    focal = timeline.get("focal") or {}

    stacks = [
        {
            "site_id": site_id,
            "run_id": run_id,
            "workspace_id": workspace_id,
            "batch_id": batch_id,
            "anchor_panoid": anchor,
            "stack_id": stack_id,
            "stack_status": stack_status,
            "photometa_count": photometa_count,
            "stack_dir": rel_path(stack_dir, test_root),
            "source_url": timeline.get("source_url"),
            "anchor_lat": to_float(focal.get("lat")),
            "anchor_lng": to_float(focal.get("lng")),
            "anchor_date": focal.get("date"),
            "harvested_at": timeline.get("harvested_at"),
            "capture_count": to_int(timeline.get("capture_count")),
            "timeline_path": rel_path(timeline_path, test_root) if timeline_path.exists() else None,
        }
    ]

    labels_by_panoid = {
        item.get("panoid"): item.get("date_label")
        for item in (timeline.get("captures") or [])
        if isinstance(item, dict)
    }
    captures: list[dict[str, Any]] = []
    for capture_dir in sorted((stack_dir / "captures").glob("*")):
        if not capture_dir.is_dir():
            continue
        meta_path = capture_dir / "meta.json"
        meta = read_json(meta_path) or {}
        year_month_raw = meta.get("capture_year_month")
        year_month = None
        if isinstance(year_month_raw, list) and len(year_month_raw) >= 2:
            year_month = f"{to_int(year_month_raw[0]):04d}-{to_int(year_month_raw[1]):02d}"
        pano_returned = meta.get("panoid_returned")
        captures.append(
            {
                "site_id": site_id,
                "run_id": run_id,
                "workspace_id": workspace_id,
                "batch_id": batch_id,
                "anchor_panoid": anchor,
                "stack_id": stack_id,
                "capture_id": capture_dir.name,
                "panoid_requested": meta.get("panoid_requested"),
                "panoid_returned": pano_returned,
                "date_label": meta.get("timeline_date_label") or labels_by_panoid.get(pano_returned),
                "date_short": meta.get("date_short"),
                "year_month": year_month,
                "is_focal": to_bool(meta.get("is_focal")),
                "capture_source": meta.get("capture_source"),
                "fetched_at": meta.get("fetched_at"),
                "bytes": to_int(meta.get("bytes")),
                "capture_dir": rel_path(capture_dir, test_root),
                "meta_path": rel_path(meta_path, test_root) if meta_path.exists() else None,
                "parsed_path": existing_rel(capture_dir / "parsed.json", test_root),
                "pointcloud_meta_path": existing_rel(capture_dir / "pointcloud_meta.json", test_root),
            }
        )

    return {"temporal_stacks": stacks, "temporal_captures": captures}


def build_temporal_rows(paths: Any, test_root: Path) -> dict[str, list[dict[str, Any]]]:
    rows = build_temporal_stack_rows(
        test_root=test_root,
        anchor=paths.anchor,
        stack_id=paths.stack_id,
        stack_dir=paths.stack_dir,
    )
    stacks = rows["temporal_stacks"]
    captures = rows["temporal_captures"]

    explosion_root = paths.factor_explosion_root / paths.anchor
    viewpoint_path = explosion_root / "viewpoint_index.json"
    viewpoint = read_json(viewpoint_path) or {}
    factor = viewpoint.get("factor") or {}
    target = factor.get("target_world_enu") or []
    outputs = viewpoint.get("render_outputs") or {}

    explosion: list[dict[str, Any]] = []
    cells: list[dict[str, Any]] = []
    if viewpoint:
        explosion.append(
            {
                "anchor_panoid": paths.anchor,
                "stack_id": paths.stack_id,
                "factor_local_plane_id": to_int(factor.get("plane_idx")),
                "factor_class": factor.get("class"),
                "factor_pixel_count": to_int(factor.get("pixel_count")),
                "target_east_m": to_float(safe_get(target, 0)),
                "target_north_m": to_float(safe_get(target, 1)),
                "target_up_m": to_float(safe_get(target, 2)),
                "max_match_dist_m": to_float(viewpoint.get("max_match_dist_m")),
                "n_rows": to_int(viewpoint.get("n_rows")),
                "n_cols": to_int(viewpoint.get("n_cols")),
                "grid_path": rel_path(outputs.get("grid") or (explosion_root / "grid.png"), test_root),
                "explosion_3d_path": rel_path(outputs.get("explosion_3d") or (explosion_root / "explosion_3d.png"), test_root),
                "index_path": rel_path(outputs.get("index") or (explosion_root / "index.md"), test_root),
                "viewpoint_index_path": rel_path(viewpoint_path, test_root),
                "raw_json": json_text({"factor": factor, "ref_columns": viewpoint.get("ref_columns")}),
            }
        )
        for cell in viewpoint.get("cells") or []:
            render = cell.get("render") or {}
            year = to_int(cell.get("year"))
            month = to_int(cell.get("month"))
            row_year_month = f"{year:04d}-{month:02d}" if year and month else None
            cells.append(
                {
                    "anchor_panoid": paths.anchor,
                    "stack_id": paths.stack_id,
                    "row_year_month": row_year_month,
                    "year": year,
                    "month": month,
                    "col_index": to_int(cell.get("col")),
                    "source_panoid": cell.get("ref_panoid"),
                    "matched_panoid": cell.get("matched_panoid"),
                    "matched_distance_m": to_float(cell.get("matched_dist_m")),
                    "matched_east_m": to_float(cell.get("matched_e")),
                    "matched_north_m": to_float(cell.get("matched_n")),
                    "kept": to_bool(cell.get("kept")),
                    "reason": cell.get("reason"),
                    "heading_deg": to_float(cell.get("heading_deg")),
                    "pitch_deg": to_float(cell.get("pitch_deg")),
                    "roll_deg": to_float(cell.get("roll_deg")),
                    "n_planes": to_int(cell.get("n_planes")),
                    "repair_attempted": to_bool(render.get("repair_attempted")),
                    "used_repaired": to_bool(render.get("used_repaired")),
                    "repair_status": render.get("repair_status"),
                    "black_fraction": to_float(render.get("black_fraction")),
                    "original_black_fraction": to_float(render.get("original_black_fraction")),
                    "target_azimuth_deg": to_float(render.get("target_azimuth_deg")),
                    "target_roll_shift_px": to_int(render.get("target_roll_shift_px")),
                    "image_path": rel_path(render.get("render_jpg_path"), test_root),
                    "overlay_path": None,
                    "raw_json": json_text(cell),
                }
            )

    return {
        "temporal_stacks": stacks,
        "temporal_captures": captures,
        "temporal_factor_explosion": explosion,
        "temporal_factor_cells": cells,
    }


def temporal_batch_manifest_paths(args: argparse.Namespace, paths: Any, test_root: Path) -> list[Path]:
    batch_root = test_root / "data/raw/google_maps/temporal_batches" / paths.site
    batch_id = getattr(args, "temporal_batch_id", None)
    if batch_id:
        manifest_path = batch_root / batch_id / "manifest.json"
        return [manifest_path] if manifest_path.exists() else []
    if getattr(args, "all_temporal_batches", False):
        return sorted(batch_root.glob("*/manifest.json")) if batch_root.exists() else []
    manifests = sorted(batch_root.glob("*/manifest.json")) if batch_root.exists() else []
    return manifests[-1:] if manifests else []


def temporal_stack_path_from_manifest_row(row: dict[str, Any], test_root: Path) -> Path | None:
    stack_rel = row.get("stack_dir")
    if not stack_rel:
        attempts = row.get("attempts") or []
        for attempt in reversed(attempts):
            if isinstance(attempt, dict) and attempt.get("stack_dir"):
                stack_rel = attempt.get("stack_dir")
                break
    if not stack_rel:
        return None
    stack_path = Path(stack_rel)
    return stack_path if stack_path.is_absolute() else test_root / stack_path


def build_temporal_batch_rows(
    manifest_paths: list[Path],
    paths: Any,
    test_root: Path,
) -> dict[str, list[dict[str, Any]]]:
    rows: dict[str, list[dict[str, Any]]] = {
        "temporal_batches": [],
        "temporal_stacks": [],
        "temporal_captures": [],
    }
    seen_stacks: set[tuple[str, str]] = set()
    for manifest_path in manifest_paths:
        manifest = read_json(manifest_path) or {}
        batch_id = manifest.get("batch_id") or manifest_path.parent.name
        summary = manifest.get("summary") or {}
        rows["temporal_batches"].append(
            {
                "site_id": paths.site,
                "run_id": manifest.get("run_id") or paths.run_id,
                "workspace_id": paths.workspace_id,
                "batch_id": batch_id,
                "batch_dir": rel_path(manifest_path.parent, test_root),
                "manifest_path": rel_path(manifest_path, test_root),
                "started_at": manifest.get("started_at"),
                "finished_at": manifest.get("finished_at"),
                "target_count": to_int(manifest.get("target_count")),
                "ok_count": to_int(summary.get("ok")),
                "skipped_existing_count": to_int(summary.get("skipped_existing")),
                "no_timeline_captures_count": to_int(summary.get("no_timeline_captures")),
                "failed_count": to_int(summary.get("failed")),
                "timeline_captures": to_int(summary.get("timeline_captures")),
                "photometa_count": to_int(summary.get("photometa_count")),
                "strategy_json": json_text(manifest.get("strategy")),
            }
        )

        manifest_rows = manifest.get("rows") or manifest.get("stacks") or []
        for row in manifest_rows:
            if not isinstance(row, dict):
                continue
            target = row.get("target") or {}
            anchor = row.get("panoid") or target.get("panoid")
            stack_dir = temporal_stack_path_from_manifest_row(row, test_root)
            if not anchor or not stack_dir or not (stack_dir / "timeline.json").exists():
                continue
            stack_id = stack_dir.name
            key = (anchor, stack_id)
            if key in seen_stacks:
                continue
            seen_stacks.add(key)
            stack_rows = build_temporal_stack_rows(
                test_root=test_root,
                anchor=anchor,
                stack_id=stack_id,
                stack_dir=stack_dir,
                site_id=paths.site,
                run_id=paths.run_id,
                workspace_id=paths.workspace_id,
                batch_id=batch_id,
                stack_status=row.get("status"),
                photometa_count=to_int(row.get("photometa_count") or row.get("photometa_ok")),
            )
            extend_row_groups(rows, stack_rows)
    return rows


def build_generated_geometry_rows(paths: Any, test_root: Path, temporal_paths: Any | None) -> dict[str, list[dict[str, Any]]]:
    factor_geometry_dir = paths.derived_root / "04b_factor_geometry"
    visibility_dir = paths.derived_root / "04c_factor_visibility"
    crop_dir = paths.derived_root / "05_surface_crops"
    stitch_dir = paths.derived_root / "06_surface_stitching"
    comparison_dir = paths.derived_root / "07_temporal_surface_comparison"

    rows = {
        "local_plane_supports": read_manifest_rows(factor_geometry_dir / "local_plane_supports.csv"),
        "local_plane_boundaries_3d": read_manifest_rows(factor_geometry_dir / "local_plane_boundaries_3d.csv"),
        "factor_geometries": read_manifest_rows(factor_geometry_dir / "factor_geometries.csv"),
        "factor_visibility_candidates": read_manifest_rows(visibility_dir / "factor_visibility_candidates.csv"),
        "factor_observation_quality": read_manifest_rows(visibility_dir / "factor_observation_quality.csv"),
        "surface_crops": read_manifest_rows(crop_dir / "surface_crops.csv"),
        "surface_rectified_observations": read_manifest_rows(stitch_dir / "surface_rectified_observations.csv"),
        "surface_stitches": read_manifest_rows(stitch_dir / "surface_stitches.csv"),
        "temporal_surface_comparisons": read_manifest_rows(comparison_dir / "temporal_surface_comparisons.csv"),
        "temporal_factor_correspondences": [],
    }
    if temporal_paths:
        temporal_corr = test_root / "data/derived/temporal" / temporal_paths.anchor / "factor_correspondences" / "temporal_factor_correspondences.csv"
        rows["temporal_factor_correspondences"] = read_manifest_rows(temporal_corr)
    comparison_corrs = sorted(comparison_dir.glob("**/temporal_factor_correspondences.csv")) if comparison_dir.exists() else []
    seen_corr_paths = {
        row.get("correspondence_path")
        for row in rows["temporal_factor_correspondences"]
        if row.get("correspondence_path")
    }
    for corr_path in comparison_corrs:
        corr_rel = rel_path(corr_path, test_root)
        if corr_rel in seen_corr_paths:
            continue
        rows["temporal_factor_correspondences"].extend(read_manifest_rows(corr_path))
    return rows


def load_schema(conn: Any, schema_path: Path) -> None:
    schema_sql = schema_path.read_text()
    for statement in schema_sql.split(";"):
        sql = statement.strip()
        if sql:
            conn.execute(sql)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build the Street View geometry DuckDB catalog.")
    parser.add_argument("--test-root", type=Path, default=default_test_root(), help="TEST project root")
    parser.add_argument("--catalog", type=Path, default=Path("data/catalog/sv3d.duckdb"), help="Output DuckDB path")
    parser.add_argument("--schema", type=Path, default=Path("schema/sv3d_catalog.sql"), help="Catalog schema SQL")
    parser.add_argument("--keep-existing", action="store_true", help="Append to an existing catalog instead of replacing it")
    parser.add_argument("--hash-assets", choices=("none", "small", "all"), default="small", help="Asset hashing policy")
    parser.add_argument("--small-hash-max-mb", type=float, default=DEFAULT_SMALL_HASH_MB)

    parser.add_argument("--run-dir", type=Path, default=None, help="Raw spatial run directory")
    parser.add_argument("--site", default=None, help="Spatial site id")
    parser.add_argument("--run-id", default=None, help="Spatial run id")
    parser.add_argument("--workspace-id", default=None, help="Spatial workspace id")
    parser.add_argument("--intermediate-root", type=Path, default=None)
    parser.add_argument("--derived-root", type=Path, default=None)
    parser.add_argument("--diagnostics-root", type=Path, default=None)

    parser.add_argument("--stack-dir", type=Path, default=None, help="Raw temporal stack directory")
    parser.add_argument("--anchor", default=None, help="Temporal anchor panoid")
    parser.add_argument("--stack-id", default=None, help="Temporal stack id")
    parser.add_argument("--temporal-batch-id", default=None, help="Temporal batch id under data/raw/google_maps/temporal_batches/<site>/")
    parser.add_argument("--all-temporal-batches", action="store_true", help="Index all temporal batch manifests for the selected site")
    parser.add_argument("--out-root", type=Path, default=None, help="Temporal diagnostics output root")
    return parser.parse_args()


def resolve_optional_temporal(args: argparse.Namespace) -> tuple[Any | None, str | None]:
    if (args.temporal_batch_id or args.all_temporal_batches) and not (args.stack_dir or args.anchor or args.stack_id):
        return None, None
    temporal_root = Path(args.test_root).resolve() / "data/raw/google_maps/temporal"
    if not temporal_root.exists() and args.stack_dir is None:
        return None, "No temporal raw root found"
    try:
        return resolve_temporal_paths(args), None
    except Exception as exc:
        return None, str(exc)


def main() -> int:
    args = parse_args()
    test_root = Path(args.test_root).resolve()
    catalog_path = args.catalog if args.catalog.is_absolute() else test_root / args.catalog
    schema_path = args.schema if args.schema.is_absolute() else test_root / args.schema
    small_hash_bytes = int(args.small_hash_max_mb * 1024 * 1024)

    duckdb = require_duckdb()
    paths = resolve_spatial_paths(args)
    temporal_paths, temporal_warning = resolve_optional_temporal(args)
    temporal_batch_manifests = temporal_batch_manifest_paths(args, paths, test_root)
    source_url = source_url_from_summary(paths.run_dir / "summary.md")

    catalog_path.parent.mkdir(parents=True, exist_ok=True)
    if catalog_path.exists() and not args.keep_existing:
        catalog_path.unlink()
    wal_path = catalog_path.with_suffix(catalog_path.suffix + ".wal")
    if wal_path.exists() and not args.keep_existing:
        wal_path.unlink()

    conn = duckdb.connect(str(catalog_path))
    load_schema(conn, schema_path)

    built_at = datetime.now(timezone.utc).isoformat()
    warnings = [temporal_warning] if temporal_warning else []
    meta = {
        "schema_version": SCHEMA_VERSION,
        "built_at_utc": built_at,
        "test_root": ".",
        "default_site": paths.site,
        "default_run_id": paths.run_id,
        "default_workspace_id": paths.workspace_id,
        "default_anchor": temporal_paths.anchor if temporal_paths else None,
        "default_stack_id": temporal_paths.stack_id if temporal_paths else None,
        "default_temporal_batch_id": temporal_batch_manifests[-1].parent.name if temporal_batch_manifests else None,
        "hash_assets": args.hash_assets,
        "small_hash_max_mb": str(args.small_hash_max_mb),
        "build_warnings_json": json_text([w for w in warnings if w]),
    }
    insert_rows(conn, "catalog_meta", [{"key": k, "value": v} for k, v in meta.items()])

    row_groups = build_spatial_rows(paths, test_root)
    row_groups["indexmap_rectification"] = build_indexmap_rectification_rows(paths, test_root)
    row_groups["plane_observations"] = build_plane_observation_rows(paths, test_root)
    row_groups.update(build_global_factor_rows(paths, test_root))
    if temporal_batch_manifests:
        extend_row_groups(row_groups, build_temporal_batch_rows(temporal_batch_manifests, paths, test_root))
    if temporal_paths:
        extend_row_groups(row_groups, build_temporal_rows(temporal_paths, test_root))
    row_groups.update(build_generated_geometry_rows(paths, test_root, temporal_paths))

    asset_roots = [
        paths.run_dir,
        paths.parsed_photometa_dir,
        paths.depth_pointcloud_dir,
        paths.indexmap_rectified_dir,
        paths.planes_world_dir,
        paths.global_factors_dir,
        paths.indexmap_overlay_dir,
        paths.diagnostics_root / "factor_geometry",
        paths.diagnostics_root / "surface_fusion",
        paths.derived_root / "04b_factor_geometry",
        paths.derived_root / "04c_factor_visibility",
        paths.derived_root / "05_surface_crops",
        paths.derived_root / "06_surface_stitching",
        paths.derived_root / "07_temporal_surface_comparison",
    ]
    if temporal_paths:
        asset_roots.extend(
            [
                temporal_paths.stack_dir,
                temporal_paths.factor_explosion_root / temporal_paths.anchor,
                test_root / "data/derived/temporal" / temporal_paths.anchor / "factor_correspondences",
            ]
        )
    for manifest_path in temporal_batch_manifests:
        asset_roots.append(manifest_path.parent)
        manifest = read_json(manifest_path) or {}
        for row in manifest.get("rows") or manifest.get("stacks") or []:
            if not isinstance(row, dict):
                continue
            stack_dir = temporal_stack_path_from_manifest_row(row, test_root)
            if stack_dir and stack_dir.exists():
                asset_roots.append(stack_dir)
    source_urls_by_root = {root.resolve(strict=False): None for root in asset_roots}
    source_urls_by_root[paths.run_dir.resolve(strict=False)] = source_url
    if temporal_paths:
        timeline = read_json(temporal_paths.stack_dir / "timeline.json") or {}
        source_urls_by_root[temporal_paths.stack_dir.resolve(strict=False)] = timeline.get("source_url")
    for manifest_path in temporal_batch_manifests:
        manifest = read_json(manifest_path) or {}
        for row in manifest.get("rows") or manifest.get("stacks") or []:
            if not isinstance(row, dict):
                continue
            stack_dir = temporal_stack_path_from_manifest_row(row, test_root)
            if stack_dir and stack_dir.exists():
                timeline = read_json(stack_dir / "timeline.json") or {}
                source_urls_by_root[stack_dir.resolve(strict=False)] = timeline.get("source_url")
    row_groups["raw_assets"] = collect_assets(
        asset_roots,
        test_root,
        paths.site,
        paths.run_id,
        paths.workspace_id,
        temporal_paths.anchor if temporal_paths else None,
        temporal_paths.stack_id if temporal_paths else None,
        source_urls_by_root,
        args.hash_assets,
        small_hash_bytes,
    )

    for table, rows in row_groups.items():
        insert_rows(conn, table, rows)

    counts = {table: len(rows) for table, rows in sorted(row_groups.items())}
    conn.close()
    print(
        json.dumps(
            {
                "catalog": rel_path(catalog_path, test_root),
                "schema_version": SCHEMA_VERSION,
                "counts": counts,
                "warnings": [w for w in warnings if w],
            },
            indent=2,
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
