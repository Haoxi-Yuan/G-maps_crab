---
output:
  pdf_document: default
  html_document: default
---

# How Google Street View aligns hover overlays to scene surfaces

The Street View viewer in Google Maps places a surface-aligned overlay under the cursor at frame rate: an arrow that lies flat on the visible road and orients along the road's direction; a rectangle that lies on a building face and re-orients with that face's normal as the cursor crosses between adjacent walls. Two questions motivate this work: what data does Google ship to support this behaviour, and what mathematical machinery converts the data into the on-screen overlay? This report is to record the reverse-engineering and writes out the recovered geometric specification in a form that admits independent replication.\
![](images/clipboard-3090652637.png){width="1286"}

The investigation proceeds in two phases. A headed Chromium session is instrumented against a single panoid (`JqSnKB7Pp-XymzXWDuP71w`, [Ghim Moh Road, Mar 2025](https://www.google.com/maps/@1.3117929,103.7889597,3a,63.6y,308.55h,87.52t/data=!3m7!1e1!3m5!1sJqSnKB7Pp-XymzXWDuP71w!2e0!6shttps:%2F%2Fstreetviewpixels-pa.googleapis.com%2Fv1%2Fthumbnail%3Fcb_client%3Dmaps_sv.tactile%26w%3D900%26h%3D600%26pitch%3D2.4810060469717854%26panoid%3DJqSnKB7Pp-XymzXWDuP71w%26yaw%3D308.54872638871154!7i16384!8i8192?entry=ttu&g_ep=EgoyMDI2MDUwMi4wIKXMDSoASAFQAw%3D%3D)); every network request is recorded through a scripted interaction protocol and compared against payloads retrieved by an independent ingestion pipeline. The per-frame hover behaviour is then reproduced on the client side using only data accessible through the documented `photometa/v1` endpoint, with verification at the level of byte-equal photometa responses and 100% positive ray-plane intersections on the indexmap-assigned pixels.

## Network audit rules out runtime geometry fetching

The capture script opens the panoid in an anonymous browser context and records every request through six interaction phases: initial load, mouse sweep across the visible ground, mouse sweep across a building facade, hover over the click-to-go arrow, click-to-go transition, and idle baseline. For each request, the URL, content type, response size, SHA1, and the phase active at request and response time are logged.

The session generates 102 requests with 13 unique non-image response bodies. Eight of these bodies are `application/json` payloads from `https://www.google.com/maps/photometa/v1`, ranging 358–370 KB. The remaining five split into the Street View renderer (a 4.7 MB WASM module) and four small payloads attached to peripheral UI features (pegman, passive-assist, ogadds telemetry, a `generate_204` ping). No payload class beyond photometa carries geometric data.

The mouse sweep over the building facade alone triggers five distinct photometa fetches, each carrying a different panoid in its `pb` parameter; the mouse sweep over the ground triggers one. The viewer predictively retrieves photometas for adjacent panoids in the link graph at the moment the cursor crosses screen regions where navigation is most likely to occur next. A click-to-go arrival therefore receives no surprise: its photometa is already cached during the cursor's approach.

The focal-pano photometa from the audit (369,994 bytes, SHA1 `51a757e525dd…`) matches the photometa retrieved by an independent ingestion HTTP request byte-for-byte. The `pb` template that produces this byte-equal response is

```
!1m4!1smaps_sv.tactile!11m2!2m1!1b1!2m2!1sen!2ssg
!3m3!1m2!1e2!2s<PANOID>
!4m61!1e1!1e2!1e3!1e4!1e5!1e6!1e8!1e12!1e17!2m1!1e1!4m1!1i48
!5m1!1e1!5m1!1e2!6m1!1e1!6m1!1e2
!9m36!1m3!1e2!2b1!3e2!1m3!1e2!2b0!3e3!1m3!1e3!2b1!3e2!1m3!1e3!2b0!3e3
!1m3!1e8!2b0!3e3!1m3!1e1!2b0!3e3!1m3!1e4!2b0!3e3
!1m3!1e10!2b1!3e2!1m3!1e10!2b0!3e3
!11m2!3m1!4b1
```

against `https://www.google.com/maps/photometa/v1?authuser=0&hl=en&gl=sg&pb=<encoded>` with the standard Maps `Referer`. The hover responsiveness is therefore a property of two components acting together: a geometry payload that contains every surface the cursor can land on, and a client-side renderer that converts cursor position into surface-aligned overlay at frame rate. The remainder of this document characterises that geometry payload and that renderer.

## The geometry payload: plane equations and indexmap

The photometa response, after stripping the `)]}'\n` anti-hijack prefix, is a deeply nested JSON array. The geometry block sits at `d[1][0][5][0][5]` and carries two base64-encoded binary blobs: `blob1` (plane equations + indexmap) and `blob2` (depth map; not used by the overlay path and not analysed here).

`blob1` opens with an 8-byte header carrying the protocol version, the plane count $N$, the indexmap dimensions, and an offset byte. The indexmap follows: $256 \times 512$ unsigned 8-bit cells, one per direction, encoding which plane the corresponding line of sight terminates on. The plane table follows: $N$ records of 16 bytes each, four little-endian float32s per record encoding $(n_x, n_y, n_z, d)$. The Mar 2025 capture for the focal panoid carries 194 planes; plane index 0 is reserved for "no plane" (sky or unassigned ray). The full byte-walk is

``` js
const headerVer  = blob1[0];
const numPlanes  = blob1.readUInt16LE(1);
const dim1       = blob1.readUInt16LE(3);   // mapW = 256
const dim2       = blob1.readUInt16LE(5);   // mapH = 512
const idxMap     = blob1.slice(8, 8 + mapW * mapH);    // 131072 bytes
const planeOff   = 8 + mapW * mapH;
for (let i = 0; i < numPlanes; i++) {
  const o  = planeOff + i * 16;
  const nx = blob1.readFloatLE(o);
  const ny = blob1.readFloatLE(o + 4);
  const nz = blob1.readFloatLE(o + 8);
  const d  = blob1.readFloatLE(o + 12);
}
```

Each plane record encodes the equation $$\mathbf{n}\cdot\mathbf{p} = d, \qquad d > 0,$$ with $\mathbf{n}$ unit-length and $d$ the perpendicular distance from the camera origin to the plane. This sign convention places the camera on the half-space $\mathbf{n}\cdot\mathbf{p} < d$ for every plane, and the perpendicular foot from the origin sits at $\mathbf{p}_0 = d\,\mathbf{n}$. The stored normal points from the camera into the surface — the inward sense — so the ground plane's normal is $(0, 0, -1)$ rather than the more familiar outward $(0, 0, +1)$. This choice is intrinsic to the data and propagates through every downstream computation; the convention is not standard, and recovering it required a first iteration of the demo to fail before the sign was correctly inferred.

The indexmap stores its 131,072 cells row-by-row in a single byte stream. The reshape semantics that yield internal consistency are

``` python
idx = np.frombuffer(blob_or_file_bytes, dtype=np.uint8).reshape(256, 512)
# rows discretise pitch; cols discretise yaw.
```

— 256 rows by 512 columns, with rows discretising pitch and columns discretising yaw. The JSON sidecar emitted by the parsing pipeline records these dimensions as `{ "mapWidth": 256, "mapHeight": 512 }`, which inverts the standard imaging convention where width is the horizontal (yaw) axis. The mismatch may cause first-time readers to misread the layout; renaming these fields to `storageRows` and `storageCols` would close that gap.

![Indexmap integer raster for the focal pano. Panel A colours each cell by plane class (sky / ground / facade / ceiling). Panel B colours each cell by raw plane id, exposing the per-plane segmentation that classes alone collapse — every distinct hue in the colourful band corresponds to a different building face or sub-region. Panel C zooms a 70-row × 42-column block crossing the sky → wall → ground transition; each cell carries the printed `uint8` plane id, demonstrating that the indexmap is a discrete integer raster, not a continuous image. The red dashed line marks the horizon at row 128.](images/indexmap_raster.png)

## Coordinate conventions, recovered empirically

The photometa header documents neither the yaw orientation nor the choice of $z$-axis sense. Both are recovered from the data through a series of intersection-consistency tests against the focal indexmap.

### Yaw direction and the column-zero meaning

By sampling the indexmap at 32 columns along the horizon row (row 128), identifying the plane returned at each column, and computing the candidate ray direction under each of two yaw conventions — clockwise from $+\mathbf{Y}$, and counter-clockwise from $+\mathbf{Y}$ — the correct convention can be selected by sign-of-$t$ voting. For each (column, plane) pair, $t = d/(\mathbf{n}\cdot\mathbf{d})$ is evaluated along the ray from the camera origin. The clockwise-from-$+\mathbf{Y}$ convention yields positive $t$ on 81,499 of 81,499 non-sky pixels of the indexmap; the counter-clockwise alternative yields zero positive values. The yaw axis is therefore $$\theta = \frac{\text{col} + 0.5}{W_{\text{idx}}}\cdot 2\pi - \pi \in (-\pi, \pi],$$ giving column-zero direction $-\mathbf{Y}$ (pano-back) and column-256 direction $+\mathbf{Y}$ (pano-forward, the visible centre of the panorama JPEG). The column-zero correspondence to $-\mathbf{Y}$ also matches the standard equirectangular panorama layout: the seam at the left-right edge sits behind the camera, and the centre column shows the forward direction.

### Pitch direction and the row-zero meaning

The first 22,123 indexmap bytes are zero — exactly 86 full rows. This sky region must lie above some pitch threshold. The bottom 14,019 bytes return exclusively plane index 1 (one of three large ground planes with $n_z \approx -1$), placing the looking-down hemisphere at the bottom of the storage. The pitch axis is therefore $$\varphi = \frac{\pi}{2} - \frac{\text{row} + 0.5}{H_{\text{idx}}}\cdot\pi \in [-\pi/2,\ +\pi/2],$$ with row 0 corresponding to $\varphi = +\pi/2$ (zenith) and row 255 to $\varphi = -\pi/2$ (nadir). The 86-row sky band corresponds to elevations above $\varphi \approx +60°$, consistent with the visible upper-third of the open road scene.

### Z-axis sense

The choice between $+\mathbf{Z}$-up and $+\mathbf{Z}$-down does not affect the numerical equations: both interpretations describe the same physical configuration, differing only in sign on the $z$-component of every quantity. The reference implementation treats $+\mathbf{Z}$ as up: ground hits at $z = -d \approx -2.43\,\text{m}$ (camera height above the road), normals point in $-\mathbf{Z}$ "into the earth", and the ray test $t = d/(\mathbf{n}\cdot\mathbf{d})$ yields positive $t$ when the ray descends ($d_z < 0$). The same convention is adopted throughout the demo. The full encoder–decoder pair, expressed in numpy, is

``` python
# (col, row) → unit direction (+X right, +Y forward, +Z up):
theta = (col + 0.5) / W_idx * 2.0 * math.pi - math.pi
phi   = math.pi / 2.0 - (row + 0.5) / H_idx * math.pi
dx, dy, dz = math.sin(theta)*math.cos(phi), math.cos(theta)*math.cos(phi), math.sin(phi)

# direction → (col, row):
theta = math.atan2(dx, dy)
phi   = math.asin(max(-1.0, min(1.0, dz)))
col   = int((theta + math.pi) / (2*math.pi) * W_idx)
row   = int((math.pi/2 - phi)  / math.pi    * H_idx)
```

### Indexmap-to-panorama alignment

The Mar 2025 panorama JPEG ships at $8192 \times 4096$, exactly $16\times$ the indexmap on each axis. A panorama pixel $(\text{px}, \text{py})$ corresponds to indexmap $(\text{col} = \text{px}/16,\ \text{row} = \text{py}/16)$. Standard equirectangular sampling against the panorama then uses $$u = \frac{\theta + \pi}{2\pi}, \qquad v = \frac{\pi/2 - \varphi}{\pi},$$ and by transitivity the column-zero indexmap cell aligns with the leftmost panorama pixel and the row-zero cell with the topmost. Side-by-side overlay of both raster maps on the same axes confirms the alignment is exact; no rotation, no offset, no half-pixel shift.

### Pano-local geometry versus world geometry

The formulas above operate in the coordinate frame of a single panorama. They are sufficient for hover overlays and for sampling that panorama's own image, but they are not sufficient for fusing geometry from multiple panoramas or for texturing an independently measured mesh in a shared metric world frame. For those uses, each local 3D point must be transformed by the pano pose before it is compared with other geometry:

$$
\mathbf{P}_{\text{world}} = \mathbf{R}_{\text{local}\to\text{world}}\mathbf{P}_{\text{local}} + \mathbf{C}_{\text{world}},
$$

where $\mathbf{C}_{\text{world}}$ is the pano camera centre in local ENU metres, derived from latitude/longitude relative to the run's reference pano. For metric fusion this conversion should use WGS84 geodetic coordinates converted through ECEF and then into the reference tangent plane, rather than a fixed metres-per-degree approximation. The rotation used by the pipeline is

$$
\mathbf{R}_{\text{local}\to\text{world}}
= R_z(-\text{heading})\,R_x(\text{pitch}-90^\circ)\,R_y(\text{roll}).
$$

The sign on heading is deliberate: Google heading is a compass bearing, clockwise from north/world $+\mathbf{Y}$, whereas the standard $R_z$ matrix is counter-clockwise. Pitch is reported as $90^\circ$ for a level horizon, so the physical pitch offset is $\text{pitch}-90^\circ$. Roll is applied about pano-local $+\mathbf{Y}$.

Texture lookup goes the other direction. For a world-space mesh vertex, first subtract the camera centre and rotate back into pano-local coordinates,

$$
\mathbf{v}_{\text{local}} =
\mathbf{R}_{\text{local}\to\text{world}}^\mathsf{T}
(\mathbf{V}_{\text{world}}-\mathbf{C}_{\text{world}}),
$$

then normalize $\mathbf{v}_{\text{local}}$ and compute the equirectangular $(u,v)$ using the same $\mathrm{atan2}(x,y)$ and elevation formulas above. In other words, image sampling remains pano-local; metric fusion and mesh placement happen in the world frame. Mixing these two frames is the common failure mode that makes a texture look plausible in isolation but fail to line up with true metre-scale geometry.

### Map-frame validation against footprints

The local-to-world transform gives a direct spatial validation. Facade components recovered from the indexmap were projected into the ENU frame and overlaid on Google satellite imagery, the Google Maps building layer, and OpenStreetMap footprints. The same fitted wall segments are used in all three panels.

Across the three references, the recovered segments follow the exposed building edges around Blocks 6 and 19 and the Ulu Pandan Community Building. The agreement in position, scale, and orientation shows that the decoded indexmap and plane table are correctly registered in map space after pose rotation. This validates the spatial accuracy of the indexmap geometry and supports its use for assigning precise semantics to panorama pixels.

![Map-frame validation of the indexmap-derived facade geometry. Panel A overlays the recovered plane components on Google satellite imagery, Panel B uses the Google Maps building layer, and Panel C uses OpenStreetMap footprints. Agreement across all three backdrops shows that the decoded indexmap and plane table are spatially registered after pose rotation.](images/photometa_map_alignment_triptych.png){width="100%"}

### Gravity correction for raster indexmaps

The same pose fields are needed when the indexmap is inspected as a raster. The decoded `uint8` grid is internally valid as a $256 \times 512$ categorical array, but it is stored in the pano-local camera frame. If a capture was not level, vertical surfaces appear tilted in the decoded raster even when the byte parsing is correct. The temporal capture from August 2018 is the clearest case in the Ghim Moh stack: its reported pitch is $81.00^\circ$, a $-9.00^\circ$ offset from the level-horizon convention, and the raw facade regions lean visibly.

Gravity correction resamples the categorical indexmap through the capture pose before any semantic interpretation is made. For an output cell $(r',c')$, a gravity-level direction $\mathbf{d}_g$ is formed from the same equirectangular equations used above. That direction is mapped back into the source pano-local frame and sampled from the original indexmap,

$$
\mathbf{d}_{\text{src}} =
\mathbf{R}_{\text{corr}}^\mathsf{T}\mathbf{d}_g,
\qquad
I_{\text{grav}}(r',c') =
\operatorname{mode}_{s\in S(r',c')} I\!\left(\operatorname{row}(\mathbf{d}_{\text{src},s}),
\operatorname{col}(\mathbf{d}_{\text{src},s})\right).
$$

The mode over sub-pixel samples $S(r',c')$ is used because plane ids are labels, not intensities; bilinear interpolation would invent non-existent plane identifiers. A full world-azimuth version uses $\mathbf{R}_{\text{corr}}=\mathbf{R}_{\text{local}\to\text{world}}$. For direct visual comparison with the Street View panorama, the diagnostic version omits heading and applies only pitch and roll,

$$
\mathbf{R}_{\text{corr}} =
R_x(\text{pitch}-90^\circ)\,R_y(\text{roll}).
$$

This preserves the original panorama columns while flattening the camera attitude. The resulting raster remains aligned to the corresponding equirectangular street-view image in the horizontal layout, while the facade and ground regions are closer to their gravity-level appearance. Plane-class colouring then assigns sky, ground and facade semantics to regions whose apparent tilt no longer reflects camera pose.

![Gravity correction of the August 2018 temporal indexmap. Panel A shows the raw parsed `uint8` raster after class colouring. The capture has pitch $81.00^\circ$, so the camera-local raster carries a visible lean in the facade regions. Panel B resamples the same categorical cells with pitch and roll correction while preserving panorama columns. The correction removes most pose-induced skew without moving the raster into a different horizontal world-heading layout.](images/indexmap_gravity_rectification_2018_08.png)

## The per-frame algorithm

A perspective viewer at the panorama origin must convert each on-screen pixel to a world-frame ray, find the surface that ray hits, and project a small overlay polygon back onto the screen. The full pipeline is six operations.

### Pixel to ray

For a viewer with right, up, forward camera basis $(\mathbf{r}, \mathbf{u}, \mathbf{f})$, vertical FOV $\alpha_v$, canvas size $W_c \times H_c$ and aspect $A = W_c/H_c$, a pixel $(p_x, p_y)$ unprojects to $$\text{ndc}_x = \left(\tfrac{2 p_x}{W_c} - 1\right)\cdot A, \qquad \text{ndc}_y = -\left(\tfrac{2 p_y}{H_c} - 1\right),$$ $$\mathbf{d} = \frac{\text{ndc}_x \tau\,\mathbf{r} + \text{ndc}_y \tau\,\mathbf{u} + \mathbf{f}}{\|\text{ndc}_x \tau\,\mathbf{r} + \text{ndc}_y \tau\,\mathbf{u} + \mathbf{f}\|}, \qquad \tau = \tan(\alpha_v/2).$$

### Direction to plane id

The direction $\mathbf{d}$ inverts to indexmap coordinates by the formulae of the previous section, and the indexmap returns a plane id $\in \{0, 1, ..., 193\}$. A returned id of zero corresponds to sky and terminates the overlay path.

### Ray-plane intersection

Substituting $\mathbf{p}(t) = t\,\mathbf{d}$ into $\mathbf{n}\cdot\mathbf{p} = d$ gives $$t = \frac{d}{\mathbf{n}\cdot\mathbf{d}}, \qquad \mathbf{P}_{\text{hit}} = t\,\mathbf{d}.$$ The data convention guarantees $\mathbf{n}\cdot\mathbf{d} > 0$ on every assigned pixel, verified on all 81,499 non-sky cells of the focal indexmap. Pixels where $t$ exceeds the panorama's effective horizon (a 250 m cutoff matching the production pipeline) are dropped. The vectorised numpy form used by the existing 3D-viewer pipeline is

``` python
n_dot_dir = nx[idxs] * dx + ny[idxs] * dy + nz[idxs] * dz
plane_d   = d[idxs]
with np.errstate(divide='ignore', invalid='ignore'):
    t = plane_d / n_dot_dir
valid = (idxs != 0) & np.isfinite(t) & (t > 0) & (t < max_distance)
```

### Plane classification

The overlay shape depends on the surface orientation. The classifier thresholds on $|n_z|$:

``` js
function classifyPlane(p) {
  const len = Math.sqrt(p.nx*p.nx + p.ny*p.ny + p.nz*p.nz);
  if (len < 1e-6) return 'invalid';
  const nz = p.nz / len;
  if (nz < -0.5)               return 'ground';   // points into earth
  if (nz >  0.5)               return 'ceiling';  // points up
  if (Math.abs(nz) < 0.5)      return 'facade';   // vertical wall
  return 'oblique';
}
```

| Class | Condition | Geometry |
|----|----|----|
| Ground | $n_z < -0.5$ | Horizontal, below camera |
| Ceiling | $n_z > +0.5$ | Horizontal, above camera |
| Facade | $\|n_z\| < 0.5$, $\sqrt{n_x^2 + n_y^2} > 0.3$ | Vertical wall |
| Oblique | otherwise | Tilted surface |

In the focal panorama, ground planes account for 48.9% of the 131,072 indexmap cells (planes #1, #2, and #3 cover most of the road), sky for 37.8% (plane id 0), facade and oblique planes for 13.1% (44 facade plane records, of which most cover under 2% of the indexmap), and ceiling planes for 0.2%. The distribution is highly skewed: the four largest plane ids together account for 75.8% of the indexmap, while the remaining 190 planes share the last 24%.

![Top-20 plane ids by indexmap pixel coverage. Bar height is the cell count out of 131,072; bar colour matches the per-plane hue used in panel B above. Plane id 0 (sky) and the three large ground planes #1–#3 dominate; the largest facade (plane #4) covers only 3.2% of the indexmap, and most facades cover under 2%.](images/indexmap_histogram.png)

### Overlay corner construction

A ground hit produces a flat chevron lying on the ground plane, oriented to point away from the camera in the radial direction $$\mathbf{f}_{\text{arr}} = (h_x/\rho,\ h_y/\rho,\ 0), \quad \rho = \sqrt{h_x^2 + h_y^2},$$ $$\mathbf{p}_{\text{arr}} = (f_y, -f_x, 0).$$ Six vertices form the chevron at distances $\{0.65,\ 0.20,\ 0.05,\ -0.30\}\,\text{m}$ along $\mathbf{f}_{\text{arr}}$ and $\{0,\ \pm 0.20,\ \pm 0.50\}\,\text{m}$ along $\mathbf{p}_{\text{arr}}$, lifted by 4 cm along $+\mathbf{Z}$ to avoid z-fighting with the ground plane.

A facade hit produces a $0.6 \times 0.9\,\text{m}$ rectangle on the wall surface. The outward normal (toward the camera) is $\mathbf{n}_{\text{out}} = -\mathbf{n}_{\text{stored}}$. A local in-plane basis is built from $$\mathbf{l}_r = \mathrm{normalize}(\mathbf{n}_{\text{out}} \times \hat{\mathbf{z}}), \qquad \mathbf{l}_u = \mathbf{l}_r \times \mathbf{n}_{\text{out}},$$ with the rectangle centre offset 5 cm outward along $\mathbf{n}_{\text{out}}$. The four corners are $\mathbf{c} \pm 0.3\,\mathbf{l}_r \pm 0.45\,\mathbf{l}_u$.

### World to screen

Each overlay corner re-projects through the viewer using $$x_c = \mathbf{P}\cdot\mathbf{r}, \quad y_c = \mathbf{P}\cdot\mathbf{u}, \quad z_c = \mathbf{P}\cdot\mathbf{f},$$ $$s_x = \tfrac{1}{2}\left(\tfrac{x_c/z_c}{\tau A} + 1\right) W_c, \qquad s_y = \tfrac{1}{2}\left(1 - \tfrac{y_c/z_c}{\tau}\right) H_c,$$ which produces a 4-vertex (facade) or 6-vertex (ground) screen-space polygon. Filling this polygon with 50% alpha and stroking its boundary completes one frame of the overlay path.

### Camera basis from yaw and pitch

The viewer rotates the camera around the world up axis (yaw, $Y$) and the camera right axis (pitch, $P$): $$\mathbf{f} = (\sin Y \cos P,\ \cos Y \cos P,\ \sin P),$$ $$\mathbf{r} = (\cos Y,\ -\sin Y,\ 0),$$ $$\mathbf{u} = (-\sin Y \sin P,\ -\cos Y \sin P,\ \cos P).$$ Yaw is measured clockwise from $+\mathbf{Y}$ as seen from above (positive yaw turns the view to the user's right); pitch is measured upward from the horizontal plane (positive pitch tilts the view skyward).

## End-to-end verification

A single-file replication embeds the focal panoid's panorama JPEG, indexmap, and plane table inline, renders the panorama through a WebGL fragment shader implementing the equirectangular sampling above, and runs the per-frame overlay path on a 2D canvas overlay layer. Three checks anchor correctness.

The byte-equality test compares the focal photometa retrieved by an independent ingestion request against the photometa retrieved by the live UI capture: SHA1 `51a757e525ddfe6afb1e81b0199167014cf1ed62`, 369,994 bytes, identical. Anyone using the published `pb` template above receives the same bytes Google ships to its viewer; the geometric specification recovered above operates on the same input the live system receives.

The intersection consistency test enumerates the 81,499 non-sky cells of the focal indexmap, computes each cell's ray direction by inverse-mapping from $(\text{col}, \text{row})$ under the recovered conventions, and evaluates $t = d/(\mathbf{n}\cdot\mathbf{d})$ against the assigned plane. Every cell yields $t > 0$ with $\mathbf{n}\cdot\mathbf{d} > 0$ and $t < 110\,\text{m}$. The data is internally consistent under the recovered convention, with no exceptions and no need for sign-flipping fallbacks.

The hit-rate test samples a $16 \times 16$ pixel grid at the demo's default camera (yaw 0, pitch 0, FOV 75°) and counts pixels that produce a non-sky overlay. 204 of 256 pixels return a surface, 52 return sky, and zero return a sky-classified pixel that subsequently fails intersection. The 79.7% hit rate is shaped by the data: sky covers roughly 38% of the focal panorama as a whole, but rather less of the centred 75° field of view because the road extends to the horizon and the upper-frame sky is largely cropped out.

## Implications for the downstream pipeline

The conventions recovered here also govern every script that consumes photometa-derived planes. A survey of the six consumers shows the math correct in every case: the intersection formula reduces to $t = d/(\mathbf{n}\cdot\mathbf{d})$, and the spherical encoding is exactly the column-zero-as-$-\mathbf{Y}$ form that produces 100% positive $t$ in the consistency test. The pipeline silently drops cells with negative or out-of-range $t$ via a `valid = (t > 0) & (t < max_d)` mask, and the test confirms no cells need to be dropped under the current convention.

Two cosmetic improvements would prevent the convention-recovery work from being repeated in future. The JSON field names `mapWidth` / `mapHeight` carry the photometa header values directly, in a way that swaps the imaging convention of "width = columns = horizontal axis"; renaming to `storageRows` / `storageCols` would prevent first-contact misreads. The plane-classification source comment "z is typically up" is correct but does not document the inward-normal convention; spelling out "stored normal points into the surface — ground has $n_z = -1$ because it points downward into the earth" would close the documentation gap.

The Street View hover behaviour is therefore not the product of any data Google withholds. The geometry it requires — surface plane equations, a per-direction surface index, a panorama image — is already present in the documented `photometa/v1` response. The viewer's responsiveness is the result of running the formulas above at frame rate against an in-memory copy of that response, with predictive prefetch supplying neighbouring panoid responses ahead of likely user moves.

## Sampling resolution: indexmap quantises plane id, not data density

The indexmap assigns a plane to each direction at $256 \times 512$ angular resolution; the geometry itself can be sampled at any finer angular resolution the panorama supplies. The panorama JPEG ships at $16\times$ the indexmap on each axis (§Indexmap-to-panorama alignment), so each indexmap cell covers $16 \times 16 = 256$ pano pixels under a single plane id. Each pano pixel is an independent angular observation, and substituting its direction $\mathbf{d}_p$ into $t = d/(\mathbf{n}\cdot\mathbf{d}_p)$ yields a 3D point that varies smoothly within the cell rather than being quantised to the cell centre.

Moving from cell-centre to pano-pixel sampling raises the achievable point count by $256$, reaching ${\sim}2.5\times 10^{7}$ non-sky hits for the focal panorama. Sub-cell directional precision of ${\sim}4$ mm at $5$ m and ${\sim}4$ cm at $50$ m replaces the cell-centre values of ${\sim}6$ cm and ${\sim}60$ cm.

The density of samples on the plane itself is governed by the angular footprint of one cell, the hit distance $r$, and the angle $\alpha$ between the ray and the plane normal:

$$
\rho_{\text{plane}}(r, \alpha) = \frac{\cos\alpha}{r^2 \, d\Omega_{\text{cell}}}, \qquad d\Omega_{\text{cell}} = \frac{4\pi}{N_{\text{cells}}}.
$$

An indexmap cell viewing a wall at $r = 50$ m, $\alpha = 30°$ has a footprint of ${\sim}0.28$ m² on the wall — about $3.6$ cells per square metre, or ${\sim}920$ pano-pixel samples per square metre. The same cell at $r = 5$ m yields ${\sim}360$ cells per square metre; density falls as $1/r^2$ at fixed $\alpha$ because the panorama physically captured fewer angular samples in those directions, and the missing detail is not present in the input.

Texturing a world-frame plane from a single panorama inherits the same angular limit. The metric width covered by one pano pixel at distance $r$ and normal angle $\alpha$ is

$$
\Delta s = \frac{r\,\Delta\theta_{\text{pano}}}{\cos\alpha},
$$

with $\Delta\theta_{\text{pano}} = 2\pi / 8192 \approx 7.7\times 10^{-4}$ rad. One pano pixel covers ${\sim}4$ mm at $r = 5$ m on a perpendicular wall and ${\sim}19$ cm at $r = 50$ m, $\alpha = 78°$. Anisotropic stretching of textured plane quads at far or grazing positions reflects this scaling, not a rendering artefact.

Far-region density is recoverable only by adding samples from neighbouring panos. Each pano $i$, transformed into the focal frame using the rotation in §"Pano-local geometry versus world geometry" with its own $\mathbf{C}_{\text{world},i}$, contributes independent ray-plane samples; a surface seen at $50$ m from one pano typically lies at $5$ m from a pano $50$ m further along the road, and sample counts add in proportion to the angular coverage each pano contributes to the surface.

Sub-cell sampling introduces one numerical caveat. The data convention guarantees $\mathbf{n}\cdot\mathbf{d}>0$ at every cell-centre direction; cell-corner directions can fall onto neighbouring planes and yield $\mathbf{n}\cdot\mathbf{d}$ values approaching zero. A floor of $\mathbf{n}\cdot\mathbf{d} > 10^{-3}$ — equivalent to discarding $t > 10^{3} d$, well beyond the $250$ m horizon cutoff — removes those directions without losing any sample inside an indexmap cell's interior.

## Temporal stability: indexmap as a pose-invariant channel

Comparing the same scene across years requires a representation whose values change with the world rather than with sampling pose. The Google timeline at panoid `JqSnKB7Pp-XymzXWDuP71w` returns 12 historical captures spanning Nov 2008 to Mar 2025 through the same `photometa/v1` endpoint. The lat/lng/heading/pitch/roll metadata recovered from `d[1][0][5][0][1]` shows that "the same point" is in fact 12 distinct camera poses scattered across a $9.3$ m $\times\,8.5$ m footprint with $10.1°$ of heading rotation and $11.2°$ of pitch (Table 1).

| Date    | dLat (m) | dLng (m) | Heading (°) | Pitch (°) | Roll (°) |
|:--------|---------:|---------:|------------:|----------:|---------:|
| 2008-11 |    -0.76 |    +1.08 |      321.24 |     92.15 |   359.70 |
| 2013-01 |    +1.96 |    -2.44 |      314.81 |     90.43 |   359.00 |
| 2016-09 |    +0.40 |    -4.57 |      316.49 |     88.67 |   357.81 |
| 2018-03 |    -0.18 |    -3.82 |      316.72 |     90.06 |   358.13 |
| 2018-08 |    -7.37 |    -7.42 |      318.03 |     81.00 |   359.76 |
| 2019-06 |    -4.14 |    -0.81 |      324.89 |     90.55 |   358.87 |
| 2020-09 |    -1.18 |    -3.03 |      320.87 |     91.31 |   358.80 |
| 2021-02 |    -1.33 |    -2.53 |      319.92 |     91.29 |   358.96 |
| 2022-11 |    -2.60 |    -1.71 |      322.88 |     90.34 |   358.62 |
| 2023-04 |    -2.01 |    -3.07 |      319.83 |     90.22 |   358.25 |
| 2024-07 |    +1.34 |    -1.36 |      319.14 |     89.79 |   359.26 |
| 2025-03 |     0.00 |     0.00 |      320.87 |     90.46 |   359.31 |

Table 1. Pose drift across the 12 captures at panoid `JqSnKB7Pp-XymzXWDuP71w`. dLat and dLng are metric offsets relative to the Mar 2025 focal capture; heading is compass bearing of pano-local $+y$; pitch $90°$ corresponds to a level horizon. The 2018-08 capture is the clearest pose outlier with a $-9.00°$ pitch offset.

Pixel-level RGB comparison across the 12 captures cannot isolate world change from sampling change. The photometric channel moves with lighting, white balance, exposure, and the JPEG encoder Google has updated at least once in this date range, leaving different ringing and chroma artefacts at object edges. Scene contents move with vehicles, pedestrians, signage, street furniture, wet pavement, and seasonal vegetation. Acquisition pose moves through the envelope of Table 1; the 2008-11 capture is rendered at lower angular resolution than the 2025-03 capture, and the 2018-08 capture sits $9°$ below the level-horizon convention, so its raw ground-skyline transition appears $9°$ lower in image coordinates — a pose artefact that mimics a 5–10 m vertical shift of the buildings if read directly off pixels.

![RGB panoramas for the 12 captures at panoid `JqSnKB7Pp-XymzXWDuP71w`, arranged chronologically left-to-right and top-to-bottom. Lighting, season, vehicles, pedestrians, and JPEG sharpness vary across panels; the 2008-11 panel is at lower angular resolution than the others, and the 2018-08 panel is tilted by the $9°$ pitch offset.](images/temporal_jq_pano_grid.png)

The indexmap encodes the same scene through a different pipeline. Each cell holds an integer plane id, independent of illumination, ISO, JPEG quantisation, and per-frame world dynamics. Pose drift now enters through the ray direction rather than the sample value, and is removed by the gravity correction in §"Gravity correction for raster indexmaps". The 2018-08 tilt is absorbed by the $R_x$ term in $\mathbf{R}_{\text{local}\to\text{world}}$, and the rectified row alignment matches the other 11 captures within a few cells.

![Gravity-rectified indexmaps for the same 12 captures, on a fixed world-azimuth grid. The pitch-induced tilt of the 2018-08 capture is removed; building façade extents, ground–facade transitions, and sky regions overlay across the 17-year window. Per-pid colours are randomised within each capture and do not correspond between captures.](images/temporal_jq_indexmap_grid.png)

Quantitative evidence of cross-year stability comes from the topmost facade row per column, extracted from each rectified indexmap as a single skyline curve. The 12 curves fall on top of each other within ${\sim}5$ rows over most of the building-bearing azimuth window — equivalent to ${\sim}3.5°$ of elevation, the magnitude expected from residual lat/lng translation of a few metres against a building line at 30–60 m. None carries the systematic offset that pixel-level RGB diff would produce, despite the pose envelope of Table 1.

![Topmost facade row vs world azimuth, extracted from each gravity-rectified indexmap. Twelve curves, coloured by capture month from Nov 2008 (purple) to Mar 2025 (yellow) on a viridis ramp, trace nearly the same building outline despite 9.3 m of latitude drift, 8.5 m of longitude drift, and $10°$ of heading rotation. Residual row deviations of order $5$ are consistent with lat/lng translation against the 30–60 m building line.](images/temporal_jq_skyline_overlay.png)

The indexmap-derived skyline therefore matches the same building across years at cell resolution without world-frame plane fusion. Sub-cell precision becomes necessary only when fusing plane normals across panos that sample a wall from different distances; that step is already specified in §"Pano-local geometry versus world geometry".

## Worked example: a single ground pixel

The lower-centre pixel $(p_x, p_y) = (800, 720)$ on a $1600 \times 900$ canvas, with the demo at default state (yaw 0, pitch 0, FOV 75°), illustrates the full pipeline.

The camera basis is $\mathbf{r} = (1, 0, 0)$, $\mathbf{u} = (0, 0, 1)$, $\mathbf{f} = (0, 1, 0)$, with $\tau = \tan(37.5°) \approx 0.768$ and $A = 16/9 \approx 1.78$.

The pixel unprojects as $\text{ndc}_x = 0$, $\text{ndc}_y = -(1.6 - 1) = -0.6$, giving $\mathbf{d}_{\text{cam}} = (0, -0.461, 1)$ and, after world-frame rotation and normalisation, $\mathbf{d} = (0, 0.907, -0.418)$. The negative $z$-component places the ray below the horizon (looking down at the road).

The inverse map yields $\theta = \mathrm{atan2}(0, 0.907) = 0$, so $\text{col} = (0+\pi)/(2\pi)\cdot 512 = 256$, and $\varphi = \arcsin(-0.418) \approx -0.431\,\text{rad}$, so $\text{row} = (1.572 + 0.431)/\pi \cdot 256 \approx 163$. The indexmap returns plane id 5 at $(163, 256)$, with $\mathbf{n} \approx (-0.02, -0.03, -1.00)$, $d \approx 2.51\,\text{m}$.

The intersection evaluates to $\mathbf{n}\cdot\mathbf{d} = -0.02 \cdot 0 + -0.03 \cdot 0.907 + -1 \cdot (-0.418) = 0.391$, giving $t = 2.51/0.391 = 6.42\,\text{m}$ and a hit point of $(0,\ 5.82,\ -2.68)\,\text{m}$ — 5.8 m forward of the camera, 2.7 m below it. The point lies on the ground plane at the expected camera height.

Plane id 5 classifies as ground ($n_z = -1.00 < -0.5$), so a chevron is constructed. The radial direction $\mathbf{f}_{\text{arr}} = (0, 1, 0)$ aligns with the ray; the perpendicular $\mathbf{p}_{\text{arr}} = (1, 0, 0)$. The six chevron vertices project back through the world-to-screen transform; corner $(0,\ 5.82 + 0.65,\ -2.68 + 0.04) = (0,\ 6.47,\ -2.64)$ goes to $z_c = 6.47$, $y_c = -2.64$, $\text{ndc}_y = -0.531$, $s_y \approx 689$. The complete polygon, filled at 50% alpha and stroked, is the orange chevron the user sees under the cursor on the road.

## Reference: equation index

| Quantity | Formula | Domain |
|----|----|----|
| (col, row) → direction | $\mathbf{d} = (\sin\theta\cos\varphi,\ \cos\theta\cos\varphi,\ \sin\varphi)$ | unit vector |
| direction → col | $\text{col} = \lfloor (\mathrm{atan2}(d_x, d_y) + \pi)/(2\pi)\cdot 512 \rfloor$ | $\{0, ..., 511\}$ |
| direction → row | $\text{row} = \lfloor (\pi/2 - \arcsin d_z)/\pi \cdot 256 \rfloor$ | $\{0, ..., 255\}$ |
| Pano texture u | $u = (\mathrm{atan2}(d_x, d_y) + \pi)/(2\pi)$ | $[0, 1]$ |
| Pano texture v | $v = (\pi/2 - \arcsin d_z)/\pi$ | $[0, 1]$ |
| Plane equation | $\mathbf{n}\cdot\mathbf{p} = d, \ d > 0$ | inward normal |
| Ray-plane $t$ | $t = d / (\mathbf{n}\cdot\mathbf{d})$ | metres |
| Hit point | $\mathbf{P} = t\,\mathbf{d}$ | metres |
| Wall xy-foot (facades, $n_x^2+n_y^2 > 0$) | $(n_x, n_y) \cdot d / (n_x^2 + n_y^2)$ | metres |
| Outward normal | $\mathbf{n}_{\text{out}} = -\mathbf{n}_{\text{stored}}$ | unit vector |
| FOV half-tan | $\tau = \tan(\alpha_v / 2)$ | dimensionless |
| Camera forward | $(\sin Y \cos P,\ \cos Y \cos P,\ \sin P)$ | unit vector |
| Camera right | $(\cos Y,\ -\sin Y,\ 0)$ | unit vector |
| Camera up | $(-\sin Y \sin P,\ -\cos Y \sin P,\ \cos P)$ | unit vector |
| Pixel ndcX | $(2 p_x/W_c - 1)\cdot A$ | $[-A, +A]$ |
| Pixel ndcY | $-(2 p_y/H_c - 1)$ | $[-1, +1]$ |
| Project ndcX | $(x_c/z_c)/(\tau A)$ | dimensionless |
| Project ndcY | $(y_c/z_c)/\tau$ | dimensionless |
| Screen $s_x$ | $(\text{ndc}_x + 1)/2 \cdot W_c$ | px |
| Screen $s_y$ | $(1 - \text{ndc}_y)/2 \cdot H_c$ | px |

## Appendix A: byte layout of `blob1`

The blob opens with an 8-byte header — version (1 byte), plane count (uint16 LE), `dim1` (uint16 LE), `dim2` (uint16 LE), offset (1 byte). The indexmap occupies the next $H_{\text{idx}} \times W_{\text{idx}} = 256 \times 512 = 131{,}072$ bytes, one byte per cell in row-major order. The plane table follows: $N$ records of 16 bytes each, with each record encoding $(n_x, n_y, n_z, d)$ as four little-endian float32s. The walking code is reproduced above in §2.

`blob2` carries a depth map of the same dimensions and contains a `[mapW, mapH]` header of `[256, 512]`. The depth map is not required for the overlay path and is not analysed in this study.

## Appendix B: serialised JSON output schema

A typical JSON sidecar emitted by parsing `blob1` has the form

``` json
{
  "panoid": "JqSnKB7Pp-XymzXWDuP71w",
  "numPlanes": 194,
  "mapWidth":  256,
  "mapHeight": 512,
  "planes": [{ "idx": 0, "nx": 0, "ny": 0, "nz": 0, "d": 0 }, ...],
  "pixelsPerPlane": [49573, 27445, ...]
}
```

The `mapWidth` and `mapHeight` values invert the standard convention where width is the horizontal (yaw) axis. Renaming these fields to `storageRows` and `storageCols` in a future serialisation would make the layout self-documenting.

------------------------------------------------------------------------

*Investigation conducted on `JqSnKB7Pp-XymzXWDuP71w` (Mar 2025 capture).*
