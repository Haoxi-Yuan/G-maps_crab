#!/usr/bin/env python3
"""Visualize street-level topology from refined global plane matches.

Outputs:
  TEST/data/derived/<workspace-id>/04_global_factors_refined/street_topology/
    index.md
    topdown_whole_street.png
    selected_elements_topdown.png
    element_gid_<N>_*.png

Interpretation:
  - pano centers are observation nodes;
  - refined global plane gids are "same element" nodes;
  - gray/colored links show which panos observe the same element.
"""

from __future__ import annotations

import argparse
import colorsys
import csv
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Polygon
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visualize_global_plane_match_examples as match_examples  # noqa: E402
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sv3d_paths import add_spatial_args, resolve_spatial_paths  # noqa: E402


REFINED: Path
OUT: Path

QUALITY_COLORS = {"high": "#2ca02c", "medium": "#ffbf50", "low": "#d62728"}
CLASS_COLORS = {
    "ground": "#4faa66",
    "facade": "#8d6bd1",
    "ceiling": "#b7793f",
    "oblique": "#d149a8",
}


def configure_paths(paths):
    global REFINED, OUT
    REFINED = paths.global_factors_dir
    OUT = REFINED / "street_topology"
    match_examples.configure_paths(paths)


def gid_color(gid: int, sat=0.82, val=0.88):
    h = (gid * 0.6180339887498949) % 1.0
    return colorsys.hsv_to_rgb(h, sat, val)


def load_registry():
    data = json.loads((REFINED / "registry.json").read_text())
    return {int(r["gid"]): r for r in data["registry"]}


def load_sources():
    by_gid = defaultdict(list)
    pano_pos = {}
    with (REFINED / "sources.csv").open(newline="") as f:
        for row in csv.DictReader(f):
            row["gid"] = int(row["gid"])
            row["local_idx"] = int(row["local_idx"])
            row["n_pixels"] = int(row["n_pixels"])
            for k in ["d_local", "d_global", "n_x", "n_y", "n_z", "pano_east_m", "pano_north_m"]:
                row[k] = float(row[k])
            by_gid[row["gid"]].append(row)
            pano_pos[row["panoid"]] = (row["pano_east_m"], row["pano_north_m"])
    return by_gid, pano_pos


def xy_from_sources(sources: list[dict]) -> np.ndarray:
    return np.array([[s["pano_east_m"], s["pano_north_m"]] for s in sources], dtype=float)


def principal_order(points: np.ndarray) -> np.ndarray:
    if len(points) <= 1:
        return np.arange(len(points))
    centered = points - points.mean(axis=0)
    _, _, vh = np.linalg.svd(centered, full_matrices=False)
    proj = centered @ vh[0]
    return np.argsort(proj)


def ordered_pano_path(pano_pos: dict[str, tuple[float, float]]) -> np.ndarray:
    pts = np.array(list(pano_pos.values()), dtype=float)
    return pts[principal_order(pts)]


def facade_projection(row: dict, sources: list[dict]):
    nxy = np.array([row["nx"], row["ny"]], dtype=float)
    d = float(row["d_global"])
    den = float(np.dot(nxy, nxy))
    pts = xy_from_sources(sources)
    if den < 1e-8:
        return pts, np.zeros(len(pts)), None
    residual = (pts @ nxy - d) / math.sqrt(den)
    foot = pts - ((pts @ nxy - d) / den)[:, None] * nxy[None, :]
    tangent = np.array([-nxy[1], nxy[0]]) / math.sqrt(den)
    return foot, residual, tangent


def facade_segment(row: dict, sources: list[dict], min_len=8.0, pad=4.0):
    foot, _residual, tangent = facade_projection(row, sources)
    if tangent is None:
        return None
    center = np.median(foot, axis=0)
    t = (foot - center) @ tangent
    lo, hi = float(t.min() - pad), float(t.max() + pad)
    if hi - lo < min_len:
        mid = (lo + hi) / 2
        lo, hi = mid - min_len / 2, mid + min_len / 2
    return center + lo * tangent, center + hi * tangent


def hull_polygon(points: np.ndarray, pad=2.0):
    if len(points) < 3:
        return None
    pts = np.unique(points, axis=0)
    if len(pts) < 3:
        return None
    try:
        from scipy.spatial import ConvexHull
        hull = ConvexHull(pts)
        poly = pts[hull.vertices]
    except Exception:
        order = principal_order(pts)
        poly = pts[order]
    center = poly.mean(axis=0)
    vec = poly - center
    norm = np.linalg.norm(vec, axis=1)
    scale = np.where(norm > 1e-6, (norm + pad) / norm, 1.0)
    return center + vec * scale[:, None]


def select_examples(registry: dict[int, dict]) -> list[int]:
    rows = list(registry.values())

    def top(pred, key, n):
        vals = [r for r in rows if pred(r)]
        vals = sorted(vals, key=key)
        return [int(r["gid"]) for r in vals[:n]]

    gids = []
    gids += top(
        lambda r: r["classification"] == "facade" and r["quality"] == "high",
        lambda r: (-r["total_pixels"], -r["n_unique_panos"]),
        2,
    )
    gids += top(
        lambda r: r["classification"] == "facade" and r["quality"] == "medium",
        lambda r: (-r["n_unique_panos"], -r["total_pixels"]),
        1,
    )
    gids += top(
        lambda r: r["classification"] == "ground" and r["quality"] == "high",
        lambda r: (-r["total_pixels"], -r["n_unique_panos"]),
        1,
    )
    gids += top(
        lambda r: r["classification"] == "ground" and r["quality"] == "medium",
        lambda r: (-r["n_unique_panos"], -r["total_pixels"]),
        1,
    )
    out = []
    seen = set()
    for gid in gids:
        if gid not in seen:
            out.append(gid)
            seen.add(gid)
    return out


def draw_pano_path(ax, pano_pos: dict[str, tuple[float, float]], color="#222", alpha=0.8):
    path = ordered_pano_path(pano_pos)
    ax.plot(path[:, 0], path[:, 1], color=color, lw=1.2, alpha=alpha, zorder=2)
    ax.scatter(path[:, 0], path[:, 1], s=24, c="#d62728", edgecolor="black", linewidth=0.35, zorder=5, label="pano centers")


def draw_facade_element(ax, row, sources, color, lw=2.0, alpha=0.78, label=None):
    seg = facade_segment(row, sources)
    if seg is None:
        return
    a, b = seg
    ax.plot([a[0], b[0]], [a[1], b[1]], color=color, lw=lw, alpha=alpha, solid_capstyle="round", zorder=4, label=label)


def draw_ground_element(ax, row, sources, color, alpha=0.18, edge_alpha=0.55):
    pts = xy_from_sources(sources)
    poly = hull_polygon(pts)
    if poly is not None:
        ax.add_patch(Polygon(poly, closed=True, facecolor=color, edgecolor=color, alpha=alpha, lw=1.3, zorder=1))
        ax.plot(poly[:, 0], poly[:, 1], color=color, alpha=edge_alpha, lw=1.1, zorder=2)
    else:
        ax.scatter(pts[:, 0], pts[:, 1], s=20, c=[color], alpha=0.5, zorder=3)


def build_whole_topdown(registry, sources_by_gid, pano_pos, selected_gids):
    fig, axes = plt.subplots(1, 2, figsize=(20, 10), dpi=160)

    ax = axes[0]
    draw_pano_path(ax, pano_pos)
    facades = [
        r for r in registry.values()
        if r["classification"] == "facade" and r["quality"] in {"high", "medium"} and r["n_unique_panos"] >= 2
    ]
    facades = sorted(facades, key=lambda r: (-r["n_unique_panos"], -r["total_pixels"]))[:140]
    for r in facades:
        gid = int(r["gid"])
        color = gid_color(gid, sat=0.72, val=0.78)
        lw = 0.5 + min(2.5, math.log10(max(r["total_pixels"], 10)) * 0.35)
        draw_facade_element(ax, r, sources_by_gid[gid], color=color, lw=lw, alpha=0.55)
    for gid in selected_gids:
        r = registry[gid]
        if r["classification"] == "facade":
            draw_facade_element(ax, r, sources_by_gid[gid], color="black", lw=5.0, alpha=0.9)
            draw_facade_element(ax, r, sources_by_gid[gid], color=gid_color(gid), lw=3.2, alpha=1.0)
    ax.set_title("Whole street topology: high/medium facade elements\n(each colored segment = one refined global-plane gid)")
    ax.set_xlabel("east (m)")
    ax.set_ylabel("north (m)")
    ax.set_aspect("equal")
    ax.grid(alpha=0.25)
    ax.legend(loc="best", fontsize=8)

    ax = axes[1]
    draw_pano_path(ax, pano_pos)
    grounds = [
        r for r in registry.values()
        if r["classification"] == "ground" and r["quality"] in {"high", "medium"} and r["n_unique_panos"] >= 5
    ]
    grounds = sorted(grounds, key=lambda r: (-r["n_unique_panos"], -r["total_pixels"]))[:30]
    for r in grounds:
        gid = int(r["gid"])
        color = gid_color(gid, sat=0.55, val=0.82)
        draw_ground_element(ax, r, sources_by_gid[gid], color=color, alpha=0.12, edge_alpha=0.4)
    for gid in selected_gids:
        r = registry[gid]
        color = gid_color(gid)
        if r["classification"] == "facade":
            draw_facade_element(ax, r, sources_by_gid[gid], color=color, lw=3.0, alpha=0.95)
        elif r["classification"] == "ground":
            draw_ground_element(ax, r, sources_by_gid[gid], color=color, alpha=0.25, edge_alpha=0.8)
        pts = xy_from_sources(sources_by_gid[gid])
        c = pts.mean(axis=0)
        ax.text(c[0], c[1], f"gid {gid}", color=color, fontsize=9, weight="bold",
                bbox=dict(facecolor="white", alpha=0.78, edgecolor=color, lw=0.8))
    ax.set_title("Ground topology + selected examples\n(translucent regions = pano support footprint)")
    ax.set_xlabel("east (m)")
    ax.set_ylabel("north (m)")
    ax.set_aspect("equal")
    ax.grid(alpha=0.25)

    fig.suptitle("Street topology from refined global-plane matches", fontsize=15)
    fig.tight_layout(rect=(0, 0, 1, 0.96))
    fp = OUT / "topdown_whole_street.png"
    fig.savefig(fp, bbox_inches="tight")
    plt.close(fig)
    return fp


def best_source_per_pano(sources: list[dict]) -> list[dict]:
    by_pano = {}
    for s in sources:
        old = by_pano.get(s["panoid"])
        if old is None or s["n_pixels"] > old["n_pixels"]:
            by_pano[s["panoid"]] = s
    return list(by_pano.values())


def sample_sources_across_street(sources: list[dict], max_n=8) -> list[dict]:
    unique = best_source_per_pano(sources)
    pts = xy_from_sources(unique)
    order = principal_order(pts)
    ordered = [unique[i] for i in order]
    if len(ordered) <= max_n:
        return ordered
    idx = np.linspace(0, len(ordered) - 1, max_n).round().astype(int)
    # Preserve order while removing duplicates from rounding.
    out = []
    seen = set()
    for i in idx.tolist():
        key = ordered[i]["panoid"]
        if key not in seen:
            out.append(ordered[i])
            seen.add(key)
    return out


def draw_element_support(ax, row, sources, pano_pos, color):
    draw_pano_path(ax, pano_pos, color="#999", alpha=0.25)
    pts = xy_from_sources(sources)

    if row["classification"] == "facade":
        foot, _camera_distance, _tangent = facade_projection(row, sources)
        residual = np.array([s["d_global"] - row["d_global"] for s in sources], dtype=float)
        draw_facade_element(ax, row, sources, color=color, lw=3.0, alpha=0.95, label=f"gid {row['gid']}")
        sc = ax.scatter(foot[:, 0], foot[:, 1], c=residual, cmap="coolwarm", vmin=-0.5, vmax=0.5,
                        s=np.clip(np.sqrt([s["n_pixels"] for s in sources]) * 1.7, 18, 170),
                        edgecolor="black", linewidth=0.35, zorder=6, label="source projection")
        for p, q in zip(pts, foot):
            ax.plot([p[0], q[0]], [p[1], q[1]], color=color, alpha=0.22, lw=0.75, zorder=3)
        plt.colorbar(sc, ax=ax, shrink=0.65, pad=0.01, label="source d_global residual (m)")
    else:
        draw_ground_element(ax, row, sources, color=color, alpha=0.25, edge_alpha=0.9)
        ax.scatter(pts[:, 0], pts[:, 1], color=color, s=np.clip(np.sqrt([s["n_pixels"] for s in sources]) * 1.4, 18, 160),
                   edgecolor="black", linewidth=0.35, zorder=6, label="support panos")
    ax.scatter(pts[:, 0], pts[:, 1], c="#d62728", s=28, edgecolor="black", linewidth=0.35, zorder=7)
    ax.set_aspect("equal")
    ax.grid(alpha=0.25)
    ax.set_xlabel("east (m)")
    ax.set_ylabel("north (m)")
    ax.legend(loc="best", fontsize=8)


def build_element_figure(gid, row, sources, pano_pos):
    color = gid_color(gid)
    sampled = sample_sources_across_street(sources, max_n=8)
    fig = plt.figure(figsize=(20, 13), dpi=150)
    gs = fig.add_gridspec(3, 4, height_ratios=[1.2, 1.0, 1.0], hspace=0.42, wspace=0.24)

    ax = fig.add_subplot(gs[:2, :2])
    draw_element_support(ax, row, sources, pano_pos, color)
    ax.set_title("Topdown observation topology\nred points = panos that observe this same gid")

    ax = fig.add_subplot(gs[0, 2:])
    src_res = np.array([s["d_global"] - row["d_global"] for s in sources])
    order = np.argsort(src_res)
    pix = np.array([sources[i]["n_pixels"] for i in order], dtype=float)
    ax.scatter(src_res[order], np.arange(len(order)), s=np.clip(np.sqrt(pix) * 1.7, 14, 170),
               c=[color], alpha=0.75, edgecolor="black", linewidth=0.3)
    ax.axvline(0, color="#222", lw=1)
    ax.axvline(-0.5, color="#d62728", lw=1, ls="--")
    ax.axvline(0.5, color="#d62728", lw=1, ls="--")
    ax.set_xlabel("source residual to global element (m)")
    ax.set_ylabel("source observations")
    ax.set_title("Residual distribution: matching tightness")
    ax.grid(axis="x", alpha=0.25)

    thumb_gs = gs[1:, 2:].subgridspec(4, 2, hspace=0.48, wspace=0.12)
    for i, src in enumerate(sampled[:8]):
        ax = fig.add_subplot(thumb_gs[i // 2, i % 2])
        ax.axis("off")
        im = match_examples.mask_overlay_thumbnail(src["panoid"], src["local_idx"], max_size=(510, 255))
        if im is not None:
            ax.imshow(im)
        else:
            ax.text(0.5, 0.5, "missing thumbnail", ha="center", va="center")
        residual = src["d_global"] - row["d_global"]
        ax.set_title(
            f"{src['panoid'][:12]} idx={src['local_idx']} pix={src['n_pixels']} res={residual:+.3f}m",
            fontsize=8,
        )

    fig.suptitle(
        f"Same street element across panos: gid={gid} {row['classification']} {row['quality']}\n"
        f"unique_panos={row['n_unique_panos']} sources={row['n_sources']} "
        f"pixels={row['total_pixels']} spread={row['offset_spread_m']:.3f}m",
        fontsize=14,
        y=0.985,
    )
    fp = OUT / f"element_gid_{gid:03d}_{row['classification']}_{row['quality']}.png"
    fig.savefig(fp, bbox_inches="tight")
    plt.close(fig)
    return fp


def build_selected_elements_map(registry, sources_by_gid, pano_pos, selected_gids):
    fig, ax = plt.subplots(figsize=(13, 12), dpi=160)
    draw_pano_path(ax, pano_pos, color="#777", alpha=0.5)
    for gid in selected_gids:
        row = registry[gid]
        color = gid_color(gid)
        sources = sources_by_gid[gid]
        if row["classification"] == "facade":
            draw_facade_element(ax, row, sources, color=color, lw=3.2, alpha=0.9)
        else:
            draw_ground_element(ax, row, sources, color=color, alpha=0.22, edge_alpha=0.9)
        pts = xy_from_sources(sources)
        ax.scatter(pts[:, 0], pts[:, 1], s=12, c=[color], alpha=0.55, zorder=7)
        c = pts.mean(axis=0)
        ax.text(c[0], c[1], f"gid {gid}\n{row['classification']}", color=color, fontsize=9,
                bbox=dict(facecolor="white", alpha=0.82, edgecolor=color, lw=0.8))
    ax.set_title("Selected same-element examples on the whole street topology")
    ax.set_xlabel("east (m)")
    ax.set_ylabel("north (m)")
    ax.set_aspect("equal")
    ax.grid(alpha=0.25)
    fig.tight_layout()
    fp = OUT / "selected_elements_topdown.png"
    fig.savefig(fp, bbox_inches="tight")
    plt.close(fig)
    return fp


def write_index(selected_gids, registry, element_fps, whole_fp, selected_fp):
    lines = [
        "# Street topology visualization",
        "",
        "This view treats each refined global plane `gid` as a repeated street element.",
        "A pano observes an element when one of its local Google photometa planes belongs to that gid.",
        "",
        "## Main plots",
        "",
        f"- [{whole_fp.name}]({whole_fp.name}): whole-street topdown topology.",
        f"- [{selected_fp.name}]({selected_fp.name}): selected same-element examples in the full street map.",
        "",
        "## Element examples",
        "",
        "| gid | class | quality | unique_panos | sources | pixels | spread_m | figure |",
        "|----:|-------|---------|-------------:|--------:|-------:|---------:|--------|",
    ]
    for gid, fp in zip(selected_gids, element_fps):
        r = registry[gid]
        lines.append(
            f"| {gid} | {r['classification']} | {r['quality']} | {r['n_unique_panos']} | "
            f"{r['n_sources']} | {r['total_pixels']} | {r['offset_spread_m']:.3f} | "
            f"[{fp.name}]({fp.name}) |"
        )
    lines.extend([
        "",
        "## Notes",
        "",
        "- Facade elements are drawn as finite topdown line segments inferred from their supporting pano projections.",
        "- Ground elements are drawn as translucent support footprints, not exact road polygons.",
        "- Thumbnail red masks are Google photometa plane supports in the gravity-aligned frame; they are topology evidence, not precise building crops.",
    ])
    (OUT / "index.md").write_text("\n".join(lines) + "\n")


def main():
    ap = argparse.ArgumentParser(description="Build top-down street topology diagnostics.")
    add_spatial_args(ap)
    args = ap.parse_args()
    configure_paths(resolve_spatial_paths(args))

    OUT.mkdir(parents=True, exist_ok=True)
    registry = load_registry()
    sources_by_gid, pano_pos = load_sources()
    selected_gids = select_examples(registry)

    whole_fp = build_whole_topdown(registry, sources_by_gid, pano_pos, selected_gids)
    selected_fp = build_selected_elements_map(registry, sources_by_gid, pano_pos, selected_gids)
    element_fps = []
    for gid in selected_gids:
        fp = build_element_figure(gid, registry[gid], sources_by_gid[gid], pano_pos)
        element_fps.append(fp)
        print(f"Wrote {fp}")
    write_index(selected_gids, registry, element_fps, whole_fp, selected_fp)
    print(f"Wrote {whole_fp}")
    print(f"Wrote {selected_fp}")
    print(f"Wrote {OUT / 'index.md'}")


if __name__ == "__main__":
    main()
