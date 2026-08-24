# Google Maps Reviews Extraction - Solution Summary

## Current Conclusion

The review system has moved to an **API-first** architecture with DOM fallback.

- Primary extractor: `src/api-review-fetcher.js`
- Fallback extractor: `src/reviews_extractor_scroll.js`
- Browser hardening: `src/stealth/`

This replaces the older "scroll-first" narrative.

## Why This Changed

The earlier DOM-only approach was workable, but it had clear limits:

- slow end-to-end runtime
- practical depth limits
- fragile dependence on Google Maps DOM structure
- higher browser interaction cost

The newer API path improves coverage and speed while keeping the DOM extractor available for edge cases.

## Stable Requirements That Still Matter

### Two-step page loading

The project still relies on the same place loading pattern:

```javascript
const searchUrl = `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${placeId}`;
await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2000);

const placeUrl = `https://www.google.com/maps/place/?q=place_id:${placeId}&hl=en`;
await page.goto(placeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('h1', { timeout: 60000 });
await page.waitForTimeout(2000);
```

This is still important because it stabilizes the page before either API or DOM review extraction begins.

## Current Production Flow

1. Load the place with the two-step sequence.
2. Extract business data via the main pipeline.
3. Fetch reviews through the Google Maps review RPC endpoint.
4. If detected count exists and API coverage is below threshold, run DOM supplement.
5. Merge results by `review_id`.
6. Apply timestamps and optionally download review images.

## High-Level Results

The April 5, 2026 improvement (`a74df81`) established the following project direction:

- API review fetching became the default path.
- DOM scrolling was retained only as a supplement.
- Scrapling-inspired stealth protections were integrated into the runtime.
- The project target shifted from "good partial extraction" to "near-complete or complete review coverage when possible".

## Practical Guidance

- Use `--max-reviews` to control total review volume.
- Treat `--max-scrolls` as a fallback-only tuning knob.
- Use `--review-sort newest` when deep pagination quality matters.
- Investigate API logs before spending time on DOM debugging.

## Related Files

- `src/api-review-fetcher.js`
- `src/reviews_extractor_scroll.js`
- `src/gmaps_batch_scrape_with_reviews.js`
- `src/gmaps_batch_scrape_ipc.js`
- `src/stealth/`

## Historical Note

Older documents and tests may still mention the DOM scrolling method as the main solution. Those references are historical and should not be treated as the current architecture unless they explicitly describe fallback behavior.
