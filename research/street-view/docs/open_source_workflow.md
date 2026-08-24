# Workflow Standards

This document defines path, data-layout, and extension conventions for the
Street View geometry workflow.

## Path Rules

- Resolve project paths from the repository layout or explicit CLI arguments.
- Do not hard-code absolute machine paths.
- Do not hard-code sample site ids, run timestamps, or panoids inside algorithm
  code.
- Use `src/py/sv3d_paths.py` for Python path resolution.
- Use canonical data roots for new outputs:
  - `data/raw`
  - `data/intermediate`
  - `data/derived`
  - `data/diagnostics`
  - `data/catalog`

## Spatial Dataset Selection

Spatial scripts support:

- `--run-dir`: explicit raw run directory.
- `--site`: site id under `data/raw/google_maps/spatial/`.
- `--run-id`: run id under `data/raw/google_maps/spatial/<site>/`.
- `--workspace-id`: workspace id under `data/intermediate`, `data/derived`, and
  `data/diagnostics`.

If a root contains a single candidate, scripts may infer it. Batch workflows pass
explicit dataset arguments.

Generic command shape:

```bash
python3 src/py/diagnostics/filter_and_rectify.py \
  --site <site> \
  --run-id <run-id> \
  --workspace-id <workspace-id>
```

## Temporal Dataset Selection

Temporal scripts support:

- `--stack-dir`: explicit temporal stack directory.
- `--anchor`: anchor panoid under `data/raw/google_maps/temporal/`.
- `--stack-id`: stack id under `data/raw/google_maps/temporal/<anchor>/`.
- `--out-root`: optional diagnostics output root.

Generic command shape:

```bash
python3 src/py/diagnostics/build_temporal_explosion.py \
  --anchor <anchor-panoid> \
  --stack-id <stack-id>
```

## Factor Geometry And Surfaces

After refined global factors are available, generate factor geometry, temporal
surface crops, and pixel-level fused surface textures:

```bash
python3 src/py/derive/derive_factor_surfaces.py \
  --site <site> \
  --run-id <run-id> \
  --workspace-id <workspace-id> \
  --anchor <anchor-panoid> \
  --stack-id <stack-id>
```

This writes:

- `data/derived/<workspace-id>/04b_factor_geometry`
- `data/derived/<workspace-id>/04c_factor_visibility`
- `data/derived/<workspace-id>/05_surface_crops`
- `data/derived/<workspace-id>/06_surface_stitching`
- `data/derived/<workspace-id>/07_temporal_surface_comparison`
- `data/derived/temporal/<anchor-panoid>/factor_correspondences`
- `data/diagnostics/<workspace-id>/factor_geometry`
- `data/diagnostics/<workspace-id>/surface_fusion`

## Data Layout

- `data/raw/`: immutable capture artifacts.
- `data/intermediate/<workspace-id>/`: reproducible parser and geometry outputs.
- `data/derived/<workspace-id>/`: analysis-ready outputs.
- `data/diagnostics/<workspace-id>/`: validation and inspection outputs.
- `data/catalog/`: query indexes over workflow metadata and project-relative
  paths.
- `archive/`: reference material outside the active pipeline.

## Catalog

The DuckDB catalog provides a structured index over the active data tree.
It records project-relative paths and selected structured geometry metadata,
including per-plane `(n, d)` tuples and b2 region summaries.

Install dependencies:

```bash
python3 -m pip install -r requirements.txt
```

Build:

```bash
python3 src/py/catalog/build_catalog.py \
  --site <site> \
  --run-id <run-id> \
  --workspace-id <workspace-id> \
  --anchor <anchor-panoid> \
  --stack-id <stack-id> \
  --catalog data/catalog/sv3d.duckdb
```

Validate:

```bash
python3 src/py/catalog/validate_catalog.py \
  --catalog data/catalog/sv3d.duckdb
```

Catalog paths are stored relative to the project root. Generated catalogs can
be rebuilt from the canonical data roots.

## Extension Rules

- Add a new numbered stage for a new algorithmic output.
- Preserve source provenance in derived products.
- Expose tuning parameters and dataset selectors as CLI arguments.
- Store visibility, occlusion, distance, and completeness as explicit fields or
  sidecar files.
- Keep visualization outputs separate from algorithmic intermediates.
