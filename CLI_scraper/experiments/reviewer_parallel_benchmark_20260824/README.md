# Reviewer parallelism benchmark on ual-chark

Date: 2026-08-24. The benchmark used one Node process, one or more Chromium
instances, isolated contexts, a 150 ms global request-start gate, retained
review media, and the same reviewers at every comparison level. Four production
reviewer lanes remained active, so results measure marginal capacity under the
actual live IP load rather than an idle-host laboratory maximum.

Artifacts on chark:

- `adaptive-live-load.json`: concurrency 1–6, 18 reviewers per window
- `adaptive-upper-bound.json`: concurrency 4–9, 18 reviewers per window
- `adaptive-confirm.json`: concurrency 6–10, 36 reviewers per window
- `canary-100-c9.json`: 100 different reviewers at candidate concurrency 9
- `multichrome-r*-b*-c9.json`: order-balanced 1/2/3-Chromium comparison at c9
- `multichrome-upper-confirm-b3.json`: 200-reviewer c15/18/21/24 staircase
- `multichrome-ceiling-b3.log`: c27/c30; stopped after a 50-review content drift
- `multichrome-high-r*-b*-c27.json`: order-balanced process A/B at c27
- `singlechrome-upper-verify.json`: 200-reviewer single-Chromium c27/c30/c33

The initial short pass peaked at 87.723 profiles/min at concurrency 9. Its
100-reviewer canary sustained 66.545 profiles/min with 100% success, 6,411
returned reviews, and zero throttle-class errors. Longer tests superseded the
initial concurrency recommendation.

`run-multichrome-ab.sh` performs an order-balanced `1,2,3,3,2,1` Chromium
process comparison at the same total concurrency 9. Every process shares the
same 150 ms gate, and every run uses the same 100-reviewer sample and collection
settings. This separates browser-process effects from added offered load and
reduces first/last-run time drift.

Mean c9 throughput was 86.028, 87.261, and 86.876 profiles/min for one, two,
and three Chromium processes. At c27, the same order-balanced comparison
produced 142.867, 139.588, and 135.373 profiles/min; one Chromium was both
faster and lower-latency.

The final 200-reviewer single-Chromium staircase preserved an identical 12,816
reviews at c27/c30/c33 and reached a steady plateau of
168.020/167.157/169.085 profiles/min. The recommended long-queue operating
point is one Chromium at c27, with continuous feedback and automatic backoff.

Every completed stage is atomically checkpointed. `--stop-on-unsafe` stops on
error/throttle thresholds or any per-reviewer status/returned-count drift.
