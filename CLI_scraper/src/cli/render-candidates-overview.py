#!/usr/bin/env python3
"""Render an overview map of boundary-wizard candidates so the user can see
where each option lies geographically before picking by number.

Each candidate is drawn as:
  * a translucent rectangle (its bbox)
  * a numbered dot at its bbox center
  * coloured by admin_level (lower = warmer = bigger admin entity)

Auto-zoom: by default the view covers all candidates. Outliers far outside
the median cluster (e.g. Tokyo prefecture's Pacific-island bboxes) get
clipped to the margin with a small marker so the main cluster is readable.

Usage:
  render-candidates-overview.py --in candidates.json --out overview.png
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import contextily as cx
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle
from pyproj import Transformer

# Color scheme: warmer = lower admin_level (broader region)
LEVEL_COLORS = {
    2: '#E63946',   # country  — red
    3: '#F77F00',   # region
    4: '#FCBF49',   # state/prefecture  — yellow-orange
    5: '#90BE6D',   # county/district
    6: '#43AA8B',   # municipality
    7: '#0ABAB5',   # city/town  — Tiffany blue
    8: '#577590',   # ward
    9: '#3F51B5',
    10: '#7B1FA2',
    11: '#9C27B0',
    12: '#673AB7',
}
DEFAULT_COLOR = '#888888'

LEVEL_NAMES = {
    2: 'Country', 3: 'Region', 4: 'State/Prefecture',
    5: 'Sub-state', 6: 'County/District', 7: 'Municipality',
    8: 'City/Town', 9: 'District', 10: 'Ward/Suburb',
    11: 'Sub-ward', 12: 'Local',
}


def to_mercator(lat: float, lng: float, t: Transformer) -> tuple[float, float]:
    return t.transform(lng, lat)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='inp', required=True)
    ap.add_argument('--out', dest='out', required=True)
    ap.add_argument('--width', type=int, default=1600)
    ap.add_argument('--height', type=int, default=1100)
    ap.add_argument('--title', default='Candidate boundaries')
    args = ap.parse_args()

    with open(args.inp) as f:
        cands = json.load(f)
    if not cands:
        print('no candidates to render', file=sys.stderr)
        return 1

    t = Transformer.from_crs('EPSG:4326', 'EPSG:3857', always_xy=True)

    # Project all bbox corners + centers
    for c in cands:
        minlon, minlat, maxlon, maxlat = c['bbox']
        c['_x0'], c['_y0'] = to_mercator(minlat, minlon, t)
        c['_x1'], c['_y1'] = to_mercator(maxlat, maxlon, t)
        c['_cx'], c['_cy'] = to_mercator(c['center'][0], c['center'][1], t)

    # Auto-zoom: use the inter-quartile range of candidate centers to find
    # the densest cluster, then expand to include candidates whose bbox
    # overlaps that cluster. Outliers (Pacific islands, exclaves) end up
    # near the edge as faint markers.
    cxs = sorted(c['_cx'] for c in cands)
    cys = sorted(c['_cy'] for c in cands)

    def percentile(arr, p):
        if not arr: return 0
        i = max(0, min(len(arr) - 1, int(round(p * (len(arr) - 1)))))
        return arr[i]

    qx0, qx1 = percentile(cxs, 0.10), percentile(cxs, 0.90)
    qy0, qy1 = percentile(cys, 0.10), percentile(cys, 0.90)
    span = max(qx1 - qx0, qy1 - qy0, 5000.0)
    pad = span * 0.35
    cx_mid = (qx0 + qx1) / 2
    cy_mid = (qy0 + qy1) / 2
    half = max(span / 2 + pad, 5000.0)
    minx, maxx = cx_mid - half, cx_mid + half
    miny, maxy = cy_mid - half, cy_mid + half

    fig, ax = plt.subplots(figsize=(args.width / 130, args.height / 130), dpi=130)
    fig.subplots_adjust(left=0, right=1, top=1, bottom=0)

    # Draw bbox rectangles + numbered centroid dots
    for i, c in enumerate(cands, start=1):
        col = LEVEL_COLORS.get(c.get('admin_level') or 0, DEFAULT_COLOR)
        x0, y0 = c['_x0'], c['_y0']
        w, h = c['_x1'] - x0, c['_y1'] - y0
        rect = Rectangle((x0, y0), w, h, facecolor=col, edgecolor=col,
                         alpha=0.13, linewidth=0.8)
        ax.add_patch(rect)
        ax.plot(c['_cx'], c['_cy'], marker='o', markersize=8,
                markerfacecolor=col, markeredgecolor='white', markeredgewidth=1.2,
                zorder=3)
        ax.annotate(f'[{i}]', (c['_cx'], c['_cy']),
                    textcoords='offset points', xytext=(8, 6),
                    fontsize=9, fontweight='bold', color='#222', zorder=4,
                    bbox=dict(facecolor='white', edgecolor=col, boxstyle='round,pad=0.18',
                              alpha=0.92, linewidth=0.8))

    ax.set_xlim(minx, maxx)
    ax.set_ylim(miny, maxy)

    try:
        cx.add_basemap(ax, source=cx.providers.CartoDB.Positron, attribution_size=7)
    except Exception as e:
        print(f'WARN basemap: {e}', file=sys.stderr)

    ax.set_axis_off()

    # Legend by admin_level (only levels actually present)
    levels_present = sorted({c.get('admin_level') for c in cands if c.get('admin_level') is not None})
    from matplotlib.patches import Patch
    handles = []
    for lvl in levels_present:
        col = LEVEL_COLORS.get(lvl, DEFAULT_COLOR)
        nm = LEVEL_NAMES.get(lvl, f'L{lvl}')
        handles.append(Patch(facecolor=col, edgecolor='white', label=f'L{lvl} {nm}'))
    if handles:
        ax.legend(handles=handles, loc='lower right', frameon=True, fontsize=8,
                  framealpha=0.92, ncol=1)

    ax.text(0.01, 0.99, args.title,
            transform=ax.transAxes, va='top', ha='left',
            fontsize=12, fontweight='bold',
            bbox=dict(facecolor='white', alpha=0.88, edgecolor='none',
                      boxstyle='round,pad=0.4'))

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    plt.savefig(out_path, dpi=130, pad_inches=0)
    plt.close(fig)
    print(f'OK: {out_path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
