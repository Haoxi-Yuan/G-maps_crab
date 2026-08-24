#!/usr/bin/env python3
"""Combined 3D viewer: multiple panorama point clouds in a shared world frame
+ all 74 neighbor panoid markers (the street view "road graph") + connecting
edges showing drivable transitions.

Reads:
  <run_dir>/photometa_<i>_parsed.json    (raw parsed photometa)
  <run_dir>/photometa_<i>_parsed_planes.json
  <run_dir>/photometa_<i>_parsed_indexmap.bin

Coordinate system (world):
  origin     = panoid 0's camera position
  x          = east
  y          = north
  z          = up (camera height ≈ 2.5m above ground)

Usage:
  python3 build_combined_viewer.py <run_dir> [--max-distance 80]
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


def color_for(plane_idx, plane, classes):
    cls = classes[plane_idx]
    n = np.array([plane['nx'], plane['ny'], plane['nz']], dtype=np.float64)
    norm = float(np.linalg.norm(n))
    if norm > 1e-6:
        n = n / norm
    if cls == 'sky':
        return (0.05, 0.05, 0.10)
    if cls == 'ground':
        l = 0.30 + 0.40 * (plane_idx % 10) / 10.0
        return colorsys.hls_to_rgb(0.33, l, 0.55)
    if cls == 'facade':
        ang = float(np.arctan2(n[1], n[0]))
        h = (ang + np.pi) / (2 * np.pi)
        return colorsys.hls_to_rgb(h, 0.55, 0.85)
    if cls == 'roof':
        return (0.55, 0.40, 0.25)
    return (0.85, 0.20, 0.80)


def geodetic_to_ecef(lat_deg, lng_deg, h_m=0.0):
    """WGS84 geodetic coordinates to ECEF metres."""
    a = 6378137.0
    f = 1.0 / 298.257223563
    e2 = f * (2.0 - f)
    lat = math.radians(float(lat_deg))
    lng = math.radians(float(lng_deg))
    sin_lat = math.sin(lat)
    cos_lat = math.cos(lat)
    n = a / math.sqrt(1.0 - e2 * sin_lat * sin_lat)
    x = (n + h_m) * cos_lat * math.cos(lng)
    y = (n + h_m) * cos_lat * math.sin(lng)
    z = (n * (1.0 - e2) + h_m) * sin_lat
    return np.array([x, y, z], dtype=np.float64)


def latlng_to_local_meters(ref_lat, ref_lng, lat, lng):
    """Return local ENU metres from WGS84 lat/lng, anchored at ref."""
    ref = geodetic_to_ecef(ref_lat, ref_lng)
    pt = geodetic_to_ecef(lat, lng)
    d = pt - ref
    lat0 = math.radians(float(ref_lat))
    lng0 = math.radians(float(ref_lng))
    sin_lat = math.sin(lat0)
    cos_lat = math.cos(lat0)
    sin_lng = math.sin(lng0)
    cos_lng = math.cos(lng0)
    east = -sin_lng * d[0] + cos_lng * d[1]
    north = -sin_lat * cos_lng * d[0] - sin_lat * sin_lng * d[1] + cos_lat * d[2]
    return float(east), float(north)


def get_pano_root(parsed):
    """Walk to the [1][0] node where pano metadata lives."""
    if not isinstance(parsed, list) or len(parsed) < 2:
        return None
    if not isinstance(parsed[1], list) or len(parsed[1]) < 1:
        return None
    return parsed[1][0]


def get_pano_latlng(parsed):
    root = get_pano_root(parsed)
    if not root or len(root) < 6:
        return None
    try:
        loc = root[5][0][1][0]  # [null, null, lat, lng]
        return float(loc[2]), float(loc[3])
    except (IndexError, TypeError, KeyError):
        return None


def get_pano_altitude(parsed):
    root = get_pano_root(parsed)
    try:
        alt = root[5][0][1][1]  # [alt1, ..., alt2] — second slot tends to be elevation
        return float(alt[0]) if alt and alt[0] is not None else 0.0
    except (IndexError, TypeError, KeyError):
        return 0.0


def wrap_signed_deg(x):
    x = float(x) % 360.0
    return x - 360.0 if x > 180.0 else x


def rot_x(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]], dtype=np.float64)


def rot_y(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], dtype=np.float64)


def rot_z(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]], dtype=np.float64)


def get_pano_pose(parsed):
    root = get_pano_root(parsed)
    try:
        pose = root[5][0][1][2]
        return {
            'heading_deg': float(pose[0]),
            'pitch_deg': float(pose[1]),
            'roll_deg': wrap_signed_deg(pose[2]),
        }
    except (IndexError, TypeError, KeyError, ValueError):
        return {'heading_deg': 0.0, 'pitch_deg': 90.0, 'roll_deg': 0.0}


def build_rotation(heading_deg, pitch_deg, roll_deg):
    h = math.radians(float(heading_deg))
    pitch_off = math.radians(float(pitch_deg) - 90.0)
    roll = math.radians(wrap_signed_deg(roll_deg))
    return rot_z(-h) @ rot_x(pitch_off) @ rot_y(roll)


def get_neighbors(parsed):
    """Return list of {panoid, lat, lng, alt} for the entries in [5][0][3][0]."""
    root = get_pano_root(parsed)
    out = []
    try:
        entries = root[5][0][3][0]
    except (IndexError, TypeError, KeyError):
        return out
    for e in entries:
        try:
            pid = e[0][1]
            loc = e[2][0]
            lat, lng = float(loc[2]), float(loc[3])
            altblock = e[2][1]
            alt = float(altblock[0]) if altblock and altblock[0] is not None else 0.0
            out.append({'panoid': pid, 'lat': lat, 'lng': lng, 'alt': alt})
        except (IndexError, TypeError, KeyError, ValueError):
            continue
    return out


def build_pano_pointcloud(run, idx, ref_lat, ref_lng, ref_alt, max_dist):
    """Build a pose-rotated ENU point cloud for panorama idx."""
    parsed_fp = os.path.join(run, f'photometa_{idx}_parsed.json')
    panes_fp = os.path.join(run, f'photometa_{idx}_parsed_planes.json')
    idx_fp = os.path.join(run, f'photometa_{idx}_parsed_indexmap.bin')
    if not all(os.path.exists(p) for p in (parsed_fp, panes_fp, idx_fp)):
        return None

    parsed = json.load(open(parsed_fp))
    meta = json.load(open(panes_fp))
    planes = meta['planes']
    n_planes = meta['numPlanes']
    panoid = meta['panoid']

    latlng = get_pano_latlng(parsed)
    if not latlng:
        return None
    lat, lng = latlng
    alt = get_pano_altitude(parsed)
    pose = get_pano_pose(parsed)
    rotation = build_rotation(pose['heading_deg'], pose['pitch_deg'], pose['roll_deg'])
    east, north = latlng_to_local_meters(ref_lat, ref_lng, lat, lng)
    # If alt is missing (0.0), assume same altitude as reference (most likely correct
    # for a flat road area; better than reporting -17m below ground).
    z_offset = (alt - ref_alt) if alt > 0 else 0.0

    if n_planes <= 2:
        # Low-detail: skip 3D point cloud, return marker only
        return {
            'panoid': panoid,
            'is_low_detail': True,
            'world_pos': [east, north, z_offset],
            'lat': lat, 'lng': lng,
            'pose': pose,
            'n_planes': n_planes,
            'positions': None,
            'colors': None,
            'classes': None,
            'plane_idx': None,
        }

    W_eq, H_eq = 512, 256
    idx_map = np.frombuffer(open(idx_fp, 'rb').read(), dtype=np.uint8).reshape(H_eq, W_eq)
    classes = [classify(p)[0] for p in planes]
    cls_idx = np.array([CLASS_INDEX[c] for c in classes], dtype=np.uint8)
    color_table = np.array([color_for(i, planes[i], classes) for i in range(n_planes)])

    us = np.arange(W_eq); vs = np.arange(H_eq)
    UU, VV = np.meshgrid(us, vs)
    theta = (UU + 0.5) / W_eq * 2 * np.pi - np.pi
    phi = np.pi / 2 - (VV + 0.5) / H_eq * np.pi
    dx = np.sin(theta) * np.cos(phi)
    dy = np.cos(theta) * np.cos(phi)
    dz = np.sin(phi)

    nx_arr = np.array([p['nx'] for p in planes])
    ny_arr = np.array([p['ny'] for p in planes])
    nz_arr = np.array([p['nz'] for p in planes])
    d_arr = np.array([p['d'] for p in planes])

    flat_idx = idx_map.flatten()
    dx_f = dx.flatten(); dy_f = dy.flatten(); dz_f = dz.flatten()
    n_dot = nx_arr[flat_idx] * dx_f + ny_arr[flat_idx] * dy_f + nz_arr[flat_idx] * dz_f
    pd = d_arr[flat_idx]
    with np.errstate(divide='ignore', invalid='ignore'):
        t = pd / n_dot
    valid = (flat_idx != 0) & np.isfinite(t) & (t > 0) & (t < max_dist)
    valid_2d = valid.reshape(H_eq, W_eq)

    # Vertex extraction: ray-plane hits are pano-local; rotate them into ENU
    # world before translating by the pano camera centre.
    local_xyz = np.stack([(t * dx_f)[valid], (t * dy_f)[valid], (t * dz_f)[valid]], axis=1)
    world_xyz = local_xyz @ rotation.T
    world_xyz += np.array([east, north, z_offset], dtype=np.float64)
    px = world_xyz[:, 0].astype(np.float32)
    py = world_xyz[:, 1].astype(np.float32)
    pz = world_xyz[:, 2].astype(np.float32)
    cols = (np.clip(color_table[flat_idx[valid]], 0, 1) * 255).astype(np.uint8)
    cls_per_pt = cls_idx[flat_idx[valid]].astype(np.uint8)
    pi_per_pt = flat_idx[valid].astype(np.uint16)
    n_valid = px.size

    # Vertex ID map (for triangle indexing): -1 for invalid pano-pixels
    vid_2d = np.full((H_eq, W_eq), -1, dtype=np.int64)
    vid_2d[valid_2d] = np.arange(n_valid, dtype=np.int64)

    # Build triangles: 4 adjacent pano-pixels of the SAME plane → 2 triangles
    # Cells: rows 0..H-2, cols 0..W-2 (interior); also wrap-around at u=W-1
    v00 = vid_2d[:-1, :-1]; v10 = vid_2d[:-1, 1:]
    v01 = vid_2d[1:, :-1];  v11 = vid_2d[1:, 1:]
    p00 = idx_map[:-1, :-1]; p10 = idx_map[:-1, 1:]
    p01 = idx_map[1:, :-1];  p11 = idx_map[1:, 1:]
    cell_ok = (v00 >= 0) & (v10 >= 0) & (v01 >= 0) & (v11 >= 0) & \
              (p00 == p10) & (p10 == p01) & (p01 == p11)
    tri_a = np.stack([v00[cell_ok], v10[cell_ok], v11[cell_ok]], axis=1)
    tri_b = np.stack([v00[cell_ok], v11[cell_ok], v01[cell_ok]], axis=1)

    # Wrap-around column (connect u=W-1 to u=0)
    v00w = vid_2d[:-1, -1]; v10w = vid_2d[:-1, 0]
    v01w = vid_2d[1:, -1];  v11w = vid_2d[1:, 0]
    p00w = idx_map[:-1, -1]; p10w = idx_map[:-1, 0]
    p01w = idx_map[1:, -1];  p11w = idx_map[1:, 0]
    wrap_ok = (v00w >= 0) & (v10w >= 0) & (v01w >= 0) & (v11w >= 0) & \
              (p00w == p10w) & (p10w == p01w) & (p01w == p11w)
    tri_aw = np.stack([v00w[wrap_ok], v10w[wrap_ok], v11w[wrap_ok]], axis=1)
    tri_bw = np.stack([v00w[wrap_ok], v11w[wrap_ok], v01w[wrap_ok]], axis=1)

    indices = np.concatenate([
        tri_a.flatten(), tri_b.flatten(),
        tri_aw.flatten(), tri_bw.flatten(),
    ]).astype(np.uint32)
    n_tris = indices.size // 3

    return {
        'panoid': panoid,
        'is_low_detail': False,
        'world_pos': [east, north, z_offset],
        'lat': lat, 'lng': lng,
        'pose': pose,
        'n_planes': n_planes,
        'n_points': n_valid,
        'n_tris': n_tris,
        'positions': np.column_stack([px, py, pz]).astype(np.float32),
        'colors': cols,
        'classes': cls_per_pt,
        'plane_idx': pi_per_pt,
        'indices': indices,
        'plane_meta': [
            {'i': i, 'cls': classes[i],
             'n': [round(p['nx'], 4), round(p['ny'], 4), round(p['nz'], 4)],
             'd': round(p['d'], 3)}
            for i, p in enumerate(planes)
        ],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('run_dir')
    ap.add_argument('--max-distance', type=float, default=80.0)
    ap.add_argument('--ref-idx', type=int, default=0,
                    help='Use this photometa as reference (origin) for local meters')
    args = ap.parse_args()

    run = args.run_dir
    photometa_files = sorted([f for f in os.listdir(run)
                              if f.startswith('photometa_') and f.endswith('_parsed.json')])
    indexes = [int(f.split('_')[1]) for f in photometa_files]
    print(f'Found photometa indexes: {indexes}')

    # Reference panoid
    ref_parsed = json.load(open(os.path.join(run, f'photometa_{args.ref_idx}_parsed.json')))
    ref_latlng = get_pano_latlng(ref_parsed)
    ref_alt = get_pano_altitude(ref_parsed)
    if not ref_latlng:
        print('Cannot find reference lat/lng', file=sys.stderr); sys.exit(1)
    print(f'Reference (idx={args.ref_idx}): lat={ref_latlng[0]:.6f}, lng={ref_latlng[1]:.6f}, alt={ref_alt:.2f}m')

    panos = []
    for i in indexes:
        pc = build_pano_pointcloud(run, i, ref_latlng[0], ref_latlng[1], ref_alt, args.max_distance)
        if pc is not None:
            panos.append(pc)
            tag = 'high-detail' if not pc['is_low_detail'] else 'low-detail'
            print(f'  idx {i} ({pc["panoid"][:12]}…): {tag}, world=({pc["world_pos"][0]:.1f}, {pc["world_pos"][1]:.1f}, {pc["world_pos"][2]:.1f})'
                  + (f', {pc["n_points"]} pts' if not pc['is_low_detail'] else ''))

    # Neighbor links — read from ref pano's [3][0]
    neighbors = get_neighbors(ref_parsed)
    print(f'Reference has {len(neighbors)} listed neighbors.')
    for nb in neighbors:
        e, n = latlng_to_local_meters(ref_latlng[0], ref_latlng[1], nb['lat'], nb['lng'])
        z = (nb['alt'] - ref_alt) if nb['alt'] > 0 else 0.0
        nb['world_pos'] = [e, n, z]

    # Concatenate all high-detail panos (positions, colors, indices…)
    parts_pos, parts_col, parts_cls, parts_pi, parts_pano = [], [], [], [], []
    parts_idx = []
    pano_handles = []
    vert_offset = 0
    for pi, pc in enumerate(panos):
        if pc['is_low_detail']:
            continue
        parts_pos.append(pc['positions'])
        parts_col.append(pc['colors'])
        parts_cls.append(pc['classes'])
        parts_pi.append(pc['plane_idx'])
        parts_pano.append(np.full(pc['positions'].shape[0], pi, dtype=np.uint8))
        parts_idx.append(pc['indices'] + vert_offset)
        vert_offset += pc['positions'].shape[0]
        pano_handles.append({
            'pano_local_idx': pi,
            'panoid': pc['panoid'],
            'world_pos': pc['world_pos'],
            'plane_meta': pc['plane_meta'],
            'n_points': pc['n_points'],
            'n_tris': pc['n_tris'],
        })

    if not parts_pos:
        print('No high-detail panoramas; nothing to render.', file=sys.stderr); sys.exit(1)

    all_pos = np.concatenate(parts_pos, axis=0)
    all_col = np.concatenate(parts_col, axis=0)
    all_cls = np.concatenate(parts_cls, axis=0)
    all_pi = np.concatenate(parts_pi, axis=0)
    all_pano = np.concatenate(parts_pano, axis=0)
    all_idx = np.concatenate(parts_idx, axis=0).astype(np.uint32)

    print(f'Combined: {all_pos.shape[0]} vertices, {all_idx.size // 3} triangles')

    pos_b64 = base64.b64encode(all_pos.tobytes()).decode()
    col_b64 = base64.b64encode(all_col.tobytes()).decode()
    cls_b64 = base64.b64encode(all_cls.tobytes()).decode()
    pi_b64 = base64.b64encode(all_pi.tobytes()).decode()
    pano_b64 = base64.b64encode(all_pano.tobytes()).decode()
    idx_b64 = base64.b64encode(all_idx.tobytes()).decode()

    # Marker / link data
    pano_handles_json = json.dumps(pano_handles)
    neighbors_json = json.dumps(neighbors)

    out_fp = os.path.join(run, '3d_viewer_combined.html')
    html = HTML_TEMPLATE.format(
        n_panos=len(pano_handles),
        n_neighbors=len(neighbors),
        n_points=all_pos.shape[0],
        n_tris=all_idx.size // 3,
        max_dist=args.max_distance,
        ref_lat=ref_latlng[0], ref_lng=ref_latlng[1],
        pos_b64=pos_b64, col_b64=col_b64, cls_b64=cls_b64,
        pi_b64=pi_b64, pano_b64=pano_b64, idx_b64=idx_b64,
        pano_handles_json=pano_handles_json,
        neighbors_json=neighbors_json,
    )
    with open(out_fp, 'w') as f:
        f.write(html)
    size_mb = os.path.getsize(out_fp) / 1e6
    print(f'Wrote {out_fp} ({size_mb:.1f} MB)')


HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Street View Combined 3D — Ghim Moh</title>
<style>
  body {{ margin: 0; overflow: hidden; background: #0d0f14; color: #e8e8ee;
          font: 13px/1.4 ui-sans-serif, system-ui, sans-serif; }}
  .panel {{ position: absolute; padding: 10px 12px; background: rgba(15,18,24,0.88);
           border: 1px solid #333; border-radius: 8px; }}
  #info {{ top: 10px; left: 10px; max-width: 360px; }}
  #info h2 {{ margin: 0 0 8px 0; font-size: 14px; color: #fff; }}
  #info code {{ font-size: 11px; color: #9cf; }}
  #pickInfo {{ top: 10px; right: 10px; min-width: 260px; font-size: 12px; }}
  #pickInfo b {{ color: #fff; }}
  .swatch {{ display: inline-block; width: 12px; height: 12px; border-radius: 3px; border: 1px solid #555; }}
  .toggles {{ margin-top: 8px; display: grid; grid-template-columns: auto auto; gap: 4px 12px; }}
  .toggles label {{ display: flex; align-items: center; gap: 6px; }}
  button {{ background: #1f2933; color: #ddd; border: 1px solid #444; padding: 4px 8px;
           border-radius: 4px; cursor: pointer; font-size: 11px; margin-right: 4px; }}
  button:hover {{ background: #2c3947; }}
  .hint {{ color: #888; font-size: 11px; }}
</style>
</head>
<body>

<div id="info" class="panel">
<h2>Combined Street View Geometry</h2>
<div>{n_tris} triangles · {n_points} vertices · {n_panos} high-detail panos · {n_neighbors} neighbor links</div>
<div class="hint">origin (red dot) = panoid 0 @ ({ref_lat}, {ref_lng}) · max distance {max_dist} m</div>
<div style="margin-top: 8px;">
  <b>Render mode:</b>
  <label><input type="radio" name="mode" value="mesh" checked> Mesh (faces)</label>
  <label><input type="radio" name="mode" value="wire"> Wireframe</label>
  <label><input type="radio" name="mode" value="points"> Points</label>
</div>
<div class="toggles">
  <label><input type="checkbox" id="t_ground" checked><span class="swatch" style="background:#4faa66"></span> ground</label>
  <label><input type="checkbox" id="t_facade" checked><span class="swatch" style="background:#bb88dd"></span> facade</label>
  <label><input type="checkbox" id="t_roof" checked><span class="swatch" style="background:#8c6640"></span> roof</label>
  <label><input type="checkbox" id="t_oblique" checked><span class="swatch" style="background:#d433cc"></span> oblique</label>
  <label><input type="checkbox" id="t_neighbors" checked><span class="swatch" style="background:#ffaa33"></span> neighbor markers</label>
  <label><input type="checkbox" id="t_links" checked><span class="swatch" style="background:#3344ee"></span> drivable links</label>
</div>
<div style="margin-top: 8px;">
  <button id="b_top">Top-down</button>
  <button id="b_iso">Isometric</button>
  <button id="b_eye">First-person at origin</button>
</div>
<div class="hint" style="margin-top: 6px;">drag = rotate · wheel = zoom · right-drag = pan</div>
</div>

<div id="pickInfo" class="panel">
  <b>Inspector</b><br>
  <span id="pickText" class="hint">hover over the cloud or a marker…</span>
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

const POS_B64 = "{pos_b64}";
const COL_B64 = "{col_b64}";
const CLS_B64 = "{cls_b64}";
const PI_B64  = "{pi_b64}";
const PANO_B64 = "{pano_b64}";
const IDX_B64 = "{idx_b64}";
const PANO_HANDLES = {pano_handles_json};
const NEIGHBORS = {neighbors_json};

function b64(s) {{
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}}

const positions = new Float32Array(b64(POS_B64).buffer);
const colorsU8 = b64(COL_B64);
const classes = b64(CLS_B64);
const planeIdxArr = new Uint16Array(b64(PI_B64).buffer);
const panoArr = b64(PANO_B64);
const indices = new Uint32Array(b64(IDX_B64).buffer);
const N = positions.length / 3;

const colorsF = new Float32Array(N * 3);
for (let i = 0; i < N * 3; i++) colorsF[i] = colorsU8[i] / 255.0;

const CLS = {{ SKY: 0, GROUND: 1, FACADE: 2, ROOF: 3, OBL: 4 }};

// ===== Scene =====
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0f14);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 1000);
camera.up.set(0, 0, 1);
camera.position.set(30, -30, 30);

const renderer = new THREE.WebGLRenderer({{ antialias: true }});
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

// ===== Geometry: shared position+color buffer; mesh has indices, points doesn't =====
const posAttr = new THREE.BufferAttribute(positions, 3);
const colAttr = new THREE.BufferAttribute(colorsF, 3);

// Mesh (faces)
const meshGeom = new THREE.BufferGeometry();
meshGeom.setAttribute('position', posAttr);
meshGeom.setAttribute('color', colAttr);
meshGeom.setIndex(new THREE.BufferAttribute(indices, 1));
const meshMat = new THREE.MeshBasicMaterial({{
  vertexColors: true, side: THREE.DoubleSide, transparent: false,
}});
const meshObj = new THREE.Mesh(meshGeom, meshMat);
scene.add(meshObj);

// Wireframe overlay (separate object, toggled together with mesh)
const wireMat = new THREE.MeshBasicMaterial({{
  color: 0x000000, wireframe: true, transparent: true, opacity: 0.25, side: THREE.DoubleSide,
}});
const wireObj = new THREE.Mesh(meshGeom, wireMat);
wireObj.visible = false;
scene.add(wireObj);

// Points (separate geometry without indices, sharing the same buffer attrs)
const pointsGeom = new THREE.BufferGeometry();
pointsGeom.setAttribute('position', posAttr);
pointsGeom.setAttribute('color', colAttr);
const pointsMat = new THREE.PointsMaterial({{
  size: 0.18, vertexColors: true, sizeAttenuation: true,
}});
const pointsObj = new THREE.Points(pointsGeom, pointsMat);
pointsObj.visible = false;
scene.add(pointsObj);

// ===== Render mode toggle =====
function setMode(mode) {{
  if (mode === 'mesh') {{
    meshObj.visible = true; wireObj.visible = false; pointsObj.visible = false;
  }} else if (mode === 'wire') {{
    meshObj.visible = true; wireObj.visible = true; pointsObj.visible = false;
  }} else {{ // points
    meshObj.visible = false; wireObj.visible = false; pointsObj.visible = true;
  }}
}}
document.querySelectorAll('input[name="mode"]').forEach(r => {{
  r.addEventListener('change', e => {{ if (e.target.checked) setMode(e.target.value); }});
}});

// ===== Pano origins =====
const panoMarkerGroup = new THREE.Group();
scene.add(panoMarkerGroup);
const panoMeshes = [];
for (const pano of PANO_HANDLES) {{
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.4, 16, 16),
    new THREE.MeshBasicMaterial({{ color: 0xff4444 }})
  );
  sphere.position.set(pano.world_pos[0], pano.world_pos[1], pano.world_pos[2]);
  sphere.userData = {{ kind: 'pano_origin', pano }};
  panoMarkerGroup.add(sphere);
  panoMeshes.push(sphere);
}}

// ===== Neighbor markers + drivable links =====
const neighborGroup = new THREE.Group();
const linkGroup = new THREE.Group();
scene.add(neighborGroup);
scene.add(linkGroup);
const neighborMeshes = [];
for (const nb of NEIGHBORS) {{
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.25, 12, 12),
    new THREE.MeshBasicMaterial({{ color: 0xffaa33 }})
  );
  mesh.position.set(nb.world_pos[0], nb.world_pos[1], nb.world_pos[2]);
  mesh.userData = {{ kind: 'neighbor', nb }};
  neighborGroup.add(mesh);
  neighborMeshes.push(mesh);
  // Link from origin
  const linkGeom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(nb.world_pos[0], nb.world_pos[1], nb.world_pos[2]),
  ]);
  linkGroup.add(new THREE.Line(linkGeom, new THREE.LineBasicMaterial({{ color: 0x3344ee, transparent: true, opacity: 0.4 }})));
}}

// ===== Axes + ground grid =====
scene.add(new THREE.AxesHelper(5));
const gridHelper = new THREE.GridHelper(100, 50, 0x222244, 0x1a1a2a);
gridHelper.rotateX(Math.PI / 2); // grid in xy plane
gridHelper.position.z = -2.5; // approx ground level
scene.add(gridHelper);

// ===== Toggle visibility =====
function rebuildVisibility() {{
  const showG = document.getElementById('t_ground').checked;
  const showF = document.getElementById('t_facade').checked;
  const showR = document.getElementById('t_roof').checked;
  const showO = document.getElementById('t_oblique').checked;
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
  colAttr.needsUpdate = true;
}}
['t_ground', 't_facade', 't_roof', 't_oblique'].forEach(id => {{
  document.getElementById(id).addEventListener('change', rebuildVisibility);
}});
document.getElementById('t_neighbors').addEventListener('change', e => {{
  neighborGroup.visible = e.target.checked;
}});
document.getElementById('t_links').addEventListener('change', e => {{
  linkGroup.visible = e.target.checked;
}});

document.getElementById('b_top').onclick = () => {{
  camera.position.set(0, 0, 80);
  controls.target.set(0, 0, 0);
}};
document.getElementById('b_iso').onclick = () => {{
  camera.position.set(30, -30, 30);
  controls.target.set(0, 0, 0);
}};
document.getElementById('b_eye').onclick = () => {{
  camera.position.set(0, 0, 0.1);
  controls.target.set(-10, -10, 0);
}};

// ===== Picking =====
const raycaster = new THREE.Raycaster();
raycaster.params.Points.threshold = 0.4;
const mouse = new THREE.Vector2();
const pickEl = document.getElementById('pickText');

addEventListener('mousemove', ev => {{
  const r = renderer.domElement.getBoundingClientRect();
  mouse.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
  mouse.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
}});

function pickTick() {{
  raycaster.setFromCamera(mouse, camera);
  // Try sphere markers first (larger, easier hits)
  const sphereHits = raycaster.intersectObjects([...neighborMeshes, ...panoMeshes]);
  if (sphereHits.length) {{
    const hit = sphereHits[0].object.userData;
    if (hit.kind === 'neighbor') {{
      const nb = hit.nb;
      pickEl.innerHTML = `<b>Neighbor pano</b><br>panoid: ${{nb.panoid.slice(0,16)}}…<br>lat,lng: ${{nb.lat.toFixed(6)}}, ${{nb.lng.toFixed(6)}}<br>local (E,N,U): ${{nb.world_pos[0].toFixed(1)}}, ${{nb.world_pos[1].toFixed(1)}}, ${{nb.world_pos[2].toFixed(1)}} m`;
    }} else if (hit.kind === 'pano_origin') {{
      const pano = hit.pano;
      pickEl.innerHTML = `<b>Pano origin</b><br>panoid: ${{pano.panoid.slice(0,16)}}…<br>${{pano.n_points}} 3D points<br>local pos: ${{pano.world_pos[0].toFixed(1)}}, ${{pano.world_pos[1].toFixed(1)}}, ${{pano.world_pos[2].toFixed(1)}} m`;
    }}
    return;
  }}
  // Fall back to mesh face hit (or points if mesh hidden)
  let geomHits = [];
  if (meshObj.visible) {{
    geomHits = raycaster.intersectObject(meshObj);
  }} else if (pointsObj.visible) {{
    geomHits = raycaster.intersectObject(pointsObj);
  }}
  if (geomHits.length === 0) {{
    pickEl.textContent = 'no surface under cursor';
    return;
  }}
  const hit = geomHits[0];
  // For mesh hit: use first vertex of the face (face.a) — same plane, so any works
  let vertIdx;
  if (typeof hit.face !== 'undefined' && hit.face) {{
    vertIdx = hit.face.a;
  }} else {{
    vertIdx = hit.index;  // points
  }}
  const panoLocal = panoArr[vertIdx];
  const piWithinPano = planeIdxArr[vertIdx];
  const pano = PANO_HANDLES[panoLocal];
  const meta = pano.plane_meta[piWithinPano] || {{cls: '?', n: ['?','?','?'], d: '?'}};
  const p = hit.point;
  pickEl.innerHTML = `
    panoid <code>${{pano.panoid.slice(0,12)}}…</code> · plane #${{piWithinPano}} <b>(${{meta.cls}})</b><br>
    normal = (${{meta.n[0]}}, ${{meta.n[1]}}, ${{meta.n[2]}})<br>
    distance d = ${{meta.d}} m<br>
    point world (E,N,U) = (${{p.x.toFixed(2)}}, ${{p.y.toFixed(2)}}, ${{p.z.toFixed(2)}})<br>
  `;
}}

function animate() {{
  requestAnimationFrame(animate);
  controls.update();
  pickTick();
  renderer.render(scene, camera);
}}
animate();

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
