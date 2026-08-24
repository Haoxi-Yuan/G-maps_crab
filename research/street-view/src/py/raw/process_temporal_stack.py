#!/usr/bin/env python3
"""Run the full per-pano pipeline on every capture in a temporal stack.

For each capture dir produced by fetch-temporal-photometas.js, treat it as a
self-contained mini run dir and orchestrate:
  1. parse-geometry.js            → planes.json + indexmap.bin + depthmap.bin
  2. stitch_panoramas.py          → 8K equirect JPEG (panoramas/<panoid>.jpg)
  3. build_rgb_pointcloud.py      → merged_pointcloud.{npz,ply}, pointcloud_meta.json

Result: each capture dir contains a single-pano point cloud anchored at the
same physical location, ready for cross-temporal comparison and the temporal
DB layer.

Usage:
  python3 src/py/raw/process_temporal_stack.py \
      --stack-dir data/raw/google_maps/temporal/<focal>/<ts>/
      [--max-distance 80]  [--skip-stitch]  [--max-captures N]
"""
import argparse
import json
import os
import subprocess
import sys
import time

# Resolve TEST_ROOT so we can find sibling scripts regardless of cwd
HERE = os.path.dirname(os.path.abspath(__file__))
TEST_ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
PROJECT_ROOT = os.path.abspath(os.path.join(TEST_ROOT, '..'))
PYTHON = os.path.join(PROJECT_ROOT, '.venv', 'bin', 'python3')
PARSE_JS = os.path.join(TEST_ROOT, 'src', 'js', 'capture', 'parse-geometry.js')
FETCH_NB_JS = os.path.join(TEST_ROOT, 'src', 'js', 'capture', 'fetch-neighbor-photometas.js')
STITCH_PY = os.path.join(TEST_ROOT, 'src', 'py', 'raw', 'stitch_panoramas.py')
BUILD_PY = os.path.join(TEST_ROOT, 'src', 'py', 'raw', 'build_rgb_pointcloud.py')


def setup_capture_as_run(capture_dir):
    """Make capture_dir resemble a run dir: photometa_0_parsed.json link +
    empty neighbor_photometas/. Idempotent."""
    parsed_fp = os.path.join(capture_dir, 'parsed.json')
    if not os.path.exists(parsed_fp):
        return False
    p0 = os.path.join(capture_dir, 'photometa_0_parsed.json')
    if not os.path.lexists(p0):
        os.symlink('parsed.json', p0)
    nb_dir = os.path.join(capture_dir, 'neighbor_photometas')
    os.makedirs(nb_dir, exist_ok=True)
    return True


def run_parse_geometry(capture_dir):
    """parse-geometry.js writes alongside its input; we run it on
    photometa_0_parsed.json so outputs are named correctly."""
    p0 = os.path.abspath(os.path.join(capture_dir, 'photometa_0_parsed.json'))
    expected = os.path.abspath(os.path.join(capture_dir, 'photometa_0_parsed_planes.json'))
    if os.path.exists(expected):
        return 'cached'
    res = subprocess.run(['node', PARSE_JS, p0],
                         cwd=TEST_ROOT, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f'parse-geometry failed: {res.stderr.strip()[-400:]}')
    return 'ok'


def run_fetch_neighbors(capture_dir, throttle_ms=200):
    """Pull every neighbor pano's photometa via direct HTTP. Writes
    neighbor_photometas/<panoid>.{bin,parsed.json} so downstream stitch +
    pointcloud build picks them up automatically. Idempotent — script skips
    cached entries internally."""
    capture_dir = os.path.abspath(capture_dir)
    res = subprocess.run(
        ['node', FETCH_NB_JS, '--run-dir', capture_dir,
         '--throttle-ms', str(throttle_ms)],
        cwd=TEST_ROOT, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f'fetch-neighbors failed: {res.stderr.strip()[-400:]}')
    nb_dir = os.path.join(capture_dir, 'neighbor_photometas')
    n = sum(1 for f in os.listdir(nb_dir) if f.endswith('.parsed.json'))
    return n


def run_stitch(capture_dir, workers=8):
    """Stitch focal + every neighbor pano. Skips work if every expected
    panorama already exists on disk (>1MB)."""
    capture_dir = os.path.abspath(capture_dir)
    panoid_fp = os.path.join(capture_dir, 'parsed.json')
    focal_panoid = json.load(open(panoid_fp))[1][0][1][1]

    expected = {focal_panoid}
    nb_dir = os.path.join(capture_dir, 'neighbor_photometas')
    if os.path.isdir(nb_dir):
        for f in os.listdir(nb_dir):
            if f.endswith('.parsed.json'):
                expected.add(f[:-len('.parsed.json')])

    pano_dir = os.path.join(capture_dir, 'panoramas')
    existing = set()
    if os.path.isdir(pano_dir):
        for f in os.listdir(pano_dir):
            if f.endswith('.jpg') and os.path.getsize(os.path.join(pano_dir, f)) > 1_000_000:
                existing.add(f[:-4])

    if expected.issubset(existing):
        return f'cached ({len(existing)})', focal_panoid

    res = subprocess.run(
        [PYTHON, STITCH_PY, capture_dir, '--workers', str(workers),
         '--zoom', '4', '--min-planes', '10'],
        cwd=TEST_ROOT, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f'stitch failed: {res.stderr.strip()[-400:]}')
    new_existing = set(f[:-4] for f in os.listdir(pano_dir)
                       if f.endswith('.jpg') and os.path.getsize(os.path.join(pano_dir, f)) > 1_000_000)
    return f'ok ({len(new_existing)})', focal_panoid


def run_build_pointcloud(capture_dir, max_distance=80, force=False):
    """Build the multi-pano point cloud. With force=True, rebuilds even if
    cached output exists (necessary after fetching new neighbors)."""
    capture_dir = os.path.abspath(capture_dir)
    out_fp = os.path.join(capture_dir, 'merged_pointcloud.npz')
    meta_fp = os.path.join(capture_dir, 'pointcloud_meta.json')
    if os.path.exists(out_fp) and os.path.exists(meta_fp) and not force:
        # Cache valid only if pointcloud already covers every available pano
        meta = json.load(open(meta_fp))
        n_used = len(meta.get('panos', []))
        n_avail = 1
        nb_dir = os.path.join(capture_dir, 'neighbor_photometas')
        if os.path.isdir(nb_dir):
            n_avail += sum(1 for f in os.listdir(nb_dir) if f.endswith('.parsed.json'))
        if n_used >= n_avail:
            return f'cached ({n_used} panos)'
    if os.path.exists(out_fp):
        os.remove(out_fp)
    res = subprocess.run(
        [PYTHON, BUILD_PY, capture_dir,
         '--hard-max-distance', str(max_distance)],
        cwd=TEST_ROOT, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f'build_pointcloud failed: {res.stderr.strip()[-400:]}')
    return 'ok'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--stack-dir', required=True)
    ap.add_argument('--max-distance', type=float, default=80.0)
    ap.add_argument('--skip-stitch', action='store_true',
                    help='Skip panorama stitching (geometry-only mode)')
    ap.add_argument('--skip-pointcloud', action='store_true',
                    help='Stop after stitching; useful for diagnostics')
    ap.add_argument('--skip-neighbors', action='store_true',
                    help='Skip per-capture neighbor photometa fetching')
    ap.add_argument('--throttle-ms', type=int, default=200,
                    help='Throttle for neighbor photometa fetching')
    ap.add_argument('--max-captures', type=int, default=0,
                    help='Process at most N captures (0 = all)')
    ap.add_argument('--captures', default='',
                    help='Comma-separated substring filter (e.g. "2024,2009") '
                         'matched against capture dir names')
    args = ap.parse_args()

    capture_root = os.path.join(args.stack_dir, 'captures')
    if not os.path.isdir(capture_root):
        print(f'No captures/ in {args.stack_dir}', file=sys.stderr); sys.exit(2)
    capture_dirs = sorted(
        os.path.join(capture_root, d) for d in os.listdir(capture_root)
        if os.path.isdir(os.path.join(capture_root, d)))
    if args.captures:
        patterns = [p.strip() for p in args.captures.split(',') if p.strip()]
        capture_dirs = [d for d in capture_dirs
                        if any(p in os.path.basename(d) for p in patterns)]
    if args.max_captures:
        capture_dirs = capture_dirs[:args.max_captures]
    print(f'Processing {len(capture_dirs)} captures in {args.stack_dir}\n')

    results = []
    for cdir in capture_dirs:
        cname = os.path.basename(cdir)
        t0 = time.time()
        print(f'== {cname} ==')
        try:
            if not setup_capture_as_run(cdir):
                print(f'  ! missing parsed.json, skip'); continue
            r1 = run_parse_geometry(cdir)
            print(f'  parse-geometry: {r1}')
            if not args.skip_neighbors:
                n_nb = run_fetch_neighbors(cdir, args.throttle_ms)
                print(f'  fetch-neighbors: {n_nb} parsed photometas in cache')
            if not args.skip_stitch:
                r2, panoid = run_stitch(cdir)
                print(f'  stitch:         {r2}  panoid={panoid[:14]}…')
            if not args.skip_pointcloud and not args.skip_stitch:
                r3 = run_build_pointcloud(cdir, args.max_distance)
                print(f'  pointcloud:     {r3}')
                # Read the pointcloud metadata to record summary stats
                meta_fp = os.path.join(cdir, 'pointcloud_meta.json')
                if os.path.exists(meta_fp):
                    pc_meta = json.load(open(meta_fp))
                    n_pts = pc_meta.get('total_points', 0)
                    print(f'    n_points = {n_pts:,}')
                    results.append({
                        'capture': cname, 'n_points': n_pts,
                        'duration_s': round(time.time() - t0, 1)})
        except Exception as e:
            print(f'  ERROR: {e}')
        print(f'  elapsed: {time.time()-t0:.1f}s\n')

    # Summary
    print('=== Summary ===')
    if results:
        for r in results:
            print(f"  {r['capture']:60s} pts={r['n_points']:>10,}  ({r['duration_s']}s)")


if __name__ == '__main__':
    main()
