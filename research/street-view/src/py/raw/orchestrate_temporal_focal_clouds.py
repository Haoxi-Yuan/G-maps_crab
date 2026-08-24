#!/usr/bin/env python3
"""Phase 1 of temporal pipeline: focal-only point clouds for every historical
capture in a temporal batch.

Reads the manifest written by orchestrate-temporal-batch.js, finds every
stack_dir that has captures, and runs process_temporal_stack.py with
--skip-neighbors for each. The output is, per historical capture:

  captures/<date>_<panoid>/
    photometa_0_parsed.json (symlink to parsed.json — set by setup_capture_as_run)
    photometa_0_parsed_planes.json
    photometa_0_parsed_indexmap.bin
    photometa_0_parsed_depthmap.bin
    panoramas/<panoid>.jpg
    merged_pointcloud.{npz,ply}        (single-pano = focal only)
    pointcloud_meta.json

Per the user's three-phase plan: phase 1 deliberately does NOT fetch
neighbours — we have 74 spatial anchors per year via the 44 focal stacks,
so each year already gets multi-pano coverage from the union of focal
captures. Phase 2 (factor correspondence) then decides whether any
specific (factor, year) pair needs phase-3 targeted neighbour fetching.

Usage:
  python3 orchestrate_temporal_focal_clouds.py \
    --batch-manifest <path/to/manifest.json>
    [--max-stacks N] [--start-at N] [--max-distance 80]
"""
import argparse
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TEST_ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
PROCESS_PY = os.path.join(TEST_ROOT, 'src', 'py', 'raw', 'process_temporal_stack.py')
PROJECT_ROOT = os.path.abspath(os.path.join(TEST_ROOT, '..'))
PYTHON = os.path.join(PROJECT_ROOT, '.venv', 'bin', 'python3')
if not os.path.exists(PYTHON):
    PYTHON = sys.executable


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--batch-manifest', required=True,
                    help='Path to the manifest.json from orchestrate-temporal-batch.js')
    ap.add_argument('--max-stacks', type=int, default=0)
    ap.add_argument('--start-at', type=int, default=0)
    ap.add_argument('--max-distance', type=float, default=80.0)
    args = ap.parse_args()

    manifest = json.load(open(args.batch_manifest))
    rows = manifest.get('rows', [])
    # Only stacks that actually had timeline captures
    eligible = [r for r in rows if r.get('status') == 'ok' and r.get('capture_count', 0) > 0]
    print(f'Total stacks in batch: {len(rows)}  eligible (have captures): {len(eligible)}')

    if args.start_at > 0:
        eligible = eligible[args.start_at:]
    if args.max_stacks > 0:
        eligible = eligible[:args.max_stacks]
    print(f'Processing {len(eligible)} stacks')

    # Output manifest for this phase 1 run
    batch_dir = os.path.dirname(args.batch_manifest)
    phase1_manifest_fp = os.path.join(batch_dir, 'phase1_focal_clouds_manifest.json')
    out = {
        'source_manifest': os.path.relpath(args.batch_manifest, TEST_ROOT),
        'phase': 1,
        'description': 'focal-only point clouds (no neighbour fetching)',
        'started_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'rows': [],
    }
    json.dump(out, open(phase1_manifest_fp, 'w'), indent=2)

    t_total = time.time()
    for idx, row in enumerate(eligible):
        stack_rel = row['stack_dir']
        stack_abs = os.path.join(TEST_ROOT, stack_rel)
        panoid = row['panoid']
        n_caps = row['capture_count']
        print(f'\n[{idx + 1}/{len(eligible)}] {panoid}  captures={n_caps}  -> {stack_rel}')

        t0 = time.time()
        proc = subprocess.run(
            [PYTHON, PROCESS_PY,
             '--stack-dir', stack_abs,
             '--skip-neighbors',
             '--max-distance', str(args.max_distance)],
            cwd=TEST_ROOT, capture_output=True, text=True)
        dt = time.time() - t0

        # Inventory what was produced
        captures_dir = os.path.join(stack_abs, 'captures')
        n_jpg, n_pc = 0, 0
        per_capture = []
        if os.path.isdir(captures_dir):
            for cdir_name in sorted(os.listdir(captures_dir)):
                cdir = os.path.join(captures_dir, cdir_name)
                jpg_glob = os.path.join(cdir, 'panoramas')
                jpg_count = 0
                if os.path.isdir(jpg_glob):
                    jpg_count = sum(1 for f in os.listdir(jpg_glob)
                                    if f.endswith('.jpg') and os.path.getsize(os.path.join(jpg_glob, f)) > 100_000)
                pc_ok = os.path.exists(os.path.join(cdir, 'merged_pointcloud.npz'))
                meta_fp = os.path.join(cdir, 'pointcloud_meta.json')
                n_pts = 0
                if os.path.exists(meta_fp):
                    try:
                        n_pts = json.load(open(meta_fp)).get('total_points', 0)
                    except Exception:
                        pass
                per_capture.append({'capture': cdir_name, 'jpgs': jpg_count,
                                    'pointcloud': pc_ok, 'n_points': n_pts})
                if jpg_count > 0: n_jpg += 1
                if pc_ok: n_pc += 1

        result = {
            'index': idx, 'panoid': panoid, 'stack_dir': stack_rel,
            'captures_total': n_caps, 'jpg_ok': n_jpg, 'pointcloud_ok': n_pc,
            'duration_s': round(dt, 1),
            'exit_code': proc.returncode,
            'stdout_tail': proc.stdout[-1000:] if proc.stdout else '',
            'stderr_tail': proc.stderr[-1000:] if proc.stderr else '',
            'captures': per_capture,
        }
        out['rows'].append(result)
        json.dump(out, open(phase1_manifest_fp, 'w'), indent=2)
        print(f'  jpg_ok={n_jpg}/{n_caps}  pointcloud_ok={n_pc}/{n_caps}  exit={proc.returncode}  ({dt:.1f}s)')

    out['finished_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    out['total_duration_s'] = round(time.time() - t_total, 1)
    out['summary'] = {
        'stacks_total': len(eligible),
        'stacks_complete': sum(1 for r in out['rows']
                               if r['jpg_ok'] == r['captures_total']
                               and r['pointcloud_ok'] == r['captures_total']),
        'captures_total': sum(r['captures_total'] for r in out['rows']),
        'jpgs_total': sum(r['jpg_ok'] for r in out['rows']),
        'pointclouds_total': sum(r['pointcloud_ok'] for r in out['rows']),
    }
    json.dump(out, open(phase1_manifest_fp, 'w'), indent=2)
    print(f'\nDone. {out["total_duration_s"]:.0f}s ({out["total_duration_s"]/60:.1f} min)')
    print(json.dumps(out['summary'], indent=2))
    print(f'Phase 1 manifest: {phase1_manifest_fp}')


if __name__ == '__main__':
    main()
