# Results

Experiment completed on `ual-chark` on 2026-08-24 against the read-only 19 GB
SQLite database with 12,941,637 source reviews.

## Reviewer list

| Metric | Result |
|---|---:|
| Requested unique reviewers | 100 |
| Produced rows / unique IDs | 100 / 100 |
| Selection | observed public review count descending |
| First cold scan | 121.46 s, 100,216 KiB RSS; only 47 unique IDs from 5,000 candidates |
| Corrected warm scan | 7.10 s, 165,736 KiB RSS; 100 unique IDs from a bounded 100,000 candidates |

The larger bounded window is necessary because a few prolific reviewers occupy
thousands of top-ranked source rows. The production database was never modified
and no index was created.

## Stability and speed

| Metric | Result |
|---|---:|
| Latest terminal profiles | 100 |
| Attempt records | 101 |
| First-pass transient errors | 1 (`ERR_NETWORK_CHANGED`) |
| Retried successfully | 1 |
| Final terminal errors | 0 |
| Final profile success rate | 100% |
| Total wall time including retry | 807.87 s |
| Throughput | 7.427 profiles/min |
| Mean wall time | 8.079 s/profile |
| First-pass peak RSS | 342,116 KiB |
| Swap | 0 |
| Output | 64 MiB; 18,400 public reviews |

The first pass completed 99/100 profiles in 793.40 seconds. Resume processed
only the failed reviewer in 14.47 seconds. The append-only error remains
auditable, while the final report takes each reviewer ID's latest terminal row.

All selected reviewers had more visible reviews than the public service could
return, so all 100 correct terminal states are `service_cap`, not `complete`.
The 18,400 returned reviews represent 4.57% of their 402,220 currently visible
reviews. This is an upstream service limit, not a claim of historical coverage.

## Core field success

| Field | Present / returned reviews | Rate |
|---|---:|---:|
| `review_id` | 18,400 / 18,400 | 100% |
| `rating` | 18,400 / 18,400 | 100% |
| `business.name` | 18,085 / 18,400 | 98.29% |
| real `coordinates.lat` + `coordinates.lng` | 18,085 / 18,400 | 98.29% |

The 315 missing business/location rows contained a valid review ID, rating and
text but an entirely empty business block from Google. This is source-side
place removal/unavailability rather than an isolated parser offset failure.

Reviewer identity, profile URL, avatar, Local Guide flag, contribution totals,
summary, guide object and contribution groups were present for 100/100 profiles.
Biography was present for 71%, because it is optional.

Selected optional review coverage:

| Field | Non-null coverage |
|---|---:|
| `review_text` | 98.00% |
| translated review text | 65.72% |
| structured responses | 45.86% |
| review images | 61.22% |
| owner response | 11.27% |
| edited timestamp | 22.65% |
| order type | 11.98% |
| price per person | 20.68% |
| meal type | 18.11% |
| food / service / atmosphere scores | 26.86% / 26.39% / 26.25% |
| recommended dishes | 1.21% |

These are observed occurrence rates, not parser failure rates. Google only asks
or exposes these optional questions for applicable reviews.

## Artifacts

- Final report: [`results/reviewer-quality-report.json`](results/reviewer-quality-report.json)
- First-pass report: [`results/reviewer-quality-report.first-pass.json`](results/reviewer-quality-report.first-pass.json)
- Reviewer list: [`results/reviewers.list.ndjson`](results/reviewers.list.ndjson)
- Runtime log: [`results/run.log`](results/run.log)
- GNU time: [`results/time.first-pass.txt`](results/time.first-pass.txt), [`results/time.txt`](results/time.txt)
- English field map: [`../../docs/assets/google-reviewer-field-map-en.png`](../../docs/assets/google-reviewer-field-map-en.png)

Remote raw output:

```text
/data/haoxi/CLI_scraper/experiments/reviewer_profiles_100_20260824/run/reviewers.ndjson
SHA-256 d36cdcf1aaba843ae0a65a7409b81d291c7e397adacdadec9753dd650e850d7f
```

Final report SHA-256:
`a5e2e5dc2aa59c041a93ace47ba81926f543e4dc0b737469a769707a5ce477e2`.
