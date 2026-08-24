#!/usr/bin/env python3
"""Detect physical + semantic change between two temporal captures.

Anchored to the most recent (or user-specified reference) capture, classify
every point in the reference cloud as one of:
  STABLE         present in both captures with the same semantic label
  SEM_CHANGE     present in both, but semantic label differs (e.g. tree was
                 there 15y ago, now a building wall)
  APPEARED       present in reference, no match in the older capture (built
                 between the two dates)
  (DISAPPEARED   present only in older — counted but not visualised on ref)

Match is by nearest-neighbour in 2D (xy) + z gating. Both clouds must already
be in the same reference frame (GPS-aligned + ICP-refined).

Inputs (per capture):
  refined_pointcloud.npz        x, y, z, sem_label, sem_conf, ...

Output (in <stack>/changes/<ref>_vs_<older>/):
  changes.npz       point-level: stable/sem_change/appeared masks +
                    matched_neighbor_label for the changed-points
  confusion.csv     n_classes x n_classes transition matrix
  summary.json      counts + dominant changes
  changes_topdown.png   visual: ref cloud coloured by change type

Usage:
  python derive_temporal_changes.py --stack-dir <stack> \
        --ref 2024-02 --older 2009-03 [--match-radius 1.5]
"""
import argparse
import json
import math
import os
import sys

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy.spatial import cKDTree


COLORS = {
    'stable':      np.array([110, 130, 150], dtype=np.uint8),  # blue-grey
    'sem_change':  np.array([255, 130,  60], dtype=np.uint8),  # orange
    'appeared':    np.array([ 80, 220, 100], dtype=np.uint8),  # green
    'disappeared': np.array([220,  80,  80], dtype=np.uint8),  # red
}

# Mapillary Vistas dynamic classes — excluded in --strict mode since they
# don't represent stable physical surfaces (cars move, the ego vehicle
# silhouette changes between captures, etc.)
DYNAMIC_CLASS_NAMES = {
    'Bird', 'Ground Animal',
    'Person', 'Bicyclist', 'Motorcyclist', 'Other Rider',
    'Bicycle', 'Boat', 'Bus', 'Car', 'Caravan', 'Motorcycle',
    'On Rails', 'Other Vehicle', 'Trailer', 'Truck', 'Wheeled Slow',
    'Car Mount', 'Ego Vehicle',
}


def load_capture(capture_dir, prefer_refined=True):
    refined_fp = os.path.join(capture_dir, 'refined_pointcloud.npz')
    aligned_fp = os.path.join(capture_dir, 'aligned_pointcloud.npz')
    fp = refined_fp if (prefer_refined and os.path.exists(refined_fp)) else aligned_fp
    if not os.path.exists(fp):
        raise FileNotFoundError(f'No aligned/refined cloud in {capture_dir}')
    d = dict(np.load(fp))
    if 'sem_label' not in d:
        raise ValueError(f'{fp} has no sem_label — run derive_point_semantics first')
    return d, fp


def find_capture_dir(captures_dir, prefix):
    matches = [d for d in os.listdir(captures_dir) if d.startswith(prefix)]
    if not matches:
        raise FileNotFoundError(f'No capture dir starting with {prefix} in {captures_dir}')
    return os.path.join(captures_dir, sorted(matches)[0])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--stack-dir', required=True)
    ap.add_argument('--ref', required=True, help='Reference capture date prefix, e.g. 2024-02')
    ap.add_argument('--older', required=True, help='Older capture date prefix, e.g. 2009-03')
    ap.add_argument('--match-radius', type=float, default=1.5,
                    help='Max xy distance to call points "same physical point" (m)')
    ap.add_argument('--z-gate', type=float, default=2.0,
                    help='Max abs z-difference to count as a match')
    ap.add_argument('--strict', action='store_true',
                    help='Strict mode: exclude dynamic classes + restrict to '
                         'stable geom classes (facade + roof)')
    ap.add_argument('--min-sem-conf', type=float, default=0.0,
                    help='Min semantic voting confidence (0-1)')
    ap.add_argument('--cls-filter', default='',
                    help='Comma-separated list of geom cls to KEEP '
                         '(0=sky 1=ground 2=facade 3=roof 4=oblique). '
                         'Empty = keep all.')
    args = ap.parse_args()
    if args.strict:
        # Strict defaults: facade+roof only, no dynamic classes
        # (intentionally NOT setting min_sem_conf or match_radius — multi-pano
        #  votes are already noisy at high res; conf ~0.4 is normal even when
        #  a point is well-classified)
        if not args.cls_filter:
            args.cls_filter = '2,3'

    captures_dir = os.path.join(args.stack_dir, 'captures')
    ref_dir = find_capture_dir(captures_dir, args.ref)
    old_dir = find_capture_dir(captures_dir, args.older)

    print(f'Reference:  {os.path.basename(ref_dir)}')
    print(f'Older:      {os.path.basename(old_dir)}')

    ref_d, ref_fp = load_capture(ref_dir)
    old_d, old_fp = load_capture(old_dir)

    # Load class names from either capture
    sem_meta_fp = os.path.join(ref_dir, 'semantic', '_meta.json')
    sem_meta = json.load(open(sem_meta_fp))
    id2label = {int(k): v for k, v in sem_meta['id2label'].items()}
    n_classes = len(id2label)

    # Optionally filter both clouds by geometric class BEFORE matching
    if args.cls_filter:
        keep_cls = set(int(c) for c in args.cls_filter.split(',') if c.strip())
        ref_keep = np.isin(ref_d['cls'], list(keep_cls))
        old_keep = np.isin(old_d['cls'], list(keep_cls))
        ref_d = {k: ref_d[k][ref_keep] for k in ref_d}
        old_d = {k: old_d[k][old_keep] for k in old_d}
        print(f'cls filter {sorted(keep_cls)}: ref kept {ref_keep.sum():,}/'
              f'{len(ref_keep):,}, old kept {old_keep.sum():,}/{len(old_keep):,}')

    ref_xyz = np.stack([ref_d['x'], ref_d['y'], ref_d['z']], axis=1)
    old_xyz = np.stack([old_d['x'], old_d['y'], old_d['z']], axis=1)

    print(f'Reference points: {len(ref_xyz):,}')
    print(f'Older points:     {len(old_xyz):,}')

    # Match: for each ref point, find nearest neighbor in older within radius
    print('Building KD-tree on older xy...')
    tree = cKDTree(old_xyz[:, :2])
    dists, idxs = tree.query(ref_xyz[:, :2], k=1)
    z_delta = np.abs(ref_xyz[:, 2] - old_xyz[idxs, 2])
    matched = (dists < args.match_radius) & (z_delta < args.z_gate)
    n_matched = int(matched.sum())
    print(f'Matched ref points: {n_matched:,} / {len(ref_xyz):,} '
          f'({100*n_matched/len(ref_xyz):.1f}%)')

    ref_sem = ref_d['sem_label'].astype(np.int32)
    old_sem_at_ref = np.full(len(ref_xyz), -1, dtype=np.int32)
    old_sem_at_ref[matched] = old_d['sem_label'][idxs[matched]].astype(np.int32)

    # Strict filters: drop dynamic classes + low-confidence votes
    dynamic_ids = {i for i, n in id2label.items() if n in DYNAMIC_CLASS_NAMES}
    if args.strict or args.min_sem_conf > 0:
        ref_dynamic = np.isin(ref_sem, list(dynamic_ids))
        old_dynamic = np.isin(old_sem_at_ref, list(dynamic_ids))
        bad = ref_dynamic | old_dynamic
        if 'sem_conf' in ref_d:
            low_conf = (ref_d['sem_conf'].astype(np.float32) < args.min_sem_conf)
            bad |= low_conf
        if 'sem_conf' in old_d:
            low_conf_old = np.zeros(len(ref_xyz), dtype=bool)
            low_conf_old[matched] = (old_d['sem_conf'][idxs[matched]].astype(np.float32)
                                     < args.min_sem_conf)
            bad |= low_conf_old
        n_dropped = int(bad.sum())
        print(f'Strict filter dropped {n_dropped:,} points '
              f'({100*n_dropped/len(ref_xyz):.1f}%) — dynamic class or low conf')
        # Mark dropped points as "ignored" by setting to 255 sentinel
        ref_sem[bad] = 255
        old_sem_at_ref[bad] = 255

    same_label = matched & (ref_sem == old_sem_at_ref) & (ref_sem != 255)
    diff_label = matched & (ref_sem != old_sem_at_ref) & (ref_sem != 255) & (old_sem_at_ref != 255)
    appeared = ~matched

    n_stable = int(same_label.sum())
    n_change = int(diff_label.sum())
    n_appeared = int(appeared.sum())

    # Disappeared: older points that have no match in ref
    print('Reverse match for disappeared...')
    tree_ref = cKDTree(ref_xyz[:, :2])
    d2, _ = tree_ref.query(old_xyz[:, :2], k=1)
    disappeared = d2 >= args.match_radius
    n_disappeared = int(disappeared.sum())

    # Confusion: when label changed, count A_label -> B_label
    confusion = np.zeros((n_classes, n_classes), dtype=np.int64)
    a = ref_sem[diff_label]
    b = old_sem_at_ref[diff_label]
    valid = (a < n_classes) & (b < n_classes) & (a >= 0) & (b >= 0)
    np.add.at(confusion, (b[valid], a[valid]), 1)  # rows: old, cols: new

    # Top transitions
    flat = []
    for i in range(n_classes):
        for j in range(n_classes):
            if i != j and confusion[i, j] > 0:
                flat.append((confusion[i, j], i, j, id2label[i], id2label[j]))
    flat.sort(reverse=True)
    top = flat[:20]

    # Summary
    suffix = '_strict' if args.strict else ''
    out_dir = os.path.join(args.stack_dir, 'changes',
                           f'{args.ref}_vs_{args.older}{suffix}'.replace('/', '_'))
    os.makedirs(out_dir, exist_ok=True)
    summary = {
        'ref_capture': os.path.basename(ref_dir),
        'older_capture': os.path.basename(old_dir),
        'n_ref_points': len(ref_xyz),
        'n_older_points': len(old_xyz),
        'n_matched': n_matched,
        'n_stable_same_label': n_stable,
        'n_changed_label': n_change,
        'n_appeared_only_in_ref': n_appeared,
        'n_disappeared_only_in_older': n_disappeared,
        'match_radius_m': args.match_radius,
        'z_gate_m': args.z_gate,
        'top_transitions_old_to_new': [
            {'count': int(c), 'old_class': old_l, 'new_class': new_l}
            for (c, _, _, old_l, new_l) in top
        ],
    }
    json.dump(summary, open(os.path.join(out_dir, 'summary.json'), 'w'), indent=2)

    # Save confusion as CSV
    cls_names = [id2label[i] for i in range(n_classes)]
    df = pd.DataFrame(confusion, index=cls_names, columns=cls_names)
    df.index.name = 'old_class'
    df.columns.name = 'new_class'
    df.to_csv(os.path.join(out_dir, 'confusion.csv'))

    # Save per-point change masks
    np.savez_compressed(os.path.join(out_dir, 'changes.npz'),
                        x=ref_xyz[:, 0].astype(np.float32),
                        y=ref_xyz[:, 1].astype(np.float32),
                        z=ref_xyz[:, 2].astype(np.float32),
                        ref_label=ref_sem.astype(np.uint8),
                        older_label=np.where(matched,
                                             old_sem_at_ref,
                                             255).astype(np.uint8),
                        stable=same_label,
                        sem_change=diff_label,
                        appeared=appeared,
                        match_dist_xy=dists.astype(np.float32))

    # Top-down visualization
    fig, ax = plt.subplots(figsize=(10, 10), facecolor='#0d0f14')
    ax.set_facecolor('#0d0f14')
    sl = slice(None, None, 4)
    rgb_pp = np.zeros((len(ref_xyz), 3), dtype=np.uint8)
    rgb_pp[same_label] = COLORS['stable']
    rgb_pp[diff_label] = COLORS['sem_change']
    rgb_pp[appeared] = COLORS['appeared']
    ax.scatter(ref_xyz[sl, 0], ref_xyz[sl, 1],
               c=rgb_pp[sl] / 255.0, s=0.4, marker='.', linewidths=0,
               rasterized=True)
    # Add disappeared from older cloud
    ax.scatter(old_xyz[disappeared][::4, 0], old_xyz[disappeared][::4, 1],
               c=COLORS['disappeared'] / 255.0, s=0.4, marker='.',
               linewidths=0, rasterized=True, alpha=0.7)
    ax.set_aspect('equal')
    ax.set_xlabel('east (m)', color='#aaa')
    ax.set_ylabel('north (m)', color='#aaa')
    ax.tick_params(colors='#aaa')
    for s in ax.spines.values(): s.set_color('#444')
    title = (f'{args.ref} vs {args.older}  ·  '
             f'stable={n_stable:,}  sem_change={n_change:,}  '
             f'appeared={n_appeared:,}  disappeared={n_disappeared:,}')
    ax.set_title(title, color='#fff', fontsize=11)
    handles = []
    for k, c in COLORS.items():
        handles.append(plt.Line2D([0], [0], marker='o', linestyle='',
                                  color=c / 255.0, label=k))
    leg = ax.legend(handles=handles, loc='upper right', frameon=True)
    leg.get_frame().set_facecolor('#1a1d24')
    for t in leg.get_texts(): t.set_color('#ddd')
    fig.tight_layout()
    fig.savefig(os.path.join(out_dir, 'changes_topdown.png'), dpi=140,
                facecolor=fig.get_facecolor())
    plt.close(fig)

    print(f'\nSummary:')
    print(f'  STABLE:        {n_stable:>8,}  same physical point + same semantic label')
    print(f'  SEM_CHANGE:    {n_change:>8,}  same physical point, different label')
    print(f'  APPEARED:      {n_appeared:>8,}  in {args.ref} but not in {args.older}')
    print(f'  DISAPPEARED:   {n_disappeared:>8,}  in {args.older} but not in {args.ref}')
    print(f'\nTop 10 sem-change transitions (old -> new):')
    for c, _, _, ol, nl in top[:10]:
        print(f'  {c:>6,}  {ol:30s} -> {nl}')
    print(f'\nOutputs in: {out_dir}')


if __name__ == '__main__':
    main()
