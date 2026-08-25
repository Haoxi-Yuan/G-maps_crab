# Reviewer profile 100-person stability experiment

- Host: `ual-chark` (`10.192.132.2`)
- Database: `/data/haoxi/CLI_scraper/output/singapore/2026-08-14/singapore_reviews_20260814.db`
- Remote root: `/data/haoxi/CLI_scraper/experiments/reviewer_profiles_100_20260824`
- Selection: 100 unique Google reviewers ordered by observed public review count descending
- Runtime: isolated Node.js 22.14.0 and locked npm dependencies
- Browser: project Playwright Chromium build 1200
- Session: `gmaps-reviewer100-20260824`

Start fresh:

```bash
tmux new-session -d -s gmaps-reviewer100-20260824 \
  'bash /data/haoxi/CLI_scraper/experiments/reviewer_profiles_100_20260824/launch.sh fresh'
```

Resume without deleting successful output:

```bash
bash /data/haoxi/CLI_scraper/experiments/reviewer_profiles_100_20260824/launch.sh resume
```

Inspect:

```bash
tmux has-session -t gmaps-reviewer100-20260824
cat /data/haoxi/CLI_scraper/experiments/reviewer_profiles_100_20260824/run/reviewers.live.json
tail -n 30 /data/haoxi/CLI_scraper/experiments/reviewer_profiles_100_20260824/run/run.log
```

Normal completion requires all of:

- `exit.code` contains `0`;
- `complete.marker` exists;
- `reviewer-quality-report.json` parses;
- 100 latest terminal reviewer records are present and terminal errors are zero.

If `needs-retry.marker` exists, run the resume command. Append-only failed
attempts remain auditable, while the quality report uses each reviewer ID's
latest terminal record and reports attempt-level errors separately.
