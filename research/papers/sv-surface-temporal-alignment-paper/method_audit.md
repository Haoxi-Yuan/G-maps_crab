# Method Audit

Generated: 2026-05-04

This audit records assumptions, uncertainty sources and engineering backlog
items identified while writing the manuscript. It is intentionally separate
from `report.qmd` so that the paper narrative remains focused on established
outputs while method risks remain visible.

## Scope

Current manuscript scope:

- Site: `ghim_moh_market_food_centre`
- Catalog: `TEST/data/catalog/sv3d.duckdb`
- Main result: `temporal_spacetime_overview_top30_best_hd.png`
- Primary example: `gid_0011`
- No references in this pass.

## Formula and Code Audit

### Equirectangular Ray

Code source:

- `TEST/src/py/raw/build_rgb_pointcloud.py`

Implementation:

- `theta = (UU + 0.5) / W * 2 * pi - pi`
- `phi = pi/2 - (VV + 0.5) / H * pi`
- `dx = sin(theta) * cos(phi)`
- `dy = cos(theta) * cos(phi)`
- `dz = sin(phi)`

Assumption:

- The decoded indexmap grid follows the same equirectangular convention as the
  panorama sampling stage after any gravity/indexmap rectification used by the
  pipeline.

Risk:

- Horizontal shift or horizon rectification errors propagate into every
  ray-plane intersection.

### Pixel-to-Plane Intersection

Code source:

- `TEST/src/py/raw/build_rgb_pointcloud.py`

Implementation:

- `k = idx_map[i, j]`
- plane row gives `(nx, ny, nz, d)`
- `t = d / dot(n, ray)`
- local point is `t * ray`

Reliability evidence:

- Indexmap overlay should align categorical plane boundaries with image
  structures.
- Point cloud should produce plausible site layout.

Risk:

- Small or unstable denominators can create distant points. The implementation
  uses finite checks, positive distance, hard max distance and an effective cap.

### Local ENU Conversion

Code source:

- `latlng_to_local` in `TEST/src/py/raw/build_rgb_pointcloud.py`

Implementation:

- east uses `111320 * cos(radians(ref_lat))`
- north uses `110540`

Assumption:

- The site is small enough for a local flat approximation.

Risk:

- This is not a full geodetic transform. It is suitable for site-scale
  alignment but should be replaced with a geodesic/ENU library for larger
  spatial extent.

### Local-to-World Rotation

Code source:

- `build_rotation` in `TEST/src/py/diagnostics/filter_and_rectify.py`
- `TEST/src/py/derive/derive_planes_world.py`

Implementation:

- local axes: `+x` right, `+y` front, `+z` up
- world axes: `+x` east, `+y` north, `+z` up
- `R = R_z(-heading) @ R_x(pitch_deg - 90) @ R_y(roll)`

Reliability evidence:

- `ground_normal_validation.png` shows ground normal clustering after rotation.

Risk:

- The pitch convention is empirically derived from the current metadata
  structure. It is reliable for this run but should remain under validation for
  other sites and capture generations.

### Plane Offset Translation

Code source:

- `derive_planes_world.py`
- `derive_factor_surfaces.py`
- `derive_temporal_factor_surfaces.py`

Important distinction:

- `derive_planes_world.py` records rotation-only world normals and keeps local
  `d` unchanged at that stage.
- Global factor matching and temporal residuals use translated global offsets:
  `d_global = d_local + dot(n_world, pano_pos)`.

Risk:

- Mixing rotation-only `world_d` and translated `d_global` can create false
  residuals. The manuscript explicitly separates these two quantities.

### Factor Matching

Current evidence:

- `global_factors`: 275 factors.
- `global_factor_sources`: 2405 sources.
- `gid_0011`: 32 source observations from 30 unique panos.

Reliability evidence:

- Match uses normal agreement, offset agreement, class and repeated support.
- Top-down topology shows source panos arranged consistently relative to the
  factor plane.

Risk:

- Near-parallel facade segments at similar offsets can still be merged if
  spatial extent constraints are too loose.

### Surface Atlas

Code source:

- `TEST/src/py/derive/derive_factor_surfaces.py`

Implementation:

- Basis is derived from the factor normal.
- Atlas grid is projected into source panos.
- Pixels are retained only where the source indexmap equals the local plane id.

Reliability evidence:

- Rectified candidates are visually comparable after perspective removal.

Risk:

- Atlas dimensions and basis orientation are currently method choices. They are
  stable enough for visualization, but a later paper-quality method should
  formalize scale, resolution, orientation and boundary selection.

### Temporal Projection

Code source:

- `TEST/src/py/derive/derive_temporal_factor_surfaces.py`

Implementation:

- Project atlas grid into temporal capture local frame.
- Map local vectors to equirectangular coordinates.
- Sample temporal indexmap.
- Select dominant local plane.
- Record valid fraction, dominance, normal angle and offset residual.

Current thresholds:

- `min_valid_fraction = 0.015`
- `min_dominance = 0.35`
- `max_normal_angle_deg = 22.0`
- `max_offset_residual_m = 7.0`

Risk:

- These thresholds are permissive. They are suitable for preserving candidates
  for visual inspection, but formal change detection should tighten them or
  learn thresholds from manually reviewed examples.

## Data Uncertainty

### Missing Temporal Captures

Observed issue:

- Some years are absent from Google Street View coverage. The current usable
  span reaches from 2008 to 2025 but has gaps.

Effect:

- Absence of a cell cannot be interpreted as absence of a surface or absence of
  change.

### Uneven Timelines

Observed issue:

- Some panos have no timeline, incomplete timeline data or captures returned
  under a different panoid.

Effect:

- Temporal completeness varies by anchor pano and by factor.

### Photometa as Hidden Geometry

Observed issue:

- Plane equations, indexmaps and pose fields come from Google metadata, not from
  a surveyed ground-truth source.

Effect:

- The method is a reproducible reconstruction from hidden metadata, not a
  ground-truth measurement system.

### Quantized Indexmap

Observed issue:

- Indexmap resolution is `256 x 512`, lower than 8K panorama imagery.

Effect:

- Small structures, sharp boundaries and thin occluders can be assigned to
  coarse cells.

### Occlusion

Observed issue:

- Trees, people, vehicles, signboards and temporary objects can hide facade
  support.

Effect:

- Accepted geometry can still contain impure visual texture.

### Lighting and Capture Pipeline

Observed issue:

- Historical captures differ in exposure, lighting, season and image processing.

Effect:

- Texture differences are not automatically physical surface change.

## Engineering Backlog

1. Replace local ENU approximation with a small geodesic/ENU utility for sites
   that cover larger extents.

2. Add a per-site pose validation report that samples facade and ground normals
   separately and records residual distributions in the catalog.

3. Store a clear field distinction between rotation-only plane offset and
   translated global plane offset wherever both appear in outputs.

4. Formalize factor geometry extent. Current bbox and boundary summaries are
   useful, but a stronger representation would include a cleaned 3D polygon,
   uncertainty band and support-weighted footprint.

5. Add an explicit occlusion/completeness classifier. Current visibility and
   quality tables contain useful proxies, but occlusion reason is still not
   fully algorithmic.

6. Improve surface atlas orientation and scale conventions. A reproducible
   atlas orientation should be stable across reruns and easy to compare across
   factors.

7. Tighten temporal acceptance thresholds for quantitative change detection.
   The current thresholds are designed for preserving visual candidates.

8. Add browser click-sweep ground truth for b2/SVI targets. Current target
   mapping is inferred from heading alignment.

9. Add true Google `place_id` capture. Current POI references mainly use ftid
   pairs.

10. Build a manual review set for accepted and rejected temporal cells. This
    would calibrate thresholds and quantify false accept/reject cases.

11. Produce semantic purity scores for surface crops. Current crop purity is
    geometric; it does not yet evaluate whether the RGB surface is visually
    clean.

12. Separate publication figures from diagnostic figures more aggressively.
    Many current diagnostics are correct but too dense for page layout.

## Manuscript Claims That Should Not Be Overstated

- Do not call Google photometa geometry ground truth.
- Do not claim temporal texture difference equals physical change without a
  change model.
- Do not claim b2/SVI target panoids are ground truth until click-sweep
  validation is added.
- Do not claim full occlusion reasoning has been solved.
- Do not claim surface fusion is complete for non-planar surfaces.
- Do not claim missing years are zero-change years.
