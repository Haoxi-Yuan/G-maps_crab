"""Refined global plane registry with complete-linkage plane matching.

This script keeps the v2 coordinate math but changes the clustering rule.

v2 used connected components over pairwise matches:
  A~B and B~C could merge A,B,C even when A and C were far apart.

Here each final cluster must satisfy complete-linkage constraints:
  max pairwise angular distance <= ANGLE_THRESH
  max pairwise offset distance  <= OFFSET_THRESH_M

The output is stored in the canonical derived tree. If the archived legacy
`_global_planes` result exists, it is read only for comparison.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from scipy.cluster.hierarchy import fcluster, linkage
from scipy.spatial.distance import pdist

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sv3d_paths import add_spatial_args, find_legacy_global_dir, resolve_spatial_paths  # noqa: E402

CAPTURE: Path
WORLD_DIR: Path
RECT_DIR: Path
LEGACY_GLOBAL_DIR: Path | None
OUT: Path

COS_THRESH = 0.985
ANGLE_THRESH = math.acos(COS_THRESH)
OFFSET_THRESH_M = 0.5
MIN_PIXEL_SUPPORT = 50
MIN_NORMAL_MAGNITUDE = 1e-6

CLASS_ORDER = ["ground", "facade", "ceiling", "oblique"]
CLASS_COLORS = {
    "ground": "#4faa66",
    "facade": "#8d6bd1",
    "ceiling": "#b7793f",
    "oblique": "#d149a8",
}
QUALITY_COLORS = {"high": "#2ca02c", "medium": "#ffbf50", "low": "#d62728"}


def configure_paths(paths, legacy_global_dir: Path | None = None):
    global CAPTURE, WORLD_DIR, RECT_DIR, LEGACY_GLOBAL_DIR, OUT
    CAPTURE = paths.run_dir
    WORLD_DIR = paths.planes_world_dir
    RECT_DIR = paths.indexmap_rectified_dir
    LEGACY_GLOBAL_DIR = legacy_global_dir
    OUT = paths.global_factors_dir


def find_photometa(panoid: str) -> Path | None:
    nb = CAPTURE / "neighbor_photometas" / f"{panoid}.parsed.json"
    if nb.exists():
        return nb
    for fp in sorted(CAPTURE.glob("photometa_*_parsed.json")):
        try:
            d = json.loads(fp.read_text())
            if d[1][0][1][1] == panoid:
                return fp
        except Exception:
            continue
    return None


def get_lat_lng(parsed_json_path: Path) -> tuple[float, float]:
    d = json.loads(parsed_json_path.read_text())
    block = d[1][0][5][0][1][0]
    return float(block[2]), float(block[3])


def latlng_to_enu(lat: float, lng: float, lat_ref: float, lng_ref: float) -> tuple[float, float]:
    r_earth = 6371000.0
    east = math.radians(lng - lng_ref) * r_earth * math.cos(math.radians(lat_ref))
    north = math.radians(lat - lat_ref) * r_earth
    return east, north


def classify(n_world: np.ndarray) -> str:
    nz = float(n_world[2])
    if abs(nz) > 0.85:
        return "ground" if nz < 0 else "ceiling"
    if abs(nz) < 0.20:
        return "facade"
    return "oblique"


def load_raw_planes():
    log = list(csv.DictReader(open(RECT_DIR / "filter_log.csv")))
    kept = [r["panoid"] for r in log if r.get("kept") == "True"]
    if not kept:
        raise RuntimeError(f"No kept panos in {RECT_DIR / 'filter_log.csv'}")

    fp_anchor = find_photometa(kept[0])
    if fp_anchor is None:
        raise RuntimeError(f"Cannot locate anchor photometa for {kept[0]}")
    lat_ref, lng_ref = get_lat_lng(fp_anchor)

    raw = []
    pano_pos = {}
    for pid in kept:
        wp_fp = WORLD_DIR / f"{pid}_planes_world.json"
        if not wp_fp.exists():
            continue
        fp = find_photometa(pid)
        if fp is None:
            continue

        lat, lng = get_lat_lng(fp)
        east, north = latlng_to_enu(lat, lng, lat_ref, lng_ref)
        pos = np.array([east, north, 0.0], dtype=np.float64)
        pano_pos[pid] = (east, north)

        bp = RECT_DIR / f"{pid}_indexmap_gravity.bin"
        if bp.exists():
            counts = np.bincount(np.frombuffer(bp.read_bytes(), dtype=np.uint8), minlength=256)
        else:
            counts = None

        wp = json.loads(wp_fp.read_text())
        planes_world = np.array(wp["planes_world"], dtype=np.float64)
        for local_idx in range(1, planes_world.shape[0]):
            n_world = planes_world[local_idx, :3]
            mag = float(np.linalg.norm(n_world))
            if mag < MIN_NORMAL_MAGNITUDE:
                continue
            n_world = n_world / mag
            d_local = float(planes_world[local_idx, 3])
            d_global = d_local + float(np.dot(n_world, pos))
            pix = int(counts[local_idx]) if counts is not None and local_idx < counts.size else 0
            if pix < MIN_PIXEL_SUPPORT:
                continue

            raw.append({
                "key": f"{pid}:{local_idx}",
                "panoid": pid,
                "local_idx": local_idx,
                "n": n_world,
                "d_local": d_local,
                "d_global": d_global,
                "pix": pix,
                "pos_e": east,
                "pos_n": north,
                "classification": classify(n_world),
            })

    return raw, pano_pos, lat_ref, lng_ref


def complete_linkage_labels(indices: list[int], raw: list[dict]) -> list[list[int]]:
    if len(indices) <= 1:
        return [indices]

    normals = np.array([raw[i]["n"] for i in indices], dtype=np.float64)
    offsets = np.array([raw[i]["d_global"] for i in indices], dtype=np.float64)

    # max(angle / threshold, offset / threshold) <= 1 means both constraints pass.
    cosine_dist = pdist(normals, metric="cosine")
    dots = np.clip(1.0 - cosine_dist, -1.0, 1.0)
    angle_dist = np.arccos(dots) / ANGLE_THRESH
    offset_dist = pdist(offsets[:, None], metric="cityblock") / OFFSET_THRESH_M
    plane_dist = np.maximum(angle_dist, offset_dist)

    z = linkage(plane_dist, method="complete")
    labels = fcluster(z, t=1.0, criterion="distance")

    grouped = defaultdict(list)
    for src_idx, label in zip(indices, labels.tolist()):
        grouped[int(label)].append(src_idx)
    return list(grouped.values())


def cluster_raw_planes(raw: list[dict]) -> list[list[int]]:
    by_class = defaultdict(list)
    for i, r in enumerate(raw):
        by_class[r["classification"]].append(i)

    clusters = []
    for cls in CLASS_ORDER:
        indices = by_class.get(cls, [])
        if not indices:
            continue
        print(f"  complete-linkage {cls}: {len(indices)} raw planes")
        clusters.extend(complete_linkage_labels(indices, raw))
    return clusters


def quality_label(row: dict) -> str:
    if (
        row["n_unique_panos"] >= 3
        and row["offset_spread_m"] <= 0.35
        and row["normal_consistency_min"] >= 0.995
        and row["source_pixels_median"] >= 150
    ):
        return "high"
    if (
        row["n_unique_panos"] >= 2
        and row["offset_spread_m"] <= OFFSET_THRESH_M
        and row["normal_consistency_min"] >= COS_THRESH
    ):
        return "medium"
    return "low"


def build_registry(clusters: list[list[int]], raw: list[dict]):
    registry = []
    source_rows = []
    for gid, members in enumerate(sorted(clusters, key=lambda m: (-len(m), -sum(raw[i]["pix"] for i in m)))):
        normals = np.array([raw[i]["n"] for i in members], dtype=np.float64)
        offsets = np.array([raw[i]["d_global"] for i in members], dtype=np.float64)
        pixels = np.array([raw[i]["pix"] for i in members], dtype=np.float64)
        panos = [raw[i]["panoid"] for i in members]
        weights = pixels / max(float(pixels.sum()), 1.0)

        n_mean = (normals * weights[:, None]).sum(axis=0)
        n_mean = n_mean / max(float(np.linalg.norm(n_mean)), 1e-12)
        d_mean = float((offsets * weights).sum())
        cos_to_mean = normals @ n_mean
        cls = classify(n_mean)
        source_pix = [int(raw[i]["pix"]) for i in members]
        d_local_abs = [abs(float(raw[i]["d_local"])) for i in members]

        row = {
            "gid": gid,
            "nx": float(n_mean[0]),
            "ny": float(n_mean[1]),
            "nz": float(n_mean[2]),
            "d_global": d_mean,
            "classification": cls,
            "n_sources": len(members),
            "n_unique_panos": len(set(panos)),
            "total_pixels": int(pixels.sum()),
            "normal_consistency_min": float(np.min(cos_to_mean)) if len(members) else 1.0,
            "normal_consistency_mean": float(np.mean(cos_to_mean)) if len(members) else 1.0,
            "offset_spread_m": float(offsets.max() - offsets.min()) if len(members) > 1 else 0.0,
            "offset_std_m": float(np.std(offsets)) if len(members) > 1 else 0.0,
            "source_pixels_median": float(np.median(source_pix)),
            "source_pixels_min": int(min(source_pix)),
            "source_pixels_p10": float(np.percentile(source_pix, 10)),
            "source_distance_median": float(np.median(d_local_abs)),
            "source_distance_p90": float(np.percentile(d_local_abs, 90)),
        }
        row["quality"] = quality_label(row)
        registry.append(row)

        for i in members:
            r = raw[i]
            source_rows.append({
                "gid": gid,
                "key": r["key"],
                "panoid": r["panoid"],
                "local_idx": r["local_idx"],
                "n_pixels": r["pix"],
                "d_local": r["d_local"],
                "d_global": r["d_global"],
                "n_x": float(r["n"][0]),
                "n_y": float(r["n"][1]),
                "n_z": float(r["n"][2]),
                "classification": r["classification"],
                "pano_east_m": r["pos_e"],
                "pano_north_m": r["pos_n"],
            })

    return registry, source_rows


def write_sources_csv(rows: list[dict], fp: Path):
    with fp.open("w", newline="") as f:
        keys = list(rows[0].keys())
        writer = csv.DictWriter(f, fieldnames=keys)
        writer.writeheader()
        writer.writerows(rows)


def write_report(raw: list[dict], registry: list[dict], pano_pos: dict, fp: Path):
    q_counts = Counter(r["quality"] for r in registry)
    cls_counts = Counter(r["classification"] for r in registry)
    cls_pix = defaultdict(int)
    for r in registry:
        cls_pix[r["classification"]] += int(r["total_pixels"])

    multi = [r for r in registry if r["n_unique_panos"] >= 2]
    high_medium = [r for r in registry if r["quality"] in {"high", "medium"}]
    worst = sorted(registry, key=lambda r: (r["offset_spread_m"], r["n_sources"]), reverse=True)[:12]

    lines = [
        "# Refined global plane registry",
        "",
        "Clustering rule: complete-linkage over `(normal angle, d_global)`.",
        f"A cluster is valid only when every pair stays within `{math.degrees(ANGLE_THRESH):.2f} deg` and `{OFFSET_THRESH_M:.2f} m`.",
        "",
        f"- Source panos: **{len(pano_pos)}**",
        f"- Raw planes (pix>={MIN_PIXEL_SUPPORT}): **{len(raw)}**",
        f"- Refined global planes: **{len(registry)}**",
        f"- Compression: {len(raw)}/{len(registry)} = **{len(raw) / len(registry):.1f}x**",
        f"- Multi-pano clusters: **{len(multi)}**",
        f"- High/medium quality clusters: **{len(high_medium)}**",
        "",
        "## Quality breakdown",
        "",
        "| quality | n_clusters |",
        "|---------|-----------:|",
    ]
    for q in ["high", "medium", "low"]:
        lines.append(f"| {q} | {q_counts[q]} |")

    lines.extend([
        "",
        "## Class breakdown",
        "",
        "| class | n_clusters | total_pixels |",
        "|-------|-----------:|-------------:|",
    ])
    for cls in CLASS_ORDER:
        lines.append(f"| {cls} | {cls_counts[cls]} | {cls_pix[cls]} |")

    lines.extend([
        "",
        "## Top 15 by unique pano support",
        "",
        "| gid | class | quality | unique_panos | sources | total_pix | offset_spread_m | normal_min | d_global |",
        "|----:|-------|---------|-------------:|--------:|----------:|----------------:|-----------:|---------:|",
    ])
    for r in sorted(registry, key=lambda x: (-x["n_unique_panos"], -x["total_pixels"]))[:15]:
        lines.append(
            f"| {r['gid']} | {r['classification']} | {r['quality']} | "
            f"{r['n_unique_panos']} | {r['n_sources']} | {r['total_pixels']} | "
            f"{r['offset_spread_m']:.3f} | {r['normal_consistency_min']:.4f} | {r['d_global']:+.2f} |"
        )

    lines.extend([
        "",
        "## Worst remaining clusters by offset spread",
        "",
        "| gid | class | quality | unique_panos | sources | offset_spread_m | normal_min |",
        "|----:|-------|---------|-------------:|--------:|----------------:|-----------:|",
    ])
    for r in worst:
        lines.append(
            f"| {r['gid']} | {r['classification']} | {r['quality']} | "
            f"{r['n_unique_panos']} | {r['n_sources']} | "
            f"{r['offset_spread_m']:.3f} | {r['normal_consistency_min']:.4f} |"
        )

    lines.extend([
        "",
        "## Interpretation",
        "",
        "- `high`: useful as a stronger pseudo-GT plane.",
        "- `medium`: usable weak label; inspect if it matters.",
        "- `low`: singleton, tiny support, or weak consistency; do not treat as GT.",
        "- Visibility/completeness is still observational: pixel support and unique pano count measure what was actually seen, not what should have been visible through occlusion.",
    ])
    fp.write_text("\n".join(lines) + "\n")


def load_old_registry_and_sources():
    if LEGACY_GLOBAL_DIR is None:
        return [], []
    reg_fp = LEGACY_GLOBAL_DIR / "registry.json"
    src_fp = LEGACY_GLOBAL_DIR / "sources.csv"
    if not reg_fp.exists() or not src_fp.exists():
        return [], []
    old = json.loads(reg_fp.read_text())["registry"]
    src = []
    with src_fp.open(newline="") as f:
        for r in csv.DictReader(f):
            r["gid"] = int(r["gid"])
            r["local_idx"] = int(r["local_idx"])
            r["n_pixels"] = int(r["n_pixels"])
            r["d_global"] = float(r["d_global"])
            r["key"] = f"{r['panoid']}:{r['local_idx']}"
            src.append(r)
    by_gid = defaultdict(set)
    for r in src:
        by_gid[r["gid"]].add(r["panoid"])
    for r in old:
        r["n_unique_panos"] = len(by_gid[int(r["gid"])])
        r["quality"] = "old"
    return old, src


def metric_arrays(registry):
    return {
        "spread": np.array([r["offset_spread_m"] for r in registry], dtype=float),
        "normal_min": np.array([r["normal_consistency_min"] for r in registry], dtype=float),
        "sources": np.array([r["n_sources"] for r in registry], dtype=float),
        "unique": np.array([r.get("n_unique_panos", r["n_sources"]) for r in registry], dtype=float),
        "pixels": np.array([r["total_pixels"] for r in registry], dtype=float),
    }


def plot_line_plane(ax, row, color, alpha=0.6, lw=1.2, seg=8.0):
    nxy = np.array([row["nx"], row["ny"]], dtype=float)
    nmag2 = float(np.dot(nxy, nxy))
    if nmag2 < 1e-6:
        return
    p0 = nxy * (float(row["d_global"]) / nmag2)
    tangent = np.array([-nxy[1], nxy[0]]) / math.sqrt(nmag2)
    ax.plot(
        [p0[0] - tangent[0] * seg, p0[0] + tangent[0] * seg],
        [p0[1] - tangent[1] * seg, p0[1] + tangent[1] * seg],
        color=color,
        alpha=alpha,
        lw=lw,
    )


def build_comparison_plots(raw, refined, refined_sources, pano_pos):
    old, old_sources = load_old_registry_and_sources()
    if not old:
        return

    old_m = metric_arrays(old)
    new_m = metric_arrays(refined)

    fig = plt.figure(figsize=(18, 13), dpi=150)
    gs = fig.add_gridspec(3, 3, hspace=0.38, wspace=0.32)

    ax = fig.add_subplot(gs[0, 0])
    labels = ["clusters", "multi-pano", "spread>0.5m", "spread>1m"]
    old_vals = [
        len(old),
        int(np.sum(old_m["unique"] >= 2)),
        int(np.sum(old_m["spread"] > OFFSET_THRESH_M)),
        int(np.sum(old_m["spread"] > 1.0)),
    ]
    new_vals = [
        len(refined),
        int(np.sum(new_m["unique"] >= 2)),
        int(np.sum(new_m["spread"] > OFFSET_THRESH_M)),
        int(np.sum(new_m["spread"] > 1.0)),
    ]
    x = np.arange(len(labels))
    ax.bar(x - 0.18, old_vals, width=0.36, label="old connected-components", color="#8c8c8c")
    ax.bar(x + 0.18, new_vals, width=0.36, label="refined complete-linkage", color="#4c78a8")
    ax.set_xticks(x)
    ax.set_xticklabels(labels, rotation=15, ha="right")
    ax.set_title("Registry-level difference")
    ax.legend(fontsize=8)

    ax = fig.add_subplot(gs[0, 1])
    bins = np.array([0, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 2, 5, 15])
    ax.hist(old_m["spread"], bins=bins, alpha=0.65, label="old", color="#8c8c8c")
    ax.hist(new_m["spread"], bins=bins, alpha=0.70, label="refined", color="#4c78a8")
    ax.axvline(OFFSET_THRESH_M, color="#d62728", ls="--", lw=1.5, label="0.5m threshold")
    ax.set_xscale("symlog", linthresh=0.05)
    ax.set_xlabel("cluster offset spread (m)")
    ax.set_ylabel("# clusters")
    ax.set_title("Offset spread: lower is better")
    ax.legend(fontsize=8)

    ax = fig.add_subplot(gs[0, 2])
    ax.hist(old_m["normal_min"], bins=np.linspace(0.95, 1.0, 30), alpha=0.65, label="old", color="#8c8c8c")
    ax.hist(new_m["normal_min"], bins=np.linspace(0.95, 1.0, 30), alpha=0.70, label="refined", color="#4c78a8")
    ax.axvline(COS_THRESH, color="#d62728", ls="--", lw=1.5, label="cos threshold")
    ax.set_xlabel("min cosine to cluster mean")
    ax.set_ylabel("# clusters")
    ax.set_title("Normal consistency: closer to 1 is better")
    ax.legend(fontsize=8)

    ax = fig.add_subplot(gs[1, 0])
    q = [Counter(r["quality"] for r in refined)[k] for k in ["high", "medium", "low"]]
    ax.bar(["high", "medium", "low"], q, color=[QUALITY_COLORS[k] for k in ["high", "medium", "low"]])
    for i, v in enumerate(q):
        ax.text(i, v + 1, str(v), ha="center", va="bottom")
    ax.set_title("Refined cluster quality buckets")
    ax.set_ylabel("# clusters")

    ax = fig.add_subplot(gs[1, 1])
    cls_color = [CLASS_COLORS[r["classification"]] for r in refined]
    sizes = np.clip(np.sqrt(new_m["pixels"]) * 1.5, 15, 360)
    ax.scatter(new_m["unique"], new_m["spread"], s=sizes, c=cls_color, alpha=0.72, edgecolor="black", linewidth=0.3)
    ax.axhline(OFFSET_THRESH_M, color="#d62728", ls="--", lw=1.2)
    ax.set_xlabel("unique panos supporting cluster")
    ax.set_ylabel("offset spread (m)")
    ax.set_title("Refined support vs geometric tightness\n(size = sqrt total pixels)")
    ax.set_yscale("symlog", linthresh=0.05)

    ax = fig.add_subplot(gs[1, 2])
    old_gid0 = [r for r in old_sources if r["gid"] == 0]
    new_by_key = {r["key"]: r["gid"] for r in refined_sources}
    old_gid0 = [r for r in old_gid0 if r["key"] in new_by_key]
    old_gid0.sort(key=lambda r: r["d_global"])
    y = np.array([r["d_global"] for r in old_gid0], dtype=float)
    new_labels = np.array([new_by_key[r["key"]] for r in old_gid0], dtype=int)
    # Stable color by refined gid.
    colors = plt.cm.tab20((new_labels * 7) % 20)
    ax.scatter(np.arange(len(y)), y, s=7, c=colors, alpha=0.75, linewidths=0)
    ax.set_title("Old gid=0 ground split by refined clusters")
    ax.set_xlabel("old gid=0 sources sorted by d_global")
    ax.set_ylabel("d_global (m)")
    ax.text(
        0.02,
        0.98,
        f"old spread={max(y)-min(y):.2f}m\nrefined colors show split",
        transform=ax.transAxes,
        va="top",
        fontsize=9,
        bbox=dict(facecolor="white", alpha=0.85, edgecolor="#999"),
    )

    poses = np.array(list(pano_pos.values()), dtype=float)
    for col, title, registry, min_unique in [
        (0, "Old top facade planes", old, 2),
        (1, "Refined high/medium facade planes", refined, 2),
    ]:
        ax = fig.add_subplot(gs[2, col])
        ax.scatter(poses[:, 0], poses[:, 1], s=20, c="#d62728", edgecolors="black", linewidths=0.4, zorder=5, label="pano")
        candidates = [
            r for r in registry
            if r["classification"] == "facade" and r.get("n_unique_panos", r["n_sources"]) >= min_unique
        ]
        if title.startswith("Refined"):
            candidates = [r for r in candidates if r["quality"] in {"high", "medium"}]
        candidates = sorted(candidates, key=lambda r: (-r.get("n_unique_panos", r["n_sources"]), -r["total_pixels"]))[:80]
        for r in candidates:
            if title.startswith("Refined"):
                color = QUALITY_COLORS[r["quality"]]
                alpha = 0.75 if r["quality"] == "high" else 0.42
            else:
                color = "#666666"
                alpha = 0.35
            lw = 0.8 + min(2.2, math.log10(max(r["total_pixels"], 10)) * 0.25)
            plot_line_plane(ax, r, color=color, alpha=alpha, lw=lw, seg=7.0)
        ax.set_aspect("equal")
        ax.grid(alpha=0.25)
        ax.set_title(f"{title}\n{len(candidates)} plotted")
        ax.set_xlabel("east (m)")
        ax.set_ylabel("north (m)")

    ax = fig.add_subplot(gs[2, 2])
    cls_counts = Counter(r["classification"] for r in refined)
    x = np.arange(len(CLASS_ORDER))
    ax.bar(x, [cls_counts[c] for c in CLASS_ORDER], color=[CLASS_COLORS[c] for c in CLASS_ORDER])
    ax.set_xticks(x)
    ax.set_xticklabels(CLASS_ORDER, rotation=15, ha="right")
    ax.set_title("Refined classes")
    ax.set_ylabel("# clusters")

    fig.suptitle(
        "Global plane matching accuracy: connected-components vs complete-linkage refinement",
        fontsize=15,
        y=0.985,
    )
    fig.savefig(OUT / "comparison_accuracy.png", bbox_inches="tight")
    plt.close(fig)


def build_residual_strip_plot(refined: list[dict], refined_sources: list[dict]):
    old, old_sources = load_old_registry_and_sources()
    old_by_gid = {int(r["gid"]): r for r in old}
    refined_by_gid = {int(r["gid"]): r for r in refined}

    def group_sources(rows):
        out = defaultdict(list)
        for r in rows:
            out[int(r["gid"])].append(r)
        return out

    old_grouped = group_sources(old_sources)
    new_grouped = group_sources(refined_sources)

    old_top = sorted(
        old,
        key=lambda r: (-r.get("n_unique_panos", r["n_sources"]), -r["total_pixels"]),
    )[:28]
    new_top = sorted(
        [r for r in refined if r["quality"] in {"high", "medium"}],
        key=lambda r: (-r["n_unique_panos"], -r["total_pixels"]),
    )[:28]

    fig, axes = plt.subplots(1, 2, figsize=(17, 12), dpi=150)

    def draw(ax, title, registry_rows, grouped, by_gid, xlim, refined_mode: bool):
        for y, row in enumerate(registry_rows):
            gid = int(row["gid"])
            srcs = grouped.get(gid, [])
            if not srcs:
                continue
            center = float(by_gid[gid]["d_global"])
            residual = np.array([float(s["d_global"]) - center for s in srcs], dtype=float)
            cls = row["classification"]
            if refined_mode:
                color = QUALITY_COLORS[row["quality"]]
            else:
                color = CLASS_COLORS.get(cls, "#999999")
            size = np.clip(np.sqrt([float(s["n_pixels"]) for s in srcs]) * 1.5, 8, 90)
            ax.scatter(residual, np.full_like(residual, y, dtype=float), s=size,
                       c=color, alpha=0.68, edgecolor="black", linewidth=0.25)
            label = (
                f"gid {gid} {cls} "
                f"u={row.get('n_unique_panos', row['n_sources'])} "
                f"s={row['n_sources']} "
                f"spread={row['offset_spread_m']:.2f}"
            )
            ax.text(xlim[0], y, label, ha="left", va="center", fontsize=7)

        ax.axvline(0, color="#222", lw=1.0)
        ax.axvline(-OFFSET_THRESH_M, color="#d62728", lw=1.0, ls="--")
        ax.axvline(OFFSET_THRESH_M, color="#d62728", lw=1.0, ls="--")
        ax.set_xlim(*xlim)
        ax.set_ylim(-1, len(registry_rows))
        ax.invert_yaxis()
        ax.set_yticks([])
        ax.set_xlabel("source d_global residual from cluster mean (m)")
        ax.set_title(title)
        ax.grid(axis="x", alpha=0.25)

    draw(
        axes[0],
        "Old connected-components: source residuals inside top clusters",
        old_top,
        old_grouped,
        old_by_gid,
        (-8.0, 8.0),
        refined_mode=False,
    )
    draw(
        axes[1],
        "Refined complete-linkage: source residuals inside top clusters",
        new_top,
        new_grouped,
        refined_by_gid,
        (-0.65, 0.65),
        refined_mode=True,
    )

    fig.suptitle(
        "Plane matching accuracy as residual strips\n"
        "Each row is one global plane. Each dot is one pano-local plane observation. "
        "Tight rows centered near zero are reliable matches.",
        fontsize=14,
        y=0.985,
    )
    fig.tight_layout(rect=(0, 0, 1, 0.95))
    fig.savefig(OUT / "matching_residual_strips.png", bbox_inches="tight")
    plt.close(fig)


def write_comparison_report(refined: list[dict]):
    old, _ = load_old_registry_and_sources()
    if not old:
        return
    old_m = metric_arrays(old)
    new_m = metric_arrays(refined)
    lines = [
        "# Global planes refined comparison",
        "",
        "| metric | old connected-components | refined complete-linkage |",
        "|--------|--------------------------:|--------------------------:|",
        f"| clusters | {len(old)} | {len(refined)} |",
        f"| compression | {2405 / len(old):.1f}x | {2405 / len(refined):.1f}x |",
        f"| clusters with spread > 0.5m | {int(np.sum(old_m['spread'] > 0.5))} | {int(np.sum(new_m['spread'] > 0.5))} |",
        f"| clusters with spread > 1.0m | {int(np.sum(old_m['spread'] > 1.0))} | {int(np.sum(new_m['spread'] > 1.0))} |",
        f"| max offset spread | {float(np.max(old_m['spread'])):.3f}m | {float(np.max(new_m['spread'])):.3f}m |",
        f"| min normal consistency | {float(np.min(old_m['normal_min'])):.4f} | {float(np.min(new_m['normal_min'])):.4f} |",
        "",
        "See `comparison_accuracy.png` for the visual comparison.",
        "See `matching_residual_strips.png` for source-by-source residuals inside the top clusters.",
    ]
    (OUT / "comparison_report.md").write_text("\n".join(lines) + "\n")


def main():
    ap = argparse.ArgumentParser(description="Build refined cross-pano global factor registry.")
    add_spatial_args(ap)
    ap.add_argument(
        "--legacy-global-dir",
        type=Path,
        default=None,
        help="Optional old _global_planes directory for comparison plots/reports.",
    )
    args = ap.parse_args()
    paths = resolve_spatial_paths(args)
    legacy_dir = args.legacy_global_dir.resolve() if args.legacy_global_dir else find_legacy_global_dir(paths.test_root)
    configure_paths(paths, legacy_dir)

    OUT.mkdir(parents=True, exist_ok=True)
    print("Loading raw world-frame planes...")
    raw, pano_pos, lat_ref, lng_ref = load_raw_planes()
    print(f"Raw planes: {len(raw)} from {len(pano_pos)} panos")

    print("Clustering with complete-linkage constraints...")
    clusters = cluster_raw_planes(raw)
    print(f"Refined global planes: {len(clusters)}")

    registry, sources = build_registry(clusters, raw)
    (OUT / "registry.json").write_text(json.dumps({
        "anchor_lat_ref": lat_ref,
        "anchor_lng_ref": lng_ref,
        "cos_threshold": COS_THRESH,
        "angle_threshold_deg": math.degrees(ANGLE_THRESH),
        "offset_threshold_m": OFFSET_THRESH_M,
        "min_pixel_support": MIN_PIXEL_SUPPORT,
        "clustering": "complete_linkage_max(angle/threshold, offset/threshold)",
        "n_panos": len(pano_pos),
        "n_raw_planes": len(raw),
        "n_global_planes": len(registry),
        "registry": registry,
    }, indent=2))
    write_sources_csv(sources, OUT / "sources.csv")
    write_report(raw, registry, pano_pos, OUT / "report.md")
    build_comparison_plots(raw, registry, sources, pano_pos)
    build_residual_strip_plot(registry, sources)
    write_comparison_report(registry)

    q = Counter(r["quality"] for r in registry)
    print(f"Wrote {OUT}")
    print(f"Quality: high={q['high']} medium={q['medium']} low={q['low']}")


if __name__ == "__main__":
    main()
