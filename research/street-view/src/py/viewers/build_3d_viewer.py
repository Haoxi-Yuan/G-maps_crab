#!/usr/bin/env python3
"""Build a single-file interactive Three.js viewer for the street-view geometry.

For each pano pixel, computes the 3D ray-plane intersection (using its plane
equation) to produce a 3D point. Outputs a self-contained HTML you can open
locally — orbit, zoom, toggle category visibility.

Usage:
  python3 build_3d_viewer.py <run_dir> [--photometa-idx 0] [--max-distance 80]
"""
import argparse
import base64
import colorsys
import json
import math
import os
import sys

import numpy as np


def classify(p):
    n = np.array([p['nx'], p['ny'], p['nz']])
    norm = float(np.linalg.norm(n))
    if norm < 1e-6:
        return 'sky', n
    n = n / norm
    if abs(n[2]) > 0.85:
        return ('ground', n) if n[2] < 0 else ('roof', n)
    if abs(n[2]) < 0.2:
        return 'facade', n
    return 'oblique', n


CLASS_INDEX = {'sky': 0, 'ground': 1, 'facade': 2, 'roof': 3, 'oblique': 4}


def build_color_table(planes):
    out = []
    for i, p in enumerate(planes):
        cls, n = classify(p)
        if cls == 'sky':
            out.append((0.05, 0.05, 0.10))
        elif cls == 'ground':
            l = 0.30 + 0.40 * (i % 10) / 10.0
            out.append(colorsys.hls_to_rgb(0.33, l, 0.55))
        elif cls == 'facade':
            ang = float(np.arctan2(n[1], n[0]))
            h = (ang + np.pi) / (2 * np.pi)
            out.append(colorsys.hls_to_rgb(h, 0.55, 0.85))
        elif cls == 'roof':
            out.append((0.55, 0.40, 0.25))
        else:
            out.append((0.85, 0.20, 0.80))
    return np.array(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('run_dir')
    ap.add_argument('--photometa-idx', type=int, default=0)
    ap.add_argument('--max-distance', type=float, default=80.0,
                    help='Drop points farther than this many metres')
    ap.add_argument('--heading', type=float, default=231.39)
    args = ap.parse_args()

    run = args.run_dir
    i = args.photometa_idx
    panes_fp = os.path.join(run, f'photometa_{i}_parsed_planes.json')
    idx_fp = os.path.join(run, f'photometa_{i}_parsed_indexmap.bin')
    if not all(os.path.exists(p) for p in (panes_fp, idx_fp)):
        print('Missing input file(s).', file=sys.stderr)
        sys.exit(1)

    with open(panes_fp) as f:
        meta = json.load(f)
    planes = meta['planes']
    n_planes = meta['numPlanes']
    panoid = meta.get('panoid', '?')
    W_eq, H_eq = 512, 256

    idx_map = np.frombuffer(open(idx_fp, 'rb').read(), dtype=np.uint8).reshape(H_eq, W_eq)
    colors = build_color_table(planes)
    classes_only = [classify(p)[0] for p in planes]
    class_idx = np.array([CLASS_INDEX[c] for c in classes_only], dtype=np.uint8)

    # Build per-pano-pixel rays
    us = np.arange(W_eq)
    vs = np.arange(H_eq)
    UU, VV = np.meshgrid(us, vs)
    theta = (UU + 0.5) / W_eq * 2 * np.pi - np.pi  # range (-π, π]
    phi = np.pi / 2 - (VV + 0.5) / H_eq * np.pi    # range (+π/2 .. -π/2)

    # World convention: x=east, y=north, z=up.
    # equirect (theta=heading CW from +y, phi=elevation) → ray
    dx = np.sin(theta) * np.cos(phi)
    dy = np.cos(theta) * np.cos(phi)
    dz = np.sin(phi)

    # Plane arrays
    nx_arr = np.array([p['nx'] for p in planes])
    ny_arr = np.array([p['ny'] for p in planes])
    nz_arr = np.array([p['nz'] for p in planes])
    d_arr = np.array([p['d'] for p in planes])

    idxs = idx_map.flatten()
    dx_f = dx.flatten()
    dy_f = dy.flatten()
    dz_f = dz.flatten()

    # ray-plane intersection: t = d / (n . dir)
    n_dot_dir = nx_arr[idxs] * dx_f + ny_arr[idxs] * dy_f + nz_arr[idxs] * dz_f
    plane_d = d_arr[idxs]

    with np.errstate(divide='ignore', invalid='ignore'):
        t = plane_d / n_dot_dir

    valid = (idxs != 0) & np.isfinite(t) & (t > 0) & (t < args.max_distance)
    valid_n = int(valid.sum())
    print(f'Valid 3D points: {valid_n} / {idxs.size}')

    px = (t * dx_f)[valid].astype(np.float32)
    py = (t * dy_f)[valid].astype(np.float32)
    pz = (t * dz_f)[valid].astype(np.float32)

    # Per-point colors
    col_rgb = colors[idxs[valid]]
    col_u8 = (np.clip(col_rgb, 0, 1) * 255).astype(np.uint8)

    # Per-point class index (for filtering in viewer)
    cls_per_point = class_idx[idxs[valid]]
    plane_idx_per_point = idxs[valid].astype(np.uint16)

    # Pack binary blob: positions (float32 × 3), colors (uint8 × 3), classes (uint8), plane_idx (uint16)
    positions = np.column_stack([px, py, pz]).astype(np.float32).tobytes()
    colors_bin = col_u8.tobytes()
    cls_bin = cls_per_point.astype(np.uint8).tobytes()
    plane_idx_bin = plane_idx_per_point.tobytes()

    pos_b64 = base64.b64encode(positions).decode()
    col_b64 = base64.b64encode(colors_bin).decode()
    cls_b64 = base64.b64encode(cls_bin).decode()
    pi_b64 = base64.b64encode(plane_idx_bin).decode()

    # Plane metadata for the click-to-inspect panel
    plane_meta = []
    for j, p in enumerate(planes):
        plane_meta.append({
            'i': j,
            'cls': classes_only[j],
            'n': [round(p['nx'], 4), round(p['ny'], 4), round(p['nz'], 4)],
            'd': round(p['d'], 3),
        })

    counts = {}
    for c in classes_only:
        counts[c] = counts.get(c, 0) + 1

    html = HTML_TEMPLATE.format(
        panoid=panoid,
        n_planes=n_planes,
        valid_n=valid_n,
        max_dist=args.max_distance,
        heading=args.heading,
        counts_str=' · '.join(f'{k}={v}' for k, v in sorted(counts.items(), key=lambda x: -x[1])),
        pos_b64=pos_b64,
        col_b64=col_b64,
        cls_b64=cls_b64,
        pi_b64=pi_b64,
        plane_meta_json=json.dumps(plane_meta),
    )
    out_fp = os.path.join(run, f'3d_viewer_{i}.html')
    with open(out_fp, 'w') as f:
        f.write(html)
    print(f'Wrote {out_fp}')
    print(f'Open with: open {out_fp}')


HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Street View 3D — {panoid}</title>
<style>
  body {{ margin: 0; overflow: hidden; background: #0d0f14; color: #e8e8ee; font: 13px/1.4 ui-sans-serif, system-ui, sans-serif; }}
  #info {{ position: absolute; top: 10px; left: 10px; padding: 12px 14px; background: rgba(15,18,24,0.85); border: 1px solid #333; border-radius: 8px; max-width: 360px; }}
  #info h2 {{ margin: 0 0 8px 0; font-size: 14px; color: #fff; }}
  #info code {{ font-size: 11px; color: #9cf; }}
  #controls {{ margin-top: 10px; display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; align-items: center; }}
  #controls label {{ display: contents; }}
  .toggle {{ display: flex; align-items: center; gap: 6px; }}
  .swatch {{ display: inline-block; width: 14px; height: 14px; border-radius: 3px; border: 1px solid #555; }}
  #pickInfo {{ position: absolute; top: 10px; right: 10px; padding: 10px 12px; background: rgba(15,18,24,0.85); border: 1px solid #333; border-radius: 8px; min-width: 240px; font-size: 12px; }}
  #pickInfo b {{ color: #fff; }}
  button {{ background: #1f2933; color: #ddd; border: 1px solid #444; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; }}
  button:hover {{ background: #2c3947; }}
  .hint {{ color: #888; font-size: 11px; }}
</style>
</head>
<body>
<div id="info">
<h2>Street View geometry — <code>{panoid}</code></h2>
<div>{valid_n} 3D points · {n_planes} planes ({counts_str})</div>
<div>max distance: {max_dist} m · camera heading: {heading}°</div>
<div id="controls">
  <label class="toggle"><input type="checkbox" id="t_ground" checked><span><span class="swatch" style="background:#4faa66"></span> ground</span></label>
  <label class="toggle"><input type="checkbox" id="t_facade" checked><span><span class="swatch" style="background:#bb88dd"></span> facade</span></label>
  <label class="toggle"><input type="checkbox" id="t_roof" checked><span><span class="swatch" style="background:#8c6640"></span> roof</span></label>
  <label class="toggle"><input type="checkbox" id="t_oblique" checked><span><span class="swatch" style="background:#d433cc"></span> oblique</span></label>
  <span></span>
  <span class="hint">drag = rotate · wheel = zoom · right-drag = pan</span>
</div>
<div style="margin-top: 8px;">
  <button id="b_top">Top-down view</button>
  <button id="b_iso">Isometric</button>
  <button id="b_cam">Street-View cam pose</button>
</div>
</div>
<div id="pickInfo">
  <b>Point inspector</b><br>
  <span id="pickText" class="hint">hover over the point cloud…</span>
</div>

<script type="importmap">
{{
  "imports": {{
    "three": "https://unpkg.com/three@0.160.0/build/three.module.js",
    "three/addons/": "https://unpkg.com/three@0.160.0/examples/jsm/"
  }}
}}
</script>

<script type="module">
import * as THREE from 'three';
import {{ OrbitControls }} from 'three/addons/controls/OrbitControls.js';

// ===== Decode embedded data =====
const POS_B64 = "{pos_b64}";
const COL_B64 = "{col_b64}";
const CLS_B64 = "{cls_b64}";
const PI_B64  = "{pi_b64}";
const PLANE_META = {plane_meta_json};
const HEADING_DEG = {heading};

function b64ToBytes(s) {{
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}}
const posBytes = b64ToBytes(POS_B64);
const positions = new Float32Array(posBytes.buffer);
const colorsU8 = b64ToBytes(COL_B64);
const classes = b64ToBytes(CLS_B64);
const piBytes = b64ToBytes(PI_B64);
const planeIdx = new Uint16Array(piBytes.buffer);

const N = positions.length / 3;
const colorsF = new Float32Array(N * 3);
for (let i = 0; i < colorsU8.length; i++) colorsF[i] = colorsU8[i] / 255.0;

// CLASS_INDEX: sky=0, ground=1, facade=2, roof=3, oblique=4
const CLS = {{ SKY: 0, GROUND: 1, FACADE: 2, ROOF: 3, OBL: 4 }};

// ===== Scene =====
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0f14);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 1000);
camera.up.set(0, 0, 1);  // z is up
camera.position.set(20, 20, 20);

const renderer = new THREE.WebGLRenderer({{ antialias: true }});
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

// ===== Point cloud =====
const geom = new THREE.BufferGeometry();
geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
geom.setAttribute('color', new THREE.BufferAttribute(colorsF, 3));
const mat = new THREE.PointsMaterial({{ size: 0.18, vertexColors: true, sizeAttenuation: true }});
const pointsObj = new THREE.Points(geom, mat);
scene.add(pointsObj);

// ===== Origin (camera position) =====
const origin = new THREE.Mesh(
  new THREE.SphereGeometry(0.25, 16, 16),
  new THREE.MeshBasicMaterial({{ color: 0xff3333 }})
);
scene.add(origin);

// ===== Heading line =====
const hRad = HEADING_DEG * Math.PI / 180;
const headingDir = new THREE.Vector3(Math.sin(hRad), Math.cos(hRad), 0);
const headingGeom = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(0, 0, 0),
  headingDir.clone().multiplyScalar(15),
]);
scene.add(new THREE.Line(headingGeom, new THREE.LineBasicMaterial({{ color: 0x33ddff, linewidth: 2 }})));

// ===== Axes helper (X=east red, Y=north green, Z=up blue) =====
const axes = new THREE.AxesHelper(6);
scene.add(axes);

// ===== Compass ring at z=0 =====
const ringGeom = new THREE.RingGeometry(8, 8.05, 64);
const ringMat = new THREE.MeshBasicMaterial({{ color: 0x444466, side: THREE.DoubleSide }});
const ring = new THREE.Mesh(ringGeom, ringMat);
scene.add(ring);

// ===== Visibility toggles =====
function rebuildVisibility() {{
  const showG = document.getElementById('t_ground').checked;
  const showF = document.getElementById('t_facade').checked;
  const showR = document.getElementById('t_roof').checked;
  const showO = document.getElementById('t_oblique').checked;

  // Use point alpha: set color alpha to 0 for filtered-out points
  // Easier: write a per-vertex visibility attribute and discard in shader
  // Quickest: rebuild geometry with subset. But N is large.
  // Use draw range trick: sort once, use ranges. For now: set color to background-ish
  for (let i = 0; i < N; i++) {{
    const c = classes[i];
    let visible;
    if (c === CLS.GROUND) visible = showG;
    else if (c === CLS.FACADE) visible = showF;
    else if (c === CLS.ROOF) visible = showR;
    else if (c === CLS.OBL) visible = showO;
    else visible = true;
    if (visible) {{
      colorsF[i*3] = colorsU8[i*3] / 255;
      colorsF[i*3+1] = colorsU8[i*3+1] / 255;
      colorsF[i*3+2] = colorsU8[i*3+2] / 255;
    }} else {{
      colorsF[i*3] = 0.05; colorsF[i*3+1] = 0.06; colorsF[i*3+2] = 0.08;
    }}
  }}
  geom.attributes.color.needsUpdate = true;
}}
['t_ground', 't_facade', 't_roof', 't_oblique'].forEach(id => {{
  document.getElementById(id).addEventListener('change', rebuildVisibility);
}});

// ===== Camera presets =====
document.getElementById('b_top').onclick = () => {{
  camera.position.set(0, 0, 50);
  controls.target.set(0, 0, 0);
}};
document.getElementById('b_iso').onclick = () => {{
  camera.position.set(20, 20, 20);
  controls.target.set(0, 0, 0);
}};
document.getElementById('b_cam').onclick = () => {{
  // Place camera at street-view origin looking heading 231°
  camera.position.set(0, 0, 0.1);
  const target = headingDir.clone().multiplyScalar(10);
  controls.target.copy(target);
}};

// ===== Picker (raycast) =====
const raycaster = new THREE.Raycaster();
raycaster.params.Points.threshold = 0.4;
const mouse = new THREE.Vector2();
const pickEl = document.getElementById('pickText');

function onMouseMove(ev) {{
  const r = renderer.domElement.getBoundingClientRect();
  mouse.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
  mouse.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
}}
addEventListener('mousemove', onMouseMove);

function pickTick() {{
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObject(pointsObj);
  if (hits.length === 0) {{
    pickEl.textContent = 'no point under cursor';
    return;
  }}
  const idx = hits[0].index;
  const pi = planeIdx[idx];
  const meta = PLANE_META[pi];
  const p = hits[0].point;
  const distFromCam = p.length();
  pickEl.innerHTML = `
    plane #${{pi}} <b>(${{meta.cls}})</b><br>
    normal = (${{meta.n[0]}}, ${{meta.n[1]}}, ${{meta.n[2]}})<br>
    distance d = ${{meta.d}} m<br>
    point xyz = (${{p.x.toFixed(2)}}, ${{p.y.toFixed(2)}}, ${{p.z.toFixed(2)}})<br>
    range from origin = ${{distFromCam.toFixed(2)}} m
  `;
}}

// ===== Animate =====
function animate() {{
  requestAnimationFrame(animate);
  controls.update();
  pickTick();
  renderer.render(scene, camera);
}}
animate();

// ===== Resize =====
addEventListener('resize', () => {{
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}});
</script>
</body>
</html>
"""


if __name__ == '__main__':
    main()
