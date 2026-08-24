# Maintenance policy

## Supported product

`CLI_scraper/` is the maintained product. Its five supported stages are:

1. boundary and sampling-point generation;
2. single-area and multi-boundary POI collection;
3. review collection;
4. NDJSON-to-SQLite conversion and validation;
5. image discovery and download.

Existing `data/`, `output/`, checkpoint, NDJSON, and SQLite layouts are
compatibility contracts. Maintenance must not rewrite collected data as part
of a code migration.

## Supporting areas

- `tools/local-monitor/` is a daily operations tool, not a dependency of the
  scraper runtime.
- `exploratory/` contains prototypes such as OCR and menu-image analysis. An
  experiment moves into the core only after it has fixtures, tests, a stable
  interface, and an explicit compatibility decision.
- `research/` contains independent Street View, satellite, and paper work.
  Research code must not be imported by the production scraper.
- `archive/` is read-only historical context. Atlas/PBS code is unsupported
  because the server is retired.

## Git workflow

- `main` must remain releasable and pass the cross-platform test matrix.
- New work uses short-lived `feature/*` or `fix/*` branches.
- Releases use annotated `cli-scraper-vX.Y.Z` tags.
- Production runs must record a clean Git commit and environment versions.
- Generated data, downloaded assets, virtual environments, browsers, caches,
  databases, and secrets are never committed.

## Change checklist

1. Keep old checkpoints and data schemas readable, or document a versioned
   migration before merging.
2. Add or update fixture-based tests; CI must not call live Google endpoints.
3. Run `npm test` from `CLI_scraper/`.
4. Test CLI help and bootstrap behavior on every affected platform.
5. Update the relevant documentation and version notes.
