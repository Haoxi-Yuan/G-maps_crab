#!/usr/bin/env python3
"""Build menu-region crops from PP-OCR text boxes and price-like anchors."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageOps


CURRENCY_PRICE = re.compile(r"(?i)(?:S\s*\$|SGD\s*|\$)\s*\d")
DECIMAL_PRICE = re.compile(r"(?<!\d)\d{1,4}[.,]\d{1,2}(?!\d)")
PURE_INTEGER = re.compile(r"^\s*\d{1,4}\s*$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample-db", required=True)
    parser.add_argument("--ppocr-db", required=True)
    parser.add_argument("--ppocr-run-id", default="ppocr_smoke_v1")
    parser.add_argument("--classification-db")
    parser.add_argument("--classification-run-id", default="luna_smoke_v1")
    parser.add_argument("--out-db", required=True)
    parser.add_argument("--crop-root", required=True)
    parser.add_argument("--run-id", default="menu_crop_smoke_v1")
    parser.add_argument("--max-tile-side", type=int, default=1800)
    parser.add_argument("--overlap", type=float, default=0.15)
    parser.add_argument("--max-tiles-per-image", type=int, default=6)
    args = parser.parse_args()
    if args.max_tile_side < 512:
        parser.error("--max-tile-side must be at least 512")
    if not 0 <= args.overlap < 0.5:
        parser.error("--overlap must be in [0, 0.5)")
    return args


def is_price_anchor(text: str, allow_integer: bool = False) -> bool:
    return bool(
        CURRENCY_PRICE.search(text)
        or DECIMAL_PRICE.search(text)
        or (allow_integer and PURE_INTEGER.fullmatch(text))
    )


def box_distance(left: sqlite3.Row, right: sqlite3.Row, width: int, height: int) -> float:
    lx = (left["x_min"] + left["x_max"]) / 2
    ly = (left["y_min"] + left["y_max"]) / 2
    rx = (right["x_min"] + right["x_max"]) / 2
    ry = (right["y_min"] + right["y_max"]) / 2
    return math.hypot((lx - rx) / width, (ly - ry) / height)


def components(anchors: list[sqlite3.Row], width: int, height: int) -> list[list[sqlite3.Row]]:
    remaining = set(range(len(anchors)))
    groups: list[list[sqlite3.Row]] = []
    while remaining:
        seed = remaining.pop()
        indexes = {seed}
        queue = [seed]
        while queue:
            current = queue.pop()
            linked = {
                candidate
                for candidate in remaining
                if box_distance(anchors[current], anchors[candidate], width, height) <= 0.28
            }
            remaining.difference_update(linked)
            indexes.update(linked)
            queue.extend(linked)
        groups.append([anchors[index] for index in sorted(indexes)])
    return groups


def intersect(left: tuple[int, int, int, int], right: tuple[int, int, int, int]) -> bool:
    return left[0] <= right[2] and right[0] <= left[2] and left[1] <= right[3] and right[1] <= left[3]


def merge_regions(regions: list[tuple[int, int, int, int]]) -> list[tuple[int, int, int, int]]:
    pending = regions[:]
    merged: list[tuple[int, int, int, int]] = []
    while pending:
        region = pending.pop()
        changed = True
        while changed:
            changed = False
            for index, other in enumerate(pending):
                if intersect(region, other):
                    region = (
                        min(region[0], other[0]),
                        min(region[1], other[1]),
                        max(region[2], other[2]),
                        max(region[3], other[3]),
                    )
                    pending.pop(index)
                    changed = True
                    break
        merged.append(region)
    return sorted(merged, key=lambda item: (item[1], item[0]))


def price_regions(
    lines: list[sqlite3.Row], width: int, height: int
) -> list[tuple[int, int, int, int, int]]:
    integer_count = sum(bool(PURE_INTEGER.fullmatch(row["text_raw"])) for row in lines)
    anchors = [row for row in lines if is_price_anchor(row["text_raw"], allow_integer=integer_count >= 8)]
    if not anchors:
        return []
    raw_regions: list[tuple[int, int, int, int]] = []
    for group in components(anchors, width, height):
        if len(group) == 1 and not CURRENCY_PRICE.search(group[0]["text_raw"]):
            continue
        line_heights = [max(1.0, row["y_max"] - row["y_min"]) for row in group]
        vertical_margin = max(0.055 * height, 4 * sorted(line_heights)[len(line_heights) // 2])
        x0 = max(0, int(min(row["x_min"] for row in group) - 0.34 * width))
        x1 = min(width, int(max(row["x_max"] for row in group) + 0.18 * width))
        y0 = max(0, int(min(row["y_min"] for row in group) - vertical_margin))
        y1 = min(height, int(max(row["y_max"] for row in group) + vertical_margin))
        nearby = [
            row for row in lines
            if x0 <= (row["x_min"] + row["x_max"]) / 2 <= x1
            and y0 <= (row["y_min"] + row["y_max"]) / 2 <= y1
        ]
        if nearby:
            x0 = max(0, int(min(row["x_min"] for row in nearby) - 0.025 * width))
            x1 = min(width, int(max(row["x_max"] for row in nearby) + 0.025 * width))
            y0 = max(0, int(min(row["y_min"] for row in nearby) - 0.025 * height))
            y1 = min(height, int(max(row["y_max"] for row in nearby) + 0.025 * height))
        if x1 - x0 >= 128 and y1 - y0 >= 128:
            raw_regions.append((x0, y0, x1, y1))
    merged = merge_regions(raw_regions)
    return [
        (x0, y0, x1, y1, sum(
            x0 <= (row["x_min"] + row["x_max"]) / 2 <= x1
            and y0 <= (row["y_min"] + row["y_max"]) / 2 <= y1
            and is_price_anchor(row["text_raw"], allow_integer=integer_count >= 8)
            for row in lines
        ))
        for x0, y0, x1, y1 in merged
    ]


def starts(length: int, max_side: int, overlap: float) -> list[int]:
    if length <= max_side:
        return [0]
    stride = max(1, int(max_side * (1 - overlap)))
    values = list(range(0, max(1, length - max_side + 1), stride))
    last = length - max_side
    if not values or values[-1] != last:
        if values and last - values[-1] <= max_side * overlap:
            values[-1] = last
        else:
            values.append(last)
    return values


def tile_region(
    region: tuple[int, int, int, int, int], max_side: int, overlap: float, max_tiles: int
) -> list[tuple[int, int, int, int, int]]:
    x0, y0, x1, y1, anchors = region
    if x1 - x0 <= max_side * 1.15 and y1 - y0 <= max_side * 1.15:
        return [region]
    xs = starts(x1 - x0, max_side, overlap)
    ys = starts(y1 - y0, max_side, overlap)
    tiles = [
        (x0 + x, y0 + y, min(x1, x0 + x + max_side), min(y1, y0 + y + max_side), anchors)
        for y in ys for x in xs
    ]
    if len(tiles) <= max_tiles:
        return tiles
    scale = math.sqrt(len(tiles) / max_tiles)
    return tile_region(region, int(max_side * scale) + 1, overlap, max_tiles)


def create_schema(db: sqlite3.Connection) -> None:
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS sample_runs (
          run_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, source_manifest TEXT NOT NULL,
          seed TEXT NOT NULL, single_per_bin INTEGER NOT NULL, multi_pois INTEGER NOT NULL,
          images_per_multi INTEGER NOT NULL, sample_count INTEGER NOT NULL, poi_count INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS samples (
          sample_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, cohort TEXT NOT NULL,
          group_id TEXT NOT NULL, group_image_index INTEGER NOT NULL, place_id TEXT NOT NULL,
          business_name TEXT, main_category TEXT, full_address TEXT, poi_unique_images INTEGER NOT NULL,
          poi_image_bin TEXT NOT NULL, image_id TEXT NOT NULL, photo_id TEXT, local_path TEXT NOT NULL,
          source_width INTEGER, source_height INTEGER, orientation TEXT NOT NULL,
          resolution_bin TEXT NOT NULL, file_size_bytes INTEGER NOT NULL,
          parent_sample_id TEXT NOT NULL, crop_index INTEGER NOT NULL, crop_x0 INTEGER NOT NULL,
          crop_y0 INTEGER NOT NULL, crop_x1 INTEGER NOT NULL, crop_y1 INTEGER NOT NULL,
          price_anchor_count INTEGER NOT NULL
        );
        """
    )


def orientation(width: int, height: int) -> str:
    ratio = width / height
    if ratio > 1.15:
        return "landscape"
    if ratio < 0.87:
        return "portrait"
    return "squareish"


def resolution_bin(width: int, height: int) -> str:
    megapixels = width * height / 1_000_000
    if megapixels < 1:
        return "<1MP"
    if megapixels < 4:
        return "1-4MP"
    if megapixels < 12:
        return "4-12MP"
    return "12MP+"


def main() -> None:
    args = parse_args()
    sample_db = sqlite3.connect(args.sample_db)
    sample_db.row_factory = sqlite3.Row
    ppocr = sqlite3.connect(args.ppocr_db)
    ppocr.row_factory = sqlite3.Row
    out_path = Path(args.out_db).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    crop_root = Path(args.crop_root).resolve()
    crop_root.mkdir(parents=True, exist_ok=True)
    out = sqlite3.connect(out_path)
    create_schema(out)
    parents = [
        sample_db.execute("SELECT * FROM samples WHERE sample_id=?", (row[0],)).fetchone()
        for row in ppocr.execute(
            "SELECT sample_id FROM results WHERE run_id=? AND status='completed' ORDER BY sample_id",
            (args.ppocr_run_id,),
        )
    ]
    if args.classification_db:
        classification = sqlite3.connect(args.classification_db)
        menu_ids = {
            sample_id
            for sample_id, parsed_json in classification.execute(
                "SELECT sample_id, parsed_json FROM results WHERE run_id=? AND status='completed'",
                (args.classification_run_id,),
            )
            if parsed_json and bool(json.loads(parsed_json).get("is_menu"))
        }
        classification.close()
        parents = [parent for parent in parents if parent["sample_id"] in menu_ids]
    inserted = 0
    pois: set[str] = set()
    for parent in parents:
        lines = list(
            ppocr.execute(
                "SELECT * FROM text_lines WHERE run_id=? AND sample_id=? ORDER BY line_index",
                (args.ppocr_run_id, parent["sample_id"]),
            )
        )
        with Image.open(parent["local_path"]) as opened:
            image = ImageOps.exif_transpose(opened).convert("RGB")
            width, height = image.size
            regions = price_regions(lines, width, height)
            if not regions:
                regions = [(0, 0, width, height, 0)]
            tiles: list[tuple[int, int, int, int, int]] = []
            for region in regions:
                tiles.extend(
                    tile_region(region, args.max_tile_side, args.overlap, args.max_tiles_per_image)
                )
            for crop_index, (x0, y0, x1, y1, anchor_count) in enumerate(tiles):
                crop_width, crop_height = x1 - x0, y1 - y0
                crop_id = hashlib.sha256(
                    f"{args.run_id}\0{parent['sample_id']}\0{x0},{y0},{x1},{y1}".encode()
                ).hexdigest()[:24]
                crop_path = crop_root / f"{crop_id}.jpg"
                if (x0, y0, x1, y1) == (0, 0, width, height):
                    local_path = parent["local_path"]
                    file_size = Path(local_path).stat().st_size
                else:
                    image.crop((x0, y0, x1, y1)).save(crop_path, "JPEG", quality=92, optimize=True)
                    local_path = str(crop_path)
                    file_size = crop_path.stat().st_size
                out.execute(
                    "INSERT OR REPLACE INTO samples VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        crop_id, args.run_id, parent["cohort"], parent["group_id"], crop_index,
                        parent["place_id"], parent["business_name"], parent["main_category"],
                        parent["full_address"], parent["poi_unique_images"], parent["poi_image_bin"],
                        f"{parent['image_id']}:crop:{crop_index}", parent["photo_id"], local_path,
                        crop_width, crop_height, orientation(crop_width, crop_height),
                        resolution_bin(crop_width, crop_height), file_size, parent["sample_id"], crop_index,
                        x0, y0, x1, y1, anchor_count,
                    ),
                )
                inserted += 1
                pois.add(parent["place_id"])
    out.execute(
        "INSERT OR REPLACE INTO sample_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            args.run_id, datetime.now(timezone.utc).isoformat(), str(Path(args.sample_db).resolve()),
            "ppocr-price-anchor-crops-v1", 0, 0, 0, inserted, len(pois),
        ),
    )
    out.commit()
    distribution = list(
        out.execute(
            "SELECT parent_sample_id, COUNT(*), SUM(price_anchor_count) FROM samples GROUP BY parent_sample_id ORDER BY parent_sample_id"
        )
    )
    print({"run_id": args.run_id, "crop_count": inserted, "parent_count": len(parents), "distribution": distribution})
    sample_db.close()
    ppocr.close()
    out.close()


if __name__ == "__main__":
    main()
