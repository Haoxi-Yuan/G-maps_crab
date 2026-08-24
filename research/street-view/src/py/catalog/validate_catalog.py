#!/usr/bin/env python3
"""Validate the Street View geometry DuckDB catalog."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REQUIRED_TABLES = [
    "catalog_meta",
    "spatial_runs",
    "raw_assets",
    "temporal_batches",
    "pano_observations",
    "visible_pois",
    "b2_regions",
    "tile_requests",
    "parsed_photometa",
    "indexmap_rectification",
    "plane_observations",
    "global_factors",
    "global_factor_sources",
    "local_plane_supports",
    "local_plane_boundaries_3d",
    "factor_geometries",
    "factor_visibility_candidates",
    "factor_observation_quality",
    "temporal_stacks",
    "temporal_captures",
    "temporal_factor_explosion",
    "temporal_factor_cells",
    "temporal_factor_correspondences",
    "surface_crops",
    "surface_rectified_observations",
    "surface_stitches",
    "temporal_surface_comparisons",
]

PATH_COLUMNS = {
    "spatial_runs": ["run_dir"],
    "raw_assets": ["relative_path"],
    "temporal_batches": ["batch_dir", "manifest_path"],
    "pano_observations": ["panorama_path", "photometa_path", "parsed_path", "pointcloud_meta_path"],
    "parsed_photometa": ["parsed_path", "planes_path", "indexmap_path", "depthmap_path", "b2_grid_path"],
    "b2_regions": ["b2_grid_path", "parsed_path"],
    "indexmap_rectification": [
        "local_indexmap_path",
        "gravity_indexmap_path",
        "compare_path",
        "with_pano_path",
        "overlay_path",
    ],
    "plane_observations": ["source_json_path"],
    "global_factors": ["registry_path"],
    "global_factor_sources": ["sources_path"],
    "local_plane_supports": ["mask_path", "contour_path", "indexmap_path", "stage_path"],
    "local_plane_boundaries_3d": ["boundary_points_path", "support_path"],
    "factor_geometries": ["geometry_path"],
    "factor_visibility_candidates": ["visibility_path"],
    "factor_observation_quality": ["support_path", "boundary_path"],
    "temporal_stacks": ["stack_dir", "timeline_path"],
    "temporal_captures": ["capture_dir", "meta_path", "parsed_path", "pointcloud_meta_path"],
    "temporal_factor_explosion": ["grid_path", "explosion_3d_path", "index_path", "viewpoint_index_path"],
    "temporal_factor_cells": ["image_path", "overlay_path"],
    "temporal_factor_correspondences": ["crop_path", "overlay_path", "correspondence_path"],
    "surface_crops": ["crop_path", "mask_path"],
    "surface_rectified_observations": ["rectified_path", "mask_path", "atlas_json_path", "source_crop_path"],
    "surface_stitches": ["texture_path", "contribution_map_path", "atlas_json_path", "preview_path", "rectified_stack_path"],
    "temporal_surface_comparisons": ["diff_path", "report_path"],
}


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


def rel_path(path: Path, root: Path) -> str:
    try:
        return path.resolve(strict=False).relative_to(root.resolve(strict=False)).as_posix()
    except ValueError:
        return str(path)


def table_count(conn: Any, table: str) -> int:
    return int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])


def table_columns(conn: Any, table: str) -> set[str]:
    return {row[0] for row in conn.execute(f"DESCRIBE {table}").fetchall()}


def nonempty_values(conn: Any, table: str, column: str) -> list[str]:
    rows = conn.execute(
        f"SELECT {column} FROM {table} WHERE {column} IS NOT NULL AND CAST({column} AS VARCHAR) <> ''"
    ).fetchall()
    return [str(row[0]) for row in rows]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate the Street View geometry DuckDB catalog.")
    parser.add_argument("--test-root", type=Path, default=default_test_root(), help="TEST project root")
    parser.add_argument("--catalog", type=Path, default=Path("data/catalog/sv3d.duckdb"), help="DuckDB catalog path")
    parser.add_argument("--report", type=Path, default=None, help="Validation report JSON path")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    test_root = Path(args.test_root).resolve()
    catalog_path = args.catalog if args.catalog.is_absolute() else test_root / args.catalog
    report_path = args.report if args.report else catalog_path.with_name("validation_report.json")
    report_path = report_path if report_path.is_absolute() else test_root / report_path

    duckdb = require_duckdb()
    failures: list[str] = []
    warnings: list[str] = []
    metrics: dict[str, Any] = {}

    if not catalog_path.exists():
        failures.append(f"Catalog file does not exist: {catalog_path}")
        report = {
            "catalog": rel_path(catalog_path, test_root),
            "validated_at_utc": datetime.now(timezone.utc).isoformat(),
            "status": "fail",
            "failures": failures,
            "warnings": warnings,
            "metrics": metrics,
        }
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False))
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return 1

    conn = duckdb.connect(str(catalog_path), read_only=True)
    existing_tables = {row[0] for row in conn.execute("SHOW TABLES").fetchall()}
    missing_tables = [table for table in REQUIRED_TABLES if table not in existing_tables]
    if missing_tables:
        failures.append(f"Missing required tables: {', '.join(missing_tables)}")

    for table in REQUIRED_TABLES:
        if table in existing_tables:
            metrics[f"{table}.count"] = table_count(conn, table)

    if "spatial_runs" in existing_tables:
        spatial_count = table_count(conn, "spatial_runs")
        if spatial_count < 1:
            failures.append("spatial_runs has no rows")
        for site_id, run_id, expected_count in conn.execute(
            "SELECT site_id, run_id, pano_count FROM spatial_runs"
        ).fetchall():
            observed = conn.execute(
                "SELECT COUNT(*) FROM pano_observations WHERE site_id = ? AND run_id = ?",
                [site_id, run_id],
            ).fetchone()[0]
            if expected_count is not None and int(observed) != int(expected_count):
                failures.append(
                    f"pano_observations count mismatch for {site_id}/{run_id}: "
                    f"expected {expected_count}, observed {observed}"
                )

    if "raw_assets" in existing_tables:
        for asset_type in ("photometa_bin", "panorama_jpg"):
            count = conn.execute(
                "SELECT COUNT(*) FROM raw_assets WHERE asset_type = ?", [asset_type]
            ).fetchone()[0]
            if int(count) == 0:
                failures.append(f"raw_assets has no {asset_type} rows")

    if "temporal_batches" in existing_tables and table_count(conn, "temporal_batches") > 0:
        if "temporal_stacks" in existing_tables and table_count(conn, "temporal_stacks") == 0:
            failures.append("temporal_batches exists but temporal_stacks is empty")
        if "temporal_captures" in existing_tables:
            batch_photometa = conn.execute(
                "SELECT COALESCE(SUM(photometa_count), 0) FROM temporal_batches"
            ).fetchone()[0]
            capture_rows = table_count(conn, "temporal_captures")
            if int(batch_photometa) > 0 and capture_rows == 0:
                failures.append("temporal_batches reports photometa captures but temporal_captures is empty")

    if "pano_observations" in existing_tables and table_count(conn, "pano_observations") == 0:
        failures.append("pano_observations has no rows")

    if "visible_pois" in existing_tables:
        poi_count = table_count(conn, "visible_pois")
        if poi_count == 0:
            warnings.append("visible_pois has no rows")
        bad_pois = conn.execute(
            """
            SELECT COUNT(*)
            FROM visible_pois
            WHERE COALESCE(place_id, '') = ''
              AND COALESCE(ftid_0, '') = ''
              AND COALESCE(ftid_1, '') = ''
            """
        ).fetchone()[0]
        if int(bad_pois) > 0:
            failures.append(f"visible_pois has {bad_pois} rows without place_id or ftid pair")

    if "parsed_photometa" in existing_tables and "b2_regions" in existing_tables:
        b2_photometa = conn.execute("SELECT COUNT(*) FROM parsed_photometa WHERE has_b2").fetchone()[0]
        b2_region_count = table_count(conn, "b2_regions")
        if int(b2_photometa) > 0 and b2_region_count == 0:
            warnings.append("parsed_photometa has b2 grids but b2_regions is empty")
        missing_targets = conn.execute(
            "SELECT COUNT(*) FROM b2_regions WHERE target_panoid IS NULL"
        ).fetchone()[0]
        if int(missing_targets) > 0:
            warnings.append(f"b2_regions has {missing_targets} rows without inferred target_panoid")

    if "global_factors" in existing_tables and "global_factor_sources" in existing_tables:
        factor_count = table_count(conn, "global_factors")
        source_count = table_count(conn, "global_factor_sources")
        if factor_count > 0 and source_count == 0:
            warnings.append("global_factors exists but global_factor_sources is empty")
        orphan_count = conn.execute(
            """
            SELECT COUNT(*)
            FROM global_factor_sources s
            LEFT JOIN global_factors g
              ON s.workspace_id = g.workspace_id AND s.gid = g.gid
            WHERE s.gid IS NOT NULL AND g.gid IS NULL
            """
        ).fetchone()[0]
        if int(orphan_count) > 0:
            failures.append(f"global_factor_sources has {orphan_count} orphan rows")

    if "plane_observations" in existing_tables and "local_plane_supports" in existing_tables:
        support_count = table_count(conn, "local_plane_supports")
        plane_count = table_count(conn, "plane_observations")
        if plane_count > 0 and support_count == 0:
            warnings.append("plane_observations exists but local_plane_supports is empty")
        if support_count > 0:
            mismatch = conn.execute(
                """
                SELECT COUNT(*)
                FROM plane_observations p
                JOIN local_plane_supports s
                  ON p.workspace_id = s.workspace_id
                 AND p.panoid = s.panoid
                 AND p.local_plane_id = s.local_plane_id
                WHERE p.n_pixels IS NOT NULL
                  AND s.cell_count IS NOT NULL
                  AND CAST(p.n_pixels AS BIGINT) <> CAST(s.cell_count AS BIGINT)
                """
            ).fetchone()[0]
            if int(mismatch) > 0:
                failures.append(f"local_plane_supports has {mismatch} cell_count mismatches against plane_observations")

    if "global_factor_sources" in existing_tables and "local_plane_supports" in existing_tables and "local_plane_boundaries_3d" in existing_tables:
        source_count = table_count(conn, "global_factor_sources")
        if source_count > 0 and table_count(conn, "local_plane_supports") > 0:
            missing_support = conn.execute(
                """
                SELECT COUNT(*)
                FROM global_factor_sources s
                LEFT JOIN local_plane_supports l
                  ON s.workspace_id = l.workspace_id
                 AND s.panoid = l.panoid
                 AND s.local_plane_id = l.local_plane_id
                WHERE l.panoid IS NULL
                """
            ).fetchone()[0]
            if int(missing_support) > 0:
                failures.append(f"global_factor_sources has {missing_support} rows without local_plane_supports")
        if source_count > 0 and table_count(conn, "local_plane_boundaries_3d") > 0:
            missing_boundary = conn.execute(
                """
                SELECT COUNT(*)
                FROM global_factor_sources s
                LEFT JOIN local_plane_boundaries_3d b
                  ON s.workspace_id = b.workspace_id
                 AND s.panoid = b.panoid
                 AND s.local_plane_id = b.local_plane_id
                WHERE b.panoid IS NULL
                """
            ).fetchone()[0]
            if int(missing_boundary) > 0:
                failures.append(f"global_factor_sources has {missing_boundary} rows without local_plane_boundaries_3d")

    if "surface_crops" in existing_tables and table_count(conn, "surface_crops") > 0:
        bad_crops = conn.execute(
            """
            SELECT COUNT(*)
            FROM surface_crops
            WHERE COALESCE(crop_path, '') = ''
               OR COALESCE(mask_path, '') = ''
               OR COALESCE(status, '') = ''
               OR purity_score IS NULL
               OR completeness_score IS NULL
            """
        ).fetchone()[0]
        if int(bad_crops) > 0:
            failures.append(f"surface_crops has {bad_crops} incomplete rows")

    if "surface_rectified_observations" in existing_tables and table_count(conn, "surface_rectified_observations") > 0:
        bad_rectified = conn.execute(
            """
            SELECT COUNT(*)
            FROM surface_rectified_observations
            WHERE COALESCE(rectified_path, '') = ''
               OR COALESCE(mask_path, '') = ''
               OR COALESCE(status, '') = ''
               OR valid_fraction IS NULL
            """
        ).fetchone()[0]
        if int(bad_rectified) > 0:
            failures.append(f"surface_rectified_observations has {bad_rectified} incomplete rows")

    if "temporal_stacks" in existing_tables and table_count(conn, "temporal_stacks") > 0:
        if "temporal_captures" in existing_tables and table_count(conn, "temporal_captures") == 0:
            warnings.append("temporal_stacks exists but temporal_captures is empty")
        if (
            "temporal_factor_explosion" in existing_tables
            and table_count(conn, "temporal_factor_explosion") > 0
            and "temporal_factor_cells" in existing_tables
            and table_count(conn, "temporal_factor_cells") == 0
        ):
            warnings.append("temporal_factor_explosion exists but temporal_factor_cells is empty")
        if "temporal_factor_correspondences" in existing_tables and table_count(conn, "temporal_factor_correspondences") == 0:
            warnings.append("temporal_stacks exists but temporal_factor_correspondences is empty")

    for table, columns in PATH_COLUMNS.items():
        if table not in existing_tables:
            continue
        existing_columns = table_columns(conn, table)
        for column in columns:
            if column not in existing_columns:
                continue
            for value in nonempty_values(conn, table, column):
                if value.startswith(("http://", "https://")):
                    continue
                if os.path.isabs(value):
                    failures.append(f"{table}.{column} contains absolute path: {value}")
                    continue
                if not (test_root / value).exists():
                    failures.append(f"{table}.{column} path does not exist: {value}")

    conn.close()

    status = "pass" if not failures else "fail"
    report = {
        "catalog": rel_path(catalog_path, test_root),
        "validated_at_utc": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "failures": failures,
        "warnings": warnings,
        "metrics": metrics,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if status == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
