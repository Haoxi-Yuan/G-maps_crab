# Research areas

- `street-view/`: Street View geometry, temporal capture, derivation, viewers,
  schemas, and research notes.
- `satellite/`: satellite-tile acquisition research code; downloaded tiles are
  intentionally excluded.
- `papers/`: paper source, audit notes, figure registries, and compact metadata;
  rendered reports and large figures are excluded.

These projects are independent of `CLI_scraper/`. They may consume scraper
outputs through documented files, but production code must not import them.
