#!/usr/bin/env python3
"""
Render a boundary GeoJSON (and optional sampling points) onto a basemap and
save as PNG.

Colors: hot pink boundary (#FF6FAF), Tiffany blue points (#0ABAB5).

Uses geopandas + contextily (server-side tile fetch → matplotlib composite).
No headless browser, no tile-load race conditions.
"""

import argparse
import sys
from pathlib import Path

import geopandas as gpd
import contextily as cx
import matplotlib.pyplot as plt

BASEMAPS = {
    'osm':            cx.providers.OpenStreetMap.Mapnik,
    'carto-light':    cx.providers.CartoDB.Positron,
    'carto-dark':     cx.providers.CartoDB.DarkMatter,
    'esri-satellite': cx.providers.Esri.WorldImagery,
}

BOUNDARY_COLOR = '#FF6FAF'   # hot pink
POINT_COLOR_LIGHT = '#0ABAB5'  # Tiffany blue on light basemaps
POINT_COLOR_DARK  = '#1FDBD3'  # brighter on dark/satellite


def to_webmercator(path: Path) -> gpd.GeoDataFrame:
    gdf = gpd.read_file(path)
    if gdf.crs is None:
        gdf = gdf.set_crs(epsg=4326)
    return gdf.to_crs(epsg=3857)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--boundary', required=True, help='boundary GeoJSON path')
    ap.add_argument('--points',   default=None,  help='optional points GeoJSON path')
    ap.add_argument('--out',      required=True, help='output PNG path')
    ap.add_argument('--basemap',  default='osm', choices=list(BASEMAPS.keys()))
    ap.add_argument('--width',    type=int, default=1600)
    ap.add_argument('--height',   type=int, default=1200)
    ap.add_argument('--title',    default='')
    args = ap.parse_args()

    boundary_path = Path(args.boundary)
    if not boundary_path.is_file():
        print(f'boundary file not found: {boundary_path}', file=sys.stderr)
        return 1

    boundary = to_webmercator(boundary_path)
    if boundary.empty:
        print('boundary GeoJSON has no features', file=sys.stderr)
        return 1

    points = None
    if args.points:
        pts_path = Path(args.points)
        if pts_path.is_file():
            points = to_webmercator(pts_path)

    dark = args.basemap in ('carto-dark', 'esri-satellite')
    point_color = POINT_COLOR_DARK if dark else POINT_COLOR_LIGHT
    text_color = '#ffffff' if dark else '#111111'

    dpi = 120
    fig, ax = plt.subplots(
        figsize=(args.width / dpi, args.height / dpi), dpi=dpi
    )
    # Make the axes fill the whole figure — no matplotlib-default whitespace.
    fig.subplots_adjust(left=0, right=1, top=1, bottom=0)

    # Boundary: translucent pink fill + solid pink outline
    boundary.plot(ax=ax, facecolor=BOUNDARY_COLOR, edgecolor='none', alpha=0.15)
    boundary.boundary.plot(ax=ax, edgecolor=BOUNDARY_COLOR, linewidth=2.5)

    # Sampling points
    if points is not None and not points.empty:
        points.plot(
            ax=ax, markersize=8, color=point_color,
            edgecolor='white', linewidth=0.3, alpha=0.9,
        )

    # Lock axes to current extent before adding basemap so contextily picks
    # the right zoom based on the feature bbox (plus a small padding).
    minx, miny, maxx, maxy = boundary.total_bounds
    pad_x = (maxx - minx) * 0.05
    pad_y = (maxy - miny) * 0.05
    ax.set_xlim(minx - pad_x, maxx + pad_x)
    ax.set_ylim(miny - pad_y, maxy + pad_y)

    try:
        cx.add_basemap(ax, source=BASEMAPS[args.basemap], attribution_size=7)
    except Exception as e:
        print(f'WARN: basemap fetch failed ({e}); saving without tiles', file=sys.stderr)

    ax.set_axis_off()

    if args.title:
        ax.text(
            0.02, 0.98, args.title,
            transform=ax.transAxes, ha='left', va='top',
            fontsize=18, fontweight='bold', color=text_color,
            bbox=dict(
                facecolor='white' if not dark else 'black',
                alpha=0.75 if not dark else 0.55,
                edgecolor='none', boxstyle='round,pad=0.4',
            ),
        )

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # Don't use bbox_inches='tight' — it re-crops the figure and throws away
    # the exact requested dimensions.
    plt.savefig(out_path, dpi=dpi, pad_inches=0)
    plt.close(fig)
    print(f'OK: {out_path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
