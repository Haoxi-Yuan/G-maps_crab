# Project Map

Updated: 2026-05-03

This project is organized as a reproducible Street View geometry workflow. The
canonical data roots are `data/raw`, `data/intermediate`, `data/derived`,
`data/diagnostics`, and `data/catalog`. `data/streetview_3d` is retained as a
compatibility layer.

## Data Roots

### `data/raw`

Captured source artifacts from Google Maps and Street View.

Spatial captures use:

`data/raw/google_maps/spatial/<site>/<run-id>/`

Typical contents:

- `photometa_*.bin`
- `panoramas/`
- `neighbor_photometas/`
- `screenshots/`
- `mouse_trace.ndjson`
- `tile_inventory.json`
- `wasm_loads.json`
- `summary.md`

Temporal captures use:

`data/raw/google_maps/temporal/<anchor-panoid>/<stack-id>/`

Typical contents:

- `timeline.json`
- `captures/<date>_<panoid>/`

### `data/intermediate`

Reproducible outputs from parsing and geometry-processing stages.

Spatial workspaces use:

`data/intermediate/<workspace-id>/`

Current stage layout:

- `00_parsed_photometa/`: decoded photometa, depthmap, indexmap, and plane files.
- `01_depthmap_pointcloud_baseline/`: depthmap-derived point-cloud baseline.
- `02_indexmap_rectified/`: local and gravity-aligned indexmaps.
- `03_planes_world/`: per-pano plane equations transformed into world/gravity frame.

### `data/derived`

Analysis-ready outputs.

Spatial outputs use:

`data/derived/<workspace-id>/`

Current stage layout:

- `04_global_factors_refined/`: cross-pano factor registry and source observations.
- `04_global_factors_refined/match_examples/`: visual examples of matched factors.
- `04_global_factors_refined/street_topology/`: top-down topology visualizations.
- `04b_factor_geometry/`: local plane supports, 3D boundaries, and factor geometry manifests.
- `04c_factor_visibility/`: expected visibility and observation quality manifests.
- `05_surface_crops/`: factor-linked panorama crops, masks, and temporal surface crops.
- `06_surface_stitching/`: world-plane atlas textures fused from multiple pano observations.
- `07_temporal_surface_comparison/`: historical capture projections, temporal
  factor correspondences, space-time rectified candidate grids, and comparison reports.

Temporal outputs use:

`data/derived/temporal/<anchor-panoid>/`

Current stage layout:

- `alignment_pointcloud_icp/`
- `changes/`
- `factor_correspondences/`
- `history/`

### `data/diagnostics`

Validation figures and inspection products.

Current stage layout:

- `data/diagnostics/<workspace-id>/factor_geometry/`
- `data/diagnostics/<workspace-id>/indexmap_overlay/`
- `data/diagnostics/temporal/factor_explosion/<anchor-panoid>/`

### `data/catalog`

Query indexes over the active workflow outputs.

Current contents:

- `sv3d.duckdb`: DuckDB catalog built from raw, intermediate, derived, and
  diagnostic metadata, including plane equations, indexmap/b2 references, POI
  references, and cross-pano factor provenance.
- `validation_report.json`: catalog validation report.

### `data/streetview_3d`

Compatibility links for legacy path conventions. New scripts read and write
canonical paths directly.

### `archive`

Reference material outside the active pipeline. Archived files are retained for
traceability and comparison. Active scripts access archived material only through
explicit CLI arguments.

## Code Roots

### `src/js/capture`

Capture and metadata-harvesting scripts:

- `walk-streetview-3d.js`
- `fetch-neighbor-photometas.js`
- `harvest-temporal-stack.js`
- `fetch-temporal-photometas.js`
- `orchestrate-temporal-batch.js`
- `parse-geometry.js`

### `src/py/raw`

Raw-data processing scripts:

- `stitch_panoramas.py`
- `build_rgb_pointcloud.py`
- `process_temporal_stack.py`

### `src/py/derive`

Geometry derivation scripts:

- `derive_planes_world.py`
- `derive_global_planes_refined.py`
- `derive_temporal_alignment.py`
- `derive_temporal_icp.py`
- `derive_temporal_changes.py`
- `derive_temporal_history.py`
- `derive_factor_surfaces.py`
- `derive_temporal_factor_surfaces.py`

### `src/py/diagnostics`

Validation and visualization scripts:

- `filter_and_rectify.py`
- `pair_indexmap_with_pano.py`
- `build_indexmap_overlay.py`
- `visualize_planes_world_validation.py`
- `visualize_global_plane_match_examples.py`
- `visualize_street_topology.py`
- `build_temporal_explosion.py`

### `src/py/catalog`

Catalog schema build and validation scripts:

- `build_catalog.py`
- `validate_catalog.py`

### `src/py/viewers`

Local viewer utilities for point-cloud and mesh inspection.

### `src/py/sv3d_paths.py`

Shared Python path resolver. New Python scripts use this module rather than
constructing project paths manually.

Supported argument groups:

- Spatial: `--run-dir`, `--site`, `--run-id`, `--workspace-id`.
- Temporal: `--stack-dir`, `--anchor`, `--stack-id`.

## Extension Rules

- Keep raw captures immutable.
- Write each algorithm stage to a separate numbered directory.
- Preserve source provenance from derived outputs back to panoid, local plane id,
  and raw run.
- Keep catalog paths project-relative.
- Add dataset selection and tuning parameters as CLI arguments.
- Do not hard-code local machine paths, sample ids, run timestamps, or panoids.
