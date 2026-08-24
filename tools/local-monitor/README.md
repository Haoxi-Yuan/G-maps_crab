# Local Scraper Monitor

The monitor is a daily operations tool and is not a dependency of the core
scraper. Atlas/PBS monitoring was retired; the final Atlas-aware source is kept
under `archive/atlas/monitor/` for historical reference.

## Portable local monitor

The Node monitor works on macOS, Linux, and Windows:

```bash
node tools/local-monitor/monitor.js --root CLI_scraper
node tools/local-monitor/monitor.js --root CLI_scraper --once
node tools/local-monitor/monitor.js --root CLI_scraper --interval 10
```

It recursively reads small `*.live.json` sidecars under `output/`. It does not
scan large NDJSON files, launch a browser, modify task state, or connect to a
remote server.

## Native macOS monitor

The AppKit monitor provides maps, progress charts, review details, process
discovery, and workstation resource views:

```bash
bash tools/local-monitor/scraper-monitor.sh
bash tools/local-monitor/scraper-monitor.sh --build-only
bash tools/local-monitor/scraper-monitor.sh --install
node tools/local-monitor/test-shell-compatibility.js
```

The launcher automatically supplies the sibling `CLI_scraper/` directory as
the local project root. Override local or remaining SSH workstation settings
with `--local-root`, `--host`, `--remote-root`, `--chark-host`, and
`--chark-root`. Atlas endpoints are no longer created or polled.

The installed application is `~/Applications/Scraper Monitor.app`. The older
`poi-search-monitor.sh` and `review-rate-monitor.sh` commands forward to the
unified application.

## Sidecar contract

POI status normally lives at:

```text
output/<city>/poi_search.live.json
```

Review status is supplied through the review runner's live-status option. Other
tasks may publish the optional fields described by
`CLI_scraper/contracts/scraper-monitor-task.schema.json`. Writers must replace
sidecars atomically; readers ignore unknown fields for forward compatibility.

Only bounded chart history and the latest sidecar values are retained. Review
text is not accumulated by the monitor.
