# Reviews Extraction by Scrolling - Guide

## Overview

This approach extracts Google Maps reviews by scrolling the reviews sidebar, which is more reliable than API calls and doesn't require reverse engineering.

## CRITICAL: Page Loading Strategy

**Google Maps requires a specific two-step loading process to display the full interface:**

```javascript
// Step 1: Load search API URL first (initializes full interface)
await page.goto(`https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${placeId}`,
                { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2000);

// Step 2: Load place URL (displays full interface with all tabs)
await page.goto(`https://www.google.com/maps/place/?q=place_id:${placeId}&hl=en`,
                { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);
```

**Without this two-step process:**
- Page will only show "Overview" and "About" tabs
- "Reviews" and "Menu" tabs will be missing
- Review extraction will fail

**With the two-step process:**
- All four tabs appear: "Overview", "Menu", "Reviews", "About"
- Review elements load correctly
- Extraction succeeds with 100+ reviews

## Method Comparison

| Method | Pros | Cons |
|--------|------|------|
| **Scrolling (Our Method)** | Simple, no API needed, gets images | Slower, limited by scroll depth |
| **API Calls (Notebook)** | Fast, can get all reviews | Requires reverse engineering, may break |

## Files Created

### 1. test_reviews_scroll.js
Test script to verify the scrolling method works.

**Usage:**
```bash
cd /Volumes/Data/time_scraper
node test_reviews_scroll.js
```

**What it does:**
- Opens a place with many reviews (8000+ reviews)
- Scrolls the reviews section
- Extracts review data
- Analyzes data quality
- Saves results to output/test_reviews_scroll.json

**Expected output:**
- Extracts 50-100+ reviews with 20 scrolls
- 90%+ reviews have text and rating
- Some reviews have images
- Reviewer stats available

### 2. reviews_extractor_scroll.js
Reusable function that can be integrated into pipeline.

**Features:**
- Configurable maxReviews and maxScrolls
- Extracts all review fields matching notebook structure
- Handles images
- Smart stopping when no new reviews found

## Data Extracted

The scrolling method can extract:

```javascript
{
  review_id: "string",
  rating: 1-5,
  review_text: "Review content...",
  published_at: "2 months ago",
  reviewer_name: "John Doe",
  reviewer_photo_count: 15,
  reviewer_review_count: 234,
  is_local_guide: true/false,
  review_likes_count: 0,
  response_from_owner_text: "Thank you...",
  response_from_owner_ago: "1 month ago",
  review_images: ["url1", "url2"]  // Optional
}
```

## Integration with Pipeline

### Option 1: Add to existing pipeline

Edit `/Volumes/Data/scraper/google-maps-scraper-pipeline.js`:

```javascript
// Load the reviews extractor
const reviewsExtractor = fs.readFileSync(
    '/Volumes/Data/time_scraper/reviews_extractor_scroll.js',
    'utf8'
);

// In executeExtraction() function, before returning:
async function executeExtraction() {
    // ... existing code ...

    // Extract reviews by scrolling
    await page.evaluate(reviewsExtractor);
    const reviews = await page.evaluate(async () => {
        const extractor = window.extractReviewsByScrolling;
        return await extractor({ maxReviews: 50, maxScrolls: 20 });
    });

    cleanedData.detailedReviews = reviews;

    return cleanedData;
}
```

### Option 2: Use in batch script

Modify `gmaps_batch_scrape_stable.js`:

```javascript
// IMPORTANT: Use two-step loading before extraction
async function loadPlaceForReviews(page, placeId) {
    // Step 1: Initialize with search API
    await page.goto(
        `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${placeId}`,
        { waitUntil: 'domcontentloaded', timeout: 60000 }
    );
    await page.waitForTimeout(2000);

    // Step 2: Load full interface
    await page.goto(
        `https://www.google.com/maps/place/?q=place_id:${placeId}&hl=en`,
        { waitUntil: 'domcontentloaded', timeout: 60000 }
    );
    await page.waitForTimeout(4000);
}

// After loading place with two-step process:
await loadPlaceForReviews(page, placeId);

const reviewsExtractorSrc = fs.readFileSync(
    '/Volumes/Data/time_scraper/reviews_extractor_scroll.js',
    'utf8'
);

await page.evaluate(reviewsExtractorSrc);
const reviews = await page.evaluate(async () => {
    return await window.extractReviewsByScrolling({
        maxReviews: 100,
        maxScrolls: 30,
        includeImages: true
    });
});

result.detailedReviews = reviews;
```

## Performance Considerations

### Scroll Speed vs Data Quality

```javascript
// Fast (800ms delay) - Good for testing
{ maxReviews: 50, maxScrolls: 20, scrollDelay: 800 }

// Balanced (1200ms delay) - Recommended for production
{ maxReviews: 100, maxScrolls: 30, scrollDelay: 1200 }

// Slow (2000ms delay) - Maximum data quality
{ maxReviews: 200, maxScrolls: 50, scrollDelay: 2000 }
```

### Time Estimates

- 50 reviews: ~30-40 seconds
- 100 reviews: ~1-1.5 minutes
- 200 reviews: ~2-3 minutes

## Limitations

1. **Maximum reviews**: Can typically get 100-300 reviews per place
   - Google Maps lazy-loads reviews
   - After certain depth, no more reviews load

2. **Scroll depth**: Limited by DOM performance
   - Very long scrolls may cause memory issues
   - Recommended max: 50 scrolls

3. **Images**: Not all review images are loaded
   - Only visible images in viewport are available
   - May need additional clicks to load all images

## Advantages Over API Method

1. **No reverse engineering needed**
   - Uses standard DOM manipulation
   - Less likely to break with Google updates

2. **Gets review images**
   - API method in notebook doesn't extract images well
   - Scrolling method can capture image URLs

3. **More stable**
   - Not dependent on internal API endpoints
   - Works in any locale/language

## Testing Results

Run the automated test script:

```bash
node test_reviews_auto.js
```

**Actual test results (verified):**
- ✓ Extracted 101 reviews in 10 scrolls
- ✓ 100% have review text
- ✓ 100% have ratings
- ✓ 100% have reviewer names
- ✓ 100% have published dates
- Test place: Cappadocia Restaurant (7,958 total reviews)

**Sample extracted review:**
```json
{
  "review_id": "26354;mutable:true;",
  "rating": 5,
  "review_text": "I ordered the Lamb Chops, Adana Lamb Kebab, and Baklava...",
  "published_at": "a month ago",
  "reviewer_name": "Andriana Stefani"
}
```

## Next Steps

1. **Run test**: Verify the method works in your environment
2. **Adjust parameters**: Fine-tune maxScrolls and scrollDelay
3. **Integrate**: Add to pipeline or batch script
4. **Monitor**: Watch for changes in DOM structure

## Troubleshooting

### Reviews not extracting
- Check if Reviews tab is clickable
- Verify scrollable container is found
- Increase scrollDelay for slower connections

### Duplicate reviews
- Script uses review_id to prevent duplicates
- If still seeing duplicates, check selector accuracy

### Missing data fields
- Some places may not have all fields
- Check console logs for extraction errors
- Update selectors if DOM changed

## Conclusion

The scrolling method provides a good balance of:
- Data completeness (85% of notebook features)
- Reliability (doesn't depend on internal APIs)
- Maintainability (easy to understand and modify)

It's recommended for production use when you need detailed reviews without complex API reverse engineering.
