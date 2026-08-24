# Street View Geometry Workflow

Reproducible pipeline for collecting Google Maps Street View geometry assets,
parsing photometa/depth/indexmap layers, and deriving spatial factors that can
be compared across viewpoints and capture dates.

## Project Layout

- `data/raw/`: captured Google Maps and Street View artifacts.
- `data/intermediate/`: reproducible parsing and geometry intermediates.
- `data/derived/`: analysis-ready outputs.
- `data/diagnostics/`: validation figures and visual inspection products.
- `data/catalog/`: DuckDB indexes for querying workflow metadata and paths.
- `data/streetview_3d/`: compatibility links for legacy path conventions.
- `archive/`: reference material outside the active pipeline.

## Code Layout

- `src/js/capture/`: Playwright and HTTP capture scripts.
- `src/py/raw/`: raw-data processing.
- `src/py/derive/`: geometry derivation algorithms.
- `src/py/diagnostics/`: validation and visualization scripts.
- `src/py/catalog/`: DuckDB catalog build and validation scripts.
- `src/py/viewers/`: local viewer utilities.

## Runtime Conventions

Scripts are expected to run from a clean checkout without editing source paths.
Use CLI arguments such as `--site`, `--run-id`, `--workspace-id`, `--anchor`,
and `--stack-id` to select datasets.

Install Python runtime dependencies:

```bash
python3 -m pip install -r requirements.txt
```

Build the project catalog:

```bash
python3 src/py/catalog/build_catalog.py \
  --site <site> \
  --run-id <run-id> \
  --workspace-id <workspace-id> \
  --anchor <anchor-panoid> \
  --stack-id <stack-id> \
  --catalog data/catalog/sv3d.duckdb
```

Derive factor geometry, pixel-level fused surface textures, and temporal surface
crops before rebuilding the catalog:

```bash
python3 src/py/derive/derive_factor_surfaces.py \
  --site <site> \
  --run-id <run-id> \
  --workspace-id <workspace-id> \
  --anchor <anchor-panoid> \
  --stack-id <stack-id>
```

Project historical captures onto existing factor atlases and write temporal
surface correspondence candidates:

```bash
python3 src/py/derive/derive_temporal_factor_surfaces.py \
  --site <site> \
  --run-id <run-id> \
  --workspace-id <workspace-id> \
  --temporal-batch-id <batch-id>
```

Harvest historical photometa stacks for a spatial run:

```bash
node src/js/capture/orchestrate-temporal-batch.js \
  --site <site> \
  --run-id <run-id> \
  --batch-id <batch-id>
```

Validate it:

```bash
python3 src/py/catalog/validate_catalog.py \
  --catalog data/catalog/sv3d.duckdb
```

## Documentation

- `PROJECT_MAP.md`: current directory map and active pipeline stages.
- `docs/open_source_workflow.md`: path, data-layout, and extension standards.
- `data/README.md`: data-tree contract.
