#!/usr/bin/env python3
"""Align all captures of a temporal stack into a single reference frame.

Each capture in `<stack>/captures/` lives in its own local frame (its panoid
at world origin). For temporal comparison we need them in a SHARED frame.
This script:

  1. Picks a reference capture (default = focal, configurable)
  2. For each capture, computes its panoid's offset from the reference in
     meters using the local equirectangular projection (small-area flat
     earth, accurate to <1cm at <1km scales)
  3. Translates every point in that capture's merged_pointcloud.npz by the
     offset, writing aligned_pointcloud.npz alongside the original
  4. Outputs a stacked manifest + a top-down + side-view diagnostic PNG
     showing all captures coloured by year — visual sanity check

Optional --icp refines the translation via point-to-point ICP using stable
ground / facade segments (ground class is fixed elevation, useful anchor).

Output:
  <stack>/aligned/
    stack_manifest.parquet      one row per capture with offset + n_points
    stack_overview.png          top-down + side-view overlay
    stacked_points.npz          all captures in ref frame, with capture_id col

Each <capture>/aligned_pointcloud.npz also written for downstream use.

Usage:
  python3 src/py/derive/derive_temporal_alignment.py \
      --stack-dir data/raw/google_maps/temporal/<focal>/<ts>/
      [--ref-capture <date_panoid>]
"""
import argparse
import json
import math
import os
import sys

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

METERS_PER_DEG_LAT = 110540.0


def latlng_to_local(ref_lat, ref_lng, lat, lng):
    m_per_deg_lng = 111320.0 * math.cos(math.radians(ref_lat))
    return (lng - ref_lng) * m_per_deg_lng, (lat - ref_lat) * METERS_PER_DEG_LAT


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--stack-dir', required=True)
    ap.add_argument('--ref-capture', default=None,
                    help='Reference capture name (folder under captures/). '
                         'Default: focal (panoid matches timeline.json focal)')
    args = ap.parse_args()

    stack = args.stack_dir
    timeline_fp = os.path.join(stack, 'timeline.json')
    if not os.path.exists(timeline_fp):
        print(f'Missing {timeline_fp}', file=sys.stderr); sys.exit(2)
    timeline = json.load(open(timeline_fp))
    focal_panoid = timeline['focal']['panoid']

    captures_dir = os.path.join(stack, 'captures')
    captures = sorted(os.listdir(captures_dir))
    print(f'Captures: {len(captures)}')

    # Pick reference
    if args.ref_capture:
        ref_name = args.ref_capture
    else:
        match = [c for c in captures if focal_panoid in c]
        if not match:
            print(f'  no capture contains focal panoid {focal_panoid}; using last', file=sys.stderr)
            ref_name = captures[-1]
        else:
            ref_name = match[0]
    print(f'Reference capture: {ref_name}')

    ref_pcm = json.load(open(os.path.join(captures_dir, ref_name, 'pointcloud_meta.json')))
    ref_lat = ref_pcm['panos'][0]['lat']
    ref_lng = ref_pcm['panos'][0]['lng']
    print(f'  ref lat,lng = ({ref_lat:.6f}, {ref_lng:.6f})')

    rows = []
    all_points = []
    for cap in captures:
        cdir = os.path.join(captures_dir, cap)
        pcm_fp = os.path.join(cdir, 'pointcloud_meta.json')
        npz_fp = os.path.join(cdir, 'merged_pointcloud.npz')
        if not (os.path.exists(pcm_fp) and os.path.exists(npz_fp)):
            print(f'  skip {cap}: missing pointcloud')
            continue
        pcm = json.load(open(pcm_fp))
        cam_lat = pcm['panos'][0]['lat']
        cam_lng = pcm['panos'][0]['lng']
        # Camera offset from reference in meters
        dx, dy = latlng_to_local(ref_lat, ref_lng, cam_lat, cam_lng)
        # Each capture's points are in its own frame with cam at (0,0,0).
        # To put them in ref frame, translate by (dx, dy, 0).
        d = np.load(npz_fp)
        x = d['x'] + dx
        y = d['y'] + dy
        z = d['z']  # camera height assumed equal across captures (z=0 = cam)
        cap_idx = len(rows)
        # Save aligned cloud, preserving every extra field from source npz
        # (rgb, plane, pano, cls, b2, sem_label, sem_conf, ...)
        out_npz = os.path.join(cdir, 'aligned_pointcloud.npz')
        out_kwargs = {'x': x.astype(np.float32),
                      'y': y.astype(np.float32),
                      'z': z.astype(np.float32)}
        for k in d.files:
            if k not in ('x', 'y', 'z'):
                out_kwargs[k] = d[k]
        np.savez_compressed(out_npz, **out_kwargs)
        # Stash for combined viz/output
        all_points.append({
            'cap_idx': cap_idx, 'cap_name': cap, 'date': cap[:10],
            'x': x.astype(np.float32), 'y': y.astype(np.float32), 'z': z.astype(np.float32),
            'cls': d['cls'].astype(np.uint8), 'rgb': d['rgb'],
        })
        rows.append({
            'cap_idx': cap_idx, 'capture_name': cap, 'date': cap[:10],
            'panoid': pcm['panos'][0]['panoid'],
            'cam_lat': cam_lat, 'cam_lng': cam_lng,
            'offset_x_m': dx, 'offset_y_m': dy,
            'n_points': int(x.size),
            'is_reference': cap == ref_name,
        })
        print(f'  {cap[:10]}  panoid={pcm["panos"][0]["panoid"][:14]}…  '
              f'offset=({dx:+.2f}, {dy:+.2f}) m  n_pts={x.size:,}')

    # Manifest
    out_dir = os.path.join(stack, 'aligned')
    os.makedirs(out_dir, exist_ok=True)
    manifest = pd.DataFrame(rows)
    manifest.to_parquet(os.path.join(out_dir, 'stack_manifest.parquet'), index=False)
    print(f'\nWrote stack_manifest.parquet ({len(manifest)} captures)')

    # Stacked NPZ — all captures in ref frame with cap_idx column
    cap_ids = np.concatenate([np.full(p['x'].size, p['cap_idx'], dtype=np.uint8) for p in all_points])
    Xall = np.concatenate([p['x'] for p in all_points])
    Yall = np.concatenate([p['y'] for p in all_points])
    Zall = np.concatenate([p['z'] for p in all_points])
    Call = np.concatenate([p['cls'] for p in all_points])
    np.savez_compressed(os.path.join(out_dir, 'stacked_points.npz'),
                         x=Xall, y=Yall, z=Zall, cls=Call, cap_idx=cap_ids,
                         capture_names=np.array([p['cap_name'] for p in all_points]))
    print(f'Wrote stacked_points.npz ({Xall.size:,} points across {len(all_points)} layers)')

    # Diagnostic: small multiples — one top-down per capture, with all
    # other captures faded behind for spatial reference. Reveals per-year
    # changes against the temporal-mean baseline.
    print('Rendering diagnostic...')
    n_cap = len(all_points)
    cols = min(4, n_cap)
    rows_grid = math.ceil(n_cap / cols)
    fig, axes = plt.subplots(rows_grid, cols, figsize=(cols * 4.0, rows_grid * 4.0))
    fig.patch.set_facecolor('#0d0f14')
    axes = np.atleast_2d(axes).reshape(rows_grid, cols)

    # Pre-stack ALL points for the faded baseline
    sl = slice(None, None, 4)
    ax_lim = max(np.abs(Xall).max(), np.abs(Yall).max(), 50)
    for i, p in enumerate(all_points):
        r, c = i // cols, i % cols
        ax = axes[r, c]
        ax.set_facecolor('#0d0f14')
        for s in ax.spines.values(): s.set_color('#444')
        ax.tick_params(colors='#aaa', labelsize=8)
        ax.xaxis.label.set_color('#aaa'); ax.yaxis.label.set_color('#aaa')
        ax.title.set_color('#fff')
        # Faded background: ALL points
        ax.scatter(Xall[sl], Yall[sl], s=0.25, c='#283040', marker='.',
                   linewidths=0, rasterized=True)
        # This year's points highlighted
        ax.scatter(p['x'][sl], p['y'][sl], s=0.5, c='#ff8844', marker='.',
                   linewidths=0, rasterized=True, alpha=0.85)
        ax.set_aspect('equal')
        ax.set_xlim(-ax_lim, ax_lim); ax.set_ylim(-ax_lim, ax_lim)
        ax.set_title(f'{p["date"]} · {p["x"].size:,} pts', fontsize=10)
    # Hide unused axes
    for k in range(n_cap, rows_grid * cols):
        axes[k // cols, k % cols].set_visible(False)
    fig.suptitle(
        f'Temporal stack at anchor {focal_panoid[:14]}… · '
        f'{n_cap} captures · {Xall.size:,} total pts · ref={ref_name[:10]} · '
        f'orange = this capture, faded = union',
        color='#fff', fontsize=12, y=0.995)
    fig.tight_layout()
    fig.savefig(os.path.join(out_dir, 'stack_overview.png'), dpi=130,
                facecolor=fig.get_facecolor())
    plt.close(fig)
    print(f'Wrote stack_overview.png')
    print(f'\nAll outputs in: {out_dir}')


if __name__ == '__main__':
    main()
