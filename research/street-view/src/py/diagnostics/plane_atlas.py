#!/usr/bin/env python3
"""
plane_atlas.py — Build a contact sheet of every plane's panorama region.

For each non-sky plane in the focal photometa:
  - find the indexmap cells assigned to this plane
  - crop the corresponding region of the original 8192×4096 panorama JPEG
  - desaturate pixels in the crop that DON'T belong to this plane (so the
    actual textured area pops out)
  - label with plane id (large), class, pixel count, distance, normal

Tile all into a single PNG atlas. Lets you visually identify which planes
have texture-mapping problems by their number.

Usage:
  python3 TEST/src/py/diagnostics/plane_atlas.py [--min-pixels N] [--cols K]
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


REF = Path(
    "TEST/data/raw/google_maps/temporal/JqSnKB7Pp-XymzXWDuP71w/"
    "2026-05-03_14-13-28-097/captures/2025-03-01_JqSnKB7Pp-XymzXWDuP71w"
)
OUT = Path("TEST/docs/figures/plane_atlas.png")


def classify(p: dict) -> str:
    nz = p["nz"]
    if abs(nz) > 0.85:
        return "ground" if nz < 0 else "ceiling"
    if abs(nz) < 0.5:
        return "facade"
    return "oblique"


def load_font(size: int):
    for path in (
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/HelveticaNeue.ttc",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except (OSError, IOError):
            continue
    return ImageFont.load_default()


def representative_distance(plane: dict, idx: np.ndarray, pid: int) -> float | None:
    """Distance from camera origin to the centroid hit on this plane."""
    cells = np.argwhere(idx == pid)
    if len(cells) == 0:
        return None
    H, W = idx.shape
    rs, cs = cells[:, 0], cells[:, 1]
    # Pipeline convention: theta = (c+0.5)/W·2π − π,  phi = π/2 − (r+0.5)/H·π
    theta = (cs + 0.5) / W * 2 * np.pi - np.pi
    phi = np.pi / 2 - (rs + 0.5) / H * np.pi
    cosp = np.cos(phi)
    dx = np.sin(theta) * cosp
    dy = np.cos(theta) * cosp
    dz = np.sin(phi)
    nx, ny, nz, d = plane["nx"], plane["ny"], plane["nz"], plane["d"]
    denom = nx * dx + ny * dy + nz * dz
    valid = denom > 1e-5
    if not np.any(valid):
        return None
    t = d / denom[valid]
    valid2 = (t > 0.05) & (t < 250)
    if not np.any(valid2):
        return None
    return float(np.median(t[valid2]))


def make_thumbnail(rec: dict, pano: Image.Image, idx: np.ndarray,
                   thumb_w: int) -> Image.Image:
    H_idx, W_idx = idx.shape
    pano_w, pano_h = pano.size
    DOWN = pano_w // W_idx  # 16

    px_min = rec["cmin"] * DOWN
    px_max = (rec["cmax"] + 1) * DOWN
    py_min = rec["rmin"] * DOWN
    py_max = (rec["rmax"] + 1) * DOWN
    px_min = max(0, min(pano_w, px_min))
    px_max = max(0, min(pano_w, px_max))
    py_min = max(0, min(pano_h, py_min))
    py_max = max(0, min(pano_h, py_max))

    crop = pano.crop((px_min, py_min, px_max, py_max))
    crop_arr = np.array(crop)
    h, w = crop_arr.shape[:2]
    if h == 0 or w == 0:
        return None

    # Build the "this-plane" mask at panorama resolution by reverse-mapping
    # each pano pixel back to its indexmap cell.
    pano_x = np.arange(px_min, px_max)
    pano_y = np.arange(py_min, py_max)
    cols = np.clip(pano_x // DOWN, 0, W_idx - 1)
    rows = np.clip(pano_y // DOWN, 0, H_idx - 1)
    cols_grid = np.broadcast_to(cols[None, :], (h, w))
    rows_grid = np.broadcast_to(rows[:, None], (h, w))
    mask = idx[rows_grid, cols_grid] == rec["pid"]

    # Desaturate non-mask pixels and dim them.
    gray = np.dot(crop_arr.astype(np.float32), [0.299, 0.587, 0.114])
    gray = (gray * 0.55 + 80).clip(0, 255).astype(np.uint8)
    out = crop_arr.copy()
    out[~mask] = np.stack([gray[~mask]] * 3, axis=-1)

    img = Image.fromarray(out)

    # Resize so width fits THUMB_W; clamp height too.
    aspect = w / h if h > 0 else 1.0
    target_w = thumb_w
    target_h = int(round(thumb_w / aspect)) if aspect > 0 else thumb_w
    max_h = thumb_w  # square-ish upper bound on height
    if target_h > max_h:
        target_h = max_h
        target_w = int(round(max_h * aspect))
    target_w = max(2, target_w)
    target_h = max(2, target_h)
    img = img.resize((target_w, target_h), Image.LANCZOS)

    # Draw outline of the indexmap cell extent (where mask == True bounding box)
    # — that's already the whole image since the bbox IS our crop, so skip.

    # Compose a card: header above thumbnail.
    HEADER_H = 60
    card_w = thumb_w
    card_h = HEADER_H + target_h + 8
    card = Image.new("RGB", (card_w, card_h), (252, 253, 254))
    cx = (card_w - target_w) // 2
    card.paste(img, (cx, HEADER_H + 4))

    draw = ImageDraw.Draw(card)
    font_big = load_font(28)
    font_sm = load_font(11)
    font_md = load_font(13)
    draw.text((10, 4), f"#{rec['pid']}", fill=(26, 115, 232), font=font_big)
    nx, ny, nz = rec["normal"]
    line1 = f"{rec['cls']} · {rec['pixels']} px · d={rec['d']:.1f}m"
    if rec["distance"] is not None:
        line1 += f" · t≈{rec['distance']:.0f}m"
    line2 = f"n=({nx:+.2f},{ny:+.2f},{nz:+.2f})"
    draw.text((78, 8), line1, fill=(60, 64, 67), font=font_md)
    draw.text((78, 25), line2, fill=(95, 99, 104), font=font_sm)
    extent = f"cells col [{rec['cmin']:>3}–{rec['cmax']:>3}] · row [{rec['rmin']:>3}–{rec['rmax']:>3}]"
    draw.text((78, 40), extent, fill=(128, 134, 139), font=font_sm)

    # Light divider line under the header
    draw.line([(0, HEADER_H), (card_w, HEADER_H)], fill=(218, 220, 224), width=1)
    return card


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-pixels", type=int, default=20,
                    help="Skip planes with fewer indexmap cells (default 20).")
    ap.add_argument("--cols", type=int, default=5)
    ap.add_argument("--thumb-w", type=int, default=320)
    ap.add_argument("--sort", choices=("pid", "pixels"), default="pid")
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()

    idx = np.frombuffer(
        (REF / "photometa_0_parsed_indexmap.bin").read_bytes(), dtype=np.uint8
    ).reshape(256, 512)
    pdata = json.loads((REF / "photometa_0_parsed_planes.json").read_text())
    planes = pdata["planes"]
    ppp = pdata["pixelsPerPlane"]
    pano = Image.open(REF / "panoramas" / "JqSnKB7Pp-XymzXWDuP71w.jpg").convert("RGB")
    pano_w, pano_h = pano.size
    print(f"Panorama: {pano_w}×{pano_h}, indexmap: {idx.shape}")

    records = []
    for pid in range(1, len(planes)):
        if ppp[pid] < args.min_pixels:
            continue
        cells = np.argwhere(idx == pid)
        if len(cells) == 0:
            continue
        rs, cs = cells[:, 0], cells[:, 1]
        records.append({
            "pid": pid,
            "pixels": int(ppp[pid]),
            "cls": classify(planes[pid]),
            "normal": (planes[pid]["nx"], planes[pid]["ny"], planes[pid]["nz"]),
            "d": float(planes[pid]["d"]),
            "cmin": int(cs.min()),
            "cmax": int(cs.max()),
            "rmin": int(rs.min()),
            "rmax": int(rs.max()),
            "distance": representative_distance(planes[pid], idx, pid),
        })

    if args.sort == "pixels":
        records.sort(key=lambda r: -r["pixels"])
    else:
        records.sort(key=lambda r: r["pid"])

    print(f"Generating {len(records)} thumbnails (≥{args.min_pixels} cells each)…")

    thumbs = []
    for r in records:
        t = make_thumbnail(r, pano, idx, args.thumb_w)
        if t is not None:
            thumbs.append(t)

    cols = args.cols
    rows = math.ceil(len(thumbs) / cols)
    PAD = 14
    THUMB_W = args.thumb_w
    row_heights = []
    for ri in range(rows):
        row = thumbs[ri * cols : (ri + 1) * cols]
        row_heights.append(max(t.height for t in row))

    atlas_w = cols * THUMB_W + (cols + 1) * PAD
    atlas_h = sum(row_heights) + (rows + 1) * PAD + 60  # header
    atlas = Image.new("RGB", (atlas_w, atlas_h), (240, 242, 245))
    title_draw = ImageDraw.Draw(atlas)
    title = (
        f"Plane Atlas — JqSnKB7Pp-XymzXWDuP71w · {len(records)} planes "
        f"(min cells={args.min_pixels}, sorted by {args.sort})"
    )
    title_draw.text((PAD, 18), title, fill=(32, 33, 36), font=load_font(18))
    title_draw.text(
        (PAD, 42),
        "Each thumbnail = the panorama region the plane covers; non-plane pixels are desaturated.",
        fill=(95, 99, 104),
        font=load_font(12),
    )

    y = 60 + PAD
    for ri in range(rows):
        x = PAD
        rh = row_heights[ri]
        for ci in range(cols):
            ti = ri * cols + ci
            if ti >= len(thumbs):
                break
            atlas.paste(thumbs[ti], (x, y))
            x += THUMB_W + PAD
        y += rh + PAD

    args.out.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(args.out, optimize=True)
    print(f"Saved: {args.out}  ({atlas.size[0]}×{atlas.size[1]})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
