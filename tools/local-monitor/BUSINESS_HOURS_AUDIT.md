# POI search business-hours audit

Checked on 2026-08-12 while the Warsaw and Vienna searches were still running.
The POI parser reads Google payload index `203` during POI search and writes:

```text
openingHours.currentStatus
openingHours.weeklyHours[].day
openingHours.weeklyHours[].hours
openingHours.weeklyHours[].openHour
openingHours.weeklyHours[].closeHour
```

Current exact NDJSON scan:

| Output | Valid rows | `openingHours` | Coverage | Invalid JSON | `popularTimes` |
|---|---:|---:|---:|---:|---:|
| Warsaw | 13,307 | 8,752 | 65.8% | 0 | 0 |
| Vienna | 6,643 | 3,669 | 55.2% | 0 | 0 |
| Local Singapore baseline | 180,691 | 111,748 | 61.8% | 0 | 0 |

Every row counted as `openingHours` also had a non-empty `currentStatus` and a
non-empty `weeklyHours` array. Missing hours are expected for POIs that do not
publish a schedule; they are not a JSON parsing failure. `popularTimes` is a
separate field and was not present in these POI-search outputs.

Re-run the streaming audit without loading the files into memory:

```bash
node tools/inspect-ndjson-hours.js output/warsaw/places.ndjson
```
