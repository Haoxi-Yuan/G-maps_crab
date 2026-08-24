# Google Maps Batch Scraper System

A Google Maps scraping toolkit for batch extraction of business data, opening hours, popular times, reviews, and review images.

## Current Review Architecture

The current review pipeline is **API-first**:

- `src/api-review-fetcher.js` is the primary review extractor.
- `src/reviews_extractor_scroll.js` is kept as a **DOM supplement / fallback**, not the default path.
- `src/stealth/` contains the Scrapling-inspired browser hardening layer used by both CLI and IPC entry points.

In other words: the project no longer relies on DOM scrolling as the main review strategy.

## End-to-End Scraping Flow

For a direct `place_id` input list, the runtime flow is:

```text
Input (place_id list)
  -> Create stealth browser/context
    -> For each place:
      1. Two-step page load
      2. Extract business data via pipeline
      3. Fetch reviews via API (primary path)
         |- API complete enough -> continue
         |- API blocked / clearly incomplete -> wait 30s and retry once inside API fetcher
         `- Still blocked / still insufficient -> run DOM supplement
      4. Merge reviews by review_id
      5. Attach timestamps / optional image download
      6. Append one JSON object to .ndjson
    -> Move to next place
```

### 1. Stealth Browser Startup

Both production entry points create a stealth-enabled browser/context before scraping:

- 85+ launch arguments reduce obvious automation fingerprints.
- Fingerprint generation keeps user agent, platform, locale, and viewport internally consistent.
- Init scripts spoof common browser signals such as `navigator.webdriver`, canvas output, and WebGL traits.
- Optional resource blocking reduces tracking noise and heavy background requests.

### 2. Two-Step Page Loading

Google Maps place pages are more reliable after a search preload:

1. Open `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=...`
2. Open `https://www.google.com/maps/place/?q=place_id:...&hl=en`
3. Wait for `h1` so the place page is stable

This step is important because the Reviews tab and related state are not consistently available with a direct place open alone.

### 3. Basic Business Extraction

`src/google-maps-scraper-pipeline.js` runs in `page.evaluate()` and extracts the non-review business payload:

- name, address, coordinates, categories
- rating, review count, phone, website
- opening hours and popular times
- about/service metadata

### 4. API Review Extraction

`src/api-review-fetcher.js` is the primary review engine:

1. Detect review count from the current DOM when possible.
2. Click the Reviews tab to capture the first `listugcposts` request URL.
3. Rewrite the URL for deep pagination:
   - `!1i20` for page size
   - `!13m1!1e2` for `newest` ordering
   - `!2s` reset for the first page token
4. Page through the API with `fetch()` from browser context.
5. Parse review fields, deduplicate by `review_id`, and stop at natural end, repeated empty pages, or `--max-reviews`.

Retry behavior inside the API fetcher:

- HTTP `429` or `403` -> pause 30s -> retry once
- Empty page with coverage still below 80% of detected total -> pause 30s -> retry once
- If retry still fails, mark the API path as blocked and hand off to DOM supplement

### 5. DOM Supplement

`src/reviews_extractor_scroll.js` is used only when:

- the API path is marked blocked, or
- detected review count is known and API coverage is below 95%

The DOM path injects the scroll extractor into the page, loads more review cards, and merges only reviews not already returned by the API path.

### 6. Finalization and Write-Out

For each place:

- merged reviews are stored in `result.detailedReviews`
- `_meta` is attached with `placeId` and `sourceUrl`
- one JSON object is appended to the output `.ndjson`
- optional review image download stores files under `output/images/`

### Entry Points

The two production entry points share the same scraping logic but differ in orchestration:

| Entry point | Main use | Progress reporting | State files |
| --- | --- | --- | --- |
| `src/gmaps_batch_scrape_with_reviews.js` | CLI / batch runs | `console.log` | checkpoint-oriented CLI flow |
| `src/gmaps_batch_scrape_ipc.js` | backend/UI orchestration | IPC log messages + task stats | `.state.json` for UI, output-as-truth for recovery |

## Project Structure

```
time_scraper/
├── src/                          # Core runtime files
│   ├── city-generator/                       # City data generator
│   │   ├── boundary-generator.js             # City boundary generation
│   │   ├── points-generator.js               # Sampling point generation
│   │   └── index.js                          # Main entry program
│   ├── google-maps-scraper-pipeline.js       # Basic business data extraction engine
│   ├── poi-searcher.js                       # POI search module
│   ├── gmaps_batch_scrape_with_reviews.js    # Main batch processing script (CLI)
│   ├── gmaps_batch_scrape_ipc.js             # IPC version for Web UI backend
│   ├── api-review-fetcher.js                 # Primary review extractor (Google Maps RPC API)
│   ├── reviews_extractor_scroll.js           # DOM supplement / fallback for reviews
│   ├── review_image_downloader.js            # Image download module
│   ├── review_timestamp_parser.js            # Absolute timestamp extraction
│   ├── convert-xlsx-to-input.js              # Utility: convert XLSX place lists to scraper input
│   └── stealth/                             # Scrapling-inspired stealth layer
│
├── backend/                      # Web UI backend (Express + WebSocket)
│   ├── server.js                             # Express server entry
│   ├── database.js                           # JSON file database (SQLite API compat)
│   ├── controllers/
│   │   └── TaskController.js                 # Task lifecycle management
│   ├── services/
│   │   └── WebSocketManager.js               # Real-time WebSocket push
│   └── routes/
│       ├── tasks.js                          # Task CRUD + control routes
│       ├── cityGenerator.js                  # City generator routes
│       └── files.js                          # File browser routes
│
├── frontend/                     # Web UI frontend (React + Vite)
│   ├── src/
│   │   ├── components/
│   │   │   ├── shared/                       # Reusable UI components
│   │   │   └── views/                        # Page views (Config, Monitor)
│   │   ├── hooks/                            # React hooks (useTask, useWebSocket)
│   │   ├── services/                         # API & WebSocket services
│   │   └── App.jsx                           # Main application
│   └── package.json
│
├── tests/                        # Test files
│   ├── test_batch_with_reviews.sh            # Automated integration test
│   └── ...                                   # Various test scripts
│
├── docs/                         # Documentation files
│   ├── SYSTEM_ARCHITECTURE.md                # System architecture (core document)
│   ├── IMPLEMENTATION_GUIDE.md               # Web UI implementation guide
│   ├── BATCH_WITH_REVIEWS_GUIDE.md           # Batch processing guide
│   ├── REVIEWS_EXTRACTION_GUIDE.md           # Detailed review extraction guide
│   └── ...                                   # Other docs
│
├── config/                       # Configuration files
│   ├── categories.json                       # POI category definitions
│   └── proxy-config-iproyal.json             # Proxy configuration (optional)
│
├── data/                         # Input data files
│   └── coordinates_singapore.json            # Singapore business place_id list
│
├── db/                           # Database files (auto-created)
│   ├── tasks.json                            # Task records
│   └── logs.json                             # Task logs
│
├── output/                       # Output directory
│   ├── *.ndjson                              # Extracted data (NDJSON format)
│   ├── *.json                                # Converted JSON files
│   ├── *.state.json                          # Task state files
│   ├── *.checkpoint.json                     # Resume checkpoint files
│   └── images/                               # Review images (if download enabled)
│       └── {place_id}/
│           └── {review_id}/
│               └── image_*.jpg
│
├── logs/                         # Service logs (auto-created)
│   ├── backend.log                           # Backend server log
│   └── frontend.log                          # Frontend dev server log
│
├── start.sh                      # One-click start script
├── stop.sh                       # Safe shutdown script
├── package.json                  # Node.js dependency configuration
└── README.md                     # This file
```

## Quick Start

### 0. Data Preparation (Optional - Generate input data for new cities)

If you want to generate data for a new city, use the city data generator:

```bash
# Generate city boundary and sampling points
node src/city-generator/index.js --city "Singapore" --output data/singapore

# Output files:
# - singapore_boundary.geojson
# - singapore_points.json
# - singapore_points.csv
# - singapore_summary.json

# View help
node src/city-generator/index.js --help
```

### 0.1 POI Search Mode (NEW - Recommended)

**Directly search POI from sampling points**, no need for Google Places API:

```bash
# Search and scrape POI from sampling points in one command
node src/gmaps_batch_scrape_with_reviews.js \
  --search-mode \
  --points data/hongkong/hong_kong_points.csv \
  --categories config/categories.json \
  --search-zoom 1000m \
  --output output/hongkong_results.ndjson \
  --max-reviews 50 \
  --headless
```

This mode automatically:
1. Loads sampling points and POI categories
2. Searches Google Maps for each point × category combination
3. Extracts place_id from search results
4. Deduplicates and scrapes business details

**Workflow:** Sampling Points → Search POI → Extract place_id → Scrape Details (All-in-one)

### 1. Install Dependencies

```bash
npm install
```

### 2. Basic Usage

Extract basic business information (without reviews):

```bash
node src/gmaps_batch_scrape_with_reviews.js \
  --input data/coordinates_singapore.json \
  --output output/results.ndjson \
  --limit 10 \
  --no-reviews
```

### 3. Extract Reviews

Extract business information and reviews:

```bash
node src/gmaps_batch_scrape_with_reviews.js \
  --input data/coordinates_singapore.json \
  --output output/results.ndjson \
  --limit 10 \
  --max-reviews 200 \
  --review-sort newest
```

Notes:

- Reviews are fetched via the internal Google Maps review API first.
- `--max-scrolls` still exists, but it only matters when DOM supplement is needed.

### 4. Download Review Images

Extract reviews and download images to local storage:

```bash
node src/gmaps_batch_scrape_with_reviews.js \
  --input data/coordinates_singapore.json \
  --output output/results.ndjson \
  --limit 10 \
  --max-reviews 30 \
  --download-images \
  --image-output output/images
```

### 5. Output Beautified JSON Format

Generate readable JSON files (with indentation and line breaks):

```bash
# Generate both NDJSON + beautified JSON formats
node src/gmaps_batch_scrape_with_reviews.js \
  --input data/coordinates_singapore.json \
  --output output/results.ndjson \
  --limit 10 \
  --format both

# Only generate beautified JSON (no NDJSON)
node src/gmaps_batch_scrape_with_reviews.js \
  --input data/coordinates_singapore.json \
  --output output/results.ndjson \
  --limit 10 \
  --format json
```

### 6. POI Search Mode - Complete Workflow (NEW)

**Step 1:** Generate city sampling points (if not already done)
```bash
node src/city-generator/index.js --city "Hong Kong" --output data/hongkong
```

**Step 2:** Search and scrape POI in one command
```bash
# Minimal test (1 point × 1 category)
node src/gmaps_batch_scrape_with_reviews.js \
  --search-mode \
  --points data/hongkong/hong_kong_points.csv \
  --categories config/categories.json \
  --limit 1 \
  --output output/hongkong_test.ndjson \
  --headless

# Full production run (all points × all categories)
node src/gmaps_batch_scrape_with_reviews.js \
  --search-mode \
  --points data/hongkong/hong_kong_points.csv \
  --categories config/categories.json \
  --search-zoom 1000m \
  --output output/hongkong_full.ndjson \
  --max-reviews 50 \
  --download-images \
  --format both \
  --headless
```

**Output files:**
- `hongkong_full.ndjson` - Scraped business data
- `hongkong_full.search_results.json` - Search results (place_ids found)
- `images/` - Review images (if --download-images enabled)

## Main Features

### Data Preparation Tools
- City boundary generation (using OpenStreetMap data)
- Sampling point generation (using Lloyd relaxation algorithm)
- Support for data preparation for any city
- Automatic visualization validation

### POI Search Mode (NEW)
- **Direct POI search from sampling points** (no need for Places API)
- Automatic search link generation with geo-coordinates
- Intelligent scrolling and result collection
- Fast place_id extraction from URLs
- Multi-point × multi-category batch search
- Automatic deduplication
- Seamless integration with existing scraping pipeline
- Search results saved for review

### Core Features
- Batch extract Google Maps business data
- Basic business information (name, rating, address, phone, website, Plus Code, categories, etc.)
- Opening hours (complete 7-day schedule)
- Popular times (7-day visit heat data)
- About information (service options, amenities, payment methods, etc.)
- Review extraction (**API-first**, with DOM supplement only when coverage is insufficient)
- Absolute timestamp extraction (published_at_date from API interception)
- Reviewer profile link extraction
- Review image URL extraction
- Review image local download
- Scrapling-inspired stealth hardening (launch args, fingerprinting, resource blocking, proxy rotation)

### Anti-Detection Mechanisms
- User-Agent rotation
- Proxy support (supports proxy pools)
- Random delays
- CAPTCHA detection
- Human-like behavior simulation

### Data Quality Assurance
- Two-step loading strategy (ensures complete interface)
- Error retry mechanism with configurable retry count (`--max-error-retries`)
- **Output-as-Truth resume** (output files are single source of truth)
- Automatic config change detection and backup
- Data deduplication (via placeId-based doneSet)
- Complete error handling

## Command Line Arguments

### Basic Parameters
- `--input <file>` - Input file (containing place_id list)
- `--output <file>` - Output file (NDJSON format)
- `--limit <number>` - Processing quantity limit
- `--start <number>` - Start offset (skip first N items, used for parallel splitting)
- `--headless` - Run in headless mode

### Review Related
- `--max-reviews <number>` - Maximum reviews per place (default 1000)
- `--max-scrolls <number>` - Maximum DOM supplement scroll count (default 1000, only used when fallback is needed)
- `--review-sort <order>` - Review sort order for DOM supplement: `relevant` (default), `newest`, `highest`, `lowest`
- `--no-reviews` - Disable review extraction
- `--no-review-images` - Disable review image URL extraction

Current implementation note:

- The API path already forces deep pagination internally and does not currently follow `--review-sort`.
- `--review-sort` mainly affects the DOM supplement path.

### Image Download
- `--download-images` - Enable review image download
- `--image-output <dir>` - Image output directory (default: output/images)

### Output Format
- `--format <type>` - Output format type
  - `ndjson` - NDJSON format only (default, one JSON object per line)
  - `json` - JSON array format only (beautified, readable)
  - `both` - Generate both NDJSON and JSON formats
- `--pretty` - Enable beautified output (JSON beautification enabled by default)

**Format Comparison:**
- **NDJSON** - Suitable for stream processing and large files, one compressed JSON object per line
- **Beautified JSON** - Suitable for manual viewing, with indentation and line breaks, approximately 2x file size

### POI Search Mode (NEW)
- `--search-mode` - Enable POI search mode (search from sampling points)
- `--points <file>` - Sampling points file (CSV or JSON format, required in search mode)
- `--categories <file>` - POI categories configuration file (JSON, required in search mode)
- `--search-zoom <value>` - Search radius (default: 1000m, e.g., "1000m" or "14z")
- `--max-search-scrolls <number>` - Maximum scroll count per search (default: 15)
- `--search-delay <ms>` - Delay between searches in milliseconds (default: 2000)
- `--search-results <file>` - Search results output file (optional, auto-generated if not specified)
- `--no-save-search-results` - Don't save search results to file

**Note:** In search mode, `--limit` applies to sampling points, not place_ids.

### Proxy and Anti-Detection
- `--use-proxy` - Use proxy
- `--proxy-config <file>` - Proxy configuration file
- `--random-delay` - Enable random delays

For complete parameter list, see [docs/BATCH_WITH_REVIEWS_GUIDE.md](docs/BATCH_WITH_REVIEWS_GUIDE.md)

## Run Tests

Run integration tests:

```bash
cd tests
./test_batch_with_reviews.sh
```

## Output Format

The system supports two output formats:

### NDJSON Format (Default)
One compressed JSON object per line, suitable for stream processing and large files:
```
{"business":{...},"openingHours":{...},...}
{"business":{...},"openingHours":{...},...}
```

### JSON Array Format (Beautified)
Single JSON file containing all records, with indentation and line breaks, easy to read:

```json
[
  {
    "business": {
      "name": "Business Name",
      "rating": 4.5,
      "reviewCount": 1234,
      "categories": ["Restaurant", "Chinese restaurant"],
      "address": ["Address"],
      "fullAddress": "123 Street, City",
      "plusCode": "7QP7+XX Singapore",
      "phone": "+65 1234 5678",
      "website": "https://example.com",
      "placeId": "ChIJ..."
    },
    "openingHours": {
      "weeklyHours": [...]
    },
    "popularTimes": {
      "weeklyData": [...]
    },
    "detailedReviews": [
      {
        "review_id": "...",
        "rating": 5,
        "reviewer_name": "John Doe",
        "reviewer_link": "https://www.google.com/maps/contrib/12345678",
        "reviewer_review_count": 42,
        "reviewer_photo_count": 15,
        "review_text": "...",
        "published_at": "2 years ago",
        "published_at_date": "2024-01-15T08:30:00.000Z",
        "review_images": ["https://..."],
        "local_image_paths": ["place_id/review_id/image_1.jpg"]
      }
    ]
  }
]
```

**Usage Recommendations:**
- Processing large amounts of data (>100 businesses) → Use NDJSON
- Manual viewing and debugging → Use beautified JSON (`--format json` or `--format both`)
- Production environment batch processing → Use NDJSON, smaller file size, faster processing

## Web UI

The project includes a full Web UI for managing scrape tasks through a browser interface.

### Quick Start (Web UI)

```bash
# One-click start (recommended)
./start.sh

# Or manually:
cd backend && npm install && npm run dev   # Backend on http://localhost:3000
cd frontend && npm install && npm run dev  # Frontend on http://localhost:5173
```

Open **http://localhost:5173** to access the Web UI.

### Web UI Features

- **Scraper Config**: Configure and launch tasks with a visual form
- **Parallel Split**: Split input data into 2-10 parts and run N scraping processes concurrently
  - Auto-numbered output files (e.g., `output/places_001.ndjson`, `_002.ndjson`, ...)
  - Auto-numbered image directories under one parent folder (e.g., `output/images/places/001/`, `002/`, ...)
  - Automatic item count preview and per-part size calculation
- **Task Monitor**: Real-time progress, stats, and logs via WebSocket
  - **Group Overview Banner**: Aggregate progress, stats, and part status dots for parallel task groups
- **Multi-task Management**: Run and switch between multiple tasks
  - **Instance Switcher**: Groups related parallel tasks visually by group
- **Task Controls**: Pause, resume, stop, resume from checkpoint
- **Convert to JSON**: One-click NDJSON to JSON conversion
- **Background Execution**: Tasks continue running even when browser is closed

### Parallel Split (Web UI)

Split input data into multiple parts and scrape concurrently:

1. Select input file (Traditional Mode or POI Search Mode)
2. Enable **Parallel Split** toggle in General Config
3. Set **Split Into Parts** (2-10)
4. System auto-previews output filenames and image directories
5. Click **Start Scraping** -- N tasks launch simultaneously

**Example:**
- Input: `data/coordinates_singapore.json` (300 place_ids)
- Split: 3 parts
- Output: `output/coordinates_singapore_001.ndjson`, `_002.ndjson`, `_003.ndjson`
- Images: `output/images/coordinates_singapore/001/`, `002/`, `003/`
- Each process handles ~100 items via `--start` and `--limit`

The Monitor view shows a **group overview banner** with aggregate progress across all parts, and clickable part status dots to switch between individual tasks.

### Safe Shutdown

```bash
./stop.sh   # Interactive: stop all, servers only, or scrapers only
```

## Dependencies

- **playwright** - Browser automation
- **@turf/turf** - Geospatial data processing
- **Node.js 16+** - Runtime environment
- **express** - Backend API server
- **socket.io** - WebSocket real-time communication
- **react** - Frontend UI framework

External dependencies:
- `src/google-maps-scraper-pipeline.js` - Basic data extraction engine

## Documentation

For detailed documentation, see the `docs/` directory:

- **[SYSTEM_ARCHITECTURE.md](docs/SYSTEM_ARCHITECTURE.md)** - Complete system architecture (recommended to read first)
- **[BATCH_WITH_REVIEWS_GUIDE.md](docs/BATCH_WITH_REVIEWS_GUIDE.md)** - Batch processing guide
- **[REVIEWS_EXTRACTION_GUIDE.md](docs/REVIEWS_EXTRACTION_GUIDE.md)** - Review extraction technical details

## FAQ

### 1. Review Extraction Failed or Too Few Reviews?
- Ensure using two-step loading strategy
- Review extraction is API-first; check `[Reviews] API ...` logs before debugging DOM fallback
- DOM scrolling is only used as a supplement when API coverage is clearly below the detected total
- If fallback is triggered, the scroll mechanism uses `dispatchEvent(new Event('scroll'))` to trigger lazy loading
- Check browser console logs (captured via `page.on('console')`) for `[Reviews]` messages
- Use `--review-sort newest` to sort by newest first
- Check for CAPTCHA encounter
- Try using proxy or increasing delay

### 2. Image Download Failed?
- Check network connection
- Verify image URL validity
- Review error logs

### 3. How to Improve Scraping Speed?
- Use `--headless` headless mode
- Adjust `--restart-every` parameter
- Use **Parallel Split** in Web UI to split data and run N processes concurrently
- Or manually run multiple CLI instances with `--start` and `--limit` offsets

## License

Internal use project

## Maintenance History

- **2026-04-05**: Switched review extraction to **API-first architecture** -- added `src/api-review-fetcher.js` for Google Maps RPC review pagination, integrated Scrapling-inspired stealth modules under `src/stealth/`, kept `src/reviews_extractor_scroll.js` as DOM supplement only when API coverage is below threshold, and added `src/convert-xlsx-to-input.js` for place ID conversion workflows.
- **2026-02-01**: Implemented **Output-as-Truth Architecture** -- Complete rewrite of resume/recovery logic. Output files (`output.ndjson`, `errors.ndjson`) are now the single source of truth. New functions: `computeConfigHash()`, `scanOutputForDoneSet()`, `initOutputAsTruth()`. Auto-detects config changes via MD5 hash and backs up old files. Built-in retry logic for failed items (`--max-error-retries`). Simplified `TaskController.js` by removing baseline accumulation. See [SYSTEM_ARCHITECTURE.md](docs/SYSTEM_ARCHITECTURE.md) for details.
- **2026-01-27**: Fixed **Checkpoint Resume progress accumulation** -- IPC script now reads checkpoint regardless of `--start` flag; uses `originalStart` for `endIndex` to preserve chunk boundaries; progress accumulated (baseline + new) like stats; `error`/`completed_at` properly cleared on resume; added `scripts/repair-progress.js` to sync historical data
- **2026-01-27**: Fixed **Parallel Group progress data inconsistency** -- WebSocket progress events now include `percentage` field; `useTask` hook recalculates percentage on every update; unified Instance Switcher polling interval to 5s (was 10s) to match group banner frequency
- **2026-01-27**: Added **Parallel Split** feature -- split input data into 2-10 parts, launch N concurrent scraping processes with auto-numbered output files and image directories; full-stack: backend API (`/create-parallel`, `/start-parallel`, `/group/:groupId`), frontend config UI with item count preview, monitor group banner with aggregate stats
- **2026-01-27**: Fixed `isReviewId()` to accept "Ci"-prefix review IDs (68 chars) - root cause of ~3% missing `published_at_date`; previously only "Ch" prefix (35 chars) was recognized
- **2026-01-27**: Implemented adaptive scroll delay - 500ms when content is loading, 1500ms when idle (based on consecutive empty scroll detection)
- **2026-01-27**: Moved response handler registration before `page.goto()` for better timestamp coverage; added proper cleanup in try/catch/finally
- **2026-01-27**: Added `--review-sort` option (relevant/newest/highest/lowest) with full-stack support (CLI, frontend dropdown, extractor sort logic)
- **2026-01-27**: Added `reviewer_link` field extraction from `button[data-href*="/maps/contrib/"]`
- **2026-01-27**: Fixed `reviewer_photo_count` extraction - targeted `div.RfnDt` instead of broad `container.textContent` to avoid false matches
- **2026-01-27**: Added Plus Code extraction via `[data-item-id="oloc"]` DOM selector
- **2026-01-27**: Added category extraction via `button.DkEaL` DOM selector (more reliable than previous method)
- **2026-01-26**: Added "+N more photos" button expansion - Phase 1 detects `button.Tya61d[aria-label*="more photos"]` during scrolling; Phase 2 scrolls back to click each detected button, extracts all expanded photo URLs from CSS `background-image`, clicks Back with retry-based container recovery (up to 5 retries), then merges complete image sets into reviews
- **2026-01-26**: Fixed review extraction scroll mechanism - added `dispatchEvent` to trigger Google Maps lazy loading; replaced aggressive early-stop with bottom-stuck detection (10 reviews -> 408 reviews for a single place)
- **2026-01-26**: Changed default maxReviews/maxScrolls from 50/20 to 1000/1000
- **2026-01-26**: Added browser console log capture (`page.on('console')`) for review extraction debugging
- **2026-01-26**: Fixed convert-to-json API endpoint - resolved relative path issue when backend runs from `backend/` directory
- **2026-01-24**: Added absolute timestamp extraction from API responses (published_at_date, edited_at_date)
- **2026-01-24**: Added POI search mode - direct search from sampling points (no Places API needed)
- **2026-01-24**: Fixed city boundary generation Ring Assembly algorithm (proper MultiPolygon support)
- **2026-01-24**: Fixed reviewer_name field extraction issue
- **2026-01-24**: Added review image extraction and download feature
- **2026-01-23**: Completed pipeline integration
- **2026-01-20**: Initial version
