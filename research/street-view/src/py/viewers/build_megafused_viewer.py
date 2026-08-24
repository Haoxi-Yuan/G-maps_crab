#!/usr/bin/env python3
"""Build a Three.js viewer over the merged 52-panorama RGB point cloud.

Tech: instead of inlining all data as base64 (which would force subsampling
for ~4M points), this writes the raw buffers as separate binary files and a
small HTML that fetches them at runtime. Three.js renders the full 4 M points
without LOD on a modern GPU.

The HTML must be served over HTTP (file:// blocks fetch). Use the bundled
serve.py:

    python3 src/py/viewers/serve.py data/raw/google_maps/spatial/<site>/<run-id>/

then open http://localhost:8765/3d_viewer_megafused.html

Inputs:
  <run_dir>/merged_pointcloud.npz
  <run_dir>/pointcloud_meta.json

Outputs (all in <run_dir>/megafused_assets/):
  positions.f32       Float32  N×3
  rgb.u8              Uint8    N×3   (panorama photo colour)
  cls_rgb.u8          Uint8    N×3   (plane-class colour)
  plane_rgb.u8        Uint8    N×3   (plane-index hash colour)
  cls.u8              Uint8    N
  pano.u8             Uint8    N
  plane.u16           Uint16   N
  pano_pos.f32        Float32  P×3
  meta.json           {n_points, n_panos, panos:[…]}

And:
  <run_dir>/3d_viewer_megafused.html

Usage:
  python3 build_megafused_viewer.py <run_dir>
"""
import argparse
import colorsys
import json
import os
import sys

import numpy as np


CLS_COLORS = {
    0: (0.05, 0.05, 0.10),
    1: (0.30, 0.65, 0.40),
    2: (0.70, 0.50, 0.85),
    3: (0.55, 0.40, 0.25),
    4: (0.85, 0.20, 0.80),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('run_dir')
    ap.add_argument('--max-distance', type=float, default=80.0,
                    help='Display label only — actual filter applied at point-cloud build time')
    args = ap.parse_args()

    run = args.run_dir
    npz_fp = os.path.join(run, 'merged_pointcloud.npz')
    meta_fp = os.path.join(run, 'pointcloud_meta.json')
    if not os.path.exists(npz_fp):
        print(f'Missing {npz_fp}', file=sys.stderr); sys.exit(2)

    print(f'Loading {npz_fp}...')
    d = np.load(npz_fp)
    x = d['x'].astype(np.float32)
    y = d['y'].astype(np.float32)
    z = d['z'].astype(np.float32)
    rgb = d['rgb'].astype(np.uint8)
    plane = d['plane'].astype(np.uint16)
    pano = d['pano'].astype(np.uint8)
    cls = d['cls'].astype(np.uint8)
    b2 = d['b2'].astype(np.uint8) if 'b2' in d.files else np.zeros(x.size, dtype=np.uint8)
    n = x.size
    print(f'Loaded {n} points (full fidelity, no subsample).')

    cls_rgb_table = np.array([CLS_COLORS[i] for i in range(5)])
    cls_rgb_u8 = (np.clip(cls_rgb_table[cls], 0, 1) * 255).astype(np.uint8)

    HUES = np.linspace(0, 1, 24, endpoint=False)
    plane_rgb_table = np.array([colorsys.hls_to_rgb(h, 0.55, 0.85) for h in HUES])
    plane_rgb_u8 = (np.clip(plane_rgb_table[plane % 24], 0, 1) * 255).astype(np.uint8)

    pano_meta = json.load(open(meta_fp))
    pano_handles = pano_meta.get('panos', [])
    pano_pos = np.array([p['world_pos'] for p in pano_handles], dtype=np.float32)

    asset_dir = os.path.join(run, 'megafused_assets')
    os.makedirs(asset_dir, exist_ok=True)

    def write(name, arr):
        fp = os.path.join(asset_dir, name)
        with open(fp, 'wb') as f:
            f.write(arr.tobytes())
        print(f'  {name}: {os.path.getsize(fp) / 1e6:.1f} MB')

    # b2-id colour (rainbow over 24 hues; zero stays dark)
    b2_rgb_u8 = np.zeros((b2.size, 3), dtype=np.uint8)
    nonzero_mask = b2 > 0
    if nonzero_mask.any():
        b2_rgb_u8[nonzero_mask] = (np.clip(plane_rgb_table[b2[nonzero_mask] % 24], 0, 1) * 255).astype(np.uint8)
    # Zero-id (no annotation) — render dim grey so they don't look like a class colour
    b2_rgb_u8[~nonzero_mask] = [40, 40, 50]

    print('Writing binary buffers...')
    write('positions.f32', np.column_stack([x, y, z]).astype(np.float32))
    write('rgb.u8', rgb)
    write('cls_rgb.u8', cls_rgb_u8)
    write('plane_rgb.u8', plane_rgb_u8)
    write('b2_rgb.u8', b2_rgb_u8)
    write('cls.u8', cls)
    write('pano.u8', pano)
    write('plane.u16', plane)
    write('b2.u8', b2)
    write('pano_pos.f32', pano_pos)

    pano_handles_min = [{
        'i': p['pano_idx'], 'panoid': p['panoid'],
        'world_pos': p['world_pos'], 'lat': p['lat'], 'lng': p['lng'],
        'n_planes': p['n_planes'], 'n_points': p['n_points'],
        'effective_max_distance_m': p.get('effective_max_distance_m'),
        'poi_bindings': p.get('poi_bindings', []),
        'b2_unique_ids': p.get('b2_unique_ids', 0),
    } for p in pano_handles]
    asset_meta = {
        'n_points': int(n),
        'n_panos': len(pano_handles),
        'reference_lat': pano_meta.get('reference_lat', 0),
        'reference_lng': pano_meta.get('reference_lng', 0),
        'distance_policy': pano_meta.get('distance_policy', 'adaptive'),
        'panos': pano_handles_min,
    }
    with open(os.path.join(asset_dir, 'meta.json'), 'w') as f:
        json.dump(asset_meta, f, indent=2)

    out_fp = os.path.join(run, '3d_viewer_megafused.html')
    with open(out_fp, 'w') as f:
        f.write(HTML_TEMPLATE)
    print(f'Wrote {out_fp} ({os.path.getsize(out_fp) / 1e3:.1f} KB)')

    total_mb = sum(os.path.getsize(os.path.join(asset_dir, fn))
                   for fn in os.listdir(asset_dir)) / 1e6
    print(f'Asset directory: {asset_dir} ({total_mb:.1f} MB total)')
    print()
    print('To view, run:')
    print(f'  python3 src/py/serve.py {run}')
    print('then open http://localhost:8765/3d_viewer_megafused.html')


HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Megafused Street View — full-fidelity point cloud</title>
<style>
  body { margin: 0; overflow: hidden; background: #0d0f14; color: #e8e8ee;
         font: 13px/1.45 ui-sans-serif, system-ui, sans-serif; }
  .panel { position: absolute; padding: 11px 13px; background: rgba(15,18,24,0.88);
          border: 1px solid #333; border-radius: 8px; }
  #info { top: 10px; left: 10px; max-width: 420px; }
  #info h2 { margin: 0 0 6px 0; font-size: 14px; color: #fff; }
  #info code { font-size: 11px; color: #9cf; }
  #pickInfo { top: 10px; right: 10px; min-width: 280px; font-size: 12px; }
  #pickInfo b { color: #fff; }
  .swatch { display: inline-block; width: 12px; height: 12px; border-radius: 3px; border: 1px solid #555; }
  .toggles { margin-top: 8px; display: grid; grid-template-columns: auto auto; gap: 4px 12px; }
  .toggles label { display: flex; align-items: center; gap: 6px; }
  .row { margin-top: 8px; }
  button { background: #1f2933; color: #ddd; border: 1px solid #444; padding: 4px 8px;
          border-radius: 4px; cursor: pointer; font-size: 11px; margin-right: 4px; }
  button:hover { background: #2c3947; }
  .hint { color: #888; font-size: 11px; }
  #loader { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
            background: #0d0f14; z-index: 1000; flex-direction: column; gap: 12px; }
  #loader .bar { width: 320px; height: 8px; background: #222; border-radius: 4px; overflow: hidden; }
  #loader .fill { height: 100%; background: #4faa66; transition: width 0.2s; width: 0%; }
  #fileError { color: #f88; max-width: 480px; line-height: 1.5; padding: 16px;
               background: rgba(80,20,20,0.4); border: 1px solid #aa3333; border-radius: 8px; }
</style>
</head>
<body>
<div id="loader">
  <div id="loaderText">Loading buffers…</div>
  <div class="bar"><div class="fill" id="loaderFill"></div></div>
  <div id="loaderDetail" class="hint"></div>
</div>

<div id="info" class="panel" style="display:none">
<h2 id="title">Megafused Street View</h2>
<div id="subtitle"></div>
<div class="hint" id="hint"></div>

<div class="row"><b>Color mode:</b>
  <label><input type="radio" name="cmode" value="rgb" checked> RGB photo</label>
  <label><input type="radio" name="cmode" value="cls"> Plane class</label>
  <label><input type="radio" name="cmode" value="plane"> Plane index</label>
  <label><input type="radio" name="cmode" value="b2"> b2 annotation ID</label>
</div>

<div class="row"><b>Class filter:</b></div>
<div class="toggles">
  <label><input type="checkbox" id="t_ground" checked><span class="swatch" style="background:#4faa66"></span> ground</label>
  <label><input type="checkbox" id="t_facade" checked><span class="swatch" style="background:#bb88dd"></span> facade</label>
  <label><input type="checkbox" id="t_roof" checked><span class="swatch" style="background:#8c6640"></span> roof</label>
  <label><input type="checkbox" id="t_oblique" checked><span class="swatch" style="background:#d433cc"></span> oblique</label>
  <label><input type="checkbox" id="t_panos" checked><span class="swatch" style="background:#ff4444"></span> pano markers</label>
</div>

<div class="row">
  <b>Point size:</b> <input type="range" id="ptSize" min="0.05" max="0.6" step="0.01" value="0.15" style="width:120px;vertical-align:middle;">
  <span id="ptSizeLabel">0.15</span> m
</div>

<div class="row">
  <button id="b_top">Top-down</button>
  <button id="b_iso">Isometric</button>
  <button id="b_eye">First-person at origin</button>
</div>
<div class="hint" style="margin-top:6px;">drag = rotate · wheel = zoom · right-drag = pan</div>
</div>

<div id="pickInfo" class="panel" style="display:none">
<b>Inspector</b><br>
<span id="pickText" class="hint">hover over the cloud…</span>
</div>

<script type="importmap">
{
  "imports": {
    "three": "https://unpkg.com/three@0.160.0/build/three.module.js",
    "three/addons/": "https://unpkg.com/three@0.160.0/examples/jsm/"
  }
}
</script>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const ASSET_DIR = 'megafused_assets';
const FILES = [
  ['meta',         'meta.json',       'json'],
  ['positions',    'positions.f32',   'f32'],
  ['rgb',          'rgb.u8',          'u8'],
  ['cls_rgb',      'cls_rgb.u8',      'u8'],
  ['plane_rgb',    'plane_rgb.u8',    'u8'],
  ['b2_rgb',       'b2_rgb.u8',       'u8'],
  ['cls',          'cls.u8',          'u8'],
  ['pano',         'pano.u8',         'u8'],
  ['plane',        'plane.u16',       'u16'],
  ['b2',           'b2.u8',           'u8'],
  ['pano_pos',     'pano_pos.f32',    'f32'],
];

if (location.protocol === 'file:') {
  document.getElementById('loader').innerHTML = `
    <div id="fileError">
      <h3>This viewer needs an HTTP server.</h3>
      <p>Browsers block <code>fetch()</code> on <code>file://</code> URLs.
      Run <code>python3 src/py/serve.py &lt;run_dir&gt;</code> from the TEST root,
      then open the printed URL.</p>
    </div>`;
  throw new Error('file:// not supported');
}

const data = {};
const loaderFill = document.getElementById('loaderFill');
const loaderDetail = document.getElementById('loaderDetail');
const loaderText = document.getElementById('loaderText');
let loaded = 0;
async function loadAll() {
  for (const [key, fname, type] of FILES) {
    loaderText.textContent = `Loading ${fname}…`;
    const url = `${ASSET_DIR}/${fname}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`fetch ${url}: ${resp.status}`);
    if (type === 'json') {
      data[key] = await resp.json();
    } else {
      const buf = await resp.arrayBuffer();
      if (type === 'f32') data[key] = new Float32Array(buf);
      else if (type === 'u8') data[key] = new Uint8Array(buf);
      else if (type === 'u16') data[key] = new Uint16Array(buf);
    }
    loaded++;
    loaderFill.style.width = `${(loaded / FILES.length) * 100}%`;
    loaderDetail.textContent = `${loaded} / ${FILES.length} buffers`;
  }
}

await loadAll();
document.getElementById('loader').style.display = 'none';
document.getElementById('info').style.display = 'block';
document.getElementById('pickInfo').style.display = 'block';

const meta = data.meta;
const N = meta.n_points;
document.getElementById('title').innerHTML =
  `Megafused Street View — <code>${N.toLocaleString()}</code> points (full fidelity)`;
document.getElementById('subtitle').textContent =
  `${meta.n_panos} panoramas · max distance ${meta.max_distance_m} m`;
document.getElementById('hint').textContent =
  `origin = focal panoid @ (${meta.reference_lat.toFixed(6)}, ${meta.reference_lng.toFixed(6)})`;

const colorsF = new Float32Array(N * 3);
for (let i = 0; i < N * 3; i++) colorsF[i] = data.rgb[i] / 255;

const CLS = { SKY: 0, GROUND: 1, FACADE: 2, ROOF: 3, OBL: 4 };

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0f14);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1500);
camera.up.set(0, 0, 1);
camera.position.set(60, -60, 60);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

const geom = new THREE.BufferGeometry();
geom.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
geom.setAttribute('color', new THREE.BufferAttribute(colorsF, 3));
const mat = new THREE.PointsMaterial({ size: 0.15, vertexColors: true, sizeAttenuation: true });
const cloud = new THREE.Points(geom, mat);
scene.add(cloud);

const panoGroup = new THREE.Group();
scene.add(panoGroup);
const panoMeshes = [];
const PP = data.pano_pos;
for (let i = 0; i < PP.length / 3; i++) {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0xff4444 })
  );
  m.position.set(PP[i*3], PP[i*3+1], PP[i*3+2]);
  m.userData = { panoIdx: i };
  panoGroup.add(m); panoMeshes.push(m);
}

scene.add(new THREE.AxesHelper(8));
const grid = new THREE.GridHelper(200, 100, 0x223355, 0x1a1a2a);
grid.rotateX(Math.PI / 2);
grid.position.z = -2.5;
scene.add(grid);

function applyColorMode(mode) {
  let src;
  if (mode === 'rgb') src = data.rgb;
  else if (mode === 'cls') src = data.cls_rgb;
  else if (mode === 'b2') src = data.b2_rgb;
  else src = data.plane_rgb;
  const showG = document.getElementById('t_ground').checked;
  const showF = document.getElementById('t_facade').checked;
  const showR = document.getElementById('t_roof').checked;
  const showO = document.getElementById('t_oblique').checked;
  const cls = data.cls;
  for (let i = 0; i < N; i++) {
    const c = cls[i];
    let visible;
    if (c === CLS.GROUND) visible = showG;
    else if (c === CLS.FACADE) visible = showF;
    else if (c === CLS.ROOF) visible = showR;
    else if (c === CLS.OBL) visible = showO;
    else visible = true;
    if (visible) {
      colorsF[i*3] = src[i*3] / 255;
      colorsF[i*3+1] = src[i*3+1] / 255;
      colorsF[i*3+2] = src[i*3+2] / 255;
    } else {
      colorsF[i*3] = 0.04; colorsF[i*3+1] = 0.05; colorsF[i*3+2] = 0.07;
    }
  }
  geom.attributes.color.needsUpdate = true;
}
document.querySelectorAll('input[name="cmode"]').forEach(r => r.addEventListener('change', e => {
  if (e.target.checked) applyColorMode(e.target.value);
}));
['t_ground', 't_facade', 't_roof', 't_oblique'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => {
    const mode = document.querySelector('input[name="cmode"]:checked').value;
    applyColorMode(mode);
  });
});
document.getElementById('t_panos').addEventListener('change', e => { panoGroup.visible = e.target.checked; });

const ptSize = document.getElementById('ptSize');
const ptSizeLabel = document.getElementById('ptSizeLabel');
ptSize.addEventListener('input', () => {
  mat.size = parseFloat(ptSize.value);
  ptSizeLabel.textContent = parseFloat(ptSize.value).toFixed(2);
});

document.getElementById('b_top').onclick = () => {
  camera.position.set(0, 0, 150); controls.target.set(0, 0, 0);
};
document.getElementById('b_iso').onclick = () => {
  camera.position.set(60, -60, 60); controls.target.set(0, 0, 0);
};
document.getElementById('b_eye').onclick = () => {
  camera.position.set(0, 0, 0.1); controls.target.set(-15, -15, 0);
};

const raycaster = new THREE.Raycaster();
raycaster.params.Points.threshold = 0.4;
const mouse = new THREE.Vector2();
const pickEl = document.getElementById('pickText');
const PANO_HANDLES = meta.panos;
addEventListener('mousemove', ev => {
  const r = renderer.domElement.getBoundingClientRect();
  mouse.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
  mouse.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
});
function poiSummary(ph) {
  if (!ph || !ph.poi_bindings || !ph.poi_bindings.length) return '';
  const items = ph.poi_bindings.slice(0, 6).map(po =>
    `<li><b>${po.name}</b>${po.type ? ' <span class="hint">(' + po.type + ')</span>' : ''}</li>`).join('');
  const more = ph.poi_bindings.length > 6 ? `<li class="hint">… +${ph.poi_bindings.length - 6} more</li>` : '';
  return `<br><b>POIs visible from this pano:</b><ul style="margin:4px 0 0 18px;padding:0;">${items}${more}</ul>`;
}

function pickTick() {
  raycaster.setFromCamera(mouse, camera);
  const sphereHits = raycaster.intersectObjects(panoMeshes);
  if (sphereHits.length) {
    const p = sphereHits[0].object.userData.panoIdx;
    const ph = PANO_HANDLES[p];
    pickEl.innerHTML = `<b>Panorama origin</b><br>panoid: ${ph.panoid.slice(0,16)}…<br>lat,lng: ${ph.lat.toFixed(6)}, ${ph.lng.toFixed(6)}<br>local pos (E,N): ${ph.world_pos[0].toFixed(1)}, ${ph.world_pos[1].toFixed(1)}<br>${ph.n_planes} planes · ${ph.n_points.toLocaleString()} pts · cap=${(ph.effective_max_distance_m||0).toFixed(1)}m · b2-IDs=${ph.b2_unique_ids||0}${poiSummary(ph)}`;
    return;
  }
  const ptHits = raycaster.intersectObject(cloud);
  if (ptHits.length === 0) {
    pickEl.textContent = 'no point under cursor';
    return;
  }
  const i = ptHits[0].index;
  const p = ptHits[0].point;
  const pid = data.pano[i];
  const ph = PANO_HANDLES[pid];
  const cl = ['sky','ground','facade','roof','oblique'][data.cls[i]];
  const b2id = data.b2[i];
  pickEl.innerHTML = `
    panoid <code>${ph ? ph.panoid.slice(0,12) : '?'}…</code> · plane #${data.plane[i]} <b>(${cl})</b><br>
    b2 annotation ID: ${b2id || '<span class="hint">(none)</span>'}<br>
    rgb = (${data.rgb[i*3]}, ${data.rgb[i*3+1]}, ${data.rgb[i*3+2]})<br>
    point world (E,N,U) = (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})<br>
    ${poiSummary(ph)}
  `;
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  pickTick();
  renderer.render(scene, camera);
}
animate();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
</script>
</body>
</html>
"""


if __name__ == '__main__':
    main()
