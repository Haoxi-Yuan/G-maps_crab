# G-Maps Crab — CLI scraper

Interactive three-stage pipeline for scraping Google Maps POIs and reviews for
an arbitrary city.

```
Stage 1: City boundary + sampling points (+ optional map PNG)
Stage 2: POI search across the boundary
Stage 3: Review scrape (auto-finalized into a complete dataset)
```

## Quick start on a fresh machine

```bash
cd CLI_scraper
./bootstrap.sh          # installs node deps + Playwright chromium
./bin/gmaps-crab        # launches the interactive menu
```

Requirements: `node >= 18`, `npm`, `python3` (+ venv module). Bootstrap
installs: npm deps, Playwright's chromium, and a local Python venv with
`geopandas` / `contextily` / `matplotlib` for map rendering.

## Layout

```
CLI_scraper/
  bin/gmaps-crab               # top-level interactive launcher
  bootstrap.sh                 # one-command setup

  poi-search.sh                # stage 2 wizard (unchanged from upstream)
  review-scrape.sh             # stage 3 wizard (unchanged from upstream)

  src/
    cli/
      boundary-wizard.js       # stage 1 interactive wrapper (new)
      render-boundary-map.py   # geopandas + contextily → PNG (new)
    city-generator/            # stage 1 core (boundary + sampling points)
    poi-searcher-api.js        # stage 2 core
    filter-by-boundary.js      # post-filter helper
    review-scraper.js          # stage 3 core (auto-finalize merges 0-review places)
    api-review-fetcher.js      # review API client
    stealth/                   # playwright anti-bot suite

  config/categories.json       # POI category taxonomy
  data/<city>/                 # stage 1 outputs  (*_boundary.geojson, *_points.*, *_map.png)
  output/<city>/               # stages 2/3 outputs (places.ndjson, reviews.ndjson, ...)
```

## Stage 1 — Boundary + sampling points

Run `./bin/gmaps-crab` and pick `[1]`. The wizard asks:

- city name (fetched from OSM Nominatim) or existing boundary GeoJSON path
- cell size / number of points / Lloyd iterations / optional bbox clip
- optional PNG map export:
  - basemap: `osm` · `carto-light` · `carto-dark` · `esri-satellite`
  - overlay sampling points?
  - image size (default 1600×1200)

Outputs to `data/<city_slug>/`:

```
<slug>_boundary.geojson
<slug>_points.json        # used by stage 2
<slug>_points.csv
<slug>_points.geojson
<slug>_summary.json
<slug>_map.png            # only if map export was enabled
```

You can also run the renderer standalone:

```bash
.venv/bin/python3 src/cli/render-boundary-map.py \
  --boundary data/san_francisco/san_francisco_boundary.geojson \
  --points   data/san_francisco/san_francisco_points.geojson \
  --out      data/san_francisco/san_francisco_map.png \
  --basemap  osm
```

Colors: hot pink boundary (`#FF6FAF`) + Tiffany blue points (`#0ABAB5`).

## Stage 2 — POI search

Unchanged from the upstream project. Launch from the main menu or directly:

```bash
./poi-search.sh                      # interactive wizard
./poi-search.sh --run --city san_francisco   # non-interactive
```

Writes `output/<city>/places.ndjson`.

## Stage 3 — Review scrape

Unchanged from upstream, except the scraper now auto-finalizes the output on
completion: after all filtered places finish, it rewrites `reviews.ndjson` in
the order of the original `places.ndjson`, inserting placeholders
(`detailedReviews: []`, `_placeholder: true`) for places excluded by the
min-count filter. That makes `reviews.ndjson` a complete dataset without an
extra merge step.

```bash
./review-scrape.sh                                   # interactive
./review-scrape.sh --run --city san_francisco        # non-interactive
./review-scrape.sh --status
./review-scrape.sh --stop
```

To finalize manually (e.g. after an interrupted run):

```bash
node src/review-scraper.js --finalize-only \
  --output output/san_francisco/reviews.ndjson \
  --origin output/san_francisco/places.ndjson
```

## Status

```bash
./bin/gmaps-crab      # main menu → [s]
```

Shows each city's stage-1 artifacts, stage-2/3 line counts, and any running
background scrapers with their PIDs.

## Troubleshooting

- **"playwright not installed"** — re-run `./bootstrap.sh` (or `rm node_modules/.bootstrap-ok && ./bootstrap.sh`).
- **Nominatim 403 / rate-limited** — retry; use `--bbox` to skip the geocode step; or supply an existing boundary file via option `[2]` in the wizard.
- **Tiles never finish loading in map PNG** — basemap host rate-limit; switch basemap or reduce image size.
