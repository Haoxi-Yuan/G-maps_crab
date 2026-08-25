# Singapore reviewer profiles: full run (2026-08-24)

This run extracts every unique public Google reviewer profile referenced by the
read-only Singapore review database on `ual-chark`.

- Source: `/data/haoxi/CLI_scraper/output/singapore/2026-08-14/singapore_reviews_20260814.db`
- Remote run root: `/data/haoxi/CLI_scraper/experiments/reviewer_profiles_full_20260824`
- Stable partition: `BigInt(reviewer_id) % 4`
- Maximum returned reviews per public profile: 200 (Google service cap)
- Output mode: append-only and resumable; review media retained
- Source database access: SQLite read-only + `query_only=ON`
- Transient fetch policy: two immediate retries with a fresh browser

List manifest (completed 2026-08-24):

- Source rows scanned: 12,941,637
- Unique Google reviewers: 4,191,230
- Shard counts: 1,048,852 / 1,049,004 / 1,046,027 / 1,047,347
- List build elapsed: 136.141 seconds
- Stable mapping: `BigInt(reviewer_id) % 4`

Workers started at `2026-08-24T18:11:06+08:00` in these sessions:

- `gmaps-reviewers-full-s0`
- `gmaps-reviewers-full-s1`
- `gmaps-reviewers-full-s2`
- `gmaps-reviewers-full-s3`

Low-overhead status probe on chark:

```bash
/data/haoxi/CLI_scraper/experiments/reviewer_profiles_full_20260824/status.sh
```

Initial live validation at `2026-08-24T18:22+08:00`:

- 518 latest valid profiles and 22,948 returned public reviews
- 408 complete, 59 private/hidden, 51 service-capped
- review ID and rating coverage: 100%
- business name and usable coordinate coverage: 99.03%
- output size: 65 MiB; list and four shards: 3.5 GiB
- initial aggregate throughput: about 40–47 profiles/minute

During the deployment rehearsal, terminating a Playwright process closed its
browser before the old loop exited, producing retryable `browser has been
closed` attempt records. They remain in the append-only audit trail and are not
completion markers; resumed workers automatically replace them with terminal
profile records. The final scraper also handles SIGINT/SIGTERM at a reviewer
boundary and leaves the in-flight reviewer pending.

The persistent hidden-profile canary `108505202198564852715` exposed an equal
page-size rewrite edge case. The fixed parser classified it in one attempt as
`private_or_hidden` (`visible_review_count=10`, `returned_review_count=0`).

Post-resume validation at `2026-08-24T18:23:58+08:00` found 618 latest valid
profiles, 28,040 returned reviews, and zero latest terminal errors. All 144
retryable deployment-rehearsal error records had been superseded by successful
terminal records; the audit attempts remain intentionally append-only.

The list builder and each shard run in separate `tmux` sessions. `status.sh`
reads the list manifest, worker sidecars, and log tails without scanning the
large output files.

## Global parallel resume

The validated replacement runner uses one Chromium, 27 isolated in-flight
contexts, a shared 150ms navigation/MAS gate, and a round-robin streaming queue
over the same four stable list shards. It scans the original shard outputs and
continues appending to them, so no completed reviewer is intentionally fetched
again and no output merge is required.

Deployment scripts:

- `launch-parallel-canary.sh`: 200 reviewers into separate canary outputs
- `launch-parallel.sh`: resume the four production outputs
- `status.sh`: includes the parallel live status and rolling window speed
