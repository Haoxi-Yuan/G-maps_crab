# Reviewer profile collection

## Commands

Run reviewer collection from an existing review file:

```bash
node bin/gmaps-crab.js reviewers --city sg_parks_10m_20260820
node bin/gmaps-crab.js reviewers --input output/run/reviews.ndjson
node bin/gmaps-crab.js reviewers --input output/run/reviews.db \
  --list-limit 100 --list-order review-count-desc --list-only
```

Run it automatically after place reviews:

```bash
node bin/gmaps-crab.js reviews --city singapore --reviewers
```

Both stages remain independently resumable. `--fresh` belongs to the place-review
file; deleting the reviewer output requires `--reviewers-fresh` in the combined
command or `--fresh` in the standalone `reviewers` command.

## Outputs

- `reviewers.list.ndjson`: atomically regenerated unique reviewer list, including
  observed name/counts and source occurrence counts.
- `reviewers.ndjson`: append-only reviewer profiles and public review histories.
- optional live-status JSON: current reviewer and complete/capped/hidden/error
  counters.

SQLite input is opened read-only. A bounded `--list-limit` avoids exporting a
large review database to NDJSON; `review-count-desc` is useful for high-volume
stress tests. The selected reviewers are re-aggregated across the database so
their source occurrence and place counts remain accurate.

For full-database campaigns, build the unique list once and create stable shards:

```bash
node scripts/build-reviewer-list-sqlite.js \
  --db output/run/reviews.db \
  --output output/run/reviewers.all.ndjson \
  --shard-dir output/run/reviewer-shards-4 \
  --shards 4

node bin/gmaps-crab.js reviewers \
  --input output/run/reviews.db \
  --reviewer-list-input output/run/reviewer-shards-4/reviewers.part-0.ndjson \
  --output output/run/reviewers.part-0.ndjson
```

Each reviewer ID is assigned by a stable numeric modulo, so shards never overlap
and resume independently. The source database remains read-only.
The builder reads `reviews` once in table order and deduplicates reviewer IDs in
memory. It deliberately avoids full-database SQL `GROUP BY` and
`COUNT(DISTINCT)`, which create large temporary B-trees. The manifest's source
row count comes from `sqlite_stat1`, while `source_rows_scanned` records the
exact number of rows visited.

Successful, capped, requested-limit, and hidden records are skipped on resume.
Records with `_status: "error"` are retried on the next run.
Transient fetch failures are also retried twice immediately by default; each
retry starts a fresh browser and the terminal record stores
`_meta.fetch_attempts`.

## Profile fields

Each record contains:

- reviewer ID, name, biography, profile/avatar URL and Local Guide status;
- Local Guide level, points, thresholds, remaining points and progress;
- total contribution-action count and Google's localized summary text;
- contribution groups with both `public_count` and `total_count`;
- returned public reviews and an explicit completeness assessment;
- source-review observations and acquisition metadata.

`public_count` is Google's own counter, not a promise about what the profile
serves. A profile can report thousands of reviews and still return an empty list
at every page size, which Google's page words as "This person hasn't written any
reviews yet, or has chosen not to show them on their profile" (measured on
reviewer 108984331081035263485: counter 4,269, zero reviews returned at 200,
150, 100, 50 and 25). Those records are `private_or_hidden`, not `service_cap`.
`total_count` is the contribution total and may be larger still, because
deleted, moderated, restricted and non-public contributions are not part of any
visible history. The source `reviewer_review_count` is likewise a counter.

## Public review fields

Each returned review retains:

- review ID, rating, original/translated text and language;
- relative, created and edited times, likes, reviewer snapshot and media;
- owner response text/translation and time;
- business name, full address, categories, main category, price range;
- latitude/longitude, place ID, Google ID, ChIJ ID, timezone, locality, country,
  country code, neighborhood and Maps URL;
- all structured question/answer rows under `structured_responses`.

Convenience fields under `review_details` normalize the guided-dining answers:

```text
order_type          seating_type        recommend_to_vegetarians
price_per_person    noise_level         vegetarian_offerings
meal_type           reservation         parking_space
group_size          food_score          parking_options
wait_time           service_score       tips_topics
recommended_dishes  atmosphere_score
```

`recommended_dishes` and `tips_topics` are always arrays, since Google accepts
several answers there; the rest are a single label or a 1-5 score.

Missing answers remain `null` or an empty array. They are not inferred from prose.

## Structured question taxonomy

`review_details` covers the dining family only. Google asks other families too,
and the universe is larger than any small sample suggests: 226 reviews from
three reviewers already carried 29 distinct question ids across four families -
`GUIDED_DINING_*`, `TTD_*` (attractions), `HOTELS_*` and `BEAUTY_*` - and was
still turning up new option ids at the end of the scan. Every question is
retained verbatim under `structured_responses` whether or not it has a
convenience field.

Google sends only the option the reviewer selected; the candidate list is never
transmitted. The question and option universe is therefore an observed lower
bound that has to be enumerated from collected data:

```bash
node scripts/analyze-structured-responses.js \
  --input output/run/reviewers.ndjson \
  --output output/run/structured-taxonomy.json
```

The report groups questions by family, records each one's option universe with
counts and labels, flags currency-scoped questions, lists the place categories
each question attaches to, and names any question id with no `review_details`
mapping. Currency scoping is not a footnote: `GUIDED_DINING_PRICE_RANGE` had
already minted options in six currencies (EUR, JOD, LKR, QAR, SGD, VND) across
those 226 reviews, so its option space grows with the geography of the sample
and never closes.

It also emits a saturation curve. `converged` compares the last quarter of the
scan against the rest: if new question ids are still appearing there, the sample
has not exhausted the taxonomy and no total should be quoted from it.

## Completeness and limits

`completeness.stop_reason` has the following meanings:

- `complete`: returned count covers Google's current public review count.
- `private_or_hidden`: the profile reports contributions but serves no review
  history - either the counter is zero, or it is non-zero and every page size in
  the fallback ladder came back empty.
- `requested_limit`: the operator selected a limit below the visible count.
- `service_cap`: Google returned the largest usable response below the visible
  count, which is 200.
- `response_shortfall`: the reply was shorter than expected and is retryable.
  A reply with zero reviews before the fallback ladder is exhausted lands here
  rather than in `service_cap`, so it is retried instead of being recorded as a
  terminal cap.
- `fetch_error`: navigation, HTTP or parsing failed and is retryable.

The scraper first requests the desired count, then falls back through 150, 100,
50 and 25 when a large request returns no review content. `_meta` records
`attempted_review_limits`, `effective_review_limit`, the requested limit, the
service cap and whether review media were requested.

## What the 200 cap is, measured

The cap was probed directly rather than inferred, on reviewer
102873738934801008402 (counter 10,400 reviews, 10,554 contributions):

| Probe | Result |
|---|---|
| Page size 200 | 200 reviews |
| Page size 201, 250, 300, 500, 1000 | zero reviews, HTTP 200 |
| Page size 201 with review media switched off | still zero |
| Continuation token | the slot beside the review array (`publicContent[1]`) is always null |
| Offset fields injected into protobuf field 41 (`3i`, `4i`, `5i`, `6i`, `8i`, `9i`, `10i`) | byte-identical response; unknown fields are ignored |
| Field 41 mode enum `!7m2!1m1!1e2` | returns photo contributions, not a different review ordering; `1e3`-`1e12` return nothing |
| Map viewport (`/@lat,lng,zoom`) | reaches the request, does not filter the result |
| Option flags in field 41 (`2b`, `3b`, `7b`, `4m1!1e*`) and top level (`10m5` `1b`/`5b`/`11b`, `9m1!1e*`, `6m2` `4b`/`7b`) | identical window every time |

So 200 is server-side validation, not a payload-size symptom, and the service
exposes no cursor, offset, sort or filter dimension that reaches past it. The
anonymous profile page is itself only a preview: it renders 10 reviews and
issues no further request when scrolled to the bottom.

`stop_reason: complete` is therefore the only guarantee of a full public
history, and it is the common case - in an 11.5 M-row review database, 97.8% of
4,038,136 distinct reviewers had 200 or fewer public reviews.

## Window semantics

The returned reviews are ordered by last modified time, `max(published, edited)`
descending, and form one contiguous window. Checking a 200-review response
against that key gives zero inversions, while publication time alone gives 16 -
an old review that was edited recently re-enters the window ahead of newer
untouched ones. Each review carries `last_modified_at` for this reason.

Window length depends entirely on posting rate:

| Reviewer | Public reviews | 200 reviews cover |
|---|---:|---:|
| 102873738934801008402 | 10,400 | 25.8 days |
| 106689302864944033255 | 3,088 | 100.5 days |
| 118351699029752074984 | 3,472 | 276.1 days |
| 113007156091139674831 | 2,834 | 1,974 days |

## Activity fields

`activity` describes that window, and only that window, unless
`is_full_history` is true - meaning the window covered the whole public review
count, so the same numbers describe the reviewer's public lifetime.

| Field | Meaning |
|---|---|
| `window_basis` | always `last_modified_desc` |
| `is_full_history` | returned count reached the public counter |
| `reviews_in_window`, `reviews_with_timestamp` | window size, and how much of it is dateable |
| `window_newest_at`, `window_oldest_at`, `window_span_days` | window bounds on the ordering key |
| `published_newest_at`, `published_oldest_at` | bounds on publication time, which reach further back |
| `reviews_per_day` | window size over window span; null when the span is zero |
| `active_days`, `active_months`, `reviews_per_active_day` | distinct calendar days and months touched |
| `median_gap_days`, `longest_gap_days` | spacing between consecutive contributions |
| `days_since_last_review` | recency at extraction time |
| `edited_share` | fraction of the window carrying an edit timestamp |

These are raw quantities. Weighting rate against recency against persistence is
an analytical choice and is deliberately left to the consumer; there is no
composite activity score in the record.

## Wire format and maintenance

Reviewer pages load `/locationhistory/preview/mas?pb=...`. Replies use an XSSI
prefix and protobuf-shaped JSON. Small replies normally place public content at
array field 45. Large replies may serialize protobuf field 46 as a sparse object;
the production parser supports both shapes.

Only protobuf field 41's count (`!41m14!1i<n>`) governs how many reviews come
back. The `!4m1!3i<n>` field that the page also carries selects image renditions
per media item: sweeping it across 0, 1, 3, 10, 50 and 200 at a fixed page size
of 50 left the returned review count, the parsed media items (961) and the
largest per-review media count (50) unchanged, and only moved the payload from
2.18 MB to 3.02 MB. Earlier notes claimed both counts had to be raised together;
that is not so, and raising the second one only buys payload.

Field 41's `5b` flag controls whether review media are sent at all. With it off,
978 images across 50 reviews collapse to zero while text, translations,
coordinates, place ids, categories, structured answers and owner responses are
unchanged, and the payload drops from 2.26 MB to 0.31 MB. `--no-review-media`
exposes it for runs that do not need photos.

Do not treat numeric array offsets as a stable public API. Update deterministic
fixtures and repeat the live probes when Google changes the page.

## Field map and quality report

![English Google Reviewer field map](assets/google-reviewer-field-map-en.png)

A second, pixel-accurate map annotates live captures directly: every red box is
measured from the real DOM rect of the element, and the leader lines name the
contract field it feeds. The top panel is the single-box anatomy (header,
counters, one review card, owner response); the bottom panel enumerates
`review_details.*` across four real reviews, where one label per field is fed by
a leader from every example that shows it (so a field seen on N cards carries N
lines and an `xN` tag). Fields with no on-page control are listed in the footer
so they are not mistaken for visible UI. It is regenerated by
`assets/google-reviewer-field-map-annotated.discover.js` (finds cards that cover
the label set), `...capture.js` (measures rects) and `...compose.js` (draws the
overlay). `tips_topics` is an aggregator question that did not surface on the
sampled pages and is noted as such rather than invented.

![Annotated reviewer field map](assets/google-reviewer-field-map-annotated.png)

Generate a machine-readable field coverage and performance report after a run:

```bash
node scripts/analyze-reviewer-profiles.js \
  --input output/run/reviewers.ndjson \
  --live-status output/run/reviewers.live.json \
  --output output/run/reviewer-quality-report.json
```

Optional fields are reported as observed non-null coverage, not as parser
failures. Core review ID, rating, business name and coordinate success are
reported separately.
