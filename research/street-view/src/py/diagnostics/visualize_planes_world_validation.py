#!/usr/bin/env python3
"""Build intuitive validation figures for `_planes_world`.

The figures are meant to answer one practical question:

    Can the Google plane/indexmap layer be treated as ground truth?

They combine:
  - dominant ground-plane tilt before/after world-frame rotation;
  - the most reliable and most questionable per-pano overlay examples;
  - the global plane top-down diagnostics, if they already exist.
"""

from __future__ import annotations

import argparse
import csv
import math
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sv3d_paths import add_spatial_args, resolve_spatial_paths  # noqa: E402

OUT_DIR: Path
OVERLAY_DIR: Path
GLOBAL_FIG_DIR: Path


def configure_paths(paths):
    global OUT_DIR, OVERLAY_DIR, GLOBAL_FIG_DIR
    OUT_DIR = paths.planes_world_dir
    OVERLAY_DIR = paths.indexmap_overlay_dir
    GLOBAL_FIG_DIR = paths.global_factors_dir / "figures"


USER_REPORTED = [
    "w5VCFEh1Oy97tEGpsznujQ",
    "VdXblPs-TkJMd91HeYnIhQ",
    "SUmYLzRenMzPVHEPziNhUQ",
    "RsP4TtIEvgOlTnTwKoQcsw",
    "Rd4S-y2ou5t1Hqp_QUWfzg",
    "mlljSxWnfrw2zR7AMIOAfw",
]


def read_summary(summary_fp: Path) -> list[dict]:
    rows = []
    with summary_fp.open(newline="") as f:
        for row in csv.DictReader(f):
            try:
                row["n_planes"] = int(row["n_planes"])
                row["ground_tilt_local_deg"] = float(row["ground_tilt_local_deg"])
                row["ground_tilt_world_deg"] = float(row["ground_tilt_world_deg"])
                row["pitch_off_deg"] = float(row["pitch_off_deg"])
                row["roll_deg"] = float(row["roll_deg"])
            except (KeyError, ValueError):
                continue
            rows.append(row)
    return rows


def read_shift_log(shift_fp: Path) -> dict[str, dict]:
    if not shift_fp.exists():
        return {}
    out = {}
    with shift_fp.open(newline="") as f:
        for row in csv.DictReader(f):
            out[row["panoid"]] = row
    return out


def open_image(fp: Path, max_size: tuple[int, int] | None = None) -> Image.Image | None:
    if not fp.exists():
        return None
    im = Image.open(fp).convert("RGB")
    if max_size:
        im.thumbnail(max_size, Image.Resampling.LANCZOS)
    return im


def show_image(ax, fp: Path, title: str, subtitle: str = "", max_size=(900, 620)):
    im = open_image(fp, max_size=max_size)
    ax.axis("off")
    if im is None:
        ax.text(0.5, 0.5, f"Missing\n{fp.name}", ha="center", va="center", fontsize=9)
    else:
        ax.imshow(im)
    ax.set_title(title + (f"\n{subtitle}" if subtitle else ""), fontsize=9, pad=4)


def show_overlay_crop(ax, fp: Path, title: str, subtitle: str = ""):
    im = open_image(fp)
    ax.axis("off")
    if im is None:
        ax.text(0.5, 0.5, f"Missing\n{fp.name}", ha="center", va="center", fontsize=9)
    else:
        w, h = im.size
        # Overlay PNGs are 3-panel figures: JPG, indexmap, final overlay.
        # The bottom third is the visual check humans care about most.
        crop = im.crop((0, int(h * 0.66), w, int(h * 0.985)))
        ax.imshow(crop)
    ax.set_title(title + (f"\n{subtitle}" if subtitle else ""), fontsize=10, pad=4)


def quality_label(world_tilt: float) -> str:
    if world_tilt <= 2:
        return "good"
    if world_tilt <= 5:
        return "usable"
    return "risky"


def select_examples(rows: list[dict]) -> tuple[list[dict], list[dict]]:
    available = [r for r in rows if (OVERLAY_DIR / f"{r['panoid']}_overlay.png").exists()]
    good = sorted(available, key=lambda r: (r["ground_tilt_world_deg"], -r["n_planes"]))[:6]

    by_id = {r["panoid"]: r for r in available}
    risky = [by_id[p] for p in USER_REPORTED if p in by_id]
    worst = sorted(available, key=lambda r: r["ground_tilt_world_deg"], reverse=True)
    for r in worst:
        if r["panoid"] not in {x["panoid"] for x in risky}:
            risky.append(r)
        if len(risky) >= 6:
            break
    return good[:6], risky[:6]


def build_scorecard(rows: list[dict], shift_log: dict[str, dict], out_fp: Path):
    world = np.array([r["ground_tilt_world_deg"] for r in rows], dtype=float)
    local = np.array([r["ground_tilt_local_deg"] for r in rows], dtype=float)
    panoids = [r["panoid"] for r in rows]
    order = np.argsort(world)

    shifts = []
    edge_diag = []
    for r in rows:
        s = shift_log.get(r["panoid"], {})
        try:
            shifts.append(float(s.get("shift_px", "nan")))
            edge_diag.append(float(s.get("edge_shift_px", "nan")))
        except ValueError:
            shifts.append(float("nan"))
            edge_diag.append(float("nan"))
    shifts = np.array(shifts, dtype=float)
    edge_diag = np.array(edge_diag, dtype=float)

    fig = plt.figure(figsize=(18, 12), dpi=160)
    gs = fig.add_gridspec(3, 3, height_ratios=[1.0, 1.0, 1.1], hspace=0.45, wspace=0.28)

    ax = fig.add_subplot(gs[0, 0])
    bins = np.arange(0, max(15, math.ceil(np.nanmax(world)) + 2), 1)
    ax.hist(world, bins=bins, color="#4c78a8", edgecolor="white")
    ax.axvline(2, color="#2ca02c", lw=2, ls="--", label="good <= 2 deg")
    ax.axvline(5, color="#ff7f0e", lw=2, ls="--", label="risky > 5 deg")
    ax.set_title("Dominant ground normal after world rotation")
    ax.set_xlabel("tilt from vertical ground normal (deg)")
    ax.set_ylabel("# panos")
    ax.legend(fontsize=8)

    ax = fig.add_subplot(gs[0, 1])
    ax.scatter(local, world, s=45, color="#5f9ed1", edgecolor="#243447", linewidth=0.4)
    lim = max(float(np.nanmax(local)), float(np.nanmax(world)), 15)
    ax.plot([0, lim], [0, lim], color="#888", lw=1, ls=":")
    ax.axhline(2, color="#2ca02c", lw=1, ls="--")
    ax.axhline(5, color="#ff7f0e", lw=1, ls="--")
    ax.set_xlim(0, lim)
    ax.set_ylim(0, lim)
    ax.set_aspect("equal", adjustable="box")
    ax.set_title("Rotation sanity check")
    ax.set_xlabel("local-frame ground tilt (deg)")
    ax.set_ylabel("world-frame ground tilt (deg)")

    ax = fig.add_subplot(gs[0, 2])
    counts = [
        int(np.sum(world <= 2)),
        int(np.sum((world > 2) & (world <= 5))),
        int(np.sum(world > 5)),
    ]
    colors = ["#2ca02c", "#ffbf50", "#d62728"]
    ax.bar(["good", "usable", "risky"], counts, color=colors)
    for i, c in enumerate(counts):
        ax.text(i, c + 0.4, str(c), ha="center", va="bottom", fontsize=11)
    ax.set_title("Pseudo-GT confidence buckets")
    ax.set_ylabel("# panos")
    ax.set_ylim(0, max(counts) + 4)

    ax = fig.add_subplot(gs[1, :2])
    sorted_world = world[order]
    sorted_ids = [panoids[i] for i in order]
    x = np.arange(len(sorted_world))
    bar_colors = [
        "#2ca02c" if v <= 2 else "#ffbf50" if v <= 5 else "#d62728"
        for v in sorted_world
    ]
    ax.bar(x, sorted_world, color=bar_colors, width=0.8)
    ax.axhline(2, color="#2ca02c", lw=1.5, ls="--")
    ax.axhline(5, color="#ff7f0e", lw=1.5, ls="--")
    ax.set_title("Every pano sorted by world-frame ground tilt")
    ax.set_ylabel("tilt (deg)")
    ax.set_xticks(x[::2])
    ax.set_xticklabels([s[:6] for s in sorted_ids[::2]], rotation=70, fontsize=7)
    ax.set_xlim(-0.5, len(sorted_world) - 0.5)

    ax = fig.add_subplot(gs[1, 2])
    if np.isfinite(edge_diag).any():
        ax.scatter(edge_diag, world, s=40, color="#9c755f", edgecolor="#3a241f", linewidth=0.4)
        ax.axvline(0, color="#444", lw=1)
        ax.axhline(5, color="#ff7f0e", lw=1, ls="--")
        ax.set_title("Edge-shift diagnostic is not GT")
        ax.set_xlabel("edge diagnostic shift (px)")
        ax.set_ylabel("ground tilt (deg)")
    else:
        ax.text(0.5, 0.5, "No shift_log.csv", ha="center", va="center")
        ax.axis("off")

    ax = fig.add_subplot(gs[2, 0])
    ground_fp = OUT_DIR / "ground_normal_validation.png"
    show_image(ax, ground_fp, "Existing ground-normal validation", max_size=(1000, 620))

    ax = fig.add_subplot(gs[2, 1])
    global_ground = GLOBAL_FIG_DIR / "ground_only.png"
    show_image(ax, global_ground, "Global ground continuity", max_size=(1000, 620))

    ax = fig.add_subplot(gs[2, 2])
    global_facade = GLOBAL_FIG_DIR / "facades_only.png"
    show_image(ax, global_facade, "Global facade continuity", max_size=(1000, 620))

    fig.suptitle(
        "_planes_world pseudo-groundtruth validation\n"
        "Use as weak geometry labels when ground is vertical and overlay boundaries visually match; "
        "do not treat blocky/misaligned facades as true GT.",
        fontsize=15,
        y=0.985,
    )
    fig.savefig(out_fp, bbox_inches="tight")
    plt.close(fig)


def build_examples(good: list[dict], risky: list[dict], out_fp: Path):
    fig, axes = plt.subplots(4, 3, figsize=(18, 18), dpi=150)
    axes = axes.ravel()
    examples = []
    for r in good:
        examples.append(("LOW-RISK", r))
    for r in risky:
        examples.append(("CHECK", r))

    for ax, item in zip(axes, examples):
        tag, r = item
        pid = r["panoid"]
        tilt = r["ground_tilt_world_deg"]
        label = quality_label(tilt)
        fp = OVERLAY_DIR / f"{pid}_overlay.png"
        show_image(
            ax,
            fp,
            f"{tag}  {pid[:12]}",
            f"world ground tilt={tilt:.2f} deg | {label} | planes={r['n_planes']}",
            max_size=(850, 590),
        )
    for ax in axes[len(examples):]:
        ax.axis("off")

    fig.suptitle(
        "Street-view overlay examples for judging whether _planes_world behaves like GT\n"
        "LOW-RISK: ground pose is stable. CHECK: user-reported or high-tilt samples; inspect boundaries manually.",
        fontsize=14,
        y=0.995,
    )
    fig.tight_layout(rect=(0, 0, 1, 0.975))
    fig.savefig(out_fp, bbox_inches="tight")
    plt.close(fig)


def build_quicklook(good: list[dict], risky: list[dict], out_fp: Path):
    fig, axes = plt.subplots(4, 3, figsize=(20, 12), dpi=160)
    axes = axes.ravel()
    examples = [("LOW-RISK", r) for r in good] + [("CHECK", r) for r in risky]

    for ax, item in zip(axes, examples):
        tag, r = item
        pid = r["panoid"]
        tilt = r["ground_tilt_world_deg"]
        fp = OVERLAY_DIR / f"{pid}_overlay.png"
        show_overlay_crop(
            ax,
            fp,
            f"{tag}  {pid[:14]}",
            f"ground tilt={tilt:.2f} deg | {quality_label(tilt)}",
        )
    for ax in axes[len(examples):]:
        ax.axis("off")

    fig.suptitle(
        "Quick visual check: final overlay panel only\n"
        "Good pseudo-GT means colored plane boundaries follow roads, facades and horizon; "
        "blocky or shifted facades are weak-label failures.",
        fontsize=15,
        y=0.99,
    )
    fig.tight_layout(rect=(0, 0, 1, 0.95))
    fig.savefig(out_fp, bbox_inches="tight")
    plt.close(fig)


def write_markdown(rows: list[dict], out_fp: Path):
    world = np.array([r["ground_tilt_world_deg"] for r in rows], dtype=float)
    worst = sorted(rows, key=lambda r: r["ground_tilt_world_deg"], reverse=True)[:10]
    lines = [
        "# _planes_world validation notes",
        "",
        "`_planes_world` is Google photometa plane geometry rotated into the world/gravity frame.",
        "It should be treated as pseudo-groundtruth / weak GT, not survey-grade groundtruth.",
        "",
        "## Ground tilt summary",
        "",
        f"- panos: {len(rows)}",
        f"- mean world ground tilt: {world.mean():.2f} deg",
        f"- median world ground tilt: {np.median(world):.2f} deg",
        f"- good (<=2 deg): {int(np.sum(world <= 2))}",
        f"- usable (2-5 deg): {int(np.sum((world > 2) & (world <= 5)))}",
        f"- risky (>5 deg): {int(np.sum(world > 5))}",
        "",
        "## Most risky by ground tilt",
        "",
    ]
    for r in worst:
        lines.append(
            f"- `{r['panoid']}`: {r['ground_tilt_world_deg']:.2f} deg "
            f"(local {r['ground_tilt_local_deg']:.2f} deg, {r['n_planes']} planes)"
        )
    lines.extend(
        [
            "",
            "## Generated figures",
            "",
            "- `planes_world_groundtruth_validation.png`: scorecard + global continuity figures.",
            "- `planes_world_overlay_examples.png`: low-risk and risky street-view overlay examples.",
            "- `planes_world_overlay_quicklook.png`: final overlay crops only, optimized for quick visual inspection.",
        ]
    )
    out_fp.write_text("\n".join(lines) + "\n")


def main():
    ap = argparse.ArgumentParser(description="Build validation figures for world-frame planes.")
    add_spatial_args(ap)
    ap.add_argument("--out-dir", type=Path, default=None)
    ap.add_argument("--summary", type=Path, default=None)
    ap.add_argument("--shift-log", type=Path, default=None)
    args = ap.parse_args()

    paths = resolve_spatial_paths(args)
    configure_paths(paths)
    out_dir = args.out_dir or OUT_DIR
    summary = args.summary or OUT_DIR / "summary.csv"
    shift_log_fp = args.shift_log or OVERLAY_DIR / "shift_log.csv"

    out_dir.mkdir(parents=True, exist_ok=True)
    rows = read_summary(summary)
    if not rows:
        raise SystemExit(f"No usable rows in {summary}")
    shift_log = read_shift_log(shift_log_fp)
    good, risky = select_examples(rows)

    scorecard_fp = out_dir / "planes_world_groundtruth_validation.png"
    examples_fp = out_dir / "planes_world_overlay_examples.png"
    quicklook_fp = out_dir / "planes_world_overlay_quicklook.png"
    notes_fp = out_dir / "planes_world_validation_notes.md"

    build_scorecard(rows, shift_log, scorecard_fp)
    build_examples(good, risky, examples_fp)
    build_quicklook(good, risky, quicklook_fp)
    write_markdown(rows, notes_fp)

    print(f"Wrote {scorecard_fp}")
    print(f"Wrote {examples_fp}")
    print(f"Wrote {quicklook_fp}")
    print(f"Wrote {notes_fp}")


if __name__ == "__main__":
    main()
