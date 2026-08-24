"""Grid-layout figures and skyline overlay for the 12-capture temporal stack.

Companion to temporal_jq_compare.py. Reuses the same per-capture loader and
gravity-rectification path, but emits paper-friendly grid layouts (4 cols x 3
rows) and a single skyline-overlay plot that visualizes how stable the
building outline is across 17 years once gravity has been removed.

Outputs in TEST/data/diagnostics/temporal/JqSnKB7Pp_compare/:
  pano_grid.png          12 raw RGB panoramas, 4x3 grid, dated
  indexmap_grid.png      12 gravity-rectified indexmaps, 4x3 grid, dated
  skyline_overlay.png    one axes, 12 colored skyline curves
  skyline_data.json      per-capture topmost-facade row vector
"""

import json
from pathlib import Path

import numpy as np
import matplotlib.pyplot as plt
import matplotlib as mpl
from PIL import Image, ImageDraw, ImageFont

import sys
sys.path.insert(0, str(Path(__file__).parent))
from filter_and_rectify import build_rotation, rectify_indexmap  # noqa
from temporal_jq_compare import (  # noqa
    CAPTURE_ROOT, OUT_DIR, FOCAL_PANOID,
    load_capture, classify_planes, colorize_indexmap_by_class,
)

CELL_W, CELL_H = 512, 256
LABEL_H = 28
GRID_COLS, GRID_ROWS = 4, 3
GAP = 6


def _load_font(size):
    try:
        return ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", size)
    except Exception:
        return ImageFont.load_default()


def cell_with_label(img_arr, label_main, label_sub):
    h, w = img_arr.shape[:2]
    canvas = Image.new("RGB", (w, h + LABEL_H), (250, 251, 253))
    canvas.paste(Image.fromarray(img_arr), (0, LABEL_H))
    draw = ImageDraw.Draw(canvas)
    draw.text((6, 4), label_main, fill=(20, 30, 50), font=_load_font(13))
    draw.text((6, 18), label_sub, fill=(96, 110, 130), font=_load_font(9))
    return np.array(canvas)


def assemble_grid(cells, cols=GRID_COLS, rows=GRID_ROWS, gap=GAP, bg=(255, 255, 255)):
    h, w = cells[0].shape[:2]
    grid_w = cols * w + (cols + 1) * gap
    grid_h = rows * h + (rows + 1) * gap
    grid = np.full((grid_h, grid_w, 3), bg, dtype=np.uint8)
    for k, cell in enumerate(cells):
        r, c = divmod(k, cols)
        y = gap + r * (h + gap)
        x = gap + c * (w + gap)
        grid[y:y + h, x:x + w] = cell
    return grid


def extract_skyline(idxmap_grav, cls_lookup):
    """Topmost-facade-or-ceiling row per column. NaN where column has no building."""
    cls_grav = cls_lookup[idxmap_grav]
    is_building = (cls_grav == 2) | (cls_grav == 3)
    any_building = is_building.any(axis=0)
    top_row = np.argmax(is_building, axis=0).astype(np.float32)
    top_row[~any_building] = np.nan
    return top_row


def main():
    cap_dirs = sorted(p for p in CAPTURE_ROOT.iterdir() if p.is_dir())
    captures = [load_capture(p) for p in cap_dirs]
    captures.sort(key=lambda c: c["date"])
    print(f"Loaded {len(captures)} captures")

    pano_cells = []
    idx_cells = []
    skylines = []
    skyline_meta = []

    for c in captures:
        cls = classify_planes(c["planes"])

        # Pano cell.
        jpg = Image.open(c["jpg_path"]).convert("RGB").resize(
            (CELL_W, CELL_H), Image.LANCZOS
        )
        pano_arr = np.array(jpg)
        date_label = c["date"][:7]
        sub_label = (
            f"hdg {c['heading']:.1f}°  pit {c['pitch']:.1f}°  "
            f"roll {c['roll']:.1f}°"
        )
        pano_cells.append(cell_with_label(pano_arr, date_label, sub_label))

        # Gravity-rectified indexmap cell.
        R = build_rotation(c["heading"], c["pitch"], c["roll"])
        idx_grav = rectify_indexmap(c["indexmap"], R, supersample=4)
        idx_rgb = colorize_indexmap_by_class(idx_grav, cls)
        idx_cell_img = Image.fromarray(idx_rgb).resize(
            (CELL_W, CELL_H), Image.NEAREST
        )
        idx_cells.append(
            cell_with_label(np.array(idx_cell_img), date_label, sub_label)
        )

        # Skyline (operate on the unscaled 256x512 gravity indexmap).
        sky = extract_skyline(idx_grav, cls)
        skylines.append(sky)
        skyline_meta.append({
            "date": c["date"][:7],
            "panoid": c["panoid"],
            "topmost_row_per_col": np.nan_to_num(sky, nan=-1).astype(int).tolist(),
            "n_facade_cols": int(np.isfinite(sky).sum()),
        })

    # Grids.
    pano_grid = assemble_grid(pano_cells)
    idx_grid = assemble_grid(idx_cells)
    Image.fromarray(pano_grid).save(OUT_DIR / "pano_grid.png", optimize=True)
    Image.fromarray(idx_grid).save(OUT_DIR / "indexmap_grid.png", optimize=True)
    print(f"wrote pano_grid.png  {pano_grid.shape}")
    print(f"wrote indexmap_grid.png {idx_grid.shape}")

    # Skyline overlay.
    fig, ax = plt.subplots(figsize=(12, 4.2), dpi=160)
    n = len(captures)
    cmap = mpl.colormaps["viridis"]
    cols_axis = np.arange(skylines[0].shape[0])
    azimuth_axis = (cols_axis - 256) * 360.0 / 512.0  # world-azimuth degrees
    for i, (c, sky) in enumerate(zip(captures, skylines)):
        ax.plot(
            azimuth_axis, sky,
            color=cmap(i / max(n - 1, 1)),
            linewidth=1.2,
            label=c["date"][:7],
            alpha=0.85,
        )
    ax.invert_yaxis()
    ax.set_xlabel("World azimuth (deg, 0 = north, gravity-rectified)")
    ax.set_ylabel("Topmost facade row (0 = zenith, 256 = nadir)")
    ax.set_title(
        "Building skyline at JqSnKB7Pp-XymzXWDuP71w across 12 captures (Nov 2008 – Mar 2025)"
    )
    ax.set_xlim(azimuth_axis.min(), azimuth_axis.max())
    ax.grid(True, alpha=0.25)
    ax.legend(
        loc="lower right", ncol=4, fontsize=8, framealpha=0.9,
        title="capture month",
    )
    fig.tight_layout()
    fig.savefig(OUT_DIR / "skyline_overlay.png", dpi=160)
    plt.close(fig)
    print(f"wrote skyline_overlay.png")

    (OUT_DIR / "skyline_data.json").write_text(
        json.dumps(skyline_meta, indent=2)
    )
    print(f"wrote skyline_data.json")


if __name__ == "__main__":
    main()
