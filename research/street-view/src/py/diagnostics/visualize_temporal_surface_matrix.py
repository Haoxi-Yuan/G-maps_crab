#!/usr/bin/env python3
"""Visualize temporal surface crops as a time x viewpoint matrix."""

from __future__ import annotations

import argparse
import csv
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sv3d_paths import add_spatial_args  # noqa: E402


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open(newline="") as f:
        return list(csv.DictReader(f))


def rel_path(path: Path, root: Path) -> str:
    return path.resolve(strict=False).relative_to(root.resolve(strict=False)).as_posix()


def parse_col(correspondence_id: str) -> int | None:
    match = re.search(r"_c(\d+)_", correspondence_id)
    return int(match.group(1)) if match else None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a time x viewpoint matrix for temporal surface crops.")
    add_spatial_args(parser)
    parser.add_argument("--anchor", required=True, help="Temporal anchor panoid")
    parser.add_argument("--stack-id", required=True, help="Temporal stack id")
    parser.add_argument("--cell-width", type=int, default=280)
    parser.add_argument("--cell-height", type=int, default=120)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    test_root = Path(args.test_root).resolve()
    workspace_id = args.workspace_id or args.site
    if workspace_id is None:
        raise SystemExit("--workspace-id or --site is required")

    crop_root = test_root / "data/derived" / workspace_id / "05_surface_crops"
    temporal_root = crop_root / "temporal" / args.anchor / args.stack_id
    crop_rows = [
        row for row in read_csv_rows(crop_root / "surface_crops.csv")
        if row.get("source_type") == "temporal_factor_correspondence"
        and row.get("anchor_panoid") == args.anchor
        and row.get("stack_id") == args.stack_id
    ]
    corr_rows = read_csv_rows(
        test_root / "data/derived/temporal" / args.anchor / "factor_correspondences/temporal_factor_correspondences.csv"
    )
    corr_rows = [row for row in corr_rows if row.get("stack_id") == args.stack_id]

    crop_by_corr = {row.get("correspondence_id"): row for row in crop_rows if row.get("correspondence_id")}
    kept_corr = [row for row in corr_rows if str(row.get("keep")).lower() == "true"]
    year_months = sorted({row.get("year_month") for row in kept_corr if row.get("year_month")})
    cols = sorted({parse_col(row.get("correspondence_id", "")) for row in kept_corr if parse_col(row.get("correspondence_id", "")) is not None})
    if not year_months or not cols:
        raise SystemExit("No kept temporal correspondences found")

    cell_w = args.cell_width
    cell_h = args.cell_height
    left_w = 150
    top_h = 86
    pad = 10
    width = left_w + len(cols) * cell_w + pad * 2
    height = top_h + len(year_months) * cell_h + pad * 2
    canvas = Image.new("RGB", (width, height), (248, 248, 248))
    draw = ImageDraw.Draw(canvas)

    draw.text((pad, 12), "Temporal surface matrix: rows = capture time, columns = aligned spatial viewpoints", fill=(20, 20, 20))
    draw.text((pad, 34), "Cells use streetview crop with indexmap-derived surface overlay; blank cells are rejected or missing.", fill=(65, 65, 65))

    for col in cols:
        x = left_w + col * cell_w + pad
        draw.text((x + 6, top_h - 34), f"view {col}", fill=(25, 25, 25))

    corr_by_key: dict[tuple[str, int], dict[str, str]] = {}
    for row in kept_corr:
        col = parse_col(row.get("correspondence_id", ""))
        ym = row.get("year_month")
        if col is not None and ym:
            corr_by_key[(ym, col)] = row

    for r_idx, ym in enumerate(year_months):
        y = top_h + r_idx * cell_h + pad
        draw.rectangle((0, y - 5, width, y + cell_h - 6), fill=(255, 255, 255) if r_idx % 2 == 0 else (242, 244, 246))
        draw.text((pad, y + cell_h // 2 - 8), ym, fill=(20, 20, 20))
        for col in cols:
            x = left_w + col * cell_w + pad
            corr = corr_by_key.get((ym, col))
            if not corr:
                draw.rectangle((x + 4, y + 8, x + cell_w - 10, y + cell_h - 26), fill=(236, 236, 236), outline=(210, 210, 210))
                draw.text((x + 18, y + cell_h // 2 - 8), "no kept pano", fill=(110, 110, 110))
                continue
            crop = crop_by_corr.get(corr.get("correspondence_id"))
            source_path = None
            if crop:
                source_path = crop.get("support_path") or crop.get("crop_path")
            if not source_path:
                source_path = corr.get("overlay_path")
            image_path = test_root / source_path if source_path else None
            if not image_path or not image_path.exists():
                draw.rectangle((x + 4, y + 8, x + cell_w - 10, y + cell_h - 26), fill=(236, 236, 236), outline=(210, 210, 210))
                draw.text((x + 18, y + cell_h // 2 - 8), "missing crop", fill=(130, 75, 75))
                continue
            im = Image.open(image_path).convert("RGB")
            im.thumbnail((cell_w - 18, cell_h - 36), Image.Resampling.LANCZOS)
            canvas.paste(im, (x + (cell_w - im.width) // 2, y + 8 + ((cell_h - 36) - im.height) // 2))
            label = f"{corr.get('matched_panoid', '')[:10]} d={corr.get('residual_m', '')}m"
            plane = crop.get("local_plane_id") if crop else ""
            if plane:
                label += f" p{plane}"
            draw.text((x + 6, y + cell_h - 22), label, fill=(50, 50, 50))

    out_path = temporal_root / "temporal_surface_matrix.png"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path)

    index_path = temporal_root / "temporal_surface_matrix.md"
    index_path.write_text(
        "# Temporal Surface Matrix\n\n"
        f"- matrix: `{rel_path(out_path, test_root)}`\n"
        f"- rows: {len(year_months)} capture times\n"
        f"- columns: {len(cols)} spatial viewpoints\n"
        f"- kept cells with crops: {sum(1 for row in kept_corr if row.get('crop_path'))}\n"
    )
    print(rel_path(out_path, test_root))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
