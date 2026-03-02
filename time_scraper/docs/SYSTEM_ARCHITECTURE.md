# Google Maps Batch Scraper System - File Architecture

## Data Preparation Tools

### City Generator

Before running batch scraping, you need to generate input data files. The City Generator provides a complete toolchain to generate boundaries and sampling points for any city.

#### Components

**1. boundary-generator.js**
- **Purpose**: City boundary generator
- **Data Source**: OpenStreetMap (via Overpass API)
- **Output**: City boundary file in GeoJSON format
- **Key Features**:
  - Auto-query administrative boundaries by city name
  - Support for Polygon and MultiPolygon
  - Handle complex relation data (outer/inner ways)
  - Implement proper Ring Assembly algorithm for multi-way boundaries

**2. points-generator.js**
- **Purpose**: Sampling point generator
- **Algorithm**: Rejection Sampling + Lloyd Relaxation
- **Output**: Uniformly distributed sampling point coordinates
- **Key Features**:
  - Auto-calculate number of sampling points based on city area
  - Generate initial random points using rejection sampling
  - Optimize point distribution using Lloyd relaxation
  - Support multiple output formats: JSON/CSV/GeoJSON

**3. index.js**
- **Purpose**: Main entry program integrating all functions
- **Features**:
  - Command-line interface (CLI)
  - Workflow orchestration
  - Generate statistical summary
  - Output visualization HTML files

#### Usage Flow

```bash
# Step 1: Generate city boundary and sampling points
node src/city-generator/index.js --city "Singapore" --output data/singapore

# Output files:
# - singapore_boundary.geojson    # City boundary
# - singapore_points.json          # Sampling points (JSON)
# - singapore_points.csv           # Sampling points (CSV)
# - singapore_points.geojson       # Sampling points (GeoJSON)
# - singapore_summary.json         # Statistics summary

# Step 2: Use POI Search Mode to search and scrape directly (NEW - Recommended)
node src/gmaps_batch_scrape_with_reviews.js \
  --search-mode \
  --points data/singapore/singapore_points.csv \
  --categories config/categories.json \
  --output output/singapore_results.ndjson

# Alternative Step 2: Use Google Places API to obtain place_id
# (Requires external script to query Places API)
# Then generate coordinates_singapore.json
# Format: [{ latitude, longitude, place_id, name, category, ... }]
```

#### Configuration Files

**config/categories.json**
- Defines POI categories to search
- Contains 50 common categories (restaurants, supermarkets, hospitals, etc.)
- Can be customized according to needs

#### Dependencies

- `@turf/turf` - Geospatial computation library
- Node.js built-in modules (https, fs)

---

## POI Search Module ✓ New (2026-01-24)

### poi-searcher.js
**Purpose**: POI search from sampling points (eliminates need for Places API)
**Responsibilities**:
- Generate Google Maps search URLs from coordinates and categories
- Scroll and collect search results from Google Maps
- Extract place_id directly from URLs (fast and reliable)
- Batch process multiple points × categories
- Deduplicate place_ids
- Save search results for review

**Key Features**:
- **No Places API Required**: Direct search on Google Maps
- **Fast place_id Extraction**: Parse from URL parameters (!1s{place_id})
- **Intelligent Scrolling**: Handle three scenarios:
  1. Normal feed list with multiple results
  2. Single result direct redirect to place page
  3. Single result with embedded link
- **Flexible Input**: Support CSV/JSON point files, multiple column name formats
- **Comprehensive Output**: Save search URLs, links, and place_ids

**Workflow**:
```javascript
1. Load sampling points (CSV/JSON) and POI categories
2. For each point × category combination:
   - Generate search URL: https://maps.google.com/search/{query}/@{lat},{lng},{zoom}
   - Visit search page
   - Detect feed container [role="feed"]
   - Scroll to load all results
   - Collect place links
   - Extract place_id from URLs
3. Deduplicate all place_ids
4. Return unique place_id list
```

**Key Functions**:
```javascript
// Generate search link
createSearchLink(query, lat, lng, zoom='1000m', lang='en')
// Returns: https://maps.google.com/search/Restaurant/@22.298,114.263,1000m?...

// Scroll and collect results
scrollAndCollectLinks(page, options)
// Returns: ['https://maps.google.com/place/...', ...]

// Extract place_id from URL
extractPlaceIdFromUrl(url)
// Matches: !1s{place_id} or ftid={place_id}
// Returns: '0x340403cf320035ed'

// Batch search
batchSearchPOIs(browser, points, categories, options)
// Returns: { uniquePlaceIds: [...], totalPlaceIds: 28, results: [...] }
```

**Configuration**:
```javascript
SEARCH_CONFIG = {
  defaultZoom: '1000m',        // Search radius
  maxScrolls: 15,              // Max scrolls per search
  scrollDelay: 800,            // Scroll delay (ms)
  searchDelay: 2000,           // Delay between searches (ms)
  selectors: {
    feedContainer: '[role="feed"]',
    endOfList: 'p.fontBodyMedium > span > span',
    placeLinks: 'a[href*="/maps/place/"]'
  }
}
```

**Output Example**:
```json
{
  "totalSearches": 1,
  "uniquePlaceIds": ["0x340403cf320035ed", "0x340403eae45c17bb", ...],
  "totalPlaceIds": 28,
  "results": [
    {
      "pointIndex": 0,
      "point": { "lat": 22.298, "lng": 114.263 },
      "category": "Restaurant",
      "searchUrl": "https://maps.google.com/search/Restaurant/@22.298,114.263,1000m?...",
      "placeLinks": [...],
      "placeIds": [...],
      "count": 28
    }
  ]
}
```

**Integration with Main Script**:
- Called automatically when `--search-mode` flag is enabled
- Runs before main scraping pipeline
- Found place_ids are passed directly to scraping flow
- No temporary files needed (seamless integration)

---

## Core Runtime Files

### 1. gmaps_batch_scrape_with_reviews.js
**Purpose**: Main batch processing script (with review extraction and POI search)
**Responsibilities**:
- Launch and manage Playwright browser
- **POI Search Mode** (NEW): Search POI from sampling points, extract place_ids
- **Normal Mode**: Read input file (place_id list)
- Implement two-step loading strategy
- Call pipeline script to extract basic data
- Call reviews extractor to extract reviews
- Handle errors and retry logic
- Output data in NDJSON/JSON format
- Anti-detection mechanisms (User-Agent rotation, proxy support, CAPTCHA detection)

**Execution Flow**:
```javascript
// Mode Selection
if (--search-mode) {
  // POI Search Mode (NEW)
  1. Load sampling points from CSV/JSON
  2. Load POI categories from JSON
  3. Launch temporary browser for searching
  4. Call batchSearchPOIs() to find place_ids
  5. Save search results to file
  6. Use found place_ids for scraping
} else {
  // Normal Mode
  1. Load place_ids from input file
}

// Scraping Pipeline (Both Modes)
2. Launch main browser with anti-detection
3. For each place_id:
   // Two-step loading
   Step 1: await page.goto(searchUrl, ...) // Initialize full interface
   Step 2: await page.goto(placeUrl, ...)   // Load place page

   // Data extraction
   const result = await page.evaluate(pipelineSrc);  // Basic data
   await page.evaluate(reviewsExtractorSrc);         // Inject review extractor
   const reviews = await page.evaluate(async () => {
     return await window.extractReviewsByScrolling(config);
   });

4. Output to NDJSON/JSON file
```

**Command Line Arguments**:

*Basic Parameters:*
- `--input`: Input file (JSON array containing place_id) - Required in normal mode
- `--output`: Output file (NDJSON format)
- `--limit`: Processing quantity limit (applies to sampling points in search mode)
- `--start`: Start offset - skip first N items (used for parallel splitting)
- `--headless`: Headless mode

*POI Search Mode (NEW):*
- `--search-mode`: Enable POI search from sampling points
- `--points`: Sampling points file (CSV/JSON) - Required in search mode
- `--categories`: POI categories config (JSON) - Required in search mode
- `--search-zoom`: Search radius (default: 1000m)
- `--max-search-scrolls`: Max scrolls per search (default: 15)
- `--search-delay`: Delay between searches in ms (default: 2000)
- `--search-results`: Search results output file (auto-generated if not specified)
- `--no-save-search-results`: Don't save search results

*Review Extraction:*
- `--max-reviews`: Maximum reviews per place (default 1000)
- `--max-scrolls`: Maximum scroll count (default 1000)
- `--review-sort`: Review sort order: `relevant` (default), `newest`, `highest`, `lowest` ✓ New (2026-01-27)
- `--no-reviews`: Disable review extraction
- `--no-review-images`: Disable review image URL extraction

*Image Download:*
- `--download-images`: Enable review image download (default disabled)
- `--image-output`: Image output directory (default: output/images)

*Output Format:*
- `--format`: Output format (ndjson/json/both)
- `--pretty`: Enable beautified output

*Anti-Detection:*
- `--use-proxy`: Use proxy
- `--proxy-config`: Proxy configuration file
- `--random-delay`: Enable random delays
- etc...

**Dependencies**:
- src/google-maps-scraper-pipeline.js
- reviews_extractor_scroll.js
- review_timestamp_parser.js (timestamp extraction)
- review_image_downloader.js (image download module)

---

### 2. src/google-maps-scraper-pipeline.js
**Purpose**: Basic data extraction engine
**Responsibilities**:
- Extract structured data from Google Maps page DOM
- Run in browser context (injected via page.evaluate)
- Extract business info, opening hours, popular times, About info, etc.

**Extracted Data Fields**:
```javascript
{
  business: {
    name,           // Business name (from h1 element)
    rating,         // Rating
    reviewCount,    // Total review count
    categories,     // Categories (via button.DkEaL selector) ✓ Fixed (2026-01-27)
    mainCategory,   // Main category
    address,        // Address array
    fullAddress,    // Full address string
    plusCode,       // Plus Code (via [data-item-id="oloc"] selector) ✓ New (2026-01-27)
    coordinates,    // Coordinates {latitude, longitude}
    phone,          // Phone
    website,        // Website
    placeId,        // Place ID
    priceRange      // Price range
  },
  openingHours: {
    currentStatus,  // Current status
    weeklyHours     // 7-day complete hours
  },
  popularTimes: {
    weeklyData      // 7-day popular times data
  },
  about: {
    // Detailed categorized information
    "Accessibility": [...],
    "Service options": [...],
    "Amenities": [...],
    // etc...
  },
  metadata: {
    // Metadata
  }
}
```

**Key Algorithms**:
- Address recognition (via regex and heuristic rules)
- Category identification (filter noise data)
- Coordinate extraction (from URL or other sources)
- Opening hours parsing
- Popular times data structuring

---

### 3. reviews_extractor_scroll.js
**Purpose**: Review extraction module
**Responsibilities**:
- Extract Google Maps reviews via scrolling
- Run in browser context (injected via page.evaluate)
- Expose global function `window.extractReviewsByScrolling()`

**Extraction Flow**:
```javascript
// Phase 0: Sort reviews (if reviewSort specified) ✓ New (2026-01-27)
0. If reviewSort !== 'relevant':
   a. Find and click sort button (button[aria-label*="Sort reviews"])
   b. Wait for sort menu to appear
   c. Click corresponding menuitemradio (newest/highest/lowest)
   d. Wait for reviews to reload

// Phase 1: Fast scroll to extract review metadata + detect "+N" buttons
1. Find and click Reviews tab (fallback to Overview if not found)
2. Wait 3s for reviews to load
3. Find scrollable container (selector: div.m6QErb.DxyBCb.kA9KIf.dS8AEf)
4. Reset scroll position to top
5. Main scrolling loop (while scrollAttempts < maxScrolls && reviews.length < maxReviews):
   a. Click all "More" expand buttons to reveal full review text
   b. Extract reviews from current DOM (extractCurrentReviews helper)
   c. Detect "+N more photos" buttons (button.Tya61d[aria-label*="more photos"])
      - Record reviewId to clickedMoreButtons Set (detection only, no clicking)
   d. Perform scroll with adaptive delay ✓ Updated (2026-01-27):
      - scrollBy(0, clientHeight * 0.8)
      - dispatchEvent(new Event('scroll', { bubbles: true }))  // Triggers lazy loading
      - Wait adaptive delay: 500ms if new content loaded recently, 1500ms if 2+ empty scrolls
   e. Check if scroll moved:
      - If stuck at bottom: wait 2s extra, check if scrollHeight grew
      - If still stuck after 3 consecutive attempts: stop (all reviews loaded)
      - If content grew: continue scrolling
   f. If not stuck: reset stuck counter, continue

// Phase 2: Expand detected "+N more photos" buttons (runs after Phase 1)
6. If any "+N" buttons were detected:
   a. Scroll back to top
   b. Scroll through reviews at same speed as Phase 1
   c. For each detected "+N" button found in viewport:
      - Save scroll position
      - Click "+N" button -> wait 1.5s for expansion
      - Extract all expanded photo URLs from button.Tya61d[data-review-id] via CSS background-image
      - Click Back button -> wait 2s
      - Re-find scroll container with retry (up to 5 attempts, 1s each)
      - Restore scroll position
   d. Replace Phase 1 partial images with complete expanded sets
7. Return deduplicated review array
```

**Key Technical Detail - Lazy Loading Trigger** (Fixed 2026-01-26):
Google Maps uses a virtual scroll mechanism that requires both `scrollBy()` AND a dispatched
`scroll` event to trigger lazy loading of new review batches. Without `dispatchEvent`,
scrolling moves the viewport but new reviews never load from the server. Google Maps loads
reviews in batches of ~10 as the user scrolls.

**Stop Strategy**:
The extractor only stops when it is physically stuck at the bottom of the scroll container
AND the `scrollHeight` does not grow after 3 consecutive attempts with 2-second waits.
This ensures all available reviews are loaded before stopping.

**Extracted Review Fields**:
```javascript
{
  review_id,              // Unique identifier
  rating,                 // 1-5 stars
  review_text,            // Review text
  published_at,           // Publish time (relative, e.g., "4 years ago")
  published_at_date,      // Publish time (absolute ISO date) ✓ New (2026-01-24)
  edited_at_date,         // Edit time (absolute ISO date, if different from created) ✓ New (2026-01-24)
  _timestamp_us,          // Raw microsecond timestamps {created, edited} ✓ New (2026-01-24)
  reviewer_name,          // Reviewer name ✓ Fixed (2026-01-24)
  reviewer_link,          // Reviewer profile link ✓ New (2026-01-27)
  reviewer_photo_count,   // Reviewer photo count (via div.RfnDt) ✓ Fixed (2026-01-27)
  reviewer_review_count,  // Reviewer total review count
  is_local_guide,         // Is local guide
  review_likes_count,     // Like count
  review_images,          // Image URL array (if enabled) ✓ Fixed (2026-01-24)
  local_image_paths,      // Local image path array (if download enabled) ✓ New (2026-01-24)
  response_from_owner_text, // Owner response
  response_from_owner_ago   // Response time
}
```

**Configuration Parameters**:
- `maxReviews`: Maximum extraction count (default 1000)
- `maxScrolls`: Maximum scroll count (default 1000)
- `includeImages`: Whether to extract image URLs (default true)
- `scrollDelay`: Base scroll delay in ms (default 500, adaptive: 500ms fast / 1500ms slow) ✓ Updated (2026-01-27)
- `reviewSort`: Review sort order - `relevant`, `newest`, `highest`, `lowest` (default `relevant`) ✓ New (2026-01-27)

**Browser Console Log Capture** (Added 2026-01-26):
Since `reviews_extractor_scroll.js` runs inside `page.evaluate()` (browser context),
its `console.log()` output is not visible in Node.js by default. The main script now
attaches a `page.on('console')` handler that captures all `[Reviews]` prefixed messages
and forwards them via IPC logging, enabling real-time debugging of the extraction process.

**Image Extraction Technical Details** ✓ Updated (2026-01-26):

*Phase 1 Image Extraction (during scrolling):*
- **Selector**: `button[aria-label*="Photo"][aria-label*="review"]:not([aria-label*="Photo of"])`
  - Example aria-label: "Photo 1 on John's review"
- **Extraction Method**:
  1. Check `<img>` tags within button (src or data-src attributes)
  2. Check button's CSS `background-image` property (Google Maps primarily uses this)
- Captures the first 3-4 visible photo thumbnails per review

*"+N More Photos" Button Expansion (Phase 2):*
- **Detection Selector**: `button.Tya61d[aria-label*="more photos"]`
  - Example aria-label: "+ 15 more photos on John's review"
  - Detected during Phase 1 scrolling, processed after all reviews are extracted
- **Expansion Flow**: Click "+N" -> in-panel navigation to expanded photo view -> extract all `button.Tya61d[data-review-id]` via CSS `background-image` -> click Back button -> retry-based scroll container recovery (up to 5 retries)
- **Merge Strategy**: Phase 2 expanded images completely replace Phase 1 partial images for that review
- **Key DOM Details**:
  - Photo buttons: class `Tya61d`, attribute `data-review-id`, `data-photo-index`
  - "+N" button: same class, `aria-label` contains "more photos"
  - Back button: `button[aria-label="Back"]`
  - Photos render as CSS `background-image`, not `<img>` tags

*Image Filter Rules (both phases):*
- Must contain `googleusercontent` domain
- Exclude avatar images (contain avatar or small size identifiers like w36-h36, w40-h40)
- Exclude data URLs and empty URLs

---

### 4. review_image_downloader.js ✓ New (2026-01-24)
**Purpose**: Review image download module
**Responsibilities**:
- Download review images from URLs to local storage
- Organize directory structure by place_id and review_id
- Add local path references to review objects
- Provide download statistics and error handling

**Directory Structure**:
```
output/images/
  └── {place_id}/
      └── {review_id}/
          ├── image_1.jpg
          ├── image_2.jpg
          └── image_3.jpg
```

**Core Class**: `ReviewImageDownloader`

**Main Methods**:
```javascript
// Constructor
new ReviewImageDownloader(baseDir)

// Download single image
await downloadImage(imageUrl, savePath)  // Returns: boolean

// Download all images for a single review
await downloadReviewImages(placeId, reviewId, imageUrls)
  // Returns: ['place_id/review_id/image_1.jpg', ...]

// Batch download all review images
await downloadAllReviewImages(placeId, reviews, verbose)
  // Automatically adds local_image_paths field to each review

// Get statistics
getStats()  // Returns: { total, success, failed }
```

**Features**:
- Auto-create directory structure
- Filename sanitization (remove illegal characters)
- Support multiple image formats (.jpg, .png, .webp, .gif, etc.)
- Timeout protection (10 seconds/image)
- Error tolerance (single image failure doesn't affect overall process)
- Relative path storage (convenient for data migration)
- HTTP/HTTPS protocol support

**Integration Example**:
```javascript
// Usage in main batch processing script
const imageDownloader = new ReviewImageDownloader('/output/images');

// Download images after extracting reviews
if (reviews && reviews.length > 0 && imageDownloader) {
  await imageDownloader.downloadAllReviewImages(placeId, reviews, true);
  const stats = imageDownloader.getStats();
  console.log(`Downloaded ${stats.success}/${stats.total} images`);
}

// Review object will automatically have local_image_paths field added
// {
//   review_id: "...",
//   review_images: ["https://...", "https://..."],
//   local_image_paths: ["place_id/review_id/image_1.jpg", ...]
// }
```

---

### 5. review_timestamp_parser.js New (2026-01-24)
**Purpose**: Extract absolute timestamps from Google Maps API responses
**Responsibilities**:
- Intercept network responses containing review data
- Parse microsecond timestamps from API response format
- Match timestamps to DOM-extracted reviews via review_id
- Convert microseconds to ISO date strings

**Background**:
Google Maps displays relative time ("4 years ago") in the UI, but the API responses contain absolute timestamps as 16-digit microsecond Unix timestamps.

**Data Structure in API Response**:
```javascript
[
  "ChZDSUhNMG9nS0VJQ0FnSUNLOWFmMFB3EAE",  // review_id
  [
    "0x0:0x69d17c2ce13247e5",               // place reference
    null,
    1618363918805654,                       // created_at (microseconds)
    1633235442455410,                       // edited_at (microseconds)
    ...
  ],
  ...
]
```

**Key Functions**:
```javascript
// Parse API response and extract timestamps
parseReviewTimestamps(responseText)
// Returns: Map<review_id, {created_at_date, edited_at_date, ...}>

// Create Playwright response handler
createResponseHandler(timestampMap, verbose)
// Returns: async function to attach to page.on('response')

// Apply timestamps to DOM-extracted reviews
applyTimestampsToReviews(reviews, timestampMap)
// Returns: {total, matched, unmatched, matchRate}

// Convert microseconds to ISO date
microsecondsToISO(microseconds)
// Returns: "2021-04-14T01:31:58.805Z"
```

**Integration**:
```javascript
// BEFORE page.goto() - register handler early to capture all API responses:
let reviewTimestamps = new Map();
let responseHandler = createResponseHandler(reviewTimestamps, false);
page.on('response', responseHandler);

try {
    await page.goto(placeUrl);
    // ... extract reviews via DOM ...
    const reviews = await page.evaluate(...);

    // Apply timestamps
    const stats = applyTimestampsToReviews(reviews, reviewTimestamps);
    // reviews now have published_at_date and edited_at_date fields
} finally {
    // Cleanup handler
    if (responseHandler) {
        page.off('response', responseHandler);
        responseHandler = null;
    }
}
```

**Output Example**:
```json
{
  "review_id": "ChZDSUhNMG9nS0VJQ0FnSUNLOWFmMFB3EAE",
  "published_at": "4 years ago",
  "published_at_date": "2021-04-14T01:31:58.805Z",
  "edited_at_date": "2021-10-03T04:30:42.455Z",
  "_timestamp_us": {
    "created": 1618363918805654,
    "edited": 1633235442455410
  }
}
```

**Review ID Format** ✓ Fixed (2026-01-27):
Google Maps review IDs are base64-encoded protobuf strings with two known formats:
- **"Ch" prefix** (~35 chars, common): e.g. `ChZDSUhNMG9nS0VJQ0FnSUN3...`
- **"Ci" prefix** (~68 chars, alternate encoding): e.g. `Ci9DQUlRQUNvZENodHljRjlv...`

The `isReviewId()` function validates both formats (length 20-80 chars). Previously only the "Ch" prefix was recognized, causing ~3% of reviews to miss timestamps.

```javascript
function isReviewId(str) {
    if (typeof str !== 'string') return false;
    return (str.startsWith('Ch') || str.startsWith('Ci')) && str.length >= 20 && str.length <= 80;
}
```

**Response Handler Lifecycle** ✓ Updated (2026-01-27):
The response handler is registered BEFORE `page.goto()` to ensure all API responses are captured from the initial page load. Proper cleanup is performed in try/catch/finally blocks.

```javascript
// Before page.goto():
reviewTimestamps = new Map();
responseHandler = createResponseHandler(reviewTimestamps, false);
page.on('response', responseHandler);

// After review extraction (finally block):
page.off('response', responseHandler);
```

**Technical Notes**:
- Response interception is passive (read-only), does not increase anti-scraping risk
- Fallback regex extraction for non-JSON responses (pattern: `/"(C[hi][A-Za-z0-9_\-\/+]{20,75})"/g`)
- Silently fails without disrupting main flow
- Timestamps are automatically applied after DOM extraction

---

## Input/Output Files

### 5. coordinates_singapore.json
**Purpose**: Main input data file
**Format**:
```json
[
  {
    "place_id": "ChIJI41qF6kb2jERFyZ5_qaFTio",
    "name": "...",
    "lat": 1.xxx,
    "lng": 103.xxx
  },
  ...
]
```

**Notes**:
- Batch processing script reads this file
- Each object requires at least `place_id` field
- Other fields (name, lat, lng) are optional

---

### 6. output/*.ndjson
**Purpose**: Output data file
**Format**: NDJSON (one JSON object per line)
**Content**: Complete extracted data (basic data + reviews)

**Example**:
```json
{"business":{...},"openingHours":{...},"popularTimes":{...},"about":{...},"detailedReviews":[...],"_meta":{...}}
{"business":{...},"openingHours":{...},"popularTimes":{...},"about":{...},"detailedReviews":[...],"_meta":{...}}
```

---

## Configuration Files

### 7. proxy-config-iproyal.json (Optional)
**Purpose**: Proxy configuration file
**Format**:
```json
{
  "proxies": [
    {
      "server": "http://proxy1.example.com:8080",
      "username": "user1",
      "password": "pass1"
    },
    ...
  ]
}
```

**Usage**: `--use-proxy --proxy-config proxy-config-iproyal.json`

---

## Test Files

### 8. test_batch_with_reviews.sh
**Purpose**: Automated test script
**Responsibilities**:
- Create test input (1 place)
- Run batch processing script
- Validate output file
- Check review extraction results
- Display test results

**Usage**: `./test_batch_with_reviews.sh`

---

### 9. test_reviews_auto.js
**Purpose**: Standalone review extraction test
**Responsibilities**:
- Verify two-step loading strategy
- Test review extraction functionality
- Provide detailed debug information
- Independent of batch processing script

**Usage**: `node test_reviews_auto.js`

---

## Documentation Files

### 10. BATCH_WITH_REVIEWS_GUIDE.md
**Purpose**: User guide
**Content**:
- Command-line argument descriptions
- Usage examples
- Performance considerations
- Troubleshooting
- Comparison with original version

---

### 11. PIPELINE_INTEGRATION_COMPLETE.md
**Purpose**: Technical integration documentation
**Content**:
- Integration work summary
- Code modification details
- Backward compatibility notes
- Performance impact analysis
- Test validation methods

---

### 12. REVIEWS_EXTRACTION_GUIDE.md
**Purpose**: Detailed review extraction guide
**Content**:
- Two-step loading strategy explanation
- Review extraction principles
- Integration example code
- Troubleshooting

---

### 13. REVIEWS_SOLUTION_SUMMARY.md
**Purpose**: Solution summary
**Content**:
- Problem discovery process
- Key findings of two-step loading strategy
- Test results
- Comparison with API method

---

### 14. small_batch_test_results.md
**Purpose**: Small batch test report
**Content**:
- Test results for 5 locations
- Data quality analysis
- Known issues
- Performance metrics

---

## Complete Workflow Diagram

Complete flow from city name to final data scraping:

```
City Name (e.g., "Singapore")
  │
  ├─> City Generator (Data Preparation Phase)
  │     │
  │     ├─> boundary-generator.js
  │     │     └─> Call Overpass API to get city boundary
  │     │         └─> Output: city_boundary.geojson
  │     │
  │     ├─> points-generator.js
  │     │     ├─> Calculate sampling point count (based on city area)
  │     │     ├─> Rejection Sampling (generate initial random points)
  │     │     ├─> Lloyd Relaxation (optimize point distribution)
  │     │     └─> Output: city_points.json
  │     │
  │     └─> Visualization output
  │           └─> city_visualization.html
  │
  ├─> Google Places API (Manual step, not included in this project)
  │     │
  │     ├─> Read sampling point coordinates
  │     ├─> Query nearby POIs for each point + category
  │     └─> Collect place_id
  │
  ├─> Generate coordinates file
  │     └─> coordinates_singapore.json
  │         Format: [{lat, lng, place_id, name, category}]
  │
  └─> Google Maps Scraper (Data Scraping Phase)
        └─> gmaps_batch_scrape_with_reviews.js
            └─> Output: results.ndjson
```

---

## Runtime Flow Diagram

```
Input: coordinates_singapore.json
  │
  ├─> gmaps_batch_scrape_with_reviews.js (Main script)
  │     │
  │     ├─> Launch Playwright browser
  │     │
  │     ├─> Loop through each place_id:
  │     │     │
  │     │     ├─> Two-step page loading
  │     │     │     Step 1: search API URL
  │     │     │     Step 2: place URL
  │     │     │
  │     │     ├─> Inject and run google-maps-scraper-pipeline.js
  │     │     │     └─> Extract basic data (business, hours, popular times, about)
  │     │     │
  │     │     ├─> Inject and run reviews_extractor_scroll.js
  │     │     │     └─> Extract reviews (detailedReviews)
  │     │     │
  │     │     └─> Merge data and write to output file
  │     │
  │     └─> Close browser
  │
Output: output/*.ndjson
```

---

## Data Flow

```
place_id
  ↓
Two-step loading strategy
  ↓
Complete page (4 tabs: Overview, Menu, Reviews, About)
  ↓
┌─────────────────┬───────────────────┐
│                 │                   │
Basic data        Review data
extraction        extraction
(pipeline.js)    (reviews_extractor.js)
│                 │
↓                 ↓
business          detailedReviews[]
├─ categories     ├─ review_id
├─ plusCode        ├─ rating
openingHours      ├─ review_text
popularTimes      ├─ reviewer_name
about             ├─ reviewer_link
metadata          ├─ published_at_date
                  └─ ...
│                 │
└────────┬────────┘
         ↓
   Merge into complete JSON object
         ↓
   Write to NDJSON file
```

---

## Core Dependencies

```
gmaps_batch_scrape_with_reviews.js (Main script)
  │
  ├─ Required dependencies:
  │   ├─ src/google-maps-scraper-pipeline.js
  │   │   └─ Error and exit if not found
  │   │
  │   ├─ reviews_extractor_scroll.js
  │   │   └─ Warning but continue (skip review extraction) if not found
  │   │
  │   └─ review_timestamp_parser.js
  │       └─ Passive API response interception for absolute timestamps
  │
  ├─ Optional dependencies:
  │   ├─ review_image_downloader.js (if using --download-images)
  │   ├─ proxy-config-iproyal.json (if using --use-proxy)
  │   └─ input file (specified via --input)
  │
  └─ External dependencies:
      ├─ playwright (npm package)
      ├─ playwright-extra (anti-detection)
      └─ puppeteer-extra-plugin-stealth
```

---

## Minimum Running Configuration

**Required Files**:
1. `gmaps_batch_scrape_with_reviews.js` - Main script
2. `src/google-maps-scraper-pipeline.js` - Basic data extraction
3. `reviews_extractor_scroll.js` - Review extraction (optional but recommended)
4. `review_timestamp_parser.js` - Absolute timestamp extraction (optional, auto-loaded)
5. Input file (containing place_id list)

**Run Command**:
```bash
node gmaps_batch_scrape_with_reviews.js \
  --input coordinates_singapore.json \
  --output output/results.ndjson \
  --limit 10
```

**Run without reviews**:
```bash
node gmaps_batch_scrape_with_reviews.js \
  --input coordinates_singapore.json \
  --output output/results.ndjson \
  --no-reviews \
  --limit 10
```

**Run with image download** ✓ New (2026-01-24):
```bash
node gmaps_batch_scrape_with_reviews.js \
  --input coordinates_singapore.json \
  --output output/results.ndjson \
  --limit 10 \
  --max-reviews 30 \
  --download-images \
  --image-output output/images
```

---

## Summary

### Core Modules
1. **gmaps_batch_scrape_with_reviews.js** - Scheduler and coordinator
2. **google-maps-scraper-pipeline.js** - Basic data extraction engine
3. **reviews_extractor_scroll.js** - Review extraction engine
4. **review_timestamp_parser.js** - Absolute timestamp extraction (API interception)
5. **review_image_downloader.js** - Image download module (optional)

### Key Innovations
- **Two-step loading strategy**: Ensures complete interface loading
- **Modular design**: Pipeline and reviews extractor independently testable
- **Error isolation**: Review extraction failure doesn't affect basic data
- **Anti-detection mechanisms**: User-Agent rotation, proxy support, human-like behavior simulation
- **Image download**: Automatically download review images to local storage, maintain associations ✓ New (2026-01-24)
- **Adaptive scroll delay**: Dynamic scroll speed based on content loading activity ✓ New (2026-01-27)
- **API response interception**: Passive timestamp extraction from network responses ✓ Enhanced (2026-01-27)
- **Parallel splitting**: Split input data into N parts, launch concurrent processes with auto-numbered outputs ✓ New (2026-01-27)

### File Count Statistics
- Core runtime files: 5 (pipeline + batch scripts + review extractor + image downloader + timestamp parser)
- Input/output files: 2 types
- Configuration files: 1 (optional)
- Test files: 2
- Documentation files: 5

**Total**: 15 files (excluding output data)

---

## Maintenance History & Bug Fixes

### "+N More Photos" Button Expansion (2026-01-26)

**Problem Description**:
Reviews with more than 4 photos only show the first 3 thumbnails plus a "+N" button (e.g., "+15") on the 4th slot. The hidden photos are not loaded until the "+N" button is clicked, resulting in incomplete image extraction.

**Root Cause**:
Google Maps renders review photos as CSS `background-image` on `button.Tya61d` elements. When a review has >4 photos, the 4th button becomes a "+N more photos" overlay. Clicking it triggers in-panel navigation to an expanded photo view (not a lightbox/dialog), and a "Back" button appears to return to the reviews list.

**Solution**:

Modified file: `reviews_extractor_scroll.js`

Two-phase approach to avoid interrupting the main scrolling flow:

1. **Phase 1 Detection** (during main scroll loop):
```javascript
// Detect "+N" buttons in viewport, record reviewId only (no clicking)
const morePhotosButtons = document.querySelectorAll('button.Tya61d[aria-label*="more photos"]');
for (const moreBtn of morePhotosButtons) {
    const reviewId = moreBtn.getAttribute('data-review-id');
    if (reviewId && !clickedMoreButtons.has(reviewId)) {
        clickedMoreButtons.add(reviewId);
    }
}
```

2. **Phase 2 Expansion** (after all reviews extracted):
```javascript
// Scroll back to top, then scroll through to find and click each detected "+N" button
moreBtn.click();           // Navigate to expanded photo view
await sleep(1500);

// Extract all expanded photos via CSS background-image
const expandedButtons = document.querySelectorAll(`button.Tya61d[data-review-id="${reviewId}"]`);
// ... extract background-image URLs ...

// Return to reviews list
backBtn.click();
await sleep(2000);

// Re-find scroll container with retry (up to 5 attempts)
for (let retry = 0; retry < 5; retry++) {
    const newContainer = document.querySelector('div.m6QErb.DxyBCb.kA9KIf.dS8AEf');
    if (newContainer && newContainer.scrollHeight > 0) {
        scrollContainer = newContainer;
        break;
    }
    await sleep(1000);
}
```

**Key Design Decisions**:
- **Detection-only during Phase 1**: Clicking "+N" during scrolling causes in-panel navigation that destroys the scroll container (`scrollHeight` drops to 0), breaking the main extraction loop
- **Retry-based container recovery**: After clicking "Back", the scroll container may take time to rebuild in the DOM. The retry loop (5 attempts x 1s) ensures robust recovery
- **Complete replacement**: Phase 2 expanded images replace Phase 1 partial images (the expanded view shows ALL photos including the first 3)

**DOM Structure Reference**:
- Photo buttons: `button.Tya61d[data-review-id][data-photo-index]`
- "+N" button: `button.Tya61d[aria-label*="more photos"]` (e.g., `"+ 15 more photos on John's review"`)
- Back button: `button[aria-label="Back"]` (class `hYBOP`)
- Photo container: `div.KtCyie`
- Photos are CSS `background-image`, not `<img>` tags

---

### Review Extraction Scroll Mechanism Fix (2026-01-26)

**Problem Description**:
Review extraction only captured ~10 reviews per place, even when maxReviews was set to 1000 and the place had 200+ reviews.

**Root Cause**:
1. **Lazy Loading Not Triggered**: `scrollBy()` alone does not trigger Google Maps' virtual scroll lazy loading mechanism. Google Maps requires a dispatched `scroll` event to detect scroll position changes and load new review batches.
2. **Aggressive Early Stop**: The previous "no new reviews after 3 scrolls" strategy stopped extraction prematurely, before the lazy loading could complete.

**Solution**:

Modified file: `reviews_extractor_scroll.js`

1. **Added Event Dispatch After Scroll** (performScroll helper):
```javascript
scrollContainer.scrollBy(0, scrollContainer.clientHeight * 0.8);
scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
```

2. **Replaced Early Stop with Bottom-Stuck Detection**:
```javascript
// Only stop when physically stuck at bottom AND scrollHeight doesn't grow
// after 3 consecutive attempts with 2s waits
if (!scrollResult.moved) {
    await sleep(2000);
    if (scrollContainer.scrollHeight > scrollResult.scrollHeightAfter) {
        bottomStuckCount = 0; continue;  // New content loaded
    }
    bottomStuckCount++;
    if (bottomStuckCount >= 3) break;    // Truly at the end
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
    scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
    await sleep(2000);
}
```

3. **Added Browser Console Log Capture** (`gmaps_batch_scrape_ipc.js`):
```javascript
page.on('console', (msg) => {
    if (msg.text().includes('[Reviews]')) {
        ipcLog('info', `[Browser] ${msg.text()}`);
    }
});
```

**Verification Results**:
- Before fix: 10 reviews extracted (from a place with 210+ listed reviews)
- After fix: 408 reviews extracted (40x improvement)
- 169 scrolls over ~190 seconds
- Google Maps loads reviews in batches of ~10 per scroll cycle

---

### Default Parameter Change (2026-01-26)

Changed default `maxReviews` from 50 to 1000 and `maxScrolls` from 20 to 1000 across all scripts:
- `gmaps_batch_scrape_ipc.js` (parseArgs defaults + page.evaluate fallbacks)
- `gmaps_batch_scrape_with_reviews.js` (parseArgs defaults + page.evaluate fallbacks)
- `reviews_extractor_scroll.js` (internal defaults)
- `frontend/src/components/views/ScraperConfigView.jsx` (form defaults)

---

### Convert-to-JSON Path Fix (2026-01-26)

**Problem**: "Convert to JSON" button always failed with "Output file does not exist".

**Root Cause**: `config.output` stored relative paths (e.g., `"output/666.ndjson"`), but the backend process runs from the `backend/` directory (started via `cd backend && npm run dev` in `start.sh`). So `fs.existsSync("output/666.ndjson")` resolved to `/Volumes/Data/time_scraper/backend/output/666.ndjson` instead of the correct `/Volumes/Data/time_scraper/output/666.ndjson`.

**Fix** (`backend/controllers/TaskController.js`):
```javascript
const projectRoot = path.join(__dirname, '../..');
const ndjsonPath = path.isAbsolute(config.output)
  ? config.output
  : path.join(projectRoot, config.output);
```

---

### reviewer_name Field Extraction Fix (2026-01-24)

**Problem Description**:
During review extraction, all reviews except the first one had empty or incorrect `reviewer_name` fields showing as "More".

**Root Cause**:
1. **Container Location Error**: When finding review container by navigating up from star element, found child container (`GHT2ce`) instead of parent container containing complete review info
2. **DOM Structure Hierarchy**: Reviewer name `.d4r55` element is in outer container, completely missing from child container
3. **Selector Too Broad**: Backup selector `button[aria-label]` incorrectly matched "More" expand button

**Solution**:

Modified file: `reviews_extractor_scroll.js`

1. **Container Validation Logic** (Lines 100-112):
```javascript
// If initial element doesn't contain .d4r55 (reviewer name), search up to parent container
let container = el;
if (!el.querySelector('.d4r55')) {
    let parent = el.parentElement;
    for (let i = 0; i < 10 && parent; i++) {
        if (parent.querySelector('.d4r55') && parent.textContent.length > 80) {
            container = parent;
            break;
        }
        parent = parent.parentElement;
    }
}
```

2. **Optimized Selector Priority** (Lines 150-158):
```javascript
const nameSelectors = [
    '.d4r55.fontTitleMedium',                    // Primary selector (Dec 2025)
    'button[data-href*="/maps/contrib/"]',       // Contributor button
    'a[href*="/maps/contrib/"]',                 // Contributor link
    '.d4r55',                                    // Class selector
    'div.d4r55',                                 // div.d4r55
    '[data-attrid="Reviewer name"]',             // Data attribute
    'button.WEBjve'                              // Backup selector
];
```

3. **Text Filtering Rules** (Lines 167-172):
```javascript
// Exclude invalid text
if (text &&
    !textLower.includes('more') &&
    !textLower.includes('photo') &&
    !textLower.includes('local guide') &&
    text.length < 100 &&
    text.split(' ').length <= 5) {  // Names typically 1-5 words
    review.reviewer_name = text;
    break;
}
```

**Verification Results**:
- ✅ Successfully extracted complete names from 101 reviews
- ✅ Supports multilingual names (English, Arabic, Chinese, etc.)
- ✅ Batch processing script verified

**References**:
- [How to Scrape Reviews from Google Maps | Stackademic](https://stackademic.com/blog/how-to-scrape-reviews-from-google-maps)
- [How to Scrape Google Reviews - ZenRows](https://www.zenrows.com/blog/scrape-google-reviews)

---

### Review Image Extraction & Download Feature Implementation (2026-01-24)

**Requirement Description**:
When scraping reviews, need to simultaneously extract review images and download them to local storage while maintaining associations with reviews.

**Technical Challenges**:
1. **Image Location Identification**: Google Maps review images aren't traditional `<img>` tags but rendered via CSS `background-image`
2. **Selector Design**: Need to distinguish between user avatars and review photos
3. **Image URL Extraction**: Need to parse complete image URLs from CSS styles
4. **Directory Organization**: Need reasonable directory structure to organize large numbers of image files

**Solution**:

1. **Image Selector** (reviews_extractor_scroll.js Line 233):
```javascript
// Find review photo buttons (exclude user avatars)
const photoButtons = container.querySelectorAll(
  'button[aria-label*="Photo"][aria-label*="review" i]:not([aria-label*="Photo of"])'
);
```
- Matches buttons with aria-label containing "Photo" and "review"
- Excludes user avatars ("Photo of...")
- Example matches: "Photo 1 on John's review", "+ 46 more photos on John's review"

2. **Dual Extraction Strategy** (reviews_extractor_scroll.js Lines 236-272):
```javascript
// Method 1: Check <img> tags
const imgs = button.querySelectorAll('img');
imgs.forEach(img => {
  const src = img.src || img.getAttribute('data-src');
  if (isValidImage(src)) images.push(src);
});

// Method 2: Check CSS background-image (primary method)
const style = window.getComputedStyle(button);
const backgroundImage = style.backgroundImage;
if (backgroundImage && backgroundImage !== 'none') {
  const urlMatch = backgroundImage.match(/url\(["']?([^"')]+)["']?\)/);
  if (urlMatch && urlMatch[1]) {
    const src = urlMatch[1];
    if (isValidImage(src)) images.push(src);
  }
}
```

3. **Image Filter Rules**:
- ✅ Must contain `googleusercontent` domain
- ❌ Exclude avatars (containing `avatar`)
- ❌ Exclude small thumbnails (`w36-h36`, `w40-h40`)
- ❌ Exclude data URLs and empty URLs

4. **Image Download Module** (review_image_downloader.js):
```javascript
class ReviewImageDownloader {
  // Download and organize images
  async downloadReviewImages(placeId, reviewId, imageUrls) {
    // Directory structure: output/images/{placeId}/{reviewId}/image_N.jpg
    // Returns relative path array
  }
}
```

5. **Data Structure Extension**:
```javascript
{
  review_id: "...",
  review_images: [        // Original URL array
    "https://lh3.googleusercontent.com/..."
  ],
  local_image_paths: [    // Local path array (new)
    "place_id/review_id/image_1.jpg"
  ]
}
```

**Integration Flow**:
1. Extract image URLs while extracting reviews (`review_images` field)
2. If `--download-images` enabled, batch download images to local storage
3. Add `local_image_paths` field to review objects pointing to local files
4. Output complete NDJSON data (including URLs and local paths)

**Verification Results**:
- ✅ Successfully extracted review photo buttons (identified via aria-label)
- ✅ Successfully extracted image URLs from CSS background-image
- ✅ Image download functionality working (supports HTTP/HTTPS)
- ✅ Reasonable directory structure, easy to manage
- ✅ Relative path storage, convenient for data migration

**Test Example**:
```bash
# Test location: FairPrice Finest (ChIJfW2Bggga2jERJfYdomPYanQ)
# Result: 10 reviews, 3 with images, 6 images downloaded total
# Success rate: 100% (6/6)
```

**Usage Command**:
```bash
node gmaps_batch_scrape_with_reviews.js \
  --input input.json \
  --output output/results.ndjson \
  --max-reviews 30 \
  --download-images \
  --image-output output/images
```

---

### City Data Generator Implementation (2026-01-24)

**Requirement Description**:
To enable data scraping for any city, need an automated tool to generate city boundaries and sampling points, replacing manual input file preparation.

**Implementation Modules**:

1. **boundary-generator.js** - City boundary generator
   - Uses Overpass API to fetch OpenStreetMap data
   - Supports auto-querying administrative boundaries by city name
   - Handles Polygon and MultiPolygon geometry types
   - Outputs standard GeoJSON format
   - **Critical Fix**: Implements proper Ring Assembly algorithm
     - OSM stores boundaries as multiple "ways" (line segments)
     - Original simple concatenation caused scrambled boundaries
     - New algorithm connects ways by matching endpoints
     - Properly handles MultiPolygon for cities with islands
     - Example: Tokyo now correctly generates 19 separate polygons (main city + islands)

2. **points-generator.js** - Sampling point generator
   - Uses Turf.js for geospatial calculations
   - Implements rejection sampling for initial random points
   - Uses Lloyd relaxation algorithm to optimize point distribution
   - Auto-calculates sampling point count based on city area
   - Supports multiple output formats: JSON/CSV/GeoJSON

3. **index.js** - Main entry program
   - Provides command-line interface (CLI)
   - Orchestrates complete workflow
   - Generates statistical summaries

**Key Algorithms**:

1. **Sampling Point Count Calculation**:
```javascript
numPoints = cityArea / (cellSize * cellSize)
// Default: 1 sampling point per 1km²
```

2. **Rejection Sampling**:
```javascript
// Randomly generate points within bounding box
// Check if point is inside city polygon
// Repeat until target count reached
```

3. **Lloyd Relaxation**:
```javascript
for (iter = 0; iter < iterations; iter++) {
  // 1. Generate Voronoi diagram
  // 2. Intersect Voronoi cells with city boundary
  // 3. Calculate centroid of intersection
  // 4. Use centroid as new point location
}
```

4. **Ring Assembly Algorithm** (boundary-generator.js):
```javascript
// Connect OSM ways into closed rings
// Match endpoints to find connecting ways
// Support both forward and reverse connection
// Handle multiple disconnected rings (MultiPolygon)
// Assign inner rings to containing outer rings
```

**Usage Examples**:
```bash
# Generate boundaries and sampling points for Singapore
node src/city-generator/index.js --city "Singapore" --output data/singapore

# Output files:
# - singapore_boundary.geojson       # City boundary
# - singapore_points.json             # Sampling points (JSON)
# - singapore_points.csv              # Sampling points (CSV)
# - singapore_points.geojson          # Sampling points (GeoJSON)
# - singapore_summary.json            # Statistical summary

# Custom parameters
node src/city-generator/index.js \
  --city "Tokyo, Japan" \
  --cell-size 500 \
  --iterations 15 \
  --output data/tokyo

# Clip to bounding box (exclude islands)
node src/city-generator/index.js \
  --city "Tokyo" \
  --bbox 139.0,35.3,140.2,36.0 \
  --output data/tokyo
```

**Configuration Files**:
- `config/categories.json` - Defines 50 common POI categories

**Dependency Updates**:
- Added `@turf/turf` - Geospatial computation library

**Integration Notes**:

Generated sampling point files can be used with **POI Search Mode** (NEW - Recommended):
1. ✅ Use `--search-mode` to directly search and scrape POIs
2. ✅ No Google Places API needed
3. ✅ Automatically extract place_id from search results
4. ✅ One command for complete workflow

Alternative workflow (legacy):
1. Use Google Places API to query POIs near each sampling point
2. Collect returned place_id
3. Generate `coordinates_singapore.json` format file
4. Use as input for batch scraping script

**Advantages**:
- ✅ Supports any city, no manual data preparation needed
- ✅ Automated generation improves efficiency
- ✅ Uniform sampling point distribution, comprehensive coverage
- ✅ Visualization for quality verification
- ✅ Flexible configuration for different needs
- ✅ Fixed boundary scrambling issue for cities with complex boundaries
- ✅ **Direct integration with POI search mode (2026-01-24)**

---

## Complete System Workflow

### Method 1: POI Search Mode (NEW - Recommended)

**End-to-End Workflow in 2 Commands:**

```bash
# Step 1: Generate city sampling points
node src/city-generator/index.js --city "Hong Kong" --output data/hongkong

# Step 2: Search POI and scrape data in one command
node src/gmaps_batch_scrape_with_reviews.js \
  --search-mode \
  --points data/hongkong/hong_kong_points.csv \
  --categories config/categories.json \
  --output output/hongkong_results.ndjson \
  --max-reviews 50 \
  --download-images \
  --headless
```

**What Happens Internally:**
1. Load 2762 sampling points from CSV
2. Load 53 POI categories from JSON
3. Total searches: 2762 × 53 = 146,386 searches
4. For each search:
   - Generate search URL with coordinates
   - Scroll and collect place links
   - Extract place_id from URLs
5. Deduplicate all place_ids (expected: ~50,000-100,000 unique POIs)
6. Scrape each POI's details, reviews, and images
7. Output to NDJSON file

**Advantages:**
- ✅ No Google Places API required
- ✅ No intermediate files needed
- ✅ Automatic deduplication
- ✅ One command for complete workflow
- ✅ Cost-effective (no API fees)

### Method 2: Traditional Mode (Legacy)

**Requires Pre-Generated place_id List:**

```bash
# Requires coordinates_singapore.json with place_ids
node src/gmaps_batch_scrape_with_reviews.js \
  --input data/coordinates_singapore.json \
  --output output/singapore_results.ndjson \
  --max-reviews 50 \
  --headless
```

**Use Cases:**
- When you already have a place_id list
- For re-scraping existing data
- For targeted scraping of specific places

---

## Performance Considerations

### POI Search Mode

**Estimated Time:**
- Sampling points generation: ~2 minutes (one-time)
- POI search (2762 points × 53 categories): ~80-120 hours
  - Average search: 2-3 seconds
  - With delays and scrolling: ~120 seconds/search
- Place scraping (50,000 POIs): ~30-50 hours
  - Average scrape: 2-3 seconds/place

**Optimization Strategies:**
1. **Web UI Parallel Split** (Recommended): Use the Parallel Split feature to automatically split data and launch N concurrent processes
2. **Manual Parallel Instances**: Run multiple CLI instances with `--start` and `--limit` offsets
3. **Category Filtering**: Select only needed categories
4. **Limit Testing**: Use `--limit` to test with fewer points first
5. **Headless Mode**: Use `--headless` for better performance
6. **Proxy Rotation**: Use `--use-proxy` to avoid rate limiting

**Web UI Parallel Split** (Recommended):
In the Web UI Scraper Config page, enable "Parallel Split" toggle, set split count (2-10), and click Start. The system automatically:
1. Counts items in the input file
2. Calculates chunk sizes (`chunkSize = Math.ceil(totalItems / splitCount)`)
3. Creates N tasks with `--start` and `--limit` offsets
4. Auto-names output files: `output/{baseName}_001.ndjson`, `_002.ndjson`, ...
5. Auto-names image directories: `output/images/{baseName}/001/`, `002/`, ...
6. Launches all N processes concurrently

**Manual CLI Parallel Execution:**
```bash
# Terminal 1: Points 0-999
node src/gmaps_batch_scrape_with_reviews.js --search-mode --points data/hongkong/hong_kong_points.csv --start 0 --limit 1000 ...

# Terminal 2: Points 1000-1999
node src/gmaps_batch_scrape_with_reviews.js --search-mode --points data/hongkong/hong_kong_points.csv --start 1000 --limit 1000 ...

# Terminal 3: Points 2000-2762
node src/gmaps_batch_scrape_with_reviews.js --search-mode --points data/hongkong/hong_kong_points.csv --start 2000 --limit 762 ...
```

---

## Parallel Split Architecture (2026-01-27)

### Overview

The Parallel Split feature allows users to split input data into 2-10 parts and launch N scraping processes concurrently via the Web UI. Each part runs as an independent task with its own checkpoint, output file, and image directory. Tasks are logically grouped by a shared `groupId` embedded in each task's config JSON (no database schema changes required).

### Backend API Endpoints

**File: `backend/routes/tasks.js`** (placed BEFORE `/:taskId` routes to avoid Express parameter capture)

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/tasks/create-parallel` | Create N split tasks from base config |
| `POST` | `/tasks/start-parallel` | Start all tasks by taskIds array |
| `GET` | `/tasks/group/:groupId` | Get all tasks in a group |
| `POST` | `/tasks/group/:groupId/stop` | Stop all running/paused tasks in group |
| `DELETE` | `/tasks/group/:groupId` | Delete all tasks in group |

**File: `backend/routes/files.js`**

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/files/count-items` | Count items in an input file (for split preview) |

### Backend TaskController Methods

**File: `backend/controllers/TaskController.js`**

**`_countItems(filePath, mode)`** - Synchronous helper to count items:
- Traditional mode: counts place_ids in JSON array or text file (one per line)
- Search mode: counts sampling points in CSV (rows minus header) or JSON array

**`createParallelTasks(baseConfig, splitCount)`**:
1. Determine input file from `baseConfig.input` (traditional) or `baseConfig.points` (search)
2. Count total items using `_countItems()`
3. Calculate `chunkSize = Math.ceil(totalItems / splitCount)`
4. Generate `groupId = "group-" + Date.now() + "-" + randomChars`
5. Extract `baseName` from input filename (strip path and extension)
6. For each split `i` (0 to splitCount-1):
   - `start = i * chunkSize`, `limit = Math.min(chunkSize, totalItems - start)`
   - `output = "output/{baseName}_{suffix}.ndjson"` (suffix = 001, 002, ...)
   - `imageOutput = "output/images/{baseName}/{suffix}"` (if downloadImages)
   - Create task with: `{ ...baseConfig, start, limit, output, imageOutput, groupId, groupIndex, groupTotal, groupLabel }`
7. Returns `{ groupId, taskIds, baseName, totalItems, chunkSize }`

**`startParallelTasks(taskIds)`** - Starts all tasks concurrently via `Promise.all`

**`getTasksByGroupId(groupId)`** - Filters all tasks by `config.groupId`

**`_buildCommandArgs()`** - Maps `config.start` to `--start` CLI argument

### Scraper `--start` Support

**File: `src/gmaps_batch_scrape_ipc.js`**

The `--start` argument is supported in both modes:
- **Traditional mode**: Already supported -- slices the place_id array at the given offset
- **Search mode**: Added slicing of the sampling points array before applying `--limit`:
```javascript
if (opts.startIndex > 0) {
  points = points.slice(opts.startIndex);
}
if (opts.limit && opts.limit < points.length) {
  points = points.slice(0, opts.limit);
}
```

### Frontend Components

**ScraperConfigView.jsx** - Parallel split UI in General Config card:
- `enableSplit` toggle, `splitCount` number input (2-10)
- Auto-counts items via `POST /files/count-items` when input file changes
- Shows total items and per-part count preview
- Shows auto-generated output filename preview (e.g., `output/places_001.ndjson, _002.ndjson, _003.ndjson`)
- Shows auto-generated image directory preview when download images is enabled
- Disables Output File, Limit, and Image Directory inputs when split is enabled
- Passes `{ ...taskConfig, parallel: true, splitCount }` to `onStart()`

**App.jsx** - Parallel task creation flow:
- Detects `config.parallel && config.splitCount >= 2`
- Calls `api.createParallelTasks(baseConfig, splitCount)` then `api.startParallelTasks(taskIds)`
- Navigates to monitor tab with first taskId
- Polls running instances every 5 seconds (synced with group banner polling) ✓ Fixed (2026-01-27)

**InstanceSwitcher.jsx** - Task grouping:
- Groups tasks by `config.groupId` using `useMemo`
- Displays group label, part count, and individual task buttons (`#001`, `#002`, ...)
- Standalone tasks (no groupId) display as before

**MonitorView.jsx** - Group overview banner:
- Polls `GET /tasks/group/:groupId` every 5 seconds
- Shows aggregate progress bar (sum of all parts' current/total)
- Shows aggregate stats (success, failed, reviews, images)
- Clickable status dots for each part (green=running, yellow=paused, blue=completed, red=failed)
- "Stop All" button to stop entire group

### Task Config Schema (Parallel)

```json
{
  "mode": "traditional",
  "input": "data/places.txt",
  "output": "output/places_001.ndjson",
  "imageOutput": "output/images/places/001",
  "start": 0,
  "limit": 100,
  "groupId": "group-1737900000-abc123",
  "groupIndex": 0,
  "groupTotal": 3,
  "groupLabel": "places",
  "headless": true,
  "downloadImages": true
}
```

### Data Flow

```
User enables Parallel Split (splitCount=3)
  |
  v
Frontend: POST /files/count-items -> { count: 300 }
  |
  v
Frontend: POST /tasks/create-parallel { config, splitCount: 3 }
  |
  v
Backend: TaskController.createParallelTasks()
  |-- Count items: 300
  |-- chunkSize = ceil(300/3) = 100
  |-- Create task 1: start=0, limit=100, output=places_001.ndjson
  |-- Create task 2: start=100, limit=100, output=places_002.ndjson
  |-- Create task 3: start=200, limit=100, output=places_003.ndjson
  |-- Return: { groupId, taskIds: [t1, t2, t3] }
  |
  v
Frontend: POST /tasks/start-parallel { taskIds: [t1, t2, t3] }
  |
  v
Backend: Promise.all([ startTask(t1), startTask(t2), startTask(t3) ])
  |-- Each spawns: node gmaps_batch_scrape_ipc.js --start N --limit M --output ...
  |
  v
Monitor: GET /tasks/group/{groupId} (polls every 5s)
  |-- Aggregate progress, stats, status dots
```

---

## Recent Fixes (2026-01-27)

### Review Timestamp isReviewId() Fix (2026-01-27)

**Problem**: ~3% of reviews consistently missing `published_at_date`, regardless of handler timing.

**Root Cause**: `isReviewId()` only accepted "Ch"-prefix review IDs (35 chars). Google Maps also uses "Ci"-prefix review IDs (68 chars, alternate base64-encoded protobuf format). All unmatched reviews had "Ci9D..." IDs that were rejected by the filter.

**Evidence**: Comparing two independent scrape runs (000.json vs 888.json), the 12 missing review IDs in 888.json were a perfect subset of the 20 missing in 000.json, and ALL started with "Ci9D" prefix.

**Fix** (`review_timestamp_parser.js`):
```javascript
// Before: Only "Ch" prefix, max 60 chars
return str.startsWith('Ch') && str.length >= 20 && str.length <= 60;

// After: Both "Ch" and "Ci" prefixes, max 80 chars
return (str.startsWith('Ch') || str.startsWith('Ci')) && str.length >= 20 && str.length <= 80;
```
Also updated regex fallback pattern from `/"(Ch[A-Za-z0-9_-]{20,55})"/g` to `/"(C[hi][A-Za-z0-9_\-\/+]{20,75})"/g`.

---

### Adaptive Scroll Delay (2026-01-27)

**Problem**: Fixed 1000ms scroll delay was suboptimal - too slow when content loads quickly, potentially too fast when content needs time to load.

**Solution** (`reviews_extractor_scroll.js`):
- Base `scrollDelay` changed from 800ms to 500ms
- Added `scrollDelayFast` (500ms) and `scrollDelaySlow` (1500ms)
- `consecutiveEmptyScrolls` counter tracks whether recent scrolls yielded new content
- If content loaded in recent scrolls: use fast delay (500ms)
- If 2+ consecutive scrolls with no new content: use slow delay (1500ms)

```javascript
const scrollDelayFast = scrollDelay;                     // 500ms
const scrollDelaySlow = Math.max(scrollDelay * 3, 1500); // 1500ms
let consecutiveEmptyScrolls = 0;

// After each scroll:
if (newReviewCount > 0) { consecutiveEmptyScrolls = 0; }
else { consecutiveEmptyScrolls++; }
const currentDelay = consecutiveEmptyScrolls <= 2 ? scrollDelayFast : scrollDelaySlow;
```

---

### Review Sort Order Support (2026-01-27)

**Feature**: Added `--review-sort` CLI argument to control review sort order.

**Full-stack implementation**:
1. **CLI**: `--review-sort <order>` argument in both `gmaps_batch_scrape_with_reviews.js` and `gmaps_batch_scrape_ipc.js`
2. **Frontend**: Sort order dropdown in `ScraperConfigView.jsx` (relevant/newest/highest/lowest)
3. **Extractor**: `reviews_extractor_scroll.js` clicks sort button, waits for menu, selects menuitemradio

**Sort Flow in Extractor**:
```javascript
// Click sort button
const sortButton = document.querySelector('button[aria-label*="Sort reviews"]');
sortButton.click();
// Wait for menu -> click menuitemradio -> wait for reload
```

---

### Reviewer Profile Link Extraction (2026-01-27)

**Feature**: Extract `reviewer_link` field from review DOM.

**Selector**: `button[data-href*="/maps/contrib/"]`

**Output**: `"reviewer_link": "https://www.google.com/maps/contrib/12345678"`

---

### Reviewer Photo Count Fix (2026-01-27)

**Problem**: `reviewer_photo_count` extracted incorrect numbers by searching broad `container.textContent` for patterns like "X photos", matching unrelated text in the review body.

**Fix**: Targeted `div.RfnDt` element specifically, which contains only the reviewer stats line (e.g., "42 reviews - 15 photos").

---

### Category Extraction Fix (2026-01-27)

**Problem**: Categories not reliably extracted from the DOM.

**Fix**: Use `button.DkEaL` selector in `google-maps-scraper-pipeline.js` to extract category buttons, which are more reliably present in the page.

---

### Plus Code Extraction (2026-01-27)

**Feature**: Extract Plus Code (Open Location Code) from place pages.

**Selector**: `[data-item-id="oloc"]` in `google-maps-scraper-pipeline.js`

**Output**: `"plusCode": "7QP7+XX Singapore"`

---

### Response Handler Timing Fix (2026-01-27)

**Change**: Moved response handler registration from inside the review extraction block to BEFORE `page.goto()`, ensuring all API responses are captured from the initial page load. Added proper cleanup in try/catch/finally blocks with `page.off('response', responseHandler)`.

Modified files: `gmaps_batch_scrape_ipc.js`, `gmaps_batch_scrape_with_reviews.js`

---

### Parallel Group Progress Data Consistency Fix (2026-01-27)

**Problem**: Progress data displayed on the Parallel Group banner was inconsistent with the individual task card and Instance Switcher. Three root causes:

1. **Stale percentage**: WebSocket `progress` events only sent `{current, total, currentPlace}` without `percentage`. The frontend `useTask` hook merged these fields but never recalculated `percentage`, so the percentage display remained frozen at the value from the initial API load while `current/total` updated in real-time.
2. **Update frequency mismatch**: Group banner polled every 5s, individual task updated via real-time WebSocket, and Instance Switcher polled every 10s — all showing different snapshots of the same data.
3. **Backend emission gap**: `TaskController._handleIPCMessage()` saved progress to DB and emitted via WebSocket, but the emitted object lacked the calculated `percentage` field that the REST API response included.

**Fix**:

1. **`useTask.js`** - Recalculate `percentage` on every WebSocket progress update:
```javascript
const unsubProgress = subscribe('progress', (data) => {
  setTask(prev => ({
    ...prev,
    progress: {
      ...prev?.progress,
      ...data,
      percentage: data.total > 0
        ? Math.round((data.current / data.total) * 100)
        : (prev?.progress?.percentage || 0)
    }
  }));
});
```

2. **`TaskController.js`** - Include `percentage` in WebSocket progress emission:
```javascript
WebSocketManager.emit(taskId, 'progress', {
  ...data,
  percentage: data.total > 0 ? Math.round((data.current / data.total) * 100) : 0
});
```

3. **`App.jsx`** - Unified Instance Switcher polling interval from 10s to 5s (matching group banner polling frequency).

Modified files: `frontend/src/hooks/useTask.js`, `backend/controllers/TaskController.js`, `frontend/src/App.jsx`

---

### Checkpoint Resume Progress Accumulation Fix (2026-01-27)

**Problem**: After "Resume from Checkpoint", progress data (e.g., 2/8221 = 0%) was inconsistent with stats data (e.g., success=184). Three root causes:

1. **`--start` flag blocked checkpoint resume in IPC script**: The IPC script condition `if (opts.resume && !opts.startIndexSet)` prevented checkpoint reading when `--start` was set. Since `_buildCommandArgs()` always passed `--start` for chunk boundaries, checkpoint files were never read on resume — tasks restarted from the chunk's start index every time.
2. **Progress not accumulated on resume**: `resumeFromCheckpoint()` saved a `statsBaseline` but had no `progressBaseline`. Stats showed accumulated values while progress showed only the new process's count.
3. **`error` and `completed_at` not cleared on resume**: The SQL `UPDATE tasks SET status = ?, error = NULL` didn't match the JSON DB handler.

**Fix**:

1. **IPC script (`src/gmaps_batch_scrape_ipc.js`)** - Changed condition to `if (opts.resume)` so checkpoints are always read regardless of `--start`. Used `originalStart` (not resumed `startIndex`) for `endIndex` calculation to preserve chunk boundaries.
2. **`resumeFromCheckpoint()`** - Save `progressBaseline` (current + total) alongside stats baseline. Use proper SQL to clear `error` and `completed_at`.
3. **`_handleIPCMessage()`** - For `progress` events, apply progress baseline: `current = baseline.current + data.current`, `total = baseline.total`.
4. **`_handleProcessExit()`** - Clean up `progressBaselines` on task completion.

**Repair script**: `scripts/repair-progress.js` — synchronizes checkpoint files and DB progress/stats with actual NDJSON output data. Run with `--apply` to fix; default is dry-run.

Modified files: `src/gmaps_batch_scrape_ipc.js`, `backend/controllers/TaskController.js`

---

### Output-as-Truth Architecture (2026-02-01)

**Problem**: The previous checkpoint-based resume system had multiple issues:
1. Complex baseline accumulation logic in `TaskController.js` led to inconsistent progress/stats
2. Checkpoint files could become out of sync with actual output files
3. Configuration changes (e.g., different `--max-reviews`) required manual handling to avoid mixed data
4. The "source of truth" was split between checkpoint files and output files

**Solution**: **Output-as-Truth Architecture** - The output files (`output.ndjson`, `errors.ndjson`) are now the single source of truth.

#### New Functions in gmaps_batch_scrape_ipc.js (Lines 545-700)

| Function | Purpose |
|----------|---------|
| `computeConfigHash()` | Compute MD5 hash of scrape configuration to detect config changes |
| `scanOutputForDoneSet()` | Scan output files to build `doneSet` (completed placeIds) + `retrySet` (failed items eligible for retry) |
| `loadMeta()` / `saveMeta()` | Manage `output.meta.json` which stores `configHash`, timestamps, and summary stats |
| `backupOutputFiles()` | Auto-backup old output files when config changes (creates `*.bak-YYYYMMDD-HHMMSS` files) |
| `initOutputAsTruth()` | Main initialization function that orchestrates the above and returns `doneSet` |

#### Main Loop Changes (Lines 1262-1350)

```javascript
// Startup: scan output files to determine what's already done
const { doneSet, retrySet, alreadyDoneCount } = await initOutputAsTruth(opts);

// Progress starts from alreadyDoneCount, not 0
let processedCount = alreadyDoneCount;

// Main loop: skip items in doneSet, retry items in retrySet
for (const item of inputItems) {
  if (doneSet.has(item.placeId) && !retrySet.has(item.placeId)) {
    continue; // Already successfully processed, skip
  }
  // Process item...
  doneSet.add(item.placeId); // Update in-memory set after successful write to disk
}
```

#### New CLI Parameter

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--max-error-retries N` | 1 | Maximum retry attempts for failed items. Items with `_errorCount < N` in `errors.ndjson` are added to `retrySet` for automatic retry. |

#### TaskController.js Simplification (Lines 311-455)

**`resumeFromCheckpoint()` Changes:**
- Removed complex baseline accumulation calculations
- Progress/stats now read directly from output files
- Clears baseline storage (IPC script handles everything)

**`_handleIPCMessage()` Changes:**
- Removed baseline accumulation logic
- IPC script sends accurate progress values; controller passes them through directly

#### Workflow Diagram

```
Task Start
    │
    ▼
Scan output.ndjson + errors.ndjson
    │
    ├── Build doneSet (successfully completed placeIds)
    ├── Build retrySet (failed items with errorCount < maxRetries)
    └── Calculate alreadyDoneCount as initial progress
    │
    ▼
Check output.meta.json
    │
    ├── configHash matches → Continue appending to existing files
    └── configHash differs → Backup old files (*.bak-YYYYMMDD-HHMMSS)
    │
    ▼
Main loop iterates over input
    │
    ├── placeId in doneSet (and not in retrySet) → Skip
    ├── placeId in retrySet → Retry
    └── New placeId → Process normally
    │
    ▼
After processing each item
    │
    ├── Add to doneSet (in-memory)
    └── Write to output.ndjson (disk - single source of truth)
```

#### Key Benefits

1. **Single Source of Truth**: Output files determine progress, not checkpoint files
2. **Automatic Recovery**: If a process crashes, restarting automatically picks up from where it left off
3. **Config Change Detection**: MD5 hash detects when scrape config changes (e.g., `--max-reviews 50` vs `--max-reviews 100`)
4. **Auto-Backup on Config Change**: Old output files are preserved with timestamped backups
5. **Built-in Retry Logic**: Failed items are automatically retried (up to `--max-error-retries` times)
6. **Simplified Backend**: `TaskController.js` no longer needs complex baseline arithmetic

#### File Structure

```
output/
├── results.ndjson           # Main output (successful scrapes)
├── results.errors.ndjson    # Error log with retry count
├── results.meta.json        # Config hash, timestamps, summary
└── results.ndjson.bak-20260201-143022  # Auto-backup when config changes
```

#### meta.json Format

```json
{
  "configHash": "a1b2c3d4e5f6...",
  "createdAt": "2026-02-01T14:30:22.000Z",
  "lastUpdatedAt": "2026-02-01T15:45:10.000Z",
  "config": {
    "maxReviews": 100,
    "maxScrolls": 1000,
    "reviewSort": "newest"
  },
  "summary": {
    "totalProcessed": 1500,
    "successful": 1480,
    "failed": 20
  }
}
```

Modified files: `src/gmaps_batch_scrape_ipc.js`, `backend/controllers/TaskController.js`
