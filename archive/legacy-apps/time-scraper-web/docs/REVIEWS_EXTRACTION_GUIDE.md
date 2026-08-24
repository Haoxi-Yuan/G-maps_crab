# Google Maps Review Extraction Guide

## Overview

The project now uses an **API-first** review extraction pipeline.

- Primary path: `src/api-review-fetcher.js`
- Supplement path: `src/reviews_extractor_scroll.js`
- Shared requirement: two-step page loading before extraction

The DOM scroller still matters, but it is no longer the default strategy.

## Extraction Flow

### 1. Two-step place loading

Google Maps review extraction is more stable after a search preload followed by the place page:

```javascript
const searchUrl = `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${placeId}`;
await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2000);

const placeUrl = `https://www.google.com/maps/place/?q=place_id:${placeId}&hl=en`;
await page.goto(placeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('h1', { timeout: 60000 });
await page.waitForTimeout(2000);
```

### 2. API-first review fetch

```javascript
const { fetchAllReviews } = require('./api-review-fetcher');

const apiResult = await fetchAllReviews(page, {
  maxReviews: 1000,
  pageSize: 20,
  delayMs: 200,
});
```

This path is preferred because it is much faster and can paginate far deeper than DOM scrolling.

What the API fetcher currently does:

1. Detect `detectedCount` from the loaded page when possible.
2. Click the Reviews tab to capture the first `listugcposts` request.
3. Rewrite the captured URL for deep pagination:
   - `!1i20` page size
   - `!13m1!1e2` newest ordering
   - `!2s` cleared first-page token
4. Page through results with `fetch()` from browser context.
5. Deduplicate by `review_id`.
6. Retry once after a 30s pause for:
   - HTTP `429` / `403`
   - suspicious empty page while coverage is still below 80%
7. Mark the API path as blocked if retry still fails.

### 3. DOM supplement only when needed

If the detected review count is known and API coverage is clearly incomplete, the scraper can inject `reviews_extractor_scroll.js` and merge only the missing reviews.

```javascript
const needSupplement =
  apiResult.detectedCount &&
  apiResult.reviews.length / apiResult.detectedCount < 0.95;
```

## What Each Method Is Good For

| Method | Role | Best at | Main tradeoff |
| --- | --- | --- | --- |
| API fetcher | Primary | Coverage, speed, deep pagination | Depends on Google Maps RPC behavior |
| DOM supplement | Fallback | Recovering missing edge-case reviews, image expansion | Slow and UI-fragile |

## Data Returned

Typical review fields:

```javascript
{
  review_id: "string",
  rating: 1,
  review_text: "Review content...",
  published_at: "2 months ago",
  published_at_date: "2026-02-11",
  reviewer_name: "John Doe",
  reviewer_link: "https://www.google.com/maps/contrib/...",
  reviewer_photo_count: 15,
  reviewer_review_count: 234,
  is_local_guide: true,
  review_likes_count: 0,
  response_from_owner_text: "Thank you...",
  response_from_owner_ago: "1 month ago",
  review_images: []
}
```

## Integration Points

The two production entry points already use this architecture:

- `src/gmaps_batch_scrape_with_reviews.js`
- `src/gmaps_batch_scrape_ipc.js`

If you add a new entry point, keep the same pattern:

1. Run two-step loading.
2. Fetch with `api-review-fetcher.js`.
3. Update detected review count if available.
4. Optionally run DOM supplement when coverage is below threshold.
5. Merge by `review_id`.

## Operational Notes

- `--max-reviews` limits total reviews per place.
- `--max-scrolls` only affects the DOM supplement path.
- The API path currently forces `newest` internally for deep pagination.
- `--review-sort` mainly affects the DOM supplement path, not the API primary path.
- Search-result scrolling is a different concern from review extraction.

## Troubleshooting

### API path returned too few reviews

- Check whether `detectedCount` is present.
- Look for CAPTCHA, locale mismatch, or request blocking.
- Remember that `--review-sort newest` does not currently change the API primary path.

### DOM supplement triggered too often

- Review the API logs first; frequent fallback usually means blocking or page instability.
- Confirm the two-step loading sequence is intact.
- Verify the place page reached a stable `h1` before extraction starts.

### Images are incomplete

- Review images may still depend on DOM expansion behavior.
- Enable DOM supplement and image extraction when images matter more than speed.

## Related Files

- `src/api-review-fetcher.js`
- `src/reviews_extractor_scroll.js`
- `src/gmaps_batch_scrape_with_reviews.js`
- `src/gmaps_batch_scrape_ipc.js`
- `src/review_image_downloader.js`
