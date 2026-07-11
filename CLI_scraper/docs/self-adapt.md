# Self-Adapting POI Discovery (`--self-adapt`)

Category-free POI enumeration for Google Maps `tbm=map`. Instead of iterating a
hand-curated category taxonomy (`config/categories.json`, 177 terms), the scraper
**discovers each area's real place types from Google's own labels** and searches
those. This removes the taxonomy dependency — the weakness that makes a fixed list
hard to port across cities/languages and prone to missing locally-distinctive POIs.

## Why (the problem it solves)

The fixed 177-term list is the bottleneck, not the search mechanism:

- **Portability** — an English, Singapore-tuned list does not adapt to a city in
  Japan, Brazil, etc. Local types (`Hawker Stall`, `Izakaya`, `Feng shui consultant`,
  `Chinese medicine store`) simply aren't in it.
- **Long-tail leakage** — on a real Singapore run, **70% of the 2,777 observed
  `mainCategory` types (≈49% of POI mass) are named by no query term**; they only
  entered via a handful of broad buckets' server-side semantic expansion, which are
  exactly the buckets that hammer the ~140/viewport pagination cap and drop the
  long tail first.

Google already tags every returned POI with a `mainCategory` (`p[13]`) and machine
category IDs (`p[76]`, language-independent GCIDs). So we don't need to *guess* the
taxonomy up front — we let it fall out of the results and feed it back.

> Enumeration still uses search (six rounds of measurement confirmed no render /
> tile / memory path beats it — see [FINDINGS.md](../FINDINGS.md)). `--self-adapt`
> only removes the *fixed category table*, not the search step.

## Crawling logic

```
seed queue  ← generic seeds (restaurant, shop, service, clinic, office, …)
            + shared cross-area vocab (yield-ranked, if present)

while queue not empty and within budget:
    q ← dequeue
    run the full quadtree + pagination + offset-grid pass for q   (reused as-is)
      └─ every returned POI streams to places.ndjson (dedup by ftid)
      └─ for every IN-BOUNDARY POI: enqueue its Google mainCategory if unseen
    record q's IN-BOUNDARY new-POI yield
    if last K queries each added < min-yield in-boundary POIs → converged, stop

persist this area's per-category in-boundary yield into the shared vocab file,
re-ranked by cumulative yield → next area searches highest-yield types first.
```

Three properties make it efficient (validated end-to-end):

1. **In-boundary signal, not raw.** Discovery and convergence key on POIs that fall
   *inside the (buffered) boundary*, using the same boundary check as the
   post-filter. Raw yield stays high from viewport *spread* (a query pulls in the
   surrounding neighbourhood), so a raw signal never converges; the in-boundary
   signal does. A park with no in-boundary businesses stops in ~12 queries instead
   of running the full budget; a POI-rich area keeps going until its in-boundary
   types are exhausted.
2. **Discover-once, harvest-everywhere.** One yield-ranked vocabulary file is shared
   across every area in a batch. The first areas pay the discovery cost; later areas
   prime from the vocab (highest-yield types first) and converge fast. A Chinatown
   vocabulary transferred to Little India covered 97% of its POIs in a probe.
3. **Priority ordering.** The shared vocab is sorted by cumulative in-boundary
   yield, so subsequent areas front-load the types that actually produce POIs and
   can truncate the long tail via `--sa-stop-after-dry` / `--sa-max-queries`.

Everything else is unchanged: the quadtree subdivision, `!8i` pagination, offset
grid, ftid dedup, `places.ndjson` streaming, boundary pre-filter and post-filter,
and resume (per-area `_area_complete.json`, in-area `poi_search.json`).

## Usage

Multi-boundary batch (parks), the intended use:

```bash
node src/multi-boundary-orchestrator.js \
  --boundaries data/sg_parks_boundaries.geojson --name sg_parks \
  --cell-size 200 --buffer 20 \
  --self-adapt --sa-stop-after-dry 6 --sa-max-queries 80
```

Flags:

| Flag | Meaning | Default |
|---|---|---|
| `--self-adapt` | Category-free discovery instead of the fixed taxonomy | off |
| `--sa-max-queries N` | Per-area query budget (safety cap; convergence usually stops earlier) | 300 |
| `--sa-stop-after-dry K` | Stop an area after K consecutive queries with < min-yield **in-boundary** new POIs | 0 (off) |
| `--sa-min-yield N` | A "dry" query adds fewer than N in-boundary POIs | 1 |
| `--sa-seeds a,b,c` | Override the generic bootstrap seeds | 20 built-in generics |
| `--sa-vocab <file>` | Shared vocab file (discover-once across the batch) | `output/_selfadapt_vocab__<batch>.json` |

With no boundary loaded (whole-city runs), the in-boundary check passes everything,
so the in-boundary signal falls back to raw yield automatically.

## What the code touches

- `src/poi-searcher-api.js`
  - `fetchCellPaginated` — in-boundary discovery hook (`_onCategory`) + in-boundary
    new-POI counter (`_inBoundaryCounter`).
  - `batchSearchPOIs` — the per-query body is factored into `runOneQuery` (shared by
    both modes) which returns in-boundary yield; branches to `runSelfAdaptClosure`
    when `options.selfAdapt`.
  - `runSelfAdaptClosure` + `loadVocab`/`saveVocab` — the closure and the shared,
    yield-ranked cross-area vocabulary.
- `src/multi-boundary-orchestrator.js` — `--self-adapt` and `--sa-*` flags; skips the
  fixed-taxonomy load and threads one batch-shared vocab file into every area.

## Empirical basis

The design is grounded in six rounds of measurement (empty-query, adaptive bucket
scheduling, vector-tile decode, reveal/click, client-memory interception, fine-grid
render sweep) plus the self-adapt validation. Full numbers in
[FINDINGS.md](../FINDINGS.md).
