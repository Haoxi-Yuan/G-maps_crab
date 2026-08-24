"""Shared path helpers for the Street View geometry workflow.

Scripts in this project should not hard-code machine-specific paths, sample
site names, run timestamps, or panoids. Use these helpers to resolve the active
workspace from command-line arguments and the repository layout.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path


def test_root() -> Path:
    """Return the TEST project root from this module's location."""
    return Path(__file__).resolve().parents[2]


def _existing_dirs(root: Path) -> list[Path]:
    return sorted([p for p in root.iterdir() if p.is_dir()]) if root.exists() else []


def _choose_one(candidates: list[Path], label: str) -> Path:
    if not candidates:
        raise FileNotFoundError(f"No {label} directories found")
    if len(candidates) > 1:
        names = ", ".join(p.name for p in candidates[:8])
        raise ValueError(f"Multiple {label} directories found; pass an explicit argument. Candidates: {names}")
    return candidates[0]


def _latest(candidates: list[Path], label: str) -> Path:
    if not candidates:
        raise FileNotFoundError(f"No {label} directories found")
    return sorted(candidates, key=lambda p: p.name)[-1]


def add_spatial_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--test-root", type=Path, default=test_root(), help="TEST project root")
    parser.add_argument("--run-dir", type=Path, default=None, help="Raw spatial run directory; overrides --site/--run-id")
    parser.add_argument("--site", default=None, help="Spatial site id under data/raw/google_maps/spatial/")
    parser.add_argument("--run-id", default=None, help="Raw run id under data/raw/google_maps/spatial/<site>/")
    parser.add_argument(
        "--workspace-id",
        default=None,
        help="Analysis workspace id under data/{intermediate,derived,diagnostics}/; defaults to --site",
    )
    parser.add_argument("--intermediate-root", type=Path, default=None, help="Override intermediate workspace root")
    parser.add_argument("--derived-root", type=Path, default=None, help="Override derived workspace root")
    parser.add_argument("--diagnostics-root", type=Path, default=None, help="Override diagnostics workspace root")


@dataclass(frozen=True)
class SpatialPaths:
    test_root: Path
    site: str
    run_id: str
    workspace_id: str
    run_dir: Path
    intermediate_root: Path
    derived_root: Path
    diagnostics_root: Path
    parsed_photometa_dir: Path
    depth_pointcloud_dir: Path
    indexmap_rectified_dir: Path
    planes_world_dir: Path
    global_factors_dir: Path
    indexmap_overlay_dir: Path


def resolve_spatial_paths(args: argparse.Namespace) -> SpatialPaths:
    root = Path(args.test_root).resolve()
    raw_spatial_root = root / "data/raw/google_maps/spatial"

    if args.run_dir is not None:
        run_dir = Path(args.run_dir).resolve()
        run_id = run_dir.name
        site = args.site or run_dir.parent.name
    else:
        site_dir = raw_spatial_root / args.site if args.site else _choose_one(_existing_dirs(raw_spatial_root), "spatial site")
        site = site_dir.name
        run_dir = site_dir / args.run_id if args.run_id else _latest(_existing_dirs(site_dir), f"spatial run for {site}")
        run_id = run_dir.name

    if not run_dir.exists():
        raise FileNotFoundError(f"Raw spatial run directory does not exist: {run_dir}")

    workspace_id = args.workspace_id or site
    intermediate_root = Path(args.intermediate_root).resolve() if args.intermediate_root else root / "data/intermediate" / workspace_id
    derived_root = Path(args.derived_root).resolve() if args.derived_root else root / "data/derived" / workspace_id
    diagnostics_root = Path(args.diagnostics_root).resolve() if args.diagnostics_root else root / "data/diagnostics" / workspace_id

    return SpatialPaths(
        test_root=root,
        site=site,
        run_id=run_id,
        workspace_id=workspace_id,
        run_dir=run_dir,
        intermediate_root=intermediate_root,
        derived_root=derived_root,
        diagnostics_root=diagnostics_root,
        parsed_photometa_dir=intermediate_root / "00_parsed_photometa",
        depth_pointcloud_dir=intermediate_root / "01_depthmap_pointcloud_baseline",
        indexmap_rectified_dir=intermediate_root / "02_indexmap_rectified",
        planes_world_dir=intermediate_root / "03_planes_world",
        global_factors_dir=derived_root / "04_global_factors_refined",
        indexmap_overlay_dir=diagnostics_root / "indexmap_overlay",
    )


def add_temporal_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--test-root", type=Path, default=test_root(), help="TEST project root")
    parser.add_argument("--stack-dir", type=Path, default=None, help="Raw temporal stack directory")
    parser.add_argument("--anchor", default=None, help="Anchor panoid under data/raw/google_maps/temporal/")
    parser.add_argument("--stack-id", default=None, help="Temporal stack id under data/raw/google_maps/temporal/<anchor>/")
    parser.add_argument("--out-root", type=Path, default=None, help="Diagnostic output root")


@dataclass(frozen=True)
class TemporalPaths:
    test_root: Path
    anchor: str
    stack_id: str
    stack_dir: Path
    factor_explosion_root: Path


def resolve_temporal_paths(args: argparse.Namespace) -> TemporalPaths:
    root = Path(args.test_root).resolve()
    temporal_root = root / "data/raw/google_maps/temporal"

    if args.stack_dir is not None:
        stack_dir = Path(args.stack_dir).resolve()
        stack_id = stack_dir.name
        anchor = args.anchor or stack_dir.parent.name
    else:
        anchor_dir = temporal_root / args.anchor if args.anchor else _choose_one(_existing_dirs(temporal_root), "temporal anchor")
        anchor = anchor_dir.name
        stack_dir = anchor_dir / args.stack_id if args.stack_id else _latest(_existing_dirs(anchor_dir), f"temporal stack for {anchor}")
        stack_id = stack_dir.name

    if not stack_dir.exists():
        raise FileNotFoundError(f"Raw temporal stack directory does not exist: {stack_dir}")

    out_root = Path(args.out_root).resolve() if args.out_root else root / "data/diagnostics/temporal/factor_explosion"
    return TemporalPaths(
        test_root=root,
        anchor=anchor,
        stack_id=stack_id,
        stack_dir=stack_dir,
        factor_explosion_root=out_root,
    )


def find_legacy_global_dir(root: Path) -> Path | None:
    archive_root = root / "archive"
    if not archive_root.exists():
        return None
    candidates = sorted(archive_root.glob("*/data/streetview_3d/_global_planes"))
    candidates = [p for p in candidates if (p / "registry.json").exists() and (p / "sources.csv").exists()]
    return candidates[-1] if candidates else None
