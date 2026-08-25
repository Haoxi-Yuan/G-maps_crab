# Reviewer profile parallelism per public IP

## Why process count is the wrong control

A reviewer fetch contains idle navigation time, one initial MAS response, and
zero or more serial expansion requests. Fixed independent workers create bursts,
cannot share an IP request budget, and leave capacity unused when one shard has
more hidden/fallback or service-capped profiles than another.

The parallel mode uses one Node process and one or more Chromium instances:

1. A global queue interleaves reviewer work instead of assigning a permanent
   sequential lane to each shard.
2. Each in-flight reviewer gets an isolated browser context.
3. A single smooth gate controls navigation starts and expanded MAS requests
   across every Chromium process on the public IP. It defaults to 150 ms
   between gated starts.
4. The controller changes in-flight concurrency one step per observation
   window. It never converts a CPU count directly into browser concurrency.
5. A window backs off to `floor(concurrency * 0.7)` when total errors exceed 3%
   or throttle-class errors exceed 1%.
6. Healthy windows increase by one. Two consecutive windows with less than 8%
   throughput gain, or a large p95 regression, hold the historical best level.

Throttle-class errors include HTTP 403/429, CAPTCHA/unusual-traffic responses,
`ERR_NETWORK_CHANGED`, and connection resets. Review count, terminal status,
duration p50/p95/max, and returned review totals are recorded for every window.
Equal returned-review totals across levels are required before accepting a
throughput improvement.

## Chark validation, 2026-08-24

The experiment ran on `ual-chark` while the existing four production lanes
continued. Every level used the same reviewers, retained review media, requested
up to the Google service maximum of 200 reviews, and allowed two retries.

First 18-reviewer adaptive staircase:

| In flight | Profiles/min | p95 ms | Success | Returned reviews |
|---:|---:|---:|---:|---:|
| 1 | 14.137 | 6,054 | 100% | 1,245 |
| 2 | 27.583 | 5,504 | 100% | 1,245 |
| 3 | 38.598 | 6,484 | 100% | 1,245 |
| 4 | 47.102 | 6,143 | 100% | 1,245 |
| 5 | 53.262 | 6,307 | 100% | 1,245 |
| 6 | 55.223 | 7,108 | 100% | 1,245 |

The larger 36-reviewer confirmation used 2,431 returned reviews at every level:

| In flight | Profiles/min | p95 ms | Success |
|---:|---:|---:|---:|
| 6 | 32.269* | 7,160 | 100% |
| 7 | 67.150 | 8,330 | 100% |
| 8 | 69.162 | 8,892 | 100% |
| 9 | **87.723** | 8,681 | 100% |
| 10 | 80.116 | 9,997 | 100% |

`*` The first 36-reviewer window had a long-tail straggler: its p95 stayed low
while wall time doubled. This demonstrates why a global queue is needed and why
small high-concurrency windows are not sufficient for capacity decisions.

Concurrency 10 reduced throughput by 8.7% relative to 9 while increasing p95 by
15.2%. No 403, 429, or CAPTCHA occurred. Concurrency 9 was the observed
saturation point of that short first pass; the longer tests below supersede it
for chark capacity planning.

A final concurrency-9 canary used 100 different stratified reviewers. It
completed at 66.545 profiles/min with 100% success, zero throttle-class errors,
6,411 returned reviews, p50 5.403 seconds, p95 11.370 seconds, and a 65.705-second
maximum. The maximum confirms that a few fallback-heavy profiles dominate static
lanes even when ordinary request latency remains low. Relative to the live
four-lane baseline of about 55 profiles/min, the measured net gain is about 21%,
not a linear multiple of the context count.

The production errors observed during the experiment were six
`response_shortfall` records with unknown public counters and zero returned
reviews. They were not HTTP throttling records. Transient navigation errors were
successfully recovered by the existing retry policy.

### Chromium process A/B and longer-window ceiling

At total concurrency 9, an order-balanced `1,2,3,3,2,1` Chromium comparison
used the same 100 reviewers in every run:

| Chromium processes | Lanes/process | Mean profiles/min | Mean p95 ms | Mean success |
|---:|---:|---:|---:|---:|
| 1 | 9 | 86.028 | 10,272 | 100% |
| 2 | 5+4 | 87.261 | 9,928 | 100% |
| 3 | 3+3+3 | 86.876 | 9,893 | 99.5% |

Two Chromium processes improved throughput by only 1.43%; three did not improve
it further. A second order-balanced comparison at total concurrency 27 again
used the same 100 reviewers and preserved all 6,411 returned reviews:

| Chromium processes | Mean profiles/min | Mean steady profiles/min | Mean p95 ms |
|---:|---:|---:|---:|
| 1 | **142.867** | **167.736** | **15,413** |
| 2 | 139.588 | 156.242 | 16,732 |
| 3 | 135.373 | 147.521 | 17,091 |

The host still had about 70–76% idle CPU and 194 GiB available memory during
the three-process run. Multiple Chromium processes did not relieve a host
bottleneck; they lost connection-pool/cache reuse while sharing the same
public-IP and upstream capacity.

A 200-reviewer single-Chromium staircase then established the effective
long-queue ceiling. Every level returned the same 12,816 reviews with identical
per-reviewer status/count fingerprints and no throttle-class errors:

| In flight | Wall profiles/min | Steady profiles/min | p50 ms | p95 ms | Max ms |
|---:|---:|---:|---:|---:|---:|
| 27 | 94.148* | 168.020 | 8,755 | 17,814 | 66,611 |
| 30 | 92.155* | 167.157 | 9,993 | 18,385 | 66,892 |
| 33 | 158.592 | 169.085 | 11,123 | 18,028 | 30,922 |

`*` A single 66-second profile landed in the final drain. This lowers finite-job
wall throughput but does not represent the sustained completion rate of a
4.19-million-item work-conserving queue. Steady throughput plateaued at about
168–169 profiles/min from 27 through 33 while median latency kept rising.
Concurrency 27 is therefore the effective operating point; 30 and 33 add no
material throughput. No 403, 429, or CAPTCHA was observed through 33, so this is
an efficiency ceiling, not a claim about Google's enforcement threshold.

During a separate three-Chromium ceiling pass, concurrency 30 returned 50 fewer
reviews while aggregate HTTP success and status counts remained normal. This is
why per-reviewer content fingerprints, not HTTP success alone, are a safety
condition.

## Operating policy

- Start a new IP at concurrency 2, not at the previous best.
- Use at least 100 terminal profiles per production observation window.
- Keep the global start interval at 150 ms initially.
- Prefer one Chromium process with isolated contexts and a global queue.
- For chark's multi-million-item queue, use 27 as the measured in-flight cap;
  do not jump a new IP directly to that value.
- For small finite batches, use 15–21 to reduce final-drain and latency costs.
- Back off immediately on throttle signals; do not wait for a whole shard.
- Treat any per-reviewer returned-count/status mismatch as unsafe even when
  HTTP success is 100%.
- Re-probe one level above the current setting periodically, then return to the
  best level if marginal throughput is below 8%.
- Preserve per-shard append-only outputs even when scheduling from one global
  queue, so existing resume and audit semantics remain valid.

The validated capacity-discovery command is:

```bash
node bin/gmaps-crab.js reviewer-benchmark \
  --list reviewers.all.ndjson \
  --mode adaptive \
  --profiles-per-stage 100 \
  --adaptive-start 2 \
  --adaptive-max 27 \
  --request-interval-ms 150 \
  --output reviewer-parallel-benchmark.json
```

To isolate browser-process effects, keep the reviewer list, total in-flight
concurrency, request interval, and collection settings identical, and vary only
`--browser-count`. For example, compare `--browser-count 1`, `2`, and `3` with
`--concurrency-sequence 9`. The benchmark balances nine lanes as `9`, `5+4`,
and `3+3+3`; browser startup time is excluded. `browser_count`,
`active_browser_count`, and `lanes_per_browser` are written into each stage.
`reviewer_results` retains the per-reviewer returned/visible counts, terminal
status, assigned browser, attempts, duration, and error so data completeness can
be compared rather than inferred only from aggregate throughput.
Queue start/completion offsets are also retained. The reported
`steady_state_profiles_per_minute` uses the middle 80% of ordered completions,
so one slow profile in the final drain does not masquerade as an IP-capacity
collapse; the ordinary wall-clock rate remains authoritative for finite jobs.
Every stage is atomically checkpointed. With `--stop-on-unsafe`, the staircase
also stops when any reviewer's terminal status or returned-review count differs
from the first stage, even if HTTP success and aggregate status counts look
healthy. `content_mismatches` records the exact expected and actual values.
Multiple Chromium processes never receive independent request gates: on one
public IP that would confound browser isolation with extra offered load.

```bash
node bin/gmaps-crab.js reviewer-benchmark \
  --list reviewers.all.ndjson \
  --mode staircase \
  --concurrency-sequence 9 \
  --browser-count 2 \
  --profiles-per-stage 100 \
  --request-interval-ms 150 \
  --output reviewer-browser-2x-c9.json
```

## Thirty-second capacity thought experiment

Completing 4,191,230 reviewers in 30 seconds requires 139,708 profiles/second,
or 8,382,460/minute. At the observed 168–169 steady profiles/minute per public
exit, the arithmetic lower bound is roughly 49,600–49,900 independent exit
capacity units and about 1.34 million simultaneous in-flight profiles at 27 per
exit. The sample averaged about 64 returned reviews per profile, implying about
269 million reviews, or nearly 9 million review records/second.

This is a capacity calculation, not a feasible deployment design. It excludes
database enumeration, connection setup, response bytes, parsing, storage,
deduplication, upstream enforcement, cost, and applicable terms/rules. With one
measured exit, the steady lower bound is about 17.2 days; 100 truly independent
equivalent exits is about 4.1 hours, and 1,000 is about 24.8 minutes before those
other constraints.

The benchmark is safe to use for capacity discovery. Replacing an active
multi-shard collector requires a separate global-queue canary that preserves
the four existing output/checkpoint files; benchmark evidence alone does not
authorize rewriting or merging production outputs.

The production resume command is `reviewers-parallel`. It round-robins stable
shard lists through one streaming global queue, uses one Chromium and one gate,
and appends results to the original shard output selected by each reviewer ID.
Existing non-error records are scanned before scheduling; historical error
attempts remain auditable and are retried. Signals stop new windows, drain
in-flight work, close Chromium, and leave all remaining reviewers resumable.
