# Review Rate Monitor

A lightweight native macOS application for watching the Singapore review
scraper on `ual-strix`. AppKit draws the entire UI; there is no Electron,
WebView, online map, or third-party runtime dependency.

## Responsive UI

- Below roughly `600 × 360`: compact black/red rate monitor with one basic
  context line: city, primary POI category, and merchant.
- At or above `600 × 360`: the UI automatically expands to include the local
  Singapore boundary map, animated POI transition, all available categories,
  coordinates, current phase, review progress, and one transient review.
- Review content is never accumulated by the monitor. The remote scraper
  atomically replaces one small `reviews.live.json` status file.

The large value and curve use a rolling 60-second completed-POI rate. `15m`
is the rolling 15-minute average. Progress is counted from complete lines
appended to `reviews.ndjson`; after one initial count, each poll scans only new
bytes.

## Build and open

```bash
./tools/review-rate-monitor/review-rate-monitor.sh
```

Install a clickable copy in `~/Applications` and open it:

```bash
./tools/review-rate-monitor/review-rate-monitor.sh --install
```

The normal macOS close, minimize, drag, and resize controls are enabled. The
window position and size are restored on the next launch.

## Configuration

Defaults:

- SSH: `haoxi@10.192.132.3`
- Output: `/data2/shared/haoxi/CLI_scraper/output/singapore/reviews.ndjson`
- Log: `/data2/shared/haoxi/CLI_scraper/output/singapore/reviews.log`
- Status: `/data2/shared/haoxi/CLI_scraper/output/singapore/reviews.live.json`
- Poll interval: 5 seconds
- Chart history: 30 minutes

Override them when needed:

```bash
./tools/review-rate-monitor/review-rate-monitor.sh \
  --host USER@HOST \
  --output /remote/path/reviews.ndjson \
  --log /remote/path/reviews.log \
  --status /remote/path/reviews.live.json \
  --interval 5 \
  --chart-minutes 30
```

Build without opening:

```bash
./tools/review-rate-monitor/review-rate-monitor.sh --build-only
```
