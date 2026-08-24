#!/usr/bin/env python3
"""Build per-point semantic timeline across all temporal captures + apply
multi-year cross-validation to suppress noise.

Anchored to a reference capture (default: latest), for every point p_i in
the reference cloud:
  - For each historical capture c, find the nearest-neighbour point in c
    within match_radius (xy) + z_gate (z). If found, record c's sem_label
    at that match. Otherwise mark as "unmatched" for that year.
  - Apply a 3-year median filter: if year_i's label disagrees with both
    year_(i-1) and year_(i+1), and the two neighbours agree, replace it.
    Suppresses single-frame seg noise and dynamic-occlusion artefacts.
  - Classify each point into:
      STABLE         label consistent across most observed years
      REAL_CHANGE    label clearly transitions (old era != new era), with
                     persistence requirement (>= --min-persistence captures
                     in each era)
      TRANSIENT      label flips frequently (likely noise) — do NOT trust
      SPARSE_COVER   matched in too few years to conclude

Dynamic classes (Car, Person, Ego Vehicle, ...) are pre-masked: their
labels are not used in agreement scoring — they're set to a sentinel.

Inputs (per capture):
  refined_pointcloud.npz   x, y, z, sem_label, sem_conf
  semantic/_meta.json      id2label

Outputs (in <stack>/temporal_history/<ref>/):
  timeline.npz             per-point label matrix (n_pts, n_caps) +
                           presence mask + smoothed labels
  classification.npz       per-point state (one of 4 states above)
  summary.json             counts + dominant transitions
  history_topdown.png      visual: ref points coloured by classification
  per_capture_match.json   stats on matching across years

Usage:
  python derive_temporal_history.py --stack-dir <stack>
      [--ref 2024-02] [--match-radius 1.5] [--z-gate 2.0]
      [--min-persistence 2]
"""
import argparse
import json
import os
import sys
import time

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy.spatial import cKDTree


# Mapillary Vistas dynamic classes — these labels move around frame to frame
# and don't represent the underlying physical surface. Mask them out so
# they don't contaminate cross-year voting.
DYNAMIC_CLASS_NAMES = {
    'Bird', 'Ground Animal',
    'Person', 'Bicyclist', 'Motorcyclist', 'Other Rider',
    'Bicycle', 'Boat', 'Bus', 'Car', 'Caravan', 'Motorcycle',
    'On Rails', 'Other Vehicle', 'Trailer', 'Truck', 'Wheeled Slow',
    'Car Mount', 'Ego Vehicle',
}

CLASSIFICATION_COLORS = {
    'stable':       np.array([110, 130, 150], dtype=np.uint8),
    'real_change':  np.array([255, 100,  60], dtype=np.uint8),
    'transient':    np.array([180, 180,  80], dtype=np.uint8),
    'sparse_cover': np.array([ 90,  90, 110], dtype=np.uint8),
}
STATE_STABLE = 0
STATE_REAL_CHANGE = 1
STATE_TRANSIENT = 2
STATE_SPARSE_COVER = 3
STATE_NAMES = ['stable', 'real_change', 'transient', 'sparse_cover']


def list_captures(stack_dir):
    captures_dir = os.path.join(stack_dir, 'captures')
    return sorted(os.path.join(captures_dir, d)
                  for d in os.listdir(captures_dir)
                  if os.path.isdir(os.path.join(captures_dir, d)))


def load_refined(capture_dir):
    fp = os.path.join(capture_dir, 'refined_pointcloud.npz')
    if not os.path.exists(fp):
        return None
    d = np.load(fp)
    if 'sem_label' not in d.files:
        return None
    return d


def find_capture_dir(captures_dir, prefix):
    matches = [d for d in os.listdir(captures_dir) if d.startswith(prefix)]
    if not matches:
        return None
    return os.path.join(captures_dir, sorted(matches)[0])


def median_smooth_temporal(labels, presence):
    """3-year median filter. labels: (n_pts, n_caps) uint8;
    presence: (n_pts, n_caps) bool. For interior years, if both neighbours
    agree AND the centre disagrees, replace centre. Edge years left as-is.
    Returns a NEW array."""
    out = labels.copy()
    n_caps = labels.shape[1]
    for i in range(1, n_caps - 1):
        both_present = presence[:, i - 1] & presence[:, i + 1] & presence[:, i]
        neighbours_agree = labels[:, i - 1] == labels[:, i + 1]
        differs = (labels[:, i] != labels[:, i - 1]) & (labels[:, i] != labels[:, i + 1])
        suppress = both_present & neighbours_agree & differs
        out[suppress, i] = labels[suppress, i - 1]
    return out


def classify_points(labels_smoothed, presence, dynamic_mask, ref_idx,
                    min_persistence):
    """Classify each ref point. Inputs are over capture columns only — the
    ref column is always presence==True for every ref point.

    For each ref point:
      n_obs   = count of captures (excluding ref) where point matched AND
                label is not dynamic
      stable_count   = count of valid obs where label == ref_label
      change_count   = count of valid obs where label differs from ref_label
      transient_count = transitions in observed sequence (number of
                       label flips in chronological order)
    """
    n_pts, n_caps = labels_smoothed.shape
    ref_label = labels_smoothed[:, ref_idx]

    # Mask: which observations to TRUST (matched + non-dynamic + non-255)
    valid = presence & ~dynamic_mask & (labels_smoothed != 255)

    # Replace ref column for "valid" calc — exclude ref from agreement stats
    valid_no_ref = valid.copy()
    valid_no_ref[:, ref_idx] = False

    # Count valid observations per point
    n_obs = valid_no_ref.sum(axis=1)

    # Same/diff vs ref
    same_label = (labels_smoothed == ref_label[:, None]) & valid_no_ref
    diff_label = (labels_smoothed != ref_label[:, None]) & valid_no_ref
    n_same = same_label.sum(axis=1)
    n_diff = diff_label.sum(axis=1)

    # Transient detector: count label transitions in chronological order over
    # the VALID observations only. We collapse invalid columns and look at
    # the resulting sequence.
    # For efficiency: compare adjacent valid observations.
    # Use a vectorised approximation: count number of distinct labels in
    # valid observations. If >2 distinct, it's transient.
    n_distinct = np.zeros(n_pts, dtype=np.uint8)
    for c in range(n_caps):
        if c == ref_idx:
            continue
        # accumulate unique labels per row across columns: trick using bit
        # set is heavy; just use a per-class match count.
        pass  # see compact loop below

    # Compact form: for each pair (a,b) of label values per point, count
    # how many distinct ones across n_caps. We do this via per-point
    # presence per class index.
    # For performance, only check the labels that actually appear: build
    # a [n_pts, max_label+1] bitmap.
    # max_label is small (~65), n_pts ~ millions; bitmap ~250MB. Acceptable.
    max_label = max(int(labels_smoothed.max()), 65)
    bitmap = np.zeros((n_pts, max_label + 1), dtype=bool)
    for c in range(n_caps):
        if c == ref_idx:
            continue
        col = labels_smoothed[:, c]
        sel = valid_no_ref[:, c]
        idx = np.flatnonzero(sel)
        bitmap[idx, col[idx]] = True
    n_distinct = bitmap.sum(axis=1).astype(np.uint8)

    # Monotonic-transition check: a real change should look like
    # [old, old, ..., ref, ref, ...] in chronological order (over valid obs
    # only). If labels oscillate (e.g. [old, ref, old, ref]) it's likely
    # seg noise rather than a real change. We require every "diff" obs to
    # come BEFORE every "same" obs in chronological order.
    n_caps_arr = np.arange(n_caps)[None, :]
    valid_match = (labels_smoothed == ref_label[:, None]) & valid_no_ref
    valid_diff = (labels_smoothed != ref_label[:, None]) & valid_no_ref
    diff_idx = np.where(valid_diff, n_caps_arr, -1)
    same_idx = np.where(valid_match, n_caps_arr, n_caps + 1)
    max_diff = diff_idx.max(axis=1)
    min_same = same_idx.min(axis=1)
    monotonic = max_diff < min_same

    # Classification
    state = np.full(n_pts, STATE_SPARSE_COVER, dtype=np.uint8)
    enough_obs = n_obs >= min_persistence

    # STABLE: enough obs AND ALL agree with ref label (n_same == n_obs)
    is_stable = enough_obs & (n_same == n_obs) & (n_obs > 0)
    state[is_stable] = STATE_STABLE

    # REAL_CHANGE: enough obs in old era disagree with ref, change is
    # monotonic in time, and no more than 2 distinct labels overall.
    is_change = (enough_obs & (n_diff >= min_persistence)
                 & (n_distinct <= 2) & monotonic)
    state[is_change & ~is_stable] = STATE_REAL_CHANGE

    # TRANSIENT: enough obs but >2 distinct labels OR non-monotonic flips
    is_transient = enough_obs & ((n_distinct > 2)
                                  | (~monotonic & (n_diff >= 1)))
    state[is_transient & ~is_stable & ~is_change] = STATE_TRANSIENT

    # Compute "old era label" for REAL_CHANGE points: dominant non-ref
    # label. To save memory, just take the mode of valid_no_ref labels.
    old_label = np.full(n_pts, 255, dtype=np.uint8)
    if is_change.any():
        # For each point with is_change: find argmax of bitmap counts
        # excluding ref_label.
        ref_idx_arr = ref_label[is_change].astype(np.int64)
        bm_cm = bitmap[is_change].astype(np.int32)
        # We have the BITMAP not counts — need counts
        # Recompute counts only for changed points (cheaper).
        change_idx = np.flatnonzero(is_change)
        counts_c = np.zeros((change_idx.size, max_label + 1), dtype=np.int32)
        for c in range(n_caps):
            if c == ref_idx:
                continue
            col = labels_smoothed[change_idx, c]
            sel = valid_no_ref[change_idx, c]
            valid_idx = np.flatnonzero(sel)
            np.add.at(counts_c, (valid_idx, col[valid_idx]), 1)
        # Zero out the ref label so argmax picks the non-ref dominant
        counts_c[np.arange(change_idx.size), ref_idx_arr] = 0
        old_label[change_idx] = counts_c.argmax(axis=1).astype(np.uint8)

    return {
        'state': state,
        'ref_label': ref_label.astype(np.uint8),
        'old_label': old_label,
        'n_obs': n_obs,
        'n_same': n_same,
        'n_diff': n_diff,
        'n_distinct': n_distinct,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--stack-dir', required=True)
    ap.add_argument('--ref', default=None,
                    help='Capture date prefix to use as reference. '
                         'Default: the latest one.')
    ap.add_argument('--match-radius', type=float, default=1.5)
    ap.add_argument('--z-gate', type=float, default=2.0)
    ap.add_argument('--min-persistence', type=int, default=2,
                    help='Min captures with consistent label to count')
    ap.add_argument('--cls-filter', default='',
                    help='Comma-separated list of geom cls to KEEP '
                         '(0=sky 1=ground 2=facade 3=roof 4=oblique). '
                         'Empty = keep all.')
    ap.add_argument('--exclude-ref-dynamic', action='store_true', default=True,
                    help='Drop ref points whose ref-label is a dynamic class')
    args = ap.parse_args()

    captures_dir = os.path.join(args.stack_dir, 'captures')
    capture_dirs = list_captures(args.stack_dir)

    # Filter to captures with refined_pointcloud.npz + sem_label
    valid_caps = []
    for cdir in capture_dirs:
        d = load_refined(cdir)
        if d is None:
            print(f'  skip {os.path.basename(cdir)}: no refined cloud or sem_label')
            continue
        valid_caps.append(cdir)
    print(f'\nValid captures with semantic data: {len(valid_caps)}')
    for c in valid_caps:
        print(f'  {os.path.basename(c)[:40]}')

    if args.ref:
        ref_dir = find_capture_dir(captures_dir, args.ref)
        if ref_dir is None or ref_dir not in valid_caps:
            print(f'Ref capture {args.ref} not found among valid captures',
                  file=sys.stderr); sys.exit(2)
    else:
        ref_dir = valid_caps[-1]
    ref_idx = valid_caps.index(ref_dir)
    print(f'\nReference: {os.path.basename(ref_dir)} (idx {ref_idx})\n')

    # Class names for the ref capture
    sem_meta_fp = os.path.join(ref_dir, 'semantic', '_meta.json')
    sem_meta = json.load(open(sem_meta_fp))
    id2label = {int(k): v for k, v in sem_meta['id2label'].items()}
    n_classes = len(id2label)
    dynamic_ids = {i for i, n in id2label.items() if n in DYNAMIC_CLASS_NAMES}

    # Load ref cloud as plain dict so we can subset rows freely
    _rd_npz = load_refined(ref_dir)
    ref_d = {k: _rd_npz[k] for k in _rd_npz.files}

    # Optional geometric-class filter: keep only stable physical surfaces
    if args.cls_filter:
        keep_cls = set(int(c) for c in args.cls_filter.split(',') if c.strip())
        keep = np.isin(ref_d['cls'], list(keep_cls))
        n_pre = len(keep)
        ref_d = {k: v[keep] for k, v in ref_d.items()}
        print(f'cls filter {sorted(keep_cls)}: ref kept '
              f'{keep.sum():,}/{n_pre:,}')

    # Optional: drop ref points whose ref-label is a dynamic class
    if args.exclude_ref_dynamic:
        ref_dyn = np.isin(ref_d['sem_label'], list(dynamic_ids))
        n_pre = len(ref_dyn)
        keep = ~ref_dyn
        ref_d = {k: v[keep] for k, v in ref_d.items()}
        print(f'exclude ref-dynamic: kept {keep.sum():,}/{n_pre:,}')

    n_ref = len(ref_d['x'])
    ref_xyz = np.stack([ref_d['x'], ref_d['y'], ref_d['z']], axis=1)
    print(f'Ref points: {n_ref:,}')

    # Build label + presence matrix (n_ref, n_caps)
    n_caps = len(valid_caps)
    labels = np.full((n_ref, n_caps), 255, dtype=np.uint8)
    presence = np.zeros((n_ref, n_caps), dtype=bool)
    match_stats = []

    for ci, cdir in enumerate(valid_caps):
        cname = os.path.basename(cdir)
        if ci == ref_idx:
            labels[:, ci] = ref_d['sem_label']
            presence[:, ci] = True
            match_stats.append({'capture': cname, 'matched_pct': 100.0})
            print(f'  [{ci}] {cname[:35]}  ref (self)  100.0%')
            continue
        d = load_refined(cdir)
        old_xyz = np.stack([d['x'], d['y'], d['z']], axis=1)
        tree = cKDTree(old_xyz[:, :2])
        dists, idxs = tree.query(ref_xyz[:, :2], k=1)
        z_d = np.abs(ref_xyz[:, 2] - old_xyz[idxs, 2])
        ok = (dists < args.match_radius) & (z_d < args.z_gate)
        labels[ok, ci] = d['sem_label'][idxs[ok]]
        presence[:, ci] = ok
        pct = 100 * ok.sum() / n_ref
        match_stats.append({'capture': cname, 'matched_pct': float(pct),
                            'n_old': int(len(old_xyz))})
        print(f'  [{ci}] {cname[:35]}  matched {pct:5.1f}%  n_old={len(old_xyz):,}')

    # Mask of dynamic-class observations
    dynamic_mask = np.isin(labels, list(dynamic_ids))

    # Smooth
    print('\nApplying 3-year median filter...')
    smoothed = median_smooth_temporal(labels, presence)
    n_changed = (smoothed != labels).sum()
    print(f'  smoothed {n_changed:,} cells ({100*n_changed/(n_ref*n_caps):.2f}%)')

    # Classify
    print('Classifying points...')
    cls = classify_points(smoothed, presence, dynamic_mask, ref_idx,
                          args.min_persistence)
    state = cls['state']

    # Summary
    n_state = {STATE_NAMES[i]: int((state == i).sum()) for i in range(4)}
    print(f'\nClassification:')
    for k, v in n_state.items():
        print(f'  {k:14s} {v:>10,}  ({100*v/n_ref:.1f}%)')

    # Top real-change transitions
    is_change = state == STATE_REAL_CHANGE
    if is_change.any():
        old_labs = cls['old_label'][is_change]
        new_labs = cls['ref_label'][is_change]
        valid_lab = (old_labs < n_classes) & (new_labs < n_classes) & (old_labs != 255)
        old_v = old_labs[valid_lab]
        new_v = new_labs[valid_lab]
        pairs = old_v.astype(np.int64) * 256 + new_v.astype(np.int64)
        unique_pairs, counts = np.unique(pairs, return_counts=True)
        order = np.argsort(-counts)[:20]
        top_transitions = []
        for o in order:
            p = unique_pairs[o]
            ol_id = int(p // 256); nl_id = int(p % 256)
            top_transitions.append({
                'count': int(counts[o]),
                'old_class': id2label[ol_id],
                'new_class': id2label[nl_id],
            })
        print(f'\nTop real-change transitions (old era -> ref):')
        for t in top_transitions[:10]:
            print(f'  {t["count"]:>8,}  {t["old_class"]:30s} -> {t["new_class"]}')
    else:
        top_transitions = []

    # Save outputs
    out_dir = os.path.join(args.stack_dir, 'temporal_history',
                           os.path.basename(ref_dir))
    os.makedirs(out_dir, exist_ok=True)

    np.savez_compressed(os.path.join(out_dir, 'timeline.npz'),
                        labels=labels,
                        labels_smoothed=smoothed,
                        presence=presence,
                        x=ref_xyz[:, 0].astype(np.float32),
                        y=ref_xyz[:, 1].astype(np.float32),
                        z=ref_xyz[:, 2].astype(np.float32),
                        capture_names=np.array([os.path.basename(c) for c in valid_caps]))

    np.savez_compressed(os.path.join(out_dir, 'classification.npz'),
                        state=state,
                        ref_label=cls['ref_label'],
                        old_label=cls['old_label'],
                        n_obs=cls['n_obs'].astype(np.uint8),
                        n_same=cls['n_same'].astype(np.uint8),
                        n_diff=cls['n_diff'].astype(np.uint8),
                        n_distinct=cls['n_distinct'].astype(np.uint8))

    summary = {
        'ref_capture': os.path.basename(ref_dir),
        'n_captures': n_caps,
        'capture_names': [os.path.basename(c) for c in valid_caps],
        'n_ref_points': n_ref,
        'match_radius_m': args.match_radius,
        'z_gate_m': args.z_gate,
        'min_persistence': args.min_persistence,
        'classification_counts': n_state,
        'classification_pct': {k: round(100*v/n_ref, 2) for k, v in n_state.items()},
        'top_real_change_transitions': top_transitions,
        'per_capture_match_stats': match_stats,
        'dynamic_classes_excluded': sorted(DYNAMIC_CLASS_NAMES),
    }
    json.dump(summary, open(os.path.join(out_dir, 'summary.json'), 'w'),
              indent=2)

    # Top-down visualization
    fig, ax = plt.subplots(figsize=(11, 11), facecolor='#0d0f14')
    ax.set_facecolor('#0d0f14')
    sl = slice(None, None, 4)
    rgb_pp = np.zeros((n_ref, 3), dtype=np.uint8)
    for i, name in enumerate(STATE_NAMES):
        rgb_pp[state == i] = CLASSIFICATION_COLORS[name]
    ax.scatter(ref_xyz[sl, 0], ref_xyz[sl, 1],
               c=rgb_pp[sl] / 255.0, s=0.4, marker='.', linewidths=0,
               rasterized=True)
    ax.set_aspect('equal')
    ax.set_xlabel('east (m)', color='#aaa')
    ax.set_ylabel('north (m)', color='#aaa')
    ax.tick_params(colors='#aaa')
    for s in ax.spines.values(): s.set_color('#444')
    title = (f'Temporal history (ref={os.path.basename(ref_dir)[:10]}, '
             f'{n_caps} captures)  ·  '
             + '  '.join(f'{k}={v:,}' for k, v in n_state.items()))
    ax.set_title(title, color='#fff', fontsize=10)
    handles = []
    for k in STATE_NAMES:
        handles.append(plt.Line2D([0], [0], marker='o', linestyle='',
                                  color=CLASSIFICATION_COLORS[k] / 255.0,
                                  label=f'{k} ({n_state[k]:,})'))
    leg = ax.legend(handles=handles, loc='upper right', frameon=True)
    leg.get_frame().set_facecolor('#1a1d24')
    for t in leg.get_texts(): t.set_color('#ddd')
    fig.tight_layout()
    fig.savefig(os.path.join(out_dir, 'history_topdown.png'), dpi=140,
                facecolor=fig.get_facecolor())
    plt.close(fig)

    print(f'\nOutputs in: {out_dir}')


if __name__ == '__main__':
    main()
