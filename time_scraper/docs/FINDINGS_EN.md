# Research Findings: Quadtree Subdivision & Category Search Strategy

## 1. Adaptive Quadtree Subdivision

### Distance Ratio as a Subdivision Signal

When the `tbm=map` endpoint returns results for a given viewport, those results are ordered by distance from the viewport center. We can compute a distance ratio — the farthest result's distance divided by the viewport radius — and use it to estimate how much of the area's POI density the current result set actually represents.

i tested this on three areas of San Francisco at zoom level 16 (viewport radius ~3,150m), then ran a 6×6 exhaustive grid at zoom 20 to establish ground truth:

| Area | Distance ratio | Single-request results | Ground truth (grid) | Coverage |
|------|---------------|----------------------|-------------------|----------|
| Downtown | 0.32 | 20 | 303 | 6.6% |
| Residential | 0.58 | 20 | 93 | 21.5% |
| Ocean side | 1.39 | 20 | 35 | 57.1% |

A low ratio means the 20 returned results are clustered near the center — the viewport contains far more POIs than were returned. A ratio above 1.0 means Google reached beyond the viewport to fill the result set, suggesting the area is relatively sparse.

This correlation held consistently in testing, but the metric became less central to the final design once pagination was introduced.

### Pagination Changes the Economics

We discovered that the `tbm=map` endpoint supports pagination via the `!8i{offset}` parameter inserted into the `pb=` query string. Each page returns up to 20 results, and consecutive pages contain entirely different result sets (zero overlap in our tests). Pagination typically yields 6-7 pages before results dry up, producing roughly 120-140 unique POIs per viewport.

This changes the subdivision calculus. Without pagination, each viewport captures only 20 results, so the quadtree must subdivide aggressively — every cell with 20 results needs splitting. With pagination, the same viewport can yield 130+ results, and many cells that previously required subdivision no longer need it.

The current subdivision logic is: paginate each cell fully, then check whether the last page was full. If it was, the viewport likely still has undiscovered POIs, so subdivide into four quadrants and recurse. If the last page was not full, the cell is considered covered.

### The `spread` Stop Was a Bug

An earlier version of the code stopped subdividing when `distRatio >= 1.0`, reasoning that results spreading beyond the viewport meant coverage was sufficient. This turned out to be wrong. In a sparse area with ratio 1.39, pagination revealed 78 POIs where the single-page approach found only 20. The high ratio merely reflected Google's tendency to reach outward when nearby results are scarce — it did not mean there were no undiscovered POIs in the area. Removing this early stop and relying purely on pagination completeness resolved the issue.

### Offset Grid Pass

After the quadtree completes, a second scan runs with the grid shifted by half a cell width. The rationale is that POIs near quadtree cell boundaries may consistently fall outside the "nearest 20 to center" for both adjacent cells.

In testing on a 3×3 grid of San Francisco at zoom 16, the standard grid found 631 unique POIs. Adding the offset grid brought the total to 765 — an increase of 21%. This is a meaningful gain for modest additional cost (doubling the number of cells at the coarsest grid level, though finer quadtree levels are not repeated).

### Zoom Levels 19-21

We verified that zoom levels beyond 18 produce valid, differentiated results:

| Zoom | Altitude | Results | Unique vs previous zoom |
|------|----------|---------|------------------------|
| 18 | 1,577 | 21 | — |
| 19 | 788 | 21 | 9 unique |
| 20 | 394 | 21 | 6 unique |
| 21 | 197 | 21 | 2 unique |

Each zoom level returns a partially different set of POIs because the viewport center may be closer to different places at different scales. The gains diminish at zoom 20-21, so the current implementation allows subdivision down to approximately 50m cells (zoom 20) but does not go further.

### Cell Overlap Was Not Effective

We tested expanding each child cell by 15% to create overlap bands between adjacent quadrants. With pagination active, zero additional POIs were found — the ~130 results per cell already provided enough spatial coverage to prevent boundary-related omissions. This optimization was dropped.

---

## 2. Category Search Strategy

### How `tbm=map` Interprets Search Queries

The `tbm=map` endpoint performs a text search, not a structured type filter. When we send `q=food`, Google's search engine returns places it considers semantically related to "food" — restaurants, cafes, bakeries, food courts, and so on. This is fundamentally different from the Places API's `includedTypes` parameter, which filters by exact type match.

This distinction matters because it means broad terms can serve as effective catch-all queries, pulling in subcategories we might not have thought to search individually.

### Broad Terms Are Disproportionately Efficient

We organized search queries into two tiers: 18 broad "bucket" terms (food, shopping, services, health, etc.) and 159 specific category terms (Restaurant, Cafe, Hair Salon, etc.). Running all 177 queries across San Francisco produced these results:

| Metric | Tier 1 (18 broad) | Tier 2 (159 specific) |
|--------|-------------------|----------------------|
| Total new POIs | 12,068 | 28,918 |
| Share of total | 29% | 71% |
| Avg efficiency | ~7 POI/request | ~2.5 POI/request |

The broad terms are roughly 3× more efficient per request. `food` alone achieved 14.3 new POIs per request — the highest of any query. However, Tier 2 categories still contributed 71% of the total discoveries, meaning they cannot be omitted.

### Compound Terms Are Not Subsets of Their Root Words

We initially assumed that searching `office` would cover `Corporate Office`, since the latter contains the former. Testing disproved this:

| Root word | Compound term | Overlap |
|-----------|--------------|---------|
| office | Corporate Office | 19% |
| restaurant | Chinese Restaurant | 11% |
| clinic | Dental Clinic | 0% |
| store | Clothing Store | 5% |
| salon | Hair Salon | 75% |

Google treats these as distinct search intents. Searching `clinic` returns general clinics, urgent care, and medical centers. Searching `Dental Clinic` returns dental-specific practices — almost entirely different results. The only pair with substantial overlap was `salon` / `Hair Salon` (75%), likely because the word "salon" is already strongly associated with hair services.

This finding confirms that the Tier 2 specific queries are necessary and cannot be replaced by their root words alone.

### Category Coverage Against Google's Official Type List

Google's Places API defines 472 place types in Table A. We mapped all 472 into 18 semantic buckets and selected 159 high-density types as Tier 2 queries. The remaining types are expected to be captured indirectly through Tier 1 broad searches — for example, searching `food` should surface `afghani_restaurant` and `dim_sum_restaurant` without needing them as separate queries.

In practice, the 177-query configuration found 40,986 unique POIs across San Francisco, compared to 20,234 with the previous 51-query setup.

### Anomalous Category: Bus Station

The search term `Bus Station` contributed 3,114 new POIs — far more than expected for a transit query. Investigation revealed that none of these POIs had "Bus station" as their primary type. Instead, Google interpreted the query broadly, returning businesses and services located near bus stations and transit hubs. The results included restaurants, clinics, hair salons, and other commercial establishments that happened to be near transit infrastructure.

This was not an error. These are real, valid POIs that other category queries missed, likely because they fall into niche subcategories or are small businesses without strong category signals. The `Bus Station` query effectively functioned as a geographic sampling strategy — "find places near transit hubs" — complementing the category-based approach.

### Diminishing Returns Analysis

Plotting marginal discovery rate (new POIs per request) across the 177 categories shows a clear pattern: the rate starts at roughly 800 new POIs per page during early Tier 1 queries, drops to around 300-400 during mid-run Tier 2 queries, but never falls below 1 new POI per page. Even the least productive categories (Vegan Restaurant at 0.5/request, Wine Bar at 0.8/request) still discovered a handful of unique places.

Nineteen categories contributed fewer than 50 new POIs each with efficiency below 1.5 POI/request. Removing them would save 2.4% of total requests while losing 0.8% of total POIs — a reasonable trade-off if search time is a constraint, but not a clear win in all scenarios.
