#!/usr/bin/env python3
"""ICP refinement of the GPS-based temporal alignment.

derive_temporal_alignment.py translates each capture by the panoid lat/lng
delta — that gets us within ~1-2m. ICP then refines using stable structure
(facade + roof points; skip vegetation, ground noise, oblique) to <30cm.

Per-capture transform model: 4 DOF
   T(p) = R_yaw · p + (tx, ty, tz)
where R_yaw is a rotation about the world z-axis. Camera pose is gravity-
aligned by Google so we don't need to estimate roll/pitch; yaw can drift
across captures because of compass noise. Z translation captures camera-
height differences (Google's car / trekker height varies slightly).

Pipeline:
  1. Read aligned_pointcloud.npz from each capture (post GPS-translate).
  2. Filter to stable points: cls in {facade=2, roof=3}.
  3. ICP-align every non-reference capture's stable cloud to the ref's.
  4. Apply the resulting (R_yaw, t) to ALL points and re-save as
     refined_pointcloud.npz.
  5. Output `<stack>/aligned/icp_refinement.parquet` with per-capture
     residual RMSE before/after, transform params, n correspondences,
     and a diagnostic PNG comparing before/after at building level.

Usage:
  python3 src/py/derive/derive_temporal_icp.py \
      --stack-dir <stack>/  [--ref-capture <name>]
      [--max-corr-dist 2.0] [--subsample 4]
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


CLS_NAMES = {0: 'sky', 1: 'ground', 2: 'facade', 3: 'roof', 4: 'oblique'}
STABLE_CLS = {2, 3}   # facade + roof


def icp_4dof(source, target, max_iter=40, tol=1e-4, max_corr_dist=2.0):
    """4-DOF ICP: (tx, ty, tz, yaw). Both inputs (N, 3) world-frame points.

    Returns:
      T (4x4) homogeneous transform that maps source → ref frame
      rmse_history list, n_corr_final
    """
    src = source.copy().astype(np.float64)
    target = target.astype(np.float64)
    target_xy = target[:, :2]
    tree_xy = cKDTree(target_xy)
    T = np.eye(4)
    rmse_hist = []
    n_corr = 0
    for it in range(max_iter):
        src_xy = src[:, :2]
        dists_xy, idxs = tree_xy.query(src_xy, k=1)
        # Reject pairs whose XY distance exceeds threshold OR whose Z mismatch is huge
        z_resid = np.abs(src[:, 2] - target[idxs, 2])
        keep = (dists_xy < max_corr_dist) & (z_resid < max_corr_dist * 1.5)
        n_corr = int(keep.sum())
        if n_corr < 50:
            print(f'    iter {it}: only {n_corr} correspondences — stop')
            break
        s = src[keep]
        t = target[idxs[keep]]

        # ----- xy: solve 2D rigid (R_yaw, tx, ty) -----
        s_mean = s[:, :2].mean(0)
        t_mean = t[:, :2].mean(0)
        s_d = s[:, :2] - s_mean
        t_d = t[:, :2] - t_mean
        H = s_d.T @ t_d
        U, _, Vt = np.linalg.svd(H)
        R2 = Vt.T @ U.T
        if np.linalg.det(R2) < 0:
            Vt[-1] *= -1
            R2 = Vt.T @ U.T
        t2 = t_mean - R2 @ s_mean

        # ----- z: median delta -----
        dz = float(np.median(t[:, 2] - s[:, 2]))

        # Apply to src
        src[:, :2] = src[:, :2] @ R2.T + t2
        src[:, 2] += dz

        # Update full T
        T_step = np.eye(4)
        T_step[:2, :2] = R2
        T_step[:2, 3] = t2
        T_step[2, 3] = dz
        T = T_step @ T

        # RMSE on the corresponding 3D distances after step
        # Re-query for clean RMSE
        dists_xy_post, _ = tree_xy.query(src[:, :2], k=1)
        rmse = float(np.sqrt((dists_xy_post[dists_xy_post < max_corr_dist] ** 2).mean()))
        rmse_hist.append(rmse)
        if it > 1 and abs(rmse_hist[-2] - rmse) < tol:
            break
    return T, rmse_hist, n_corr


def apply_transform(T, points):
    """Apply 4x4 homogeneous transform to (N, 3) points."""
    h = np.hstack([points, np.ones((points.shape[0], 1))])
    return (h @ T.T)[:, :3]


def load_capture(cap_dir):
    """Load aligned (post-GPS) point cloud."""
    fp = os.path.join(cap_dir, 'aligned_pointcloud.npz')
    if not os.path.exists(fp):
        return None
    d = np.load(fp)
    pts = np.column_stack([d['x'], d['y'], d['z']]).astype(np.float64)
    return pts, d


def diagnostic_panel(ax, pts, label, ref_pts, color):
    sl = slice(None, None, 5)
    ax.scatter(ref_pts[sl, 0], ref_pts[sl, 1], s=0.3, c='#3a4258',
               marker='.', linewidths=0, rasterized=True, alpha=0.5)
    ax.scatter(pts[sl, 0], pts[sl, 1], s=0.5, c=[color],
               marker='.', linewidths=0, rasterized=True, alpha=0.8)
    ax.set_aspect('equal')
    for s in ax.spines.values(): s.set_color('#444')
    ax.tick_params(colors='#aaa', labelsize=8)
    ax.xaxis.label.set_color('#aaa'); ax.yaxis.label.set_color('#aaa')
    ax.title.set_color('#fff')
    ax.set_title(label, fontsize=10)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--stack-dir', required=True)
    ap.add_argument('--ref-capture', default=None)
    ap.add_argument('--max-corr-dist', type=float, default=2.0,
                    help='Reject correspondences with XY distance above this (m)')
    ap.add_argument('--subsample', type=int, default=4,
                    help='Take every Nth stable point (speed; default 4)')
    args = ap.parse_args()

    stack = args.stack_dir
    out_dir = os.path.join(stack, 'aligned')
    manifest_fp = os.path.join(out_dir, 'stack_manifest.parquet')
    if not os.path.exists(manifest_fp):
        print(f'Run derive_temporal_alignment.py first.', file=sys.stderr); sys.exit(2)
    manifest = pd.read_parquet(manifest_fp).copy()

    captures_root = os.path.join(stack, 'captures')
    captures = sorted(manifest['capture_name'].tolist())
    print(f'Captures: {len(captures)}')

    # Select reference
    ref_row = manifest[manifest['is_reference']]
    if len(ref_row) and not args.ref_capture:
        ref_name = ref_row.iloc[0]['capture_name']
    else:
        ref_name = args.ref_capture or captures[-1]
    print(f'Reference: {ref_name}')

    # Load reference stable points
    ref_pts, ref_d = load_capture(os.path.join(captures_root, ref_name))
    ref_cls = ref_d['cls']
    ref_stable_mask = np.isin(ref_cls, list(STABLE_CLS))
    ref_stable = ref_pts[ref_stable_mask][::args.subsample]
    print(f'  ref stable points: {ref_stable.shape[0]:,}')

    icp_rows = []
    fig_panels = []
    for cap in captures:
        cdir = os.path.join(captures_root, cap)
        loaded = load_capture(cdir)
        if loaded is None:
            print(f'  skip {cap}: no aligned cloud'); continue
        pts, d = loaded
        cls = d['cls']
        stable_mask = np.isin(cls, list(STABLE_CLS))
        stable = pts[stable_mask][::args.subsample]
        if cap == ref_name:
            # Identity transform; record stats
            icp_rows.append({
                'capture_name': cap, 'is_reference': True,
                'rmse_before_m': 0.0, 'rmse_after_m': 0.0,
                'n_corr': stable.shape[0],
                'tx_m': 0.0, 'ty_m': 0.0, 'tz_m': 0.0, 'yaw_deg': 0.0,
                'iter': 0,
            })
            out_kwargs = {'x': d['x'], 'y': d['y'], 'z': d['z']}
            for k in d.files:
                if k not in ('x', 'y', 'z'):
                    out_kwargs[k] = d[k]
            np.savez_compressed(os.path.join(cdir, 'refined_pointcloud.npz'),
                                 **out_kwargs)
            continue
        # Pre-ICP RMSE: NN on stable points
        tree_ref = cKDTree(ref_stable[:, :2])
        d_pre, _ = tree_ref.query(stable[:, :2], k=1)
        rmse_pre = float(np.sqrt((d_pre[d_pre < args.max_corr_dist * 2] ** 2).mean())
                         if (d_pre < args.max_corr_dist * 2).any() else d_pre.mean())
        # Run ICP
        t0 = time.time()
        T, rmse_hist, n_corr = icp_4dof(stable, ref_stable,
                                         max_corr_dist=args.max_corr_dist)
        rmse_post = rmse_hist[-1] if rmse_hist else float('nan')
        iters = len(rmse_hist)
        # Apply T to ALL points (not just stable)
        all_pts_refined = apply_transform(T, pts)
        out_kwargs = {'x': all_pts_refined[:, 0].astype(np.float32),
                      'y': all_pts_refined[:, 1].astype(np.float32),
                      'z': all_pts_refined[:, 2].astype(np.float32)}
        for k in d.files:
            if k not in ('x', 'y', 'z'):
                out_kwargs[k] = d[k]
        np.savez_compressed(os.path.join(cdir, 'refined_pointcloud.npz'),
                             **out_kwargs)
        # Decompose T
        R = T[:3, :3]
        yaw = float(np.degrees(np.arctan2(R[1, 0], R[0, 0])))
        tx, ty, tz = T[0, 3], T[1, 3], T[2, 3]
        icp_rows.append({
            'capture_name': cap, 'is_reference': False,
            'rmse_before_m': round(rmse_pre, 3),
            'rmse_after_m': round(rmse_post, 3),
            'n_corr': n_corr,
            'tx_m': round(float(tx), 3), 'ty_m': round(float(ty), 3),
            'tz_m': round(float(tz), 3), 'yaw_deg': round(yaw, 3),
            'iter': iters,
        })
        # Save before/after points for diagnostic
        fig_panels.append({
            'cap': cap[:10], 'before': stable, 'after': apply_transform(T, stable),
        })
        print(f'  {cap[:10]}  RMSE  pre={rmse_pre:.2f}m  post={rmse_post:.2f}m  '
              f'(t=({tx:+.2f},{ty:+.2f},{tz:+.2f})m yaw={yaw:+.2f}°  iter={iters}  '
              f'n_corr={n_corr})  in {time.time()-t0:.1f}s')

    icp_df = pd.DataFrame(icp_rows)
    icp_df.to_parquet(os.path.join(out_dir, 'icp_refinement.parquet'), index=False)
    print(f'\nWrote icp_refinement.parquet')

    # Update manifest with refined RMSE (for downstream visibility)
    manifest = manifest.merge(
        icp_df[['capture_name', 'rmse_before_m', 'rmse_after_m',
                'tx_m', 'ty_m', 'tz_m', 'yaw_deg']],
        on='capture_name', how='left')
    manifest.to_parquet(manifest_fp, index=False)

    # Diagnostic: before/after for each non-ref capture
    if fig_panels:
        n = len(fig_panels)
        fig, axes = plt.subplots(2, n, figsize=(n * 3.6, 7.2))
        fig.patch.set_facecolor('#0d0f14')
        if n == 1:
            axes = axes.reshape(2, 1)
        for j, p in enumerate(fig_panels):
            for ax in axes[:, j]:
                ax.set_facecolor('#0d0f14')
            diagnostic_panel(axes[0, j], p['before'], f"{p['cap']} BEFORE",
                             ref_stable, '#ff8844')
            diagnostic_panel(axes[1, j], p['after'], f"{p['cap']} AFTER",
                             ref_stable, '#44eecc')
            axes[0, j].set_xlabel('east (m)')
            axes[1, j].set_xlabel('east (m)')
            if j == 0:
                axes[0, j].set_ylabel('north (m)')
                axes[1, j].set_ylabel('north (m)')
        fig.suptitle(
            f'ICP refinement at anchor (ref = {ref_name[:10]})  '
            f'· grey = ref stable pts  · top row = pre-ICP, bottom = post-ICP',
            color='#fff', fontsize=12, y=0.995)
        fig.tight_layout()
        fig.savefig(os.path.join(out_dir, 'icp_before_after.png'), dpi=130,
                    facecolor=fig.get_facecolor())
        plt.close(fig)
        print(f'Wrote icp_before_after.png')

    # Print summary
    if len(icp_rows) > 1:
        non_ref = icp_df[~icp_df['is_reference']]
        print(f'\n=== ICP summary ===')
        print(non_ref[['capture_name', 'rmse_before_m', 'rmse_after_m',
                       'tx_m', 'ty_m', 'tz_m', 'yaw_deg', 'n_corr']].to_string(index=False))
        print(f'\nMean RMSE pre  = {non_ref["rmse_before_m"].mean():.2f} m')
        print(f'Mean RMSE post = {non_ref["rmse_after_m"].mean():.2f} m')
        print(f'Reduction      = {100*(1-non_ref["rmse_after_m"].mean()/non_ref["rmse_before_m"].mean()):.0f}%')


if __name__ == '__main__':
    main()
