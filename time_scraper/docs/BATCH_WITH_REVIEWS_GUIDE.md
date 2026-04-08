# Google Maps Batch Scraper - Batch Guide

## Current Behavior

`gmaps_batch_scrape_with_reviews.js` is the main CLI entry point for batch scraping.

Review extraction now follows this order:

1. Two-step page load to stabilize the Google Maps place UI.
2. `api-review-fetcher.js` fetches reviews from the Google Maps review RPC endpoint.
3. `reviews_extractor_scroll.js` is used only as a DOM supplement when API coverage is clearly below the detected review count.

This means the project is no longer a "scroll-first" review scraper.

## Key Parameters

| Parameter | Meaning | Default |
| --- | --- | --- |
| `--input <file>` | Input place list | required unless using search mode |
| `--output <file>` | Output NDJSON path | required |
| `--limit <n>` | Limit number of places | all |
| `--headless` | Run browser headless | off |
| `--no-reviews` | Disable review extraction | reviews enabled |
| `--max-reviews <n>` | Max reviews per place | 1000 |
| `--max-scrolls <n>` | Max DOM fallback scrolls | 1000 |
| `--review-sort <order>` | `relevant`, `newest`, `highest`, `lowest` | `relevant` |
| `--no-review-images` | Skip review image URL extraction | extract images |
| `--download-images` | Download review images locally | off |
| `--image-output <dir>` | Image output directory | `output/images` |
| `--search-mode` | Search POI from sampling points first | off |
| `--points <file>` | Sampling points CSV/JSON | required in search mode |
| `--categories <file>` | Category config JSON | required in search mode |
| `--max-search-scrolls <n>` | Max scrolls per search result page | 15 |

## Recommended Usage

### Basic business data only

```bash
node src/gmaps_batch_scrape_with_reviews.js \
  --input data/coordinates_singapore.json \
  --output output/basic.ndjson \
  --limit 10 \
  --no-reviews
```

### Business data plus reviews

```bash
node src/gmaps_batch_scrape_with_reviews.js \
  --input data/coordinates_singapore.json \
  --output output/places_with_reviews.ndjson \
  --limit 10 \
  --max-reviews 200 \
  --review-sort newest \
  --headless
```

### Search mode plus scraping

```bash
node src/gmaps_batch_scrape_with_reviews.js \
  --search-mode \
  --points data/hongkong/hong_kong_points.csv \
  --categories config/categories.json \
  --search-zoom 1000m \
  --output output/hongkong_results.ndjson \
  --max-reviews 200 \
  --headless
```

### Review image download

```bash
node src/gmaps_batch_scrape_with_reviews.js \
  --input data/coordinates_singapore.json \
  --output output/places_with_images.ndjson \
  --limit 10 \
  --max-reviews 100 \
  --download-images \
  --image-output output/images
```

## Performance Notes

- API review extraction is usually much faster than DOM scrolling.
- DOM fallback is only expected for edge cases where API coverage is obviously incomplete.
- Search mode still relies on scrolling the Google Maps result list; that is separate from review extraction.

## Troubleshooting

### Reviews are missing or too few

- Check log lines beginning with `[Reviews] API`.
- If fallback is triggered, also inspect `[Reviews] DOM supplement`.
- Use `--review-sort newest` when you care about deep pagination quality.
- Watch for CAPTCHA or soft blocks if review counts suddenly collapse.

### Review extraction is slow

- Lower `--max-reviews`.
- Use `--headless`.
- Use `--download-images` only when needed.
- Remember that search mode scroll cost and review extraction cost are separate stages.

### Images failed to download

- Check network stability and redirects.
- Confirm the output directory is writable.
- Retry with a smaller batch before large runs.

## Output Shape

Typical record layout:

```json
{
  "business": {
    "name": "Example Place",
    "rating": 4.7,
    "reviewCount": 7958
  },
  "openingHours": {},
  "popularTimes": {},
  "about": {},
  "detailedReviews": [
    {
      "review_id": "review-id",
      "rating": 5,
      "review_text": "Great place.",
      "published_at": "a month ago",
      "published_at_date": "2026-03-01",
      "reviewer_name": "Jane Doe",
      "reviewer_link": "https://www.google.com/maps/contrib/...",
      "review_images": []
    }
  ],
  "_meta": {
    "placeId": "ChIJ...",
    "sourceUrl": "https://www.google.com/maps/place/?q=place_id:ChIJ..."
  }
}
```

## Related Files

- `src/gmaps_batch_scrape_with_reviews.js`
- `src/gmaps_batch_scrape_ipc.js`
- `src/api-review-fetcher.js`
- `src/reviews_extractor_scroll.js`
- `src/review_image_downloader.js`
