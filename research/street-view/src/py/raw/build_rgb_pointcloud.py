#!/usr/bin/env python3
"""Fuse panorama imagery + plane geometry into a single colored 3D point cloud.

For every panorama with both a parsed photometa and a stitched image, compute
ray-plane intersection per pano cell in the pano-local frame, sample the
panorama image at the corresponding equirectangular UV to get its RGB, rotate
the 3D point into the gravity/world frame with the pano pose, and emit a single
combined point cloud in the ENU world frame anchored at panoid 0.

Outputs:
  merged_pointcloud.ply       binary little-endian PLY with x/y/z/r/g/b/plane_idx/pano_idx/cls
  merged_pointcloud.npz       numpy archive with same fields
  pointcloud_meta.json        per-pano metadata (panoid, world_pos, n_points, lat/lng)

Usage:
  python3 build_rgb_pointcloud.py <run_dir> [--max-distance 80] [--subsample 1]
"""
import argparse
import base64
import json
import math
import os
import struct
import sys
import time

import numpy as np
from PIL import Image

CLASS_INDEX = {'sky': 0, 'ground': 1, 'facade': 2, 'roof': 3, 'oblique': 4}


def classify(nx, ny, nz):
    norm = math.sqrt(nx * nx + ny * ny + nz * nz)
    if norm < 1e-6:
        return 'sky'
    nx, ny, nz = nx / norm, ny / norm, nz / norm
    if abs(nz) > 0.85:
        return 'ground' if nz < 0 else 'roof'
    if abs(nz) < 0.2:
        return 'facade'
    return 'oblique'


def safe_get(seq, *idx):
    cur = seq
    for i in idx:
        if cur is None or not isinstance(cur, (list, tuple)) or len(cur) <= i:
            return None
        cur = cur[i]
    return cur


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


def build_rotation(heading_deg, pitch_deg, roll_deg):
    """Return R: pano-local (+x right, +y front, +z up) -> ENU world.

    Matches diagnostics/filter_and_rectify.py and TEST/docs/math.md:
    heading is clockwise from north/world +Y, Google pitch is 90 when level,
    and roll is about pano-local +Y.
    """
    h = math.radians(float(heading_deg))
    pitch_off = math.radians(float(pitch_deg) - 90.0)
    roll = math.radians(wrap_signed_deg(roll_deg))
    return rot_z(-h) @ rot_x(pitch_off) @ rot_y(roll)


def extract_poi_bindings(parsed):
    """Pull the [5][0][9] POI binding entries: list of {ftid, name, type, icon}."""
    f9 = safe_get(parsed, 1, 0, 5, 0, 9)
    out = []
    if not isinstance(f9, list):
        return out
    for entry in f9:
        try:
            ftid_pair = entry[0][1]
            name = entry[2][0]
            place_type = entry[3][0] if entry[3] else None
            icon_url = entry[4] if len(entry) > 4 else None
            out.append({
                'ftid': ftid_pair, 'name': name, 'type': place_type, 'icon': icon_url,
            })
        except Exception:
            continue
    return out


def extract_blob2(parsed):
    """Decode the categorical b2 grid (256x512 uint8). Returns array or None."""
    node = safe_get(parsed, 1, 0, 5, 0, 5)
    b2_str = safe_get(node, 3, 2)
    if not b2_str:
        return None
    try:
        b2_str += '=' * ((4 - len(b2_str) % 4) % 4)
        b2 = base64.urlsafe_b64decode(b2_str)
        if len(b2) != 256 * 512:
            return None
        return np.frombuffer(b2, dtype=np.uint8).reshape(256, 512)
    except Exception:
        return None


def parse_photometa_geometry(parsed):
    """Return (planes_array, idx_map_array, panoid, lat, lng, pose) or None."""
    try:
        panoid = safe_get(parsed, 1, 0, 1, 1)
        if not panoid:
            return None
        lat = safe_get(parsed, 1, 0, 5, 0, 1, 0, 2)
        lng = safe_get(parsed, 1, 0, 5, 0, 1, 0, 3)
        if lat is None or lng is None:
            return None
        pose_raw = safe_get(parsed, 1, 0, 5, 0, 1, 2) or [0.0, 90.0, 0.0]
        heading = float(safe_get(pose_raw, 0) or 0.0)
        pitch = float(safe_get(pose_raw, 1) or 90.0)
        roll = wrap_signed_deg(safe_get(pose_raw, 2) or 0.0)
        node = safe_get(parsed, 1, 0, 5, 0, 5)
        if not node:
            return None
        b1_str = safe_get(node, 1, 2)
        if not b1_str:
            return None
        b1_str += '=' * ((4 - len(b1_str) % 4) % 4)
        b1 = base64.urlsafe_b64decode(b1_str)
        if len(b1) < 8:
            return None
        n_planes = int.from_bytes(b1[1:3], 'little')
        if n_planes < 3:
            return None
        W, H = 512, 256
        idx_offset = 8
        idx_map = np.frombuffer(b1[idx_offset:idx_offset + W * H], dtype=np.uint8).reshape(H, W)
        plane_offset = idx_offset + W * H
        planes_bytes = b1[plane_offset:plane_offset + n_planes * 16]
        planes = np.frombuffer(planes_bytes, dtype=np.float32).reshape(n_planes, 4)
        return planes, idx_map, panoid, float(lat), float(lng), {
            "heading_deg": heading,
            "pitch_deg": pitch,
            "roll_deg": roll,
        }
    except Exception:
        return None


def build_pano_points(panoid, planes, idx_map, image, world_x, world_y, world_z,
                      rotation_local_to_world, hard_max_dist, b2_grid=None):
    """Compute (xyz_world, rgb, plane_idx, class_idx, b2_id) for valid cells.

    Distance bound is adaptive: per-panorama p99.9 of t for plane-anchored
    cells, capped at hard_max_dist (default 200 m physical safety bound).
    Verified empirically across 30 panoramas in this run that p99.9 always
    < 100 m and observed max < 140 m, so 200 m never clips real data.
    """
    H, W = idx_map.shape
    img_w, img_h = image.size
    img_arr = np.asarray(image)

    us = np.arange(W); vs = np.arange(H)
    UU, VV = np.meshgrid(us, vs)
    theta = (UU + 0.5) / W * 2 * np.pi - np.pi
    phi = np.pi / 2 - (VV + 0.5) / H * np.pi
    dx = np.sin(theta) * np.cos(phi)
    dy = np.cos(theta) * np.cos(phi)
    dz = np.sin(phi)

    nx = planes[idx_map][:, :, 0]
    ny = planes[idx_map][:, :, 1]
    nz = planes[idx_map][:, :, 2]
    pd = planes[idx_map][:, :, 3]
    n_dot = nx * dx + ny * dy + nz * dz

    with np.errstate(divide='ignore', invalid='ignore'):
        t = pd / n_dot

    plane_norm = np.sqrt(nx * nx + ny * ny + nz * nz)
    plane_anchored = (plane_norm > 1e-6) & np.isfinite(t) & (t > 0)

    # Adaptive distance bound — drop top 0.1% as outliers, then enforce hard cap
    if plane_anchored.sum() > 100:
        adaptive_cap = float(np.percentile(t[plane_anchored], 99.9))
    else:
        adaptive_cap = hard_max_dist
    effective_cap = min(adaptive_cap, hard_max_dist)
    valid = plane_anchored & (t < effective_cap)

    UU_img = ((UU + 0.5) / W * img_w).astype(np.int64).clip(0, img_w - 1)
    VV_img = ((VV + 0.5) / H * img_h).astype(np.int64).clip(0, img_h - 1)
    rgb = img_arr[VV_img, UU_img]

    n_pl = planes.shape[0]
    cls_per_plane = np.zeros(n_pl, dtype=np.uint8)
    for i in range(n_pl):
        cls = classify(planes[i, 0], planes[i, 1], planes[i, 2])
        cls_per_plane[i] = CLASS_INDEX[cls]
    cls_arr = cls_per_plane[idx_map]

    local_xyz = np.stack([(t * dx)[valid], (t * dy)[valid], (t * dz)[valid]], axis=1)
    world_xyz = local_xyz @ rotation_local_to_world.T
    world_xyz += np.array([world_x, world_y, world_z], dtype=np.float64)
    px = world_xyz[:, 0]
    py = world_xyz[:, 1]
    pz = world_xyz[:, 2]
    rgb_pts = rgb[valid]
    plane_pts = idx_map[valid].astype(np.uint16)
    if b2_grid is not None:
        b2_pts = b2_grid[valid].astype(np.uint8)
    else:
        b2_pts = np.zeros(plane_pts.size, dtype=np.uint8)
    cls_pts = cls_arr[valid]

    return (px.astype(np.float32), py.astype(np.float32), pz.astype(np.float32),
            rgb_pts.astype(np.uint8), plane_pts, cls_pts, b2_pts,
            float(effective_cap))


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


def latlng_to_local(ref_lat, ref_lng, lat, lng):
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


def write_ply(out_fp, x, y, z, rgb, plane_idx, pano_idx, cls, b2_id):
    """Binary little-endian PLY with custom per-vertex properties (incl. b2_id)."""
    n = x.size
    with open(out_fp, 'wb') as f:
        header = (
            'ply\n'
            'format binary_little_endian 1.0\n'
            f'element vertex {n}\n'
            'property float x\n'
            'property float y\n'
            'property float z\n'
            'property uchar red\n'
            'property uchar green\n'
            'property uchar blue\n'
            'property ushort plane_idx\n'
            'property uchar pano_idx\n'
            'property uchar cls\n'
            'property uchar b2_id\n'
            'end_header\n'
        )
        f.write(header.encode('ascii'))
        dt = np.dtype([
            ('x', '<f4'), ('y', '<f4'), ('z', '<f4'),
            ('r', 'u1'), ('g', 'u1'), ('b', 'u1'),
            ('plane', '<u2'), ('pano', 'u1'), ('cls', 'u1'),
            ('b2', 'u1'),
        ])
        arr = np.zeros(n, dtype=dt)
        arr['x'] = x; arr['y'] = y; arr['z'] = z
        arr['r'] = rgb[:, 0]; arr['g'] = rgb[:, 1]; arr['b'] = rgb[:, 2]
        arr['plane'] = plane_idx
        arr['pano'] = pano_idx
        arr['cls'] = cls
        arr['b2'] = b2_id
        f.write(arr.tobytes())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('run_dir')
    ap.add_argument('--hard-max-distance', type=float, default=200.0,
                    help='Safety upper bound (m) on per-point distance. '
                         'Per-panorama p99.9 is used as the actual cap; '
                         'this just guards against pathological values.')
    ap.add_argument('--subsample', type=int, default=1, help='Take every Nth point')
    args = ap.parse_args()

    run = args.run_dir
    pano_dir = os.path.join(run, 'panoramas')
    nb_dir = os.path.join(run, 'neighbor_photometas')

    # Find all panoramas with image + geometry; carry full parsed json for POI / b2 access
    candidates = []
    for i in range(0, 6):
        fp = os.path.join(run, f'photometa_{i}_parsed.json')
        if not os.path.exists(fp):
            continue
        parsed = json.load(open(fp))
        g = parse_photometa_geometry(parsed)
        if g is None:
            continue
        planes, idx_map, panoid, lat, lng, pose = g
        img_fp = os.path.join(pano_dir, f'{panoid}.jpg')
        if os.path.exists(img_fp):
            candidates.append((panoid, planes, idx_map, lat, lng, pose, img_fp, parsed))
    if os.path.isdir(nb_dir):
        for fname in sorted(os.listdir(nb_dir)):
            if not fname.endswith('.parsed.json'):
                continue
            fp = os.path.join(nb_dir, fname)
            parsed = json.load(open(fp))
            g = parse_photometa_geometry(parsed)
            if g is None:
                continue
            planes, idx_map, panoid, lat, lng, pose = g
            img_fp = os.path.join(pano_dir, f'{panoid}.jpg')
            if os.path.exists(img_fp):
                candidates.append((panoid, planes, idx_map, lat, lng, pose, img_fp, parsed))

    seen = {}
    for c in candidates:
        seen[c[0]] = c
    candidates = list(seen.values())
    print(f'Candidates with image+geometry: {len(candidates)}')

    if not candidates:
        print('Nothing to fuse.', file=sys.stderr); sys.exit(2)

    ref_lat, ref_lng = candidates[0][3], candidates[0][4]
    print(f'Reference panoid: {candidates[0][0]} @ ({ref_lat:.6f}, {ref_lng:.6f})')
    print(f'Distance: adaptive (per-pano p99.9), hard upper bound = {args.hard_max_distance} m')

    all_x, all_y, all_z = [], [], []
    all_rgb, all_plane, all_pano, all_cls, all_b2 = [], [], [], [], []
    pano_meta = []
    t_start = time.time()
    for i, (panoid, planes, idx_map, lat, lng, pose, img_fp, parsed) in enumerate(candidates):
        wx, wy = latlng_to_local(ref_lat, ref_lng, lat, lng)
        wz = 0.0
        rotation = build_rotation(pose["heading_deg"], pose["pitch_deg"], pose["roll_deg"])
        try:
            img = Image.open(img_fp).convert('RGB')
        except Exception as e:
            print(f'  [{i + 1}/{len(candidates)}] {panoid[:12]}…  IMG ERROR: {e}')
            continue
        b2_grid = extract_blob2(parsed)
        poi_bindings = extract_poi_bindings(parsed)
        try:
            x, y, z, rgb, pl, cls, b2_id, eff_cap = build_pano_points(
                panoid, planes, idx_map, img, wx, wy, wz, rotation,
                args.hard_max_distance, b2_grid)
        except Exception as e:
            print(f'  [{i + 1}/{len(candidates)}] {panoid[:12]}…  GEOM ERROR: {e}')
            continue
        if args.subsample > 1:
            sl = slice(None, None, args.subsample)
            x = x[sl]; y = y[sl]; z = z[sl]; rgb = rgb[sl]
            pl = pl[sl]; cls = cls[sl]; b2_id = b2_id[sl]
        n = x.size
        all_x.append(x); all_y.append(y); all_z.append(z)
        all_rgb.append(rgb); all_plane.append(pl); all_cls.append(cls); all_b2.append(b2_id)
        all_pano.append(np.full(n, i, dtype=np.uint8))
        pano_meta.append({
            'panoid': panoid, 'pano_idx': i, 'world_pos': [wx, wy, wz],
            'lat': lat, 'lng': lng, 'n_planes': int(planes.shape[0]),
            'pose': pose,
            'rotation_matrix_local_to_world': rotation.tolist(),
            'n_points': int(n),
            'effective_max_distance_m': round(eff_cap, 1),
            'poi_bindings': poi_bindings,
            'b2_unique_ids': int(len(set(b2_id.tolist()))) if b2_grid is not None else 0,
        })
        poi_brief = (', '.join(p['name'][:18] for p in poi_bindings[:2])
                     + (f' (+{len(poi_bindings)-2})' if len(poi_bindings) > 2 else '')) or '-'
        print(f'  [{i + 1}/{len(candidates)}] {panoid[:12]}…  {n} pts  cap={eff_cap:.1f}m  '
              f'POIs: {poi_brief}')

    if not all_x:
        print('No points produced.', file=sys.stderr); sys.exit(2)

    X = np.concatenate(all_x).astype(np.float32)
    Y = np.concatenate(all_y).astype(np.float32)
    Z = np.concatenate(all_z).astype(np.float32)
    RGB = np.concatenate(all_rgb).astype(np.uint8)
    PLANE = np.concatenate(all_plane).astype(np.uint16)
    PANO = np.concatenate(all_pano).astype(np.uint8)
    CLS = np.concatenate(all_cls).astype(np.uint8)
    B2 = np.concatenate(all_b2).astype(np.uint8)

    n_total = X.size
    print(f'\nTotal points: {n_total} from {len(pano_meta)} panoramas')
    print(f'Took {time.time() - t_start:.1f}s')

    out_ply = os.path.join(run, 'merged_pointcloud.ply')
    out_npz = os.path.join(run, 'merged_pointcloud.npz')
    out_meta = os.path.join(run, 'pointcloud_meta.json')

    write_ply(out_ply, X, Y, Z, RGB, PLANE, PANO, CLS, B2)
    print(f'Wrote {out_ply} ({os.path.getsize(out_ply) / 1e6:.1f} MB)')

    np.savez_compressed(out_npz, x=X, y=Y, z=Z, rgb=RGB, plane=PLANE, pano=PANO, cls=CLS, b2=B2)
    print(f'Wrote {out_npz} ({os.path.getsize(out_npz) / 1e6:.1f} MB)')

    # Aggregate POI panel: list every distinct (panoid, ftid_pair, name)
    poi_index = []
    for pm in pano_meta:
        for poi in pm.get('poi_bindings', []):
            poi_index.append({
                'pano_idx': pm['pano_idx'], 'panoid': pm['panoid'],
                'ftid': poi['ftid'], 'name': poi['name'],
                'type': poi['type'], 'icon': poi['icon'],
            })

    with open(out_meta, 'w') as f:
        json.dump({
            'reference_panoid': candidates[0][0],
            'reference_lat': ref_lat, 'reference_lng': ref_lng,
            'panos': pano_meta,
            'total_points': int(n_total),
            'poi_index': poi_index,
            'distance_policy': 'adaptive p99.9 per panorama, hard upper bound %.0f m' % args.hard_max_distance,
        }, f, indent=2)
    print(f'Wrote {out_meta}')
    print(f'POI bindings collected: {len(poi_index)} across {sum(1 for pm in pano_meta if pm.get("poi_bindings"))} panoramas')


if __name__ == '__main__':
    main()
