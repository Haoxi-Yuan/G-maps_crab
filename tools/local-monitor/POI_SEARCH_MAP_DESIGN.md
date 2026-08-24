# POI Search Map Mode

## Outcome

Add a second monitor mode for quadtree POI search. The enhanced window uses a
real native `MKMapView`; the compact window keeps the existing black/red
summary and does not create or render a map.

The scraper remains the source of truth. It atomically replaces a small
`poi_search.live.json` object. Neither the scraper nor the monitor stores an
animation history.

## Live event contract

The POI searcher should emit one coalesced event at most every 250 ms:

```json
{
  "version": 1,
  "pipeline": "poi-search",
  "city": "warsaw",
  "phase": "enter",
  "category": "Restaurant",
  "categoryIndex": 19,
  "categoryTotal": 177,
  "depth": 3,
  "zoom": 17,
  "bbox": {
    "minLat": 52.20,
    "minLng": 21.00,
    "maxLat": 52.24,
    "maxLng": 21.05,
    "centerLat": 52.22,
    "centerLng": 21.025,
    "sizeKm": 0.5
  },
  "newPlaceIds": 18,
  "totalPlaceIds": 42110,
  "requests": 2388,
  "updatedAt": "2026-08-12T08:12:04.472Z"
}
```

Relevant phases are `city-start`, `query-start`, `enter`, `subdivide`,
`complete`, `leave`, `offset`, `query-complete`, and `city-complete`.
`subdivide` may include the four child bounding boxes. A `leave` event is
important: it tells the map to zoom back to the parent instead of trying to
infer recursion from log text.

Atomic replacement avoids torn JSON reads. Coalescing avoids turning visual
telemetry into a high-frequency write workload.

## Animation state machine

1. `city-start`: show the whole administrative boundary.
2. `subdivide`: outline the parent and fade in four red child rectangles.
3. `enter`: use `setRegion(_:animated:)` to fly into the selected child.
4. A sibling `enter`: pan at the same scale rather than zooming out first.
5. `leave`: zoom out to the parent cell.
6. `complete`: pulse the cell once; use dim red for exhausted cells.
7. `offset`: pan over the fixed 4 km grid without changing zoom.
8. A city transition: zoom to the whole outgoing city, switch boundary, then
   fly into the incoming city.

If events arrive faster than animation can finish, retain only the newest
event at the current recursion depth. Do not build an animation backlog.

## Resource controls

- Create one `MKMapView` lazily only when the window is at least `600 × 360`
  and POI mode is active.
- Remove and release the map after the window remains compact for 15 seconds.
- Disable pitch, rotation, 3D buildings, user location, and continuous
  tracking. Use the standard muted map configuration with one cell overlay.
- Use MapKit's camera animation instead of a permanent 30/60 FPS timer.
- Cap custom overlay redraws at 12 FPS while a transition is active; idle
  redraw rate is zero.
- Keep only the current event and a recursion stack of at most nine bounding
  boxes (`maxDepth=8`).
- Poll a 1–3 KB sidecar every 1 second through the existing SSH control socket.
  Do not scan the growing `places.ndjson` for map state.
- Fall back to the bundled boundary-only renderer when map tiles are offline.

Measured baseline for the current native monitor is roughly 85–93 MB RSS and
0% CPU while idle. Initial acceptance budgets for MapKit mode should be:

- less than 180 MB steady-state RSS;
- less than 1% CPU while idle;
- less than 15% of one CPU core during a camera transition;
- no measurable change in POI request rate when the monitor is open.

These are hard acceptance targets, not yet measured MapKit results. Build the
telemetry sidecar first, then prototype one shared map and measure before
making it the default enhanced view.
