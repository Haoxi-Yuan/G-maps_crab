#!/usr/bin/env python3
"""Build manuscript figures and summary data for the surface-temporal paper.

The script is intentionally read-only with respect to TEST data. It composes
publication-oriented figures from existing diagnostics and structured catalog
tables, then writes all outputs into this paper directory.
"""

from __future__ import annotations

import csv
import html
import json
import math
import os
import tempfile
import textwrap
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

os.environ.setdefault("MPLCONFIGDIR", str(Path(tempfile.gettempdir()) / "matplotlib-codex"))

import duckdb
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch, Rectangle
from PIL import Image, ImageDraw, ImageFont


def find_repo_root() -> Path:
    here = Path(__file__).resolve()
    for parent in [here, *here.parents]:
        if (parent / "TEST").exists():
            return parent
    raise RuntimeError("Could not find repository root containing TEST/")


REPO_ROOT = find_repo_root()
TEST_ROOT = REPO_ROOT / "TEST"
PAPER_ROOT = Path(__file__).resolve().parents[1]
FIG_DIR = PAPER_ROOT / "figures"
FIG_DIR.mkdir(parents=True, exist_ok=True)
AI_BASE_DIR = FIG_DIR / "generated_bases"
AI_PROMPT_LOG = AI_BASE_DIR / "imagegen_prompts.md"

SITE = "ghim_moh_market_food_centre"
CATALOG = TEST_ROOT / "data/catalog/sv3d.duckdb"
SURFACE_ROOT = TEST_ROOT / f"data/diagnostics/{SITE}/surface_fusion"
DERIVED_ROOT = TEST_ROOT / f"data/derived/{SITE}"
INTERMEDIATE_ROOT = TEST_ROOT / f"data/intermediate/{SITE}"
DIAGNOSTICS_ROOT = TEST_ROOT / f"data/diagnostics/{SITE}"


def rel(path: Path) -> str:
    return str(path.relative_to(REPO_ROOT))


def read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open(newline="") as f:
        return list(csv.DictReader(f))


def save_fig(fig: plt.Figure, name: str, dpi: int = 220) -> Path:
    out = FIG_DIR / name
    fig.savefig(out, dpi=dpi, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return out


def paste_fit(canvas: Image.Image, src: Image.Image, box: tuple[int, int, int, int]) -> None:
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    img = src.copy()
    img.thumbnail((w, h), Image.Resampling.LANCZOS)
    ox = x0 + (w - img.width) // 2
    oy = y0 + (h - img.height) // 2
    canvas.paste(img, (ox, oy))


def resize_to_width(path: Path, width: int, crop: tuple[int, int, int, int] | None = None) -> Image.Image:
    img = Image.open(path).convert("RGB")
    if crop is not None:
        img = img.crop(crop)
    scale = width / img.width
    height = max(1, int(round(img.height * scale)))
    return img.resize((width, height), Image.Resampling.LANCZOS)


def wrap_lines(text: str, width: int = 42) -> str:
    return "\n".join(textwrap.wrap(text, width=width))


def svg_escape(value: Any) -> str:
    return html.escape(str(value), quote=True)


def svg_text(
    x: float,
    y: float,
    text: str | list[str],
    size: int = 28,
    weight: int | str = 400,
    color: str = "#111827",
    family: str = "Inter, Arial, Helvetica, sans-serif",
    anchor: str = "start",
    line_height: float = 1.18,
) -> str:
    lines = text if isinstance(text, list) else str(text).splitlines()
    out = [
        f'<text x="{x:.1f}" y="{y:.1f}" font-family="{family}" font-size="{size}" '
        f'font-weight="{weight}" fill="{color}" text-anchor="{anchor}">'
    ]
    for idx, line in enumerate(lines):
        dy = 0 if idx == 0 else size * line_height
        out.append(f'<tspan x="{x:.1f}" dy="{dy:.1f}">{svg_escape(line)}</tspan>')
    out.append("</text>")
    return "\n".join(out)


def svg_rect(
    x: float,
    y: float,
    w: float,
    h: float,
    fill: str = "#ffffff",
    stroke: str = "#cbd5e1",
    sw: float = 2,
    rx: float = 16,
    opacity: float = 1.0,
) -> str:
    return (
        f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="{rx:.1f}" '
        f'fill="{fill}" fill-opacity="{opacity:.3f}" stroke="{stroke}" stroke-width="{sw:.1f}"/>'
    )


def svg_arrow(x1: float, y1: float, x2: float, y2: float, color: str = "#64748b", sw: float = 4) -> str:
    return (
        f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
        f'stroke="{color}" stroke-width="{sw:.1f}" marker-end="url(#arrow)"/>'
    )


def svg_file_box(
    x: float,
    y: float,
    title: str,
    rows: list[str],
    w: float = 520,
    fill: str = "#f8fafc",
    stroke: str = "#94a3b8",
) -> tuple[str, float]:
    h = 92 + 32 * len(rows)
    parts = [svg_rect(x, y, w, h, fill=fill, stroke=stroke, sw=2.2, rx=18)]
    parts.append(svg_rect(x, y, w, 54, fill=stroke, stroke=stroke, sw=0, rx=18, opacity=0.18))
    parts.append(svg_text(x + 24, y + 38, title, size=25, weight=800, color="#0f172a"))
    yy = y + 84
    for row in rows:
        parts.append(svg_text(x + 26, yy, row, size=20, color="#334155"))
        yy += 32
    return "\n".join(parts), h


def write_svg(path: Path, width: int, height: int, body: str) -> Path:
    defs = """
<defs>
  <marker id="arrow" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="strokeWidth">
    <path d="M2,2 L10,6 L2,10 z" fill="#64748b"/>
  </marker>
  <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
    <feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#64748b" flood-opacity="0.18"/>
  </filter>
</defs>
"""
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}">\n'
        f'<rect width="{width}" height="{height}" fill="#ffffff"/>\n'
        f"{defs}\n{body}\n</svg>\n"
    )
    path.write_text(svg)
    return path


def draw_box(
    ax: plt.Axes,
    xy: tuple[float, float],
    wh: tuple[float, float],
    title: str,
    body: str,
    face: str = "#f7f9fb",
    edge: str = "#2d3748",
) -> None:
    x, y = xy
    w, h = wh
    patch = FancyBboxPatch(
        (x, y),
        w,
        h,
        boxstyle="round,pad=0.018,rounding_size=0.025",
        facecolor=face,
        edgecolor=edge,
        linewidth=1.25,
    )
    ax.add_patch(patch)
    ax.text(x + 0.025, y + h - 0.08, title, fontsize=12, fontweight="bold", va="top", color="#111827")
    ax.text(x + 0.025, y + h - 0.17, wrap_lines(body, 34), fontsize=9, va="top", color="#374151")


def draw_arrow(ax: plt.Axes, start: tuple[float, float], end: tuple[float, float], color: str = "#374151") -> None:
    ax.add_patch(
        FancyArrowPatch(
            start,
            end,
            arrowstyle="-|>",
            mutation_scale=16,
            linewidth=1.4,
            color=color,
            shrinkA=6,
            shrinkB=6,
        )
    )


def save_ai_base_overlay(
    base_path: Path,
    output_name: str,
    labels: list[dict[str, Any]],
    dpi: int = 220,
) -> Path:
    """Overlay exact manuscript labels on a generated text-free base image."""
    img = Image.open(base_path).convert("RGB")
    fig, ax = plt.subplots(figsize=(16, 9))
    ax.imshow(img)
    ax.axis("off")
    ax.set_position([0, 0, 1, 1])

    for item in labels:
        x, y = item["xy"]
        text = item["text"]
        fontsize = item.get("fontsize", 13)
        weight = item.get("weight", "normal")
        color = item.get("color", "#111827")
        ha = item.get("ha", "center")
        va = item.get("va", "center")
        bbox = item.get("bbox", True)
        box = None
        if bbox:
            box = {
                "boxstyle": item.get("boxstyle", "round,pad=0.34,rounding_size=0.12"),
                "facecolor": item.get("facecolor", "white"),
                "edgecolor": item.get("edgecolor", "#d1d5db"),
                "linewidth": item.get("linewidth", 0.8),
                "alpha": item.get("alpha", 0.88),
            }
        ax.text(
            x,
            y,
            text,
            transform=ax.transAxes,
            ha=ha,
            va=va,
            fontsize=fontsize,
            fontweight=weight,
            color=color,
            bbox=box,
            linespacing=1.18,
        )

    out = FIG_DIR / output_name
    fig.savefig(out, dpi=dpi, bbox_inches="tight", pad_inches=0.02, facecolor="white")
    plt.close(fig)
    return out


def figure_conceptual_pipeline() -> tuple[Path, dict[str, Any]]:
    base = AI_BASE_DIR / "fig_01_conceptual_pipeline_base.png"
    if base.exists():
        labels = [
            {
                "xy": (0.025, 0.955),
                "text": "a  From Street View panorama to surface-time atlas",
                "fontsize": 19,
                "weight": "bold",
                "ha": "left",
                "bbox": False,
            },
            {"xy": (0.10, 0.18), "text": "RGB panorama\n+ camera pose", "fontsize": 12, "weight": "bold"},
            {"xy": (0.29, 0.24), "text": "pixel rays\nr_ij", "fontsize": 12, "weight": "bold"},
            {"xy": (0.42, 0.18), "text": "indexmap cell\nI(i,j) -> plane k", "fontsize": 12, "weight": "bold"},
            {"xy": (0.61, 0.20), "text": "local-to-world\nR, p_pano", "fontsize": 12, "weight": "bold"},
            {"xy": (0.74, 0.20), "text": "global surface\nfactor", "fontsize": 12, "weight": "bold"},
            {"xy": (0.90, 0.20), "text": "temporal atlas\nrows x years", "fontsize": 12, "weight": "bold"},
            {
                "xy": (0.50, 0.065),
                "text": "x_local = d_k r_ij / (n_k^T r_ij)     X_world = R x_local + p_pano     q_t(u,v) = R_t^T (X(u,v) - p_t)",
                "fontsize": 10,
                "family": "monospace",
                "bbox": True,
                "facecolor": "#f8fafc",
            },
        ]
        out = save_ai_base_overlay(base, "fig_01_conceptual_pipeline.png", labels)
        return out, {
            "id": "fig01",
            "output": rel(out),
            "source_paths": [rel(base), rel(AI_PROMPT_LOG)],
            "generation": "Generated text-free scientific schematic background with exact labels and formulas overlaid programmatically.",
            "evidence_use": "Frames the analytic move from panorama images to world-space surface factors.",
        }

    fig, ax = plt.subplots(figsize=(14, 8))
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.axis("off")

    ax.text(
        0.03,
        0.95,
        "Surface-temporal Street View alignment",
        fontsize=20,
        fontweight="bold",
        ha="left",
        va="top",
    )
    ax.text(
        0.03,
        0.89,
        "A panorama is treated as an observation of a world-space surface, not as the analytic unit.",
        fontsize=11,
        color="#4b5563",
        ha="left",
    )

    boxes = [
        ((0.04, 0.58), (0.22, 0.20), "One-time evidence capture", "photometa, panorama JPG, timeline, historical photometa/JPG, POI ftid, b2 grid"),
        ((0.35, 0.58), (0.23, 0.20), "Pixel to local plane", "indexmap cell I(i,j) selects plane k; ray r_ij intersects n_k dot X = d_k"),
        ((0.70, 0.58), (0.22, 0.20), "Local to world", "pose R and pano position p map each local plane into ENU world coordinates"),
        ((0.12, 0.22), (0.24, 0.20), "Global factor", "multi-pano observations with similar normal, offset and class define one surface factor"),
        ((0.44, 0.22), (0.22, 0.20), "Surface atlas", "basis vectors e_u and e_v define a metric 2D plane for rectified textures"),
        ((0.73, 0.22), (0.22, 0.20), "Space-time matrix", "rows are source panos; columns are capture dates; cells are accepted rectified evidence"),
    ]
    for i, (xy, wh, title, body) in enumerate(boxes):
        color = ["#eef6ff", "#f5f7fb", "#eefbf3", "#fff8e7", "#f6f1ff", "#fff1f2"][i]
        draw_box(ax, xy, wh, title, body, face=color)

    draw_arrow(ax, (0.26, 0.68), (0.35, 0.68))
    draw_arrow(ax, (0.58, 0.68), (0.70, 0.68))
    draw_arrow(ax, (0.79, 0.58), (0.24, 0.42))
    draw_arrow(ax, (0.36, 0.32), (0.44, 0.32))
    draw_arrow(ax, (0.66, 0.32), (0.73, 0.32))

    formula = (
        "r_ij = (sin theta cos phi, cos theta cos phi, sin phi)\n"
        "X_local = d_k r_ij / (n_k^T r_ij)\n"
        "X_world = R X_local + p_pano\n"
        "q_t(u,v) = R_t^T (X(u,v) - p_t)"
    )
    ax.text(
        0.04,
        0.08,
        formula,
        fontsize=12,
        family="monospace",
        va="bottom",
        color="#111827",
        bbox={"facecolor": "#f9fafb", "edgecolor": "#d1d5db", "pad": 8},
    )
    out = save_fig(fig, "fig_01_conceptual_pipeline.png")
    return out, {
        "id": "fig01",
        "output": rel(out),
        "source_paths": [],
        "generation": "Programmatic conceptual diagram from manuscript method definitions.",
        "evidence_use": "Frames the analytic move from panorama images to world-space surface factors.",
    }


def collect_data_summary() -> dict[str, Any]:
    validation = read_json(TEST_ROOT / "data/catalog/validation_report.json")
    all_probe = read_json(SURFACE_ROOT / "all_facade_rank_probe/summary.json")
    top30_summary = read_json(SURFACE_ROOT / "top30_best_hd_projection_allfacade/summary.json")
    rank_rows = read_csv_rows(SURFACE_ROOT / "temporal_spacetime_top30_best_hd_rank.csv")
    temporal_rows = read_csv_rows(
        SURFACE_ROOT / "top30_best_hd_projection_allfacade/temporal_rectified_observations.csv"
    )

    data: dict[str, Any] = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "site_id": SITE,
        "catalog_path": rel(CATALOG),
        "catalog_validation": {
            "status": validation.get("status"),
            "metrics": validation.get("metrics", {}),
        },
        "all_facade_rank_probe": all_probe,
        "top30_hd_projection": top30_summary,
        "top30_rank_head": rank_rows[:10],
    }

    if temporal_rows:
        years = sorted({row["year_month"] for row in temporal_rows if row.get("keep") == "True"})
        calendar_years = sorted({ym[:4] for ym in years if ym})
        keep_rows = [row for row in temporal_rows if row.get("keep") == "True"]
        data["top30_temporal_observations"] = {
            "candidate_rows": len(temporal_rows),
            "accepted_rows": len(keep_rows),
            "accepted_year_months": years,
            "accepted_year_month_count": len(years),
            "accepted_calendar_years": calendar_years,
            "accepted_calendar_year_count": len(calendar_years),
            "unique_gids": len({row["gid"] for row in keep_rows}),
            "unique_anchor_panos": len({row["anchor_panoid"] for row in keep_rows}),
            "median_valid_fraction": float(np.median([float(row["valid_fraction"]) for row in keep_rows])),
            "median_offset_residual_m": float(np.median([float(row["offset_residual_m"]) for row in keep_rows])),
            "median_normal_angle_deg": float(np.median([float(row["normal_angle_deg"]) for row in keep_rows])),
        }

    if CATALOG.exists():
        con = duckdb.connect(str(CATALOG), read_only=True)
        tables = [
            r[0]
            for r in con.execute(
                "SELECT table_name FROM information_schema.tables WHERE table_schema='main' ORDER BY table_name"
            ).fetchall()
        ]
        data["table_counts"] = {
            table: con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in tables
        }
        data["spatial_run"] = con.execute("SELECT * FROM spatial_runs LIMIT 1").fetchdf().to_dict("records")
        data["raw_asset_counts"] = {
            k: v
            for k, v in con.execute(
                "SELECT asset_type, COUNT(*) FROM raw_assets GROUP BY asset_type ORDER BY COUNT(*) DESC"
            ).fetchall()
        }
        data["global_factor_class_counts"] = {
            k: v
            for k, v in con.execute(
                "SELECT class, COUNT(*) FROM global_factors GROUP BY class ORDER BY COUNT(*) DESC"
            ).fetchall()
        }
        data["temporal_capture_year_counts"] = {
            k: v
            for k, v in con.execute(
                "SELECT substr(year_month, 1, 4) AS year, COUNT(*) FROM temporal_captures "
                "GROUP BY year ORDER BY year"
            ).fetchall()
            if k
        }
        gid11 = con.execute("SELECT * FROM global_factors WHERE gid=11").fetchdf().to_dict("records")
        data["gid_0011_global_factor"] = gid11[0] if gid11 else {}
        data["gid_0011_sources"] = con.execute(
            "SELECT panoid, local_plane_id, n_pixels, pano_east_m, pano_north_m, "
            "d_global, nx, ny, nz FROM global_factor_sources WHERE gid=11 ORDER BY n_pixels DESC"
        ).fetchdf().to_dict("records")
        con.close()

    out = PAPER_ROOT / "paper_data_summary.json"
    out.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    return data


def figure_data_acquisition(summary: dict[str, Any]) -> tuple[Path, dict[str, Any]]:
    metrics = summary.get("catalog_validation", {}).get("metrics", {})
    out = FIG_DIR / "fig_02_data_acquisition.svg"
    body: list[str] = []
    body.append(svg_text(90, 88, "b  One-time Street View evidence acquisition", size=52, weight=850))
    body.append(
        svg_text(
            92,
            136,
            "Raw spatial and temporal evidence is captured once; later algorithms only read from this immutable layer.",
            size=24,
            color="#475569",
        )
    )

    body.append(svg_text(95, 225, "Spatial raw capture", size=34, weight=800, color="#1d4ed8"))
    spatial, _ = svg_file_box(
        90,
        260,
        "data/raw/google_maps/spatial/<site>/<run>/",
        [
            "photometa.bin + parsed.json",
            "panoramas/<panoid>.jpg",
            "neighbor_photometas/<panoid>.bin",
            "tile_inventory.json",
            "screenshots/ + trace metadata",
            "POI ftid pair; place_id reserved",
            "b2/SVI click-to-go grid",
        ],
        w=760,
        fill="#eff6ff",
        stroke="#2563eb",
    )
    body.append(spatial)

    body.append(svg_text(95, 760, "Temporal raw capture", size=34, weight=800, color="#15803d"))
    temporal, _ = svg_file_box(
        90,
        795,
        "data/raw/google_maps/temporal/<anchor>/<stack>/",
        [
            "timeline.json",
            "captures/<date>_<panoid>/photometa.bin",
            "captures/<date>_<panoid>/parsed.json",
            "panoramas/<old_panoid>.jpg",
            "photometa_0_parsed_planes.json",
            "photometa_0_parsed_indexmap.bin",
            "photometa_0_parsed_depthmap.bin",
            "merged_pointcloud.npz / .ply",
            "pointcloud_meta.json",
        ],
        w=760,
        fill="#f0fdf4",
        stroke="#16a34a",
    )
    body.append(temporal)

    body.append(svg_arrow(870, 525, 1060, 525, "#2563eb", 5))
    body.append(svg_arrow(870, 1050, 1060, 820, "#16a34a", 5))

    parsed, _ = svg_file_box(
        1080,
        365,
        "Parsed geometry primitives",
        [
            "panoid, lat, lng",
            "heading_deg, pitch_deg, roll_deg",
            "plane table: nx, ny, nz, d",
            "indexmap: 256 x 512 uint8",
            "depthmap: 256 x 512",
            "b2 region ids and target-panoid estimate",
            "capture year_month",
        ],
        w=690,
        fill="#fff7ed",
        stroke="#ea580c",
    )
    body.append(parsed)

    body.append(svg_arrow(1788, 550, 1980, 550, "#64748b", 5))
    body.append(svg_arrow(1788, 725, 1980, 725, "#64748b", 5))

    body.append(svg_text(2020, 225, "Cataloged evidence", size=34, weight=800, color="#6d28d9"))
    catalog_rows = [
        ("raw_assets", metrics.get("raw_assets.count", "n/a"), "asset_type, relative_path, sha256, panoid"),
        ("pano_observations", metrics.get("pano_observations.count", "n/a"), "lat/lng, east/north/up, n_planes, n_points"),
        ("visible_pois", metrics.get("visible_pois.count", "n/a"), "ftid_0, ftid_1, place_id, name, category"),
        ("b2_regions", metrics.get("b2_regions.count", "n/a"), "cell_count, centroid_heading_deg, target_panoid"),
        ("temporal_captures", metrics.get("temporal_captures.count", "n/a"), "year_month, returned panoid, parsed_path"),
        ("plane_observations", metrics.get("plane_observations.count", "n/a"), "local_n*, local_d, world_n*, world_d"),
    ]
    body.append(svg_rect(1985, 260, 895, 710, fill="#faf5ff", stroke="#7c3aed", sw=2.4, rx=22))
    body.append(svg_rect(2025, 312, 815, 76, fill="#ede9fe", stroke="#c4b5fd", sw=1.4, rx=12))
    body.append(svg_text(2050, 360, "DuckDB catalog: data/catalog/sv3d.duckdb", size=25, weight=800))
    y = 430
    for table, count, fields in catalog_rows:
        body.append(svg_rect(2025, y - 34, 815, 74, fill="#ffffff", stroke="#ddd6fe", sw=1.2, rx=10))
        body.append(svg_text(2050, y, f"{table}  ({count})", size=23, weight=800, color="#3b0764"))
        body.append(svg_text(2420, y, fields, size=18, color="#475569"))
        y += 88

    body.append(svg_text(1080, 1125, "Layer separation", size=30, weight=800, color="#0f172a"))
    layer_rows = [
        ("raw", "source evidence; never rewritten by algorithms", "#dbeafe"),
        ("intermediate", "decoded geometry, indexmap/depth/planes, point clouds", "#fed7aa"),
        ("derived", "global factors, surface crops, atlas textures, correspondences", "#dcfce7"),
        ("diagnostics", "overlays, topdown checks, spacetime matrices", "#fce7f3"),
    ]
    x = 1080
    for name, desc, fill in layer_rows:
        body.append(svg_rect(x, 1165, 420, 126, fill=fill, stroke="#94a3b8", sw=1.5, rx=16))
        body.append(svg_text(x + 22, 1210, name, size=25, weight=800))
        body.append(svg_text(x + 22, 1248, textwrap.wrap(desc, width=32), size=18, color="#475569"))
        x += 455

    write_svg(out, 3000, 1360, "\n".join(body))
    return out, {
        "id": "fig02",
        "output": rel(out),
        "source_paths": [rel(TEST_ROOT / "data/catalog/validation_report.json"), rel(CATALOG)],
        "generation": "Information-dense SVG generated from exact file names, catalog tables, field names and validation counts.",
        "evidence_use": "Documents the one-time raw data capture block and the metadata fields that enable 3D inference.",
    }


def figure_geometry_decoding() -> tuple[Path, dict[str, Any]]:
    overlay = DIAGNOSTICS_ROOT / "indexmap_overlay/JqSnKB7Pp-XymzXWDuP71w_overlay.png"
    npz_path = INTERMEDIATE_ROOT / "01_depthmap_pointcloud_baseline/merged_pointcloud.npz"
    fig = plt.figure(figsize=(15, 8))
    gs = fig.add_gridspec(2, 3, width_ratios=[1.35, 1.15, 0.9], height_ratios=[1, 1], wspace=0.20, hspace=0.20)

    ax_img = fig.add_subplot(gs[:, 0])
    ax_img.imshow(Image.open(overlay).convert("RGB"))
    ax_img.set_title("Indexmap categories over panorama", fontsize=12, fontweight="bold")
    ax_img.axis("off")

    ax_pc = fig.add_subplot(gs[:, 1])
    if npz_path.exists():
        arr = np.load(npz_path)
        rng = np.random.default_rng(42)
        n = len(arr["x"])
        idx = rng.choice(n, size=min(70000, n), replace=False)
        rgb = arr["rgb"][idx].astype(float) / 255.0
        ax_pc.scatter(arr["x"][idx], arr["y"][idx], c=rgb, s=0.12, alpha=0.55, linewidths=0)
        ax_pc.set_aspect("equal", adjustable="box")
        ax_pc.set_xlabel("east (m)")
        ax_pc.set_ylabel("north (m)")
        ax_pc.set_title("Colored 3D samples from ray-plane intersections", fontsize=12, fontweight="bold")
        ax_pc.grid(True, color="#e5e7eb", linewidth=0.5)
    else:
        ax_pc.text(0.5, 0.5, "Point cloud file not found", ha="center", va="center")
        ax_pc.axis("off")

    ax_eq = fig.add_subplot(gs[0, 2])
    ax_eq.axis("off")
    ax_eq.set_title("Core decoding equations", fontsize=12, fontweight="bold")
    eq_text = (
        "theta_ij = ((j + 0.5) / W) 2pi - pi\n"
        "phi_ij = pi/2 - ((i + 0.5) / H) pi\n\n"
        "r_ij = (sin theta cos phi,\n"
        "       cos theta cos phi,\n"
        "       sin phi)\n\n"
        "k = I(i,j)\n"
        "t_ij = d_k / (n_k^T r_ij)\n"
        "x_local = t_ij r_ij"
    )
    ax_eq.text(0.02, 0.92, eq_text, family="monospace", fontsize=10, va="top")

    ax_meta = fig.add_subplot(gs[1, 2])
    ax_meta.axis("off")
    rows = [
        ("I(i,j)", "indexmap cell id"),
        ("n_k,d_k", "plane row k"),
        ("RGB(i,j)", "pano JPG sample"),
        ("x,y,z", "derived 3D point"),
        ("source", "build_rgb_pointcloud.py"),
    ]
    for i, (a, b) in enumerate(rows):
        y = 0.88 - i * 0.16
        ax_meta.text(0.02, y, a, fontweight="bold", fontsize=10, color="#111827")
        ax_meta.text(0.28, y, b, fontsize=10, color="#374151")

    out = save_fig(fig, "fig_03_geometry_decoding_case.png")
    return out, {
        "id": "fig03",
        "output": rel(out),
        "source_paths": [rel(overlay), rel(npz_path)],
        "generation": "Composed from a high-quality indexmap overlay and a fixed random sample of the merged RGB point cloud.",
        "evidence_use": "Shows the transition from categorical indexmap alignment to metric colored 3D evidence.",
    }


def figure_world_transform_validation() -> tuple[Path, dict[str, Any]]:
    source = INTERMEDIATE_ROOT / "03_planes_world/ground_normal_validation.png"
    img = resize_to_width(source, 1650)
    canvas = Image.new("RGB", (2300, max(img.height + 80, 1050)), "white")
    paste_fit(canvas, img, (30, 80, 1700, canvas.height - 30))

    fig, ax = plt.subplots(figsize=(8, 7))
    ax.axis("off")
    ax.text(0.02, 0.96, "Pose transform used for world-frame planes", fontsize=15, fontweight="bold", va="top")
    text = (
        "Local axes: +x right, +y front, +z up\n"
        "World axes: +x east, +y north, +z up\n\n"
        "R = R_z(-h) R_x(p - 90 deg) R_y(r)\n\n"
        "h: heading_deg from photometa\n"
        "p: pitch_deg from photometa\n"
        "r: roll_deg from photometa\n\n"
        "n_world = R n_local\n"
        "d_global = d_local + n_world^T p_pano\n\n"
        "The diagnostic checks whether ground normals cluster near the gravity direction after rotation."
    )
    ax.text(0.02, 0.85, text, fontsize=11, va="top", linespacing=1.35)
    formula_path = FIG_DIR / "_tmp_formula_world_transform.png"
    fig.savefig(formula_path, dpi=220, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    paste_fit(canvas, Image.open(formula_path).convert("RGB"), (1720, 80, 2280, canvas.height - 30))
    formula_path.unlink(missing_ok=True)

    out = FIG_DIR / "fig_04_world_transform_validation.png"
    canvas.save(out)
    return out, {
        "id": "fig04",
        "output": rel(out),
        "source_paths": [rel(source), rel(TEST_ROOT / "src/py/diagnostics/filter_and_rectify.py"), rel(TEST_ROOT / "src/py/derive/derive_planes_world.py")],
        "generation": "Composed from ground normal validation diagnostics and the pose transform implemented in code.",
        "evidence_use": "Connects the local-to-world rotation formula with a visible validation of ground normal clustering.",
    }


def figure_factor_topology(summary: dict[str, Any]) -> tuple[Path, dict[str, Any]]:
    con = duckdb.connect(str(CATALOG), read_only=True)
    panos = con.execute("SELECT panoid, east_m, north_m FROM pano_observations").fetchdf()
    src = con.execute(
        "SELECT panoid, local_plane_id, n_pixels, pano_east_m, pano_north_m, d_global, nx, ny, nz "
        "FROM global_factor_sources WHERE gid=11 ORDER BY n_pixels DESC"
    ).fetchdf()
    factor = con.execute("SELECT * FROM factor_geometries WHERE gid=11").fetchdf()
    pois = con.execute(
        "SELECT panoid, name, category FROM visible_pois WHERE panoid IN "
        "(SELECT panoid FROM global_factor_sources WHERE gid=11) LIMIT 10"
    ).fetchdf()
    con.close()

    fig, (ax, ax_table) = plt.subplots(1, 2, figsize=(14, 8), gridspec_kw={"width_ratios": [1.55, 0.9]})
    ax.set_title("Topology of one surface factor: gid_0011", fontsize=14, fontweight="bold")
    ax.scatter(panos["east_m"], panos["north_m"], s=22, color="#cbd5e1", label="spatial pano")
    sizes = np.clip(src["n_pixels"].to_numpy() / max(src["n_pixels"].max(), 1) * 220, 35, 220)
    ax.scatter(src["pano_east_m"], src["pano_north_m"], s=sizes, color="#2563eb", alpha=0.72, label="source pano")

    if not factor.empty:
        row = factor.iloc[0]
        rect = Rectangle(
            (row["bbox_x_min"], row["bbox_y_min"]),
            row["bbox_x_max"] - row["bbox_x_min"],
            row["bbox_y_max"] - row["bbox_y_min"],
            facecolor="#fb7185",
            alpha=0.12,
            edgecolor="#e11d48",
            linewidth=1.4,
            label="factor extent",
        )
        ax.add_patch(rect)
        n = np.array([row["nx"], row["ny"]], dtype=float)
        d = float(row["d_global"])
        norm2 = float(np.dot(n, n))
        if norm2 > 1e-9:
            center = d * n / norm2
            tangent = np.array([-n[1], n[0]])
            length = 95
            p0 = center - tangent * length
            p1 = center + tangent * length
            ax.plot([p0[0], p1[0]], [p0[1], p1[1]], color="#be123c", linewidth=2.0, label="factor plane")
            for _, srow in src.head(12).iterrows():
                p = np.array([srow["pano_east_m"], srow["pano_north_m"]], dtype=float)
                foot = p + ((d - float(np.dot(n, p))) / norm2) * n
                ax.plot([p[0], foot[0]], [p[1], foot[1]], color="#64748b", linewidth=0.7, alpha=0.55)

    for _, row in src.head(6).iterrows():
        ax.text(row["pano_east_m"] + 1.2, row["pano_north_m"] + 1.2, row["panoid"][:5], fontsize=7)

    ax.set_xlabel("east (m)")
    ax.set_ylabel("north (m)")
    ax.grid(True, color="#e5e7eb", linewidth=0.6)
    ax.set_aspect("equal", adjustable="box")
    ax.legend(loc="lower left", fontsize=8, frameon=True)

    ax_table.axis("off")
    gf = summary.get("gid_0011_global_factor", {})
    rank = summary.get("top30_rank_head", [{}])[0] if summary.get("top30_rank_head") else {}
    txt = [
        "Factor summary",
        f"class: {gf.get('class', 'facade')}",
        f"sources: {gf.get('n_sources', 'n/a')}",
        f"unique panos: {gf.get('n_unique_panos', 'n/a')}",
        f"offset spread: {float(gf.get('offset_spread_m', 0)):.3f} m" if gf else "offset spread: n/a",
        f"rank: {rank.get('rank', 'n/a')}",
        f"accepted cells: {rank.get('accepted_cells', 'n/a')}",
        f"accepted years: {rank.get('accepted_years', 'n/a')}",
        "",
        "Nearby POI references",
    ]
    for _, prow in pois.head(6).iterrows():
        name = str(prow["name"])[:34]
        cat = str(prow["category"])[:24]
        txt.append(f"- {name} ({cat})")
    ax_table.text(0.02, 0.96, "\n".join(txt), fontsize=10, va="top", linespacing=1.35)

    out = save_fig(fig, "fig_05_factor_topology_gid0011.png")
    return out, {
        "id": "fig05",
        "output": rel(out),
        "source_paths": [rel(CATALOG)],
        "generation": "Programmatic top-down topology plot from pano_observations, global_factor_sources, factor_geometries and visible_pois.",
        "evidence_use": "Shows how one global factor is supported by multiple panos and linked to local spatial references.",
    }


def figure_catalog_schema(summary: dict[str, Any]) -> tuple[Path, dict[str, Any]]:
    counts = summary.get("table_counts", {})
    groups = [
        ("Raw Evidence", "#1d4ed8", ["spatial_runs", "raw_assets", "temporal_batches", "tile_requests"]),
        ("Pano, POI, SVI Topology", "#15803d", ["pano_observations", "visible_pois", "b2_regions"]),
        ("Parsed Geometry", "#ea580c", ["parsed_photometa", "indexmap_rectification", "plane_observations"]),
        (
            "World Factor Geometry",
            "#7c3aed",
            [
                "global_factors",
                "global_factor_sources",
                "local_plane_supports",
                "local_plane_boundaries_3d",
                "factor_geometries",
            ],
        ),
        (
            "Visibility and Surface Products",
            "#be123c",
            [
                "factor_visibility_candidates",
                "factor_observation_quality",
                "surface_crops",
                "surface_rectified_observations",
                "surface_stitches",
            ],
        ),
        (
            "Temporal Correspondence",
            "#0f766e",
            [
                "temporal_stacks",
                "temporal_captures",
                "temporal_factor_correspondences",
                "temporal_surface_comparisons",
            ],
        ),
    ]

    con = duckdb.connect(str(CATALOG), read_only=True)
    table_columns = {
        table: [row[1] for row in con.execute(f"PRAGMA table_info('{table}')").fetchall()]
        for _, _, tables in groups
        for table in tables
    }
    con.close()

    col_w = 1220
    gutter = 70
    margin_x = 90
    margin_y = 185
    body: list[str] = [
        svg_text(90, 88, "f  DuckDB catalog schema with exact table fields", size=52, weight=850),
        svg_text(
            92,
            136,
            "Large rasters remain as files; the catalog stores project-relative paths, geometry summaries, quality metrics and provenance keys.",
            size=24,
            color="#475569",
        ),
    ]
    group_heights: list[float] = []
    card_gap = 26
    for _, _, tables in groups:
        h = 86
        for table in tables:
            n = len(table_columns.get(table, []))
            h += 72 + max(70, math.ceil(n / 2) * 26) + card_gap
        group_heights.append(h)
    row1_h = max(group_heights[:3])
    row2_h = max(group_heights[3:])
    height = int(margin_y + row1_h + 110 + row2_h + 120)

    def draw_group(gx: float, gy: float, title: str, color: str, tables: list[str], h: float) -> str:
        parts: list[str] = []
        parts.append(svg_rect(gx, gy, col_w, h, fill="#ffffff", stroke=color, sw=3.0, rx=26))
        parts.append(svg_rect(gx, gy, col_w, 72, fill=color, stroke=color, sw=0, rx=26, opacity=0.10))
        parts.append(svg_text(gx + 28, gy + 48, title, size=31, weight=850, color=color))
        y = gy + 100
        for table in tables:
            cols = table_columns.get(table, [])
            card_h = 72 + max(70, math.ceil(len(cols) / 2) * 26)
            parts.append(svg_rect(gx + 26, y, col_w - 52, card_h, fill="#f8fafc", stroke="#cbd5e1", sw=1.4, rx=14))
            parts.append(
                svg_text(
                    gx + 50,
                    y + 38,
                    f"{table}  ({counts.get(table, 'n/a')} rows)",
                    size=24,
                    weight=800,
                    color="#0f172a",
                )
            )
            left = cols[::2]
            right = cols[1::2]
            yy = y + 76
            for col in left:
                parts.append(svg_text(gx + 54, yy, col, size=17, color="#334155", family="Menlo, Consolas, monospace"))
                yy += 26
            yy = y + 76
            for col in right:
                parts.append(svg_text(gx + 575, yy, col, size=17, color="#334155", family="Menlo, Consolas, monospace"))
                yy += 26
            y += card_h + card_gap
        return "\n".join(parts)

    for idx, (title, color, tables) in enumerate(groups[:3]):
        x = margin_x + idx * (col_w + gutter)
        body.append(draw_group(x, margin_y, title, color, tables, row1_h))
    y2 = margin_y + row1_h + 100
    for idx, (title, color, tables) in enumerate(groups[3:]):
        x = margin_x + idx * (col_w + gutter)
        body.append(draw_group(x, y2, title, color, tables, row2_h))

    body.append(svg_arrow(margin_x + col_w, margin_y + row1_h * 0.50, margin_x + col_w + gutter, margin_y + row1_h * 0.50))
    body.append(svg_arrow(margin_x + 2 * col_w + gutter, margin_y + row1_h * 0.50, margin_x + 2 * (col_w + gutter), margin_y + row1_h * 0.50))
    body.append(svg_arrow(margin_x + col_w * 0.5, margin_y + row1_h, margin_x + col_w * 0.5, y2))
    body.append(svg_arrow(margin_x + col_w * 1.5 + gutter, margin_y + row1_h, margin_x + col_w * 1.5 + gutter, y2))
    body.append(svg_arrow(margin_x + col_w * 2.5 + 2 * gutter, margin_y + row1_h, margin_x + col_w * 2.5 + 2 * gutter, y2))

    out = FIG_DIR / "fig_06_catalog_schema.svg"
    write_svg(out, int(margin_x * 2 + col_w * 3 + gutter * 2), height, "\n".join(body))
    return out, {
        "id": "fig06",
        "output": rel(out),
        "source_paths": [rel(TEST_ROOT / "schema/sv3d_catalog.sql"), rel(CATALOG)],
        "generation": "Large information-first SVG generated from DuckDB PRAGMA table_info and table row counts; every shown field name is an exact catalog column.",
        "evidence_use": "Explains how raw files, parsed geometry, surface products and temporal evidence remain queryable.",
    }


def figure_existing_crop(
    source: Path,
    output_name: str,
    registry_id: str,
    evidence_use: str,
    width: int = 2400,
    crop: tuple[int, int, int, int] | None = None,
) -> tuple[Path, dict[str, Any]]:
    img = resize_to_width(source, width, crop=crop)
    out = FIG_DIR / output_name
    img.save(out)
    return out, {
        "id": registry_id,
        "output": rel(out),
        "source_paths": [rel(source)],
        "generation": "Downsampled and cropped from existing project diagnostics for manuscript layout.",
        "evidence_use": evidence_use,
    }


def resolve_project_path(path_text: str) -> Path:
    path = Path(path_text)
    if path.is_absolute():
        return path
    if path.parts and path.parts[0] == "data":
        return TEST_ROOT / path
    return REPO_ROOT / path


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial Bold.ttf" if bold else "/Library/Fonts/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def fit_image(img: Image.Image, box: tuple[int, int]) -> Image.Image:
    out = img.copy().convert("RGB")
    out.thumbnail(box, Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", box, "white")
    canvas.paste(out, ((box[0] - out.width) // 2, (box[1] - out.height) // 2))
    return canvas


def crop_visible_content(img: Image.Image, threshold: int = 244, pad: int = 8) -> Image.Image:
    arr = np.asarray(img.convert("RGB"))
    mask = np.mean(arr, axis=2) < threshold
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return img.convert("RGB")
    x0 = max(0, int(xs.min()) - pad)
    x1 = min(img.width, int(xs.max()) + pad + 1)
    y0 = max(0, int(ys.min()) - pad)
    y1 = min(img.height, int(ys.max()) + pad + 1)
    return img.convert("RGB").crop((x0, y0, x1, y1))


def visual_readability_score(path: Path, valid_fraction: float = 1.0) -> float:
    if not path.exists():
        return -1.0
    img = Image.open(path).convert("RGB")
    cropped = crop_visible_content(img)
    aspect = cropped.width / max(cropped.height, 1)
    content_area = (cropped.width * cropped.height) / max(img.width * img.height, 1)
    # Prefer crops that can fill a manuscript cell without becoming a thin strip.
    aspect_score = math.exp(-abs(math.log(max(aspect, 1e-6) / 1.55)))
    area_score = min(content_area / 0.45, 1.0)
    return float(valid_fraction) * (0.55 * aspect_score + 0.45 * area_score)


def draw_cell(
    draw: ImageDraw.ImageDraw,
    canvas: Image.Image,
    img_path: Path,
    x: int,
    y: int,
    w: int,
    h: int,
    label: str,
    sublabel: str = "",
) -> None:
    title_font = load_font(28, bold=True)
    sub_font = load_font(20)
    draw.rounded_rectangle((x, y, x + w, y + h), radius=16, fill="white", outline="#cbd5e1", width=2)
    draw.text((x + 18, y + 14), label, fill="#111827", font=title_font)
    if sublabel:
        draw.text((x + 18, y + 48), sublabel, fill="#64748b", font=sub_font)
    image_top = y + 78
    image_h = h - 96
    if img_path.exists():
        crop = fit_image(crop_visible_content(Image.open(img_path)), (w - 34, image_h))
        canvas.paste(crop, (x + 17, image_top))
    else:
        draw.text((x + 18, image_top + 32), f"missing: {img_path.name}", fill="#be123c", font=sub_font)


def pick_evenly(rows: list[dict[str, str]], n: int) -> list[dict[str, str]]:
    if len(rows) <= n:
        return rows
    idxs = np.linspace(0, len(rows) - 1, n).round().astype(int)
    seen: set[int] = set()
    picked = []
    for idx in idxs:
        if int(idx) not in seen:
            picked.append(rows[int(idx)])
            seen.add(int(idx))
    return picked


def figure_surface_atlas_example() -> tuple[Path, dict[str, Any]]:
    selected_gid = 57
    con = duckdb.connect(str(CATALOG), read_only=True)
    sources = con.execute(
        "SELECT panoid, local_plane_id, valid_fraction, rectified_path "
        f"FROM surface_rectified_observations WHERE gid={selected_gid} ORDER BY valid_fraction DESC"
    ).fetchdf().to_dict("records")
    stitch = con.execute(
        "SELECT texture_path, coverage_score, source_count, rectified_stack_path "
        f"FROM surface_stitches WHERE gid={selected_gid} LIMIT 1"
    ).fetchdf().to_dict("records")
    con.close()

    w, h = 2500, 1180
    canvas = Image.new("RGB", (w, h), "#f8fafc")
    draw = ImageDraw.Draw(canvas)
    title_font = load_font(52, bold=True)
    body_font = load_font(26)
    draw.text((70, 54), f"g  Surface atlas example: gid_{selected_gid:04d}, three source panoramas", fill="#111827", font=title_font)
    draw.text(
        (74, 122),
        "Each source crop is already rectified into the same atlas dimensions before any pixel-level fusion.",
        fill="#475569",
        font=body_font,
    )

    cell_w, cell_h = 760, 290
    x0, y0 = 70, 210
    for idx, row in enumerate(sources[:3]):
        draw_cell(
            draw,
            canvas,
            resolve_project_path(str(row["rectified_path"])),
            x0 + idx * (cell_w + 40),
            y0,
            cell_w,
            cell_h,
            f"source pano {idx + 1}",
            f"{str(row['panoid'])[:12]}  plane {row['local_plane_id']}  valid {float(row['valid_fraction']):.3f}",
        )

    if stitch:
        row = stitch[0]
        draw_cell(
            draw,
            canvas,
            resolve_project_path(str(row["texture_path"])),
            250,
            590,
            900,
            330,
            "pixel-fused atlas texture",
            f"source_count {row['source_count']}  coverage {float(row['coverage_score']):.3f}",
        )
        draw_cell(
            draw,
            canvas,
            resolve_project_path(str(row["rectified_stack_path"])),
            1310,
            590,
            900,
            330,
            "rectified source stack",
            "same surface coordinate system",
        )

    note = (
        "Selection: a readable facade factor from the top-30 temporal set. The figure shows the complete current-source "
        "set for this factor, with white atlas margins removed for page layout."
    )
    draw.text((72, 1010), textwrap.fill(note, 132), fill="#475569", font=load_font(24))
    out = FIG_DIR / "fig_07_surface_atlas_gid0057_selected.png"
    canvas.save(out)
    return out, {
        "id": "fig07",
        "output": rel(out),
        "source_paths": [rel(CATALOG)],
        "generation": f"Curated paper figure composed from gid_{selected_gid:04d} rectified source observations and pixel-fused atlas texture; visible content is cropped before fitting.",
        "evidence_use": "Shows plane-rectified multi-pano candidates without the full diagnostic overview density.",
    }


def figure_temporal_alignment_example() -> tuple[Path, dict[str, Any]]:
    selected_gid = "57"
    csv_path = SURFACE_ROOT / "top30_best_hd_projection_allfacade/temporal_rectified_observations.csv"
    rows = [r for r in read_csv_rows(csv_path) if r.get("keep") == "True" and r.get("gid") == selected_gid]
    by_anchor: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        by_anchor[row["anchor_panoid"]].append(row)
    anchor, anchor_rows = max(
        by_anchor.items(),
        key=lambda kv: (
            len(kv[1]),
            np.median(
                [
                    visual_readability_score(resolve_project_path(r["rectified_path"]), float(r["valid_fraction"]))
                    for r in kv[1]
                ]
            ),
        ),
    )
    anchor_rows = sorted(anchor_rows, key=lambda r: r["year_month"])
    picked = pick_evenly(anchor_rows, 7)

    w, h = 2800, 700
    canvas = Image.new("RGB", (w, h), "#f8fafc")
    draw = ImageDraw.Draw(canvas)
    draw.text((70, 52), f"h  Temporal alignment example for gid_{int(selected_gid):04d}", fill="#111827", font=load_font(50, bold=True))
    draw.text(
        (74, 120),
        f"One source pano row selected for visual readability: {anchor[:18]}. Cells are accepted rectified historical textures.",
        fill="#475569",
        font=load_font(25),
    )
    cell_w, cell_h = 360, 320
    x0, y0 = 70, 210
    for idx, row in enumerate(picked):
        draw_cell(
            draw,
            canvas,
            resolve_project_path(row["rectified_path"]),
            x0 + idx * (cell_w + 30),
            y0,
            cell_w,
            cell_h,
            row["year_month"],
            f"valid {float(row['valid_fraction']):.2f}  d {float(row['offset_residual_m']):.2f} m",
        )
    draw.text(
        (74, 590),
        "The full 4-row x 13-year diagnostic grid remains available as source evidence; this panel is a page-layout subset.",
        fill="#475569",
        font=load_font(24),
    )
    out = FIG_DIR / "fig_08_temporal_alignment_gid0057_selected.png"
    canvas.save(out)
    return out, {
        "id": "fig08",
        "output": rel(out),
        "source_paths": [rel(csv_path)],
        "generation": "Curated temporal strip selected from accepted gid_0057 temporal observations using visual readability scoring.",
        "evidence_use": "Shows cross-year rectification for one stable factor without using the full dense diagnostic grid.",
    }


def figure_final_exemplar_matrix() -> tuple[Path, dict[str, Any]]:
    rank_path = SURFACE_ROOT / "temporal_spacetime_top30_best_hd_rank.csv"
    csv_path = SURFACE_ROOT / "top30_best_hd_projection_allfacade/temporal_rectified_observations.csv"
    rank_rows = read_csv_rows(rank_path)
    readable_gids = {"57", "26", "53"}
    candidates = [r for r in rank_rows if r["gid"] in readable_gids]
    gids = [r["gid"] for r in candidates]
    rows = [r for r in read_csv_rows(csv_path) if r.get("keep") == "True" and r.get("gid") in gids]
    by_gid_anchor: dict[str, dict[str, list[dict[str, str]]]] = defaultdict(lambda: defaultdict(list))
    for row in rows:
        by_gid_anchor[row["gid"]][row["anchor_panoid"]].append(row)

    def draw_dominant_cell(
        img_path: Path,
        x: int,
        y: int,
        w: int,
        h: int,
        label: str,
        sublabel: str,
    ) -> None:
        draw.rounded_rectangle((x, y, x + w, y + h), radius=16, fill="#ffffff", outline="#cbd5e1", width=2)
        draw.text((x + 16, y + 12), label, fill="#111827", font=load_font(26, bold=True))
        draw.text((x + 126, y + 16), sublabel, fill="#64748b", font=load_font(19))
        image_top = y + 58
        image_box = (w - 32, h - 74)
        if img_path.exists():
            crop = fit_image(crop_visible_content(Image.open(img_path)), image_box)
            canvas.paste(crop, (x + 16, image_top))
        else:
            draw.text((x + 16, image_top + 40), f"missing: {img_path.name}", fill="#be123c", font=load_font(19))

    w, h = 2700, 1340
    canvas = Image.new("RGB", (w, h), "#f8fafc")
    draw = ImageDraw.Draw(canvas)
    draw.text((70, 52), "i  Readable surface-time evidence from top-30 factors", fill="#111827", font=load_font(48, bold=True))
    draw.text(
        (74, 118),
        "Three accepted factors are selected for page-readable surface occupancy; extremely thin atlas strips are excluded.",
        fill="#475569",
        font=load_font(24),
    )

    label_w, cell_w, cell_h = 330, 500, 335
    x0, y0 = 70, 200
    for ridx, rank_row in enumerate(candidates):
        gid = rank_row["gid"]
        anchors = by_gid_anchor[gid]
        anchor, arows = max(
            anchors.items(),
            key=lambda kv: (
                len(kv[1]),
                np.median(
                    [
                        visual_readability_score(resolve_project_path(r["rectified_path"]), float(r["valid_fraction"]))
                        for r in kv[1]
                    ]
                ),
            ),
        )
        picked = pick_evenly(sorted(arows, key=lambda r: r["year_month"]), 4)
        y = y0 + ridx * (cell_h + 28)
        draw.rounded_rectangle((x0, y, x0 + label_w, y + cell_h), radius=16, fill="#ffffff", outline="#cbd5e1", width=2)
        draw.text((x0 + 22, y + 28), f"gid_{int(gid):04d}", fill="#111827", font=load_font(30, bold=True))
        draw.text((x0 + 22, y + 72), f"rank {rank_row['rank']}  years {rank_row['accepted_years']}", fill="#475569", font=load_font(22))
        draw.text((x0 + 22, y + 106), f"valid {float(rank_row['median_valid_fraction']):.2f}", fill="#475569", font=load_font(22))
        draw.text((x0 + 22, y + 140), f"median d {float(rank_row['median_offset_residual_m']):.2f} m", fill="#475569", font=load_font(22))
        for cidx, row in enumerate(picked):
            draw_dominant_cell(
                resolve_project_path(row["rectified_path"]),
                x0 + label_w + 30 + cidx * (cell_w + 26),
                y,
                cell_w,
                cell_h,
                row["year_month"],
                f"valid {float(row['valid_fraction']):.2f}",
            )

    out = FIG_DIR / "fig_09_top_factor_readable_matrix.png"
    canvas.save(out)
    return out, {
        "id": "fig09",
        "output": rel(out),
        "source_paths": [rel(rank_path), rel(csv_path)],
        "generation": "Curated 3-factor x 4-year matrix selected from top30 accepted cells using visual occupancy/readability plus temporal acceptance status.",
        "evidence_use": "Summarizes the final result in a page-readable subset while preserving full top30 diagnostics as source evidence.",
    }


def write_registry(entries: list[dict[str, Any]]) -> None:
    lines = ["figures:"]
    for entry in entries:
        lines.append(f"  - id: {entry['id']}")
        lines.append(f"    output: {entry['output']}")
        source_paths = entry.get("source_paths", [])
        if source_paths:
            lines.append("    source_paths:")
            for path in source_paths:
                lines.append(f"      - {path}")
        else:
            lines.append("    source_paths: []")
        lines.append(f"    generation: {json.dumps(entry.get('generation', ''))}")
        lines.append(f"    evidence_use: {json.dumps(entry.get('evidence_use', ''))}")
    (PAPER_ROOT / "figure_registry.yml").write_text("\n".join(lines) + "\n")


def main() -> None:
    entries: list[dict[str, Any]] = []
    summary = collect_data_summary()

    for maker in [
        figure_conceptual_pipeline,
        lambda: figure_data_acquisition(summary),
        figure_geometry_decoding,
        figure_world_transform_validation,
        lambda: figure_factor_topology(summary),
        lambda: figure_catalog_schema(summary),
    ]:
        _, reg = maker()
        entries.append(reg)

    for maker in [
        figure_surface_atlas_example,
        figure_temporal_alignment_example,
        figure_final_exemplar_matrix,
    ]:
        _, reg = maker()
        entries.append(reg)

    write_registry(entries)
    print(f"Wrote {len(entries)} figures to {rel(FIG_DIR)}")
    print(f"Wrote {rel(PAPER_ROOT / 'paper_data_summary.json')}")
    print(f"Wrote {rel(PAPER_ROOT / 'figure_registry.yml')}")


if __name__ == "__main__":
    main()
