#!/usr/bin/env python3
"""Concrete match examples and 3D diagnostics for refined global planes.

Outputs:
  TEST/data/derived/<workspace-id>/04_global_factors_refined/match_examples/
    index.md
    examples_overview.png
    gid_<N>_<class>_<quality>.png

Each per-gid figure contains:
  - a 3D plane/pano/source-footprint view;
  - a top-down map;
  - source residuals against the cluster plane;
  - top source pano thumbnails with the exact local plane mask highlighted.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from collections import defaultdict
from functools import lru_cache
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from PIL import Image
from mpl_toolkits.mplot3d.art3d import Poly3DCollection

sys.path.insert(0, str(Path(__file__).resolve().parent))
from filter_and_rectify import build_rotation, parse_one  # noqa: E402
from pair_indexmap_with_pano import rectify_rgb  # noqa: E402
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sv3d_paths import add_spatial_args, resolve_spatial_paths  # noqa: E402


CAPTURE: Path
REFINED: Path
RECT_DIR: Path
OUT: Path
THUMB_W, THUMB_H = 1024, 512

CLASS_COLORS = {
    "ground": "#4faa66",
    "facade": "#8d6bd1",
    "ceiling": "#b7793f",
    "oblique": "#d149a8",
}
QUALITY_COLORS = {"high": "#2ca02c", "medium": "#ffbf50", "low": "#d62728"}


def configure_paths(paths):
    global CAPTURE, REFINED, RECT_DIR, OUT
    CAPTURE = paths.run_dir
    REFINED = paths.global_factors_dir
    RECT_DIR = paths.indexmap_rectified_dir
    OUT = REFINED / "match_examples"


def load_registry():
    data = json.loads((REFINED / "registry.json").read_text())
    return {int(r["gid"]): r for r in data["registry"]}, data


def load_sources():
    by_gid = defaultdict(list)
    with (REFINED / "sources.csv").open(newline="") as f:
        for row in csv.DictReader(f):
            row["gid"] = int(row["gid"])
            row["local_idx"] = int(row["local_idx"])
            row["n_pixels"] = int(row["n_pixels"])
            for k in ["d_local", "d_global", "n_x", "n_y", "n_z", "pano_east_m", "pano_north_m"]:
                row[k] = float(row[k])
            by_gid[row["gid"]].append(row)
    return by_gid


@lru_cache(maxsize=128)
def pose_for_panoid(panoid: str) -> dict:
    candidates = [CAPTURE / "neighbor_photometas" / f"{panoid}.parsed.json"]
    candidates += list(CAPTURE.glob("photometa_*_parsed.json"))
    for fp in candidates:
        if not fp.exists():
            continue
        try:
            rec = parse_one(fp)
        except Exception:
            continue
        if rec["panoid"] == panoid:
            return rec
    raise FileNotFoundError(f"pose not found for {panoid}")


@lru_cache(maxsize=64)
def gravity_rgb_for_panoid(panoid: str) -> Image.Image | None:
    pano_fp = CAPTURE / "panoramas" / f"{panoid}.jpg"
    if not pano_fp.exists():
        return None
    rec = pose_for_panoid(panoid)
    with Image.open(pano_fp) as im:
        pano = np.array(im.convert("RGB"))
    R = build_rotation(rec["heading_deg"], rec["pitch_deg"], rec["roll_deg"])
    grav = rectify_rgb(pano, R, out_size=(THUMB_H, THUMB_W), chunk_rows=64)
    return Image.fromarray(grav)


def choose_examples(registry: dict[int, dict]) -> list[int]:
    rows = list(registry.values())

    def pick(pred, sort_key, n):
        vals = [r for r in rows if pred(r)]
        vals = sorted(vals, key=sort_key)
        return [int(r["gid"]) for r in vals[:n]]

    gids = []
    gids += pick(
        lambda r: r["classification"] == "facade" and r["quality"] == "high",
        lambda r: (-r["total_pixels"], -r["n_unique_panos"]),
        2,
    )
    gids += pick(
        lambda r: r["classification"] == "facade" and r["quality"] == "medium",
        lambda r: (-r["n_unique_panos"], -r["total_pixels"]),
        1,
    )
    gids += pick(
        lambda r: r["classification"] == "ground" and r["quality"] == "high",
        lambda r: (-r["total_pixels"], -r["n_unique_panos"]),
        2,
    )
    gids += pick(
        lambda r: r["classification"] == "ground" and r["quality"] == "medium",
        lambda r: (-r["n_unique_panos"], -r["total_pixels"]),
        1,
    )
    gids += pick(
        lambda r: r["quality"] == "low" and r["n_sources"] >= 2,
        lambda r: (-r["offset_spread_m"], -r["total_pixels"]),
        1,
    )
    gids += pick(
        lambda r: r["quality"] == "low" and r["n_sources"] == 1,
        lambda r: (-r["total_pixels"],),
        1,
    )

    out = []
    seen = set()
    for gid in gids:
        if gid not in seen:
            out.append(gid)
            seen.add(gid)
    return out


def plane_basis(n: np.ndarray, classification: str):
    n = n / max(float(np.linalg.norm(n)), 1e-12)
    up = np.array([0.0, 0.0, 1.0])
    if classification == "ground" or abs(float(np.dot(n, up))) > 0.85:
        u = np.array([1.0, 0.0, 0.0])
        u = u - n * float(np.dot(u, n))
        if np.linalg.norm(u) < 1e-6:
            u = np.array([0.0, 1.0, 0.0])
            u = u - n * float(np.dot(u, n))
        u = u / np.linalg.norm(u)
        v = np.cross(n, u)
        v = v / np.linalg.norm(v)
    else:
        u = np.cross(up, n)
        u = u / np.linalg.norm(u)
        v = up - n * float(np.dot(up, n))
        v = v / np.linalg.norm(v)
    return u, v


def project_points_to_plane(points: np.ndarray, n: np.ndarray, d: float):
    dist = points @ n - d
    return points - dist[:, None] * n[None, :], dist


def set_axes_equal(ax):
    xlim = ax.get_xlim3d()
    ylim = ax.get_ylim3d()
    zlim = ax.get_zlim3d()
    ranges = np.array([xlim[1] - xlim[0], ylim[1] - ylim[0], zlim[1] - zlim[0]])
    centers = np.array([(xlim[0] + xlim[1]) / 2, (ylim[0] + ylim[1]) / 2, (zlim[0] + zlim[1]) / 2])
    radius = max(float(ranges.max()) / 2, 1.0)
    ax.set_xlim3d(centers[0] - radius, centers[0] + radius)
    ax.set_ylim3d(centers[1] - radius, centers[1] + radius)
    ax.set_zlim3d(centers[2] - radius, centers[2] + radius)


def draw_3d(ax, row: dict, sources: list[dict]):
    n = np.array([row["nx"], row["ny"], row["nz"]], dtype=float)
    n /= np.linalg.norm(n)
    d = float(row["d_global"])
    pano_pts = np.array([[s["pano_east_m"], s["pano_north_m"], 0.0] for s in sources], dtype=float)
    foot, residual = project_points_to_plane(pano_pts, n, d)

    center = np.median(foot, axis=0) if foot.size else n * d
    u, v = plane_basis(n, row["classification"])
    coord_u = (foot - center) @ u if foot.size else np.array([0.0])
    coord_v = (foot - center) @ v if foot.size else np.array([0.0])
    half_u = max(6.0, float(np.percentile(np.abs(coord_u), 90)) + 4.0)
    half_v = max(3.0, float(np.percentile(np.abs(coord_v), 90)) + 3.0)
    if row["classification"] == "facade":
        half_v = max(8.0, half_v)
    corners = [
        center - half_u * u - half_v * v,
        center + half_u * u - half_v * v,
        center + half_u * u + half_v * v,
        center - half_u * u + half_v * v,
    ]
    poly = Poly3DCollection([corners], alpha=0.26, facecolor=CLASS_COLORS[row["classification"]], edgecolor="#222")
    ax.add_collection3d(poly)

    pix = np.array([s["n_pixels"] for s in sources], dtype=float)
    sizes = np.clip(np.sqrt(pix) * 1.7, 15, 180)
    colors = plt.cm.coolwarm(np.clip((residual + 0.5) / 1.0, 0, 1))
    ax.scatter(pano_pts[:, 0], pano_pts[:, 1], pano_pts[:, 2], c="#d62728", s=22, label="pano centers", depthshade=False)
    ax.scatter(foot[:, 0], foot[:, 1], foot[:, 2], c=colors, s=sizes, edgecolors="black", linewidths=0.35,
               label="source projection on plane", depthshade=False)

    for p, q in zip(pano_pts, foot):
        ax.plot([p[0], q[0]], [p[1], q[1]], [p[2], q[2]], color="#555", alpha=0.25, lw=0.7)

    ax.quiver(center[0], center[1], center[2], n[0], n[1], n[2], length=4.0, color="black", linewidth=1.2)
    ax.set_xlabel("east m")
    ax.set_ylabel("north m")
    ax.set_zlabel("up m")
    ax.set_title("3D: representative plane + pano observations", fontsize=10)
    ax.view_init(elev=22, azim=-58)
    ax.legend(loc="upper left", fontsize=7)

    pts = np.vstack([pano_pts, foot, np.array(corners)])
    ax.set_xlim(float(np.min(pts[:, 0]) - 5), float(np.max(pts[:, 0]) + 5))
    ax.set_ylim(float(np.min(pts[:, 1]) - 5), float(np.max(pts[:, 1]) + 5))
    ax.set_zlim(float(np.min(pts[:, 2]) - 4), float(np.max(pts[:, 2]) + 8))
    set_axes_equal(ax)


def draw_topdown(ax, row: dict, sources: list[dict]):
    n = np.array([row["nx"], row["ny"], row["nz"]], dtype=float)
    n /= np.linalg.norm(n)
    d = float(row["d_global"])
    pano_pts = np.array([[s["pano_east_m"], s["pano_north_m"], 0.0] for s in sources], dtype=float)
    foot, residual = project_points_to_plane(pano_pts, n, d)
    pix = np.array([s["n_pixels"] for s in sources], dtype=float)
    sizes = np.clip(np.sqrt(pix) * 1.5, 12, 160)

    ax.scatter(pano_pts[:, 0], pano_pts[:, 1], c="#d62728", s=28, edgecolor="black", linewidth=0.35, label="pano")
    ax.scatter(foot[:, 0], foot[:, 1], c=residual, cmap="coolwarm", vmin=-0.5, vmax=0.5,
               s=sizes, edgecolor="black", linewidth=0.35, label="projected source")
    for p, q in zip(pano_pts, foot):
        ax.plot([p[0], q[0]], [p[1], q[1]], color="#777", alpha=0.25, lw=0.6)

    nxy = n[:2]
    if float(np.dot(nxy, nxy)) > 1e-6:
        p0 = nxy * (d / float(np.dot(nxy, nxy)))
        tang = np.array([-nxy[1], nxy[0]]) / np.linalg.norm(nxy)
        seg = max(10, float(np.ptp(foot[:, :2] @ tang)) / 2 + 8)
        ax.plot([p0[0] - tang[0] * seg, p0[0] + tang[0] * seg],
                [p0[1] - tang[1] * seg, p0[1] + tang[1] * seg],
                color=CLASS_COLORS[row["classification"]], lw=2.0, label="plane line")
    ax.set_aspect("equal")
    ax.set_xlabel("east m")
    ax.set_ylabel("north m")
    ax.set_title("Top-down support and projection residual", fontsize=10)
    ax.grid(alpha=0.25)
    ax.legend(fontsize=7, loc="best")


def draw_residual(ax, row: dict, sources: list[dict]):
    residual = np.array([s["d_global"] - row["d_global"] for s in sources], dtype=float)
    order = np.argsort(residual)
    residual = residual[order]
    pix = np.array([sources[i]["n_pixels"] for i in order], dtype=float)
    colors = [QUALITY_COLORS[row["quality"]]] * len(residual)
    ax.scatter(residual, np.arange(len(residual)), s=np.clip(np.sqrt(pix) * 1.8, 15, 160),
               c=colors, alpha=0.75, edgecolor="black", linewidth=0.35)
    ax.axvline(0, color="#222", lw=1)
    ax.axvline(-0.5, color="#d62728", lw=1, ls="--")
    ax.axvline(0.5, color="#d62728", lw=1, ls="--")
    ax.set_xlabel("source d_global - cluster d_global (m)")
    ax.set_ylabel("source observations sorted by residual")
    ax.set_title("Residuals inside this matched cluster", fontsize=10)
    ax.grid(axis="x", alpha=0.25)
    lim = max(0.55, float(np.max(np.abs(residual))) + 0.05) if residual.size else 0.55
    ax.set_xlim(-lim, lim)


def mask_overlay_thumbnail(panoid: str, local_idx: int, max_size=(520, 260)) -> Image.Image | None:
    idx_fp = RECT_DIR / f"{panoid}_indexmap_gravity.bin"
    pano = gravity_rgb_for_panoid(panoid)
    if pano is None or not idx_fp.exists():
        return None
    idx = np.frombuffer(idx_fp.read_bytes(), dtype=np.uint8)
    if idx.size != 512 * 256:
        return None
    mask = (idx.reshape(256, 512) == local_idx).astype(np.uint8) * 255
    mask_im = Image.fromarray(mask).resize((THUMB_W, THUMB_H), Image.Resampling.NEAREST)
    mask_up = np.array(mask_im) > 0
    boundary = np.zeros_like(mask_up)
    boundary[:, 1:] |= mask_up[:, 1:] != mask_up[:, :-1]
    boundary[1:, :] |= mask_up[1:, :] != mask_up[:-1, :]
    boundary &= mask_up

    alpha = np.zeros((THUMB_H, THUMB_W), dtype=np.uint8)
    alpha[mask_up] = 58
    alpha[boundary] = 230
    rgba_arr = np.zeros((THUMB_H, THUMB_W, 4), dtype=np.uint8)
    rgba_arr[..., 0] = 255
    rgba_arr[..., 3] = alpha
    rgba = Image.fromarray(rgba_arr)
    out = pano.convert("RGBA")
    out.alpha_composite(rgba)
    out = out.convert("RGB")
    out.thumbnail(max_size, Image.Resampling.LANCZOS)
    return out


def draw_source_thumbnails(fig, gridspec, row: dict, sources: list[dict], max_sources=6):
    top = sorted(sources, key=lambda s: -s["n_pixels"])[:max_sources]
    for i, src in enumerate(top):
        ax = fig.add_subplot(gridspec[i // 3, i % 3])
        ax.axis("off")
        im = mask_overlay_thumbnail(src["panoid"], src["local_idx"])
        if im is None:
            ax.text(0.5, 0.5, "missing image", ha="center", va="center")
        else:
            ax.imshow(im)
        residual = src["d_global"] - row["d_global"]
        ax.set_title(
            f"{src['panoid'][:12]} idx={src['local_idx']} pix={src['n_pixels']}\n"
            f"residual={residual:+.3f}m",
            fontsize=8,
        )


def build_gid_figure(gid: int, row: dict, sources: list[dict]) -> Path:
    fp = OUT / f"gid_{gid:03d}_{row['classification']}_{row['quality']}.png"
    fig = plt.figure(figsize=(18, 13), dpi=150)
    gs = fig.add_gridspec(3, 3, height_ratios=[1.15, 1.0, 0.95], hspace=0.38, wspace=0.28)

    ax3d = fig.add_subplot(gs[:2, 0], projection="3d")
    draw_3d(ax3d, row, sources)
    ax2d = fig.add_subplot(gs[0, 1])
    draw_topdown(ax2d, row, sources)
    axr = fig.add_subplot(gs[0, 2])
    draw_residual(axr, row, sources)

    sub = gs[1:, 1:].subgridspec(2, 3, hspace=0.38, wspace=0.12)
    draw_source_thumbnails(fig, sub, row, sources, max_sources=6)

    fig.suptitle(
        f"Global plane match example: gid={gid}  {row['classification']}  {row['quality']}\n"
        f"unique_panos={row['n_unique_panos']}  sources={row['n_sources']}  "
        f"pixels={row['total_pixels']}  spread={row['offset_spread_m']:.3f}m  "
        f"normal_min={row['normal_consistency_min']:.4f}",
        fontsize=14,
        y=0.985,
    )
    fig.savefig(fp, bbox_inches="tight")
    plt.close(fig)
    return fp


def build_overview(example_fps: list[Path], registry: dict[int, dict], example_gids: list[int]):
    fig, axes = plt.subplots(2, 4, figsize=(22, 11), dpi=150)
    axes = axes.ravel()
    for ax, gid, fp in zip(axes, example_gids, example_fps):
        ax.axis("off")
        im = Image.open(fp).convert("RGB")
        # Crop upper diagnostic area to keep overview readable.
        w, h = im.size
        crop = im.crop((0, 0, w, int(h * 0.58)))
        crop.thumbnail((780, 520), Image.Resampling.LANCZOS)
        ax.imshow(crop)
        r = registry[gid]
        ax.set_title(
            f"gid {gid} {r['classification']} {r['quality']} | "
            f"u={r['n_unique_panos']} spread={r['offset_spread_m']:.2f}m",
            fontsize=10,
        )
    for ax in axes[len(example_fps):]:
        ax.axis("off")
    fig.suptitle("Concrete global-plane matching examples (3D + residual + exact source masks)", fontsize=15)
    fig.tight_layout(rect=(0, 0, 1, 0.96))
    out_fp = OUT / "examples_overview.png"
    fig.savefig(out_fp, bbox_inches="tight")
    plt.close(fig)


def write_index(example_gids: list[int], registry: dict[int, dict], sources_by_gid: dict[int, list[dict]], fps: list[Path]):
    lines = [
        "# Global plane match examples",
        "",
        "Each example figure shows a concrete refined global-plane cluster.",
        "",
        "- 3D panel: translucent representative plane, red pano centers, colored projected source observations.",
        "- Residual panel: each dot is one pano-local source plane; closer to 0 means better match.",
        "- Thumbnail panel: red mask highlights the exact `local_idx` region inside each source pano's gravity indexmap, drawn over the same gravity-aligned JPG frame.",
        "- The red mask is Google photometa's coarse plane support, not a pixel-perfect building instance crop.",
        "",
        "## Examples",
        "",
        "| gid | class | quality | unique_panos | sources | pixels | spread_m | normal_min | figure | top source rows |",
        "|----:|-------|---------|-------------:|--------:|-------:|---------:|-----------:|--------|-----------------|",
    ]
    for gid, fp in zip(example_gids, fps):
        r = registry[gid]
        src = sorted(sources_by_gid[gid], key=lambda s: -s["n_pixels"])[:5]
        top = "<br>".join(
            f"`{s['panoid'][:12]} idx={s['local_idx']} pix={s['n_pixels']} res={s['d_global']-r['d_global']:+.3f}`"
            for s in src
        )
        lines.append(
            f"| {gid} | {r['classification']} | {r['quality']} | {r['n_unique_panos']} | "
            f"{r['n_sources']} | {r['total_pixels']} | {r['offset_spread_m']:.3f} | "
            f"{r['normal_consistency_min']:.4f} | [{fp.name}]({fp.name}) | {top} |"
        )
    lines.extend([
        "",
        "## Overview",
        "",
        "Open `examples_overview.png` for a contact-sheet view.",
    ])
    (OUT / "index.md").write_text("\n".join(lines) + "\n")


def main():
    ap = argparse.ArgumentParser(description="Build concrete visual examples for refined global factors.")
    add_spatial_args(ap)
    args = ap.parse_args()
    configure_paths(resolve_spatial_paths(args))

    OUT.mkdir(parents=True, exist_ok=True)
    registry, _meta = load_registry()
    sources_by_gid = load_sources()
    example_gids = choose_examples(registry)
    print("Example gids:", example_gids)

    fps = []
    for gid in example_gids:
        fp = build_gid_figure(gid, registry[gid], sources_by_gid[gid])
        fps.append(fp)
        print(f"Wrote {fp}")
    build_overview(fps, registry, example_gids)
    write_index(example_gids, registry, sources_by_gid, fps)
    print(f"Wrote {OUT / 'examples_overview.png'}")
    print(f"Wrote {OUT / 'index.md'}")


if __name__ == "__main__":
    main()
