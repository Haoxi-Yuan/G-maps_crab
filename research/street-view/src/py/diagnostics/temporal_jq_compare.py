"""Side-by-side temporal comparison of one focal panoid across 12 captures.

For panoid JqSnKB7Pp-XymzXWDuP71w (Ghim Moh Road), Google's timeline returns 12
historical captures from Nov 2008 to Mar 2025. Each capture has its own
photometa (with subtly different lat/lng/heading) and its own indexmap. This
script tabulates the pose drift across years and renders two stacked montages
that let the user judge how much of the visual change is real-world dynamics
vs sampling-pose offset:

  pose_table.md         per-year (date, panoid, lat, lng, heading, pitch, roll)
  pano_montage.png      12 rows of equirect panorama JPGs, labeled
  indexmap_montage.png  12 rows of indexmap rasters colored by plane id
  indexmap_gravity_montage.png
                         same indexmap stack after per-capture gravity rectification
                         in world-azimuth layout
  indexmap_gravity_local_montage.png
                         gravity-rectified stack that preserves original pano columns
  pano_aligned.png      same pano stack, rolled so col 256 = focal heading
  indexmap_aligned.png  same indexmap stack, rolled to focal heading

The aligned versions cancel only the heading delta (column roll); residual
mis-overlay of features comes from lat/lng translation between captures, which
no rotation can correct.
"""

import json
import os
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
import matplotlib.pyplot as plt
from matplotlib import cm
from matplotlib.colors import ListedColormap

from filter_and_rectify import build_rotation, rectify_indexmap

CAPTURE_ROOT = Path(
    "/Volumes/Data/CLI_scraper/TEST/data/raw/google_maps/temporal/"
    "JqSnKB7Pp-XymzXWDuP71w/2026-05-03_14-13-28-097/captures"
)
OUT_DIR = Path(
    "/Volumes/Data/CLI_scraper/TEST/data/diagnostics/temporal/JqSnKB7Pp_compare"
)
OUT_DIR.mkdir(parents=True, exist_ok=True)

PANO_ROW_W = 1024
PANO_ROW_H = 512
LABEL_W = 280
ROW_H = PANO_ROW_H
MAP_W = 512
MAP_H = 256

FOCAL_PANOID = "JqSnKB7Pp-XymzXWDuP71w"


def load_capture(cap_dir: Path):
    panoid = cap_dir.name.split("_", 1)[1]
    date = cap_dir.name.split("_", 1)[0]

    with open(cap_dir / "photometa_0_parsed.json") as f:
        d = json.load(f)
    pose = d[1][0][5][0][1]
    lat = pose[0][2]
    lng = pose[0][3]
    heading = pose[2][0]
    pitch = pose[2][1]
    roll = pose[2][2]

    jpg_path = cap_dir / "panoramas" / f"{panoid}.jpg"
    idx_path = cap_dir / "photometa_0_parsed_indexmap.bin"
    planes_path = cap_dir / "photometa_0_parsed_planes.json"

    indexmap = np.frombuffer(idx_path.read_bytes(), dtype=np.uint8).reshape(MAP_H, MAP_W)
    with open(planes_path) as f:
        planes_doc = json.load(f)
    planes = planes_doc["planes"] if isinstance(planes_doc, dict) else planes_doc

    return {
        "date": date,
        "panoid": panoid,
        "lat": lat,
        "lng": lng,
        "heading": heading,
        "pitch": pitch,
        "roll": roll,
        "jpg_path": jpg_path,
        "indexmap": indexmap,
        "planes": planes,
    }


def classify_planes(planes_list):
    """Return per-pid class id: 0=sky, 1=ground, 2=facade, 3=ceiling, 4=oblique."""
    cls = np.zeros(256, dtype=np.uint8)
    for rec in planes_list:
        i = rec["idx"]
        if i == 0:
            cls[i] = 0
            continue
        nx, ny, nz = rec["nx"], rec["ny"], rec["nz"]
        ln = (nx * nx + ny * ny + nz * nz) ** 0.5
        if ln < 1e-6:
            cls[i] = 0
            continue
        nzn = nz / ln
        if nzn < -0.5:
            cls[i] = 1
        elif nzn > 0.5:
            cls[i] = 3
        elif abs(nzn) < 0.5:
            cls[i] = 2
        else:
            cls[i] = 4
    return cls


def colorize_indexmap_by_class(indexmap, cls_lookup):
    """Sky = light blue; ground = orange; facade = magenta+pid hue; ceiling = grey."""
    H, W = indexmap.shape
    rgb = np.zeros((H, W, 3), dtype=np.uint8)
    cls = cls_lookup[indexmap]
    rgb[cls == 0] = (210, 230, 250)
    rgb[cls == 1] = (249, 171, 0)
    rgb[cls == 3] = (155, 162, 170)
    rgb[cls == 4] = (96, 99, 104)
    facade_mask = cls == 2
    pids = indexmap[facade_mask].astype(np.int32)
    hues = (pids * 47) % 360
    hsv = np.zeros((pids.shape[0], 3), dtype=np.float32)
    hsv[:, 0] = hues / 360.0
    hsv[:, 1] = 0.7
    hsv[:, 2] = 0.85
    from matplotlib.colors import hsv_to_rgb
    rgb[facade_mask] = (hsv_to_rgb(hsv) * 255).astype(np.uint8)
    return rgb


def make_label_strip(text_lines, height, width=LABEL_W, bg=(245, 247, 250)):
    img = Image.new("RGB", (width, height), bg)
    draw = ImageDraw.Draw(img)
    try:
        font_big = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 24)
        font_mid = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 14)
        font_mono = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 11)
    except Exception:
        font_big = ImageFont.load_default()
        font_mid = font_big
        font_mono = font_big
    y = 12
    draw.text((14, y), text_lines[0], fill=(20, 30, 50), font=font_big)
    y += 36
    for line in text_lines[1:]:
        draw.text((14, y), line, fill=(60, 70, 88), font=font_mono)
        y += 16
    return np.array(img)


def shift_columns(img, dcol):
    """Roll the COLUMN axis by dcol (positive = shift right)."""
    return np.roll(img, dcol, axis=1)


def build_pose_table(captures, focal_lat, focal_lng):
    lines = ["# Temporal pose table — focal panoid `JqSnKB7Pp-XymzXWDuP71w`",
             "",
             f"Reference (focal Mar 2025): lat={focal_lat:.10f}, lng={focal_lng:.10f}",
             "",
             "| Date | Panoid | Lat | Lng | dLat (m) | dLng (m) | Heading° | Pitch° | Roll° |",
             "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for c in captures:
        dlat = (c["lat"] - focal_lat) * 111000
        dlng = (c["lng"] - focal_lng) * 111000 * 0.999
        lines.append(
            f"| {c['date']} | `{c['panoid']}` "
            f"| {c['lat']:.10f} | {c['lng']:.10f} "
            f"| {dlat:+.2f} | {dlng:+.2f} "
            f"| {c['heading']:.2f} | {c['pitch']:.2f} | {c['roll']:.2f} |"
        )
    lines += [
        "",
        f"- lat span across 12 captures: {(max(c['lat'] for c in captures) - min(c['lat'] for c in captures)) * 111000:.2f} m",
        f"- lng span across 12 captures: {(max(c['lng'] for c in captures) - min(c['lng'] for c in captures)) * 111000 * 0.999:.2f} m",
        f"- heading span: {max(c['heading'] for c in captures) - min(c['heading'] for c in captures):.2f}°",
        f"- pitch span: {max(c['pitch'] for c in captures) - min(c['pitch'] for c in captures):.2f}° (mostly the 2018-08 outlier)",
        f"- roll span: {max(c['roll'] for c in captures) - min(c['roll'] for c in captures):.2f}°",
    ]
    return "\n".join(lines)


def main():
    cap_dirs = sorted(p for p in CAPTURE_ROOT.iterdir() if p.is_dir())
    print(f"Found {len(cap_dirs)} capture dirs")

    captures = [load_capture(p) for p in cap_dirs]
    captures.sort(key=lambda c: c["date"])

    focal = next(c for c in captures if c["panoid"] == FOCAL_PANOID)
    focal_heading = focal["heading"]
    focal_lat = focal["lat"]
    focal_lng = focal["lng"]

    # 1. Pose table
    table_md = build_pose_table(captures, focal_lat, focal_lng)
    (OUT_DIR / "pose_table.md").write_text(table_md)
    print("wrote pose_table.md")

    # 2. Pano + indexmap rows.
    pano_rows_raw = []
    pano_rows_aligned = []
    idx_rows_raw = []
    idx_rows_aligned = []
    idx_rows_gravity = []
    idx_rows_gravity_local = []

    for c in captures:
        # Pano JPG: downsample to 1024x512 with PIL.
        jpg = Image.open(c["jpg_path"]).convert("RGB")
        jpg_small = jpg.resize((PANO_ROW_W, PANO_ROW_H), Image.LANCZOS)
        jpg_arr = np.array(jpg_small)

        # Indexmap: colorize then upsample 2x col, 2x row to match width 1024 and height 512.
        cls = classify_planes(c["planes"])
        idx_rgb = colorize_indexmap_by_class(c["indexmap"], cls)
        idx_img = Image.fromarray(idx_rgb).resize((PANO_ROW_W, PANO_ROW_H), Image.NEAREST)
        idx_arr = np.array(idx_img)

        # Gravity-aligned indexmap in world-azimuth layout: resample the
        # categorical labels with this capture's full pose.
        R = build_rotation(c["heading"], c["pitch"], c["roll"])
        idx_grav = rectify_indexmap(c["indexmap"], R, supersample=4)
        idx_grav_rgb = colorize_indexmap_by_class(idx_grav, cls)
        idx_grav_img = Image.fromarray(idx_grav_rgb).resize((PANO_ROW_W, PANO_ROW_H), Image.NEAREST)
        idx_grav_arr = np.array(idx_grav_img)

        # Gravity correction that preserves the original pano/JPG column
        # layout: apply pitch/roll only, not heading. This keeps features near
        # their raw equirectangular x positions while reducing camera tilt.
        R_local_layout = build_rotation(c["heading"], c["pitch"], c["roll"], apply_heading=False)
        idx_grav_local = rectify_indexmap(c["indexmap"], R_local_layout, supersample=4)
        idx_grav_local_rgb = colorize_indexmap_by_class(idx_grav_local, cls)
        idx_grav_local_img = Image.fromarray(idx_grav_local_rgb).resize((PANO_ROW_W, PANO_ROW_H), Image.NEAREST)
        idx_grav_local_arr = np.array(idx_grav_local_img)

        # Heading-aligned versions: roll column axis so col 256/1024 aligns to focal heading.
        # Each pano's col c covers heading h_pano + (c/W - 0.5) * 360.
        # To align, shift columns by ((h_focal - h_pano) / 360) * W.
        dh = focal_heading - c["heading"]
        # Wrap to [-180, 180]
        dh = ((dh + 180) % 360) - 180
        dcol_pano = int(round(dh / 360.0 * PANO_ROW_W))
        dcol_idx = int(round(dh / 360.0 * PANO_ROW_W))

        jpg_aligned = shift_columns(jpg_arr, dcol_pano)
        idx_aligned = shift_columns(idx_arr, dcol_idx)

        # Label strip.
        label = make_label_strip([
            c["date"][:7],
            c["panoid"],
            f"lat {c['lat']:.6f}",
            f"lng {c['lng']:.6f}",
            f"hdg {c['heading']:.2f}°",
            f"pit {c['pitch']:.2f}°",
            f"rol {c['roll']:.2f}°",
        ], height=ROW_H)

        pano_rows_raw.append(np.concatenate([label, jpg_arr], axis=1))
        pano_rows_aligned.append(np.concatenate([label, jpg_aligned], axis=1))
        idx_rows_raw.append(np.concatenate([label, idx_arr], axis=1))
        idx_rows_aligned.append(np.concatenate([label, idx_aligned], axis=1))
        idx_rows_gravity.append(np.concatenate([label, idx_grav_arr], axis=1))
        idx_rows_gravity_local.append(np.concatenate([label, idx_grav_local_arr], axis=1))

    pano_montage = np.concatenate(pano_rows_raw, axis=0)
    pano_aligned = np.concatenate(pano_rows_aligned, axis=0)
    idx_montage = np.concatenate(idx_rows_raw, axis=0)
    idx_aligned = np.concatenate(idx_rows_aligned, axis=0)
    idx_gravity = np.concatenate(idx_rows_gravity, axis=0)
    idx_gravity_local = np.concatenate(idx_rows_gravity_local, axis=0)

    Image.fromarray(pano_montage).save(OUT_DIR / "pano_montage.png", optimize=True)
    Image.fromarray(pano_aligned).save(OUT_DIR / "pano_aligned.png", optimize=True)
    Image.fromarray(idx_montage).save(OUT_DIR / "indexmap_montage.png", optimize=True)
    Image.fromarray(idx_aligned).save(OUT_DIR / "indexmap_aligned.png", optimize=True)
    Image.fromarray(idx_gravity).save(OUT_DIR / "indexmap_gravity_montage.png", optimize=True)
    Image.fromarray(idx_gravity_local).save(OUT_DIR / "indexmap_gravity_local_montage.png", optimize=True)

    print(f"wrote 6 montages to {OUT_DIR}")
    print(f"  pano_montage.png    {pano_montage.shape}")
    print(f"  pano_aligned.png    {pano_aligned.shape}")
    print(f"  indexmap_montage.png {idx_montage.shape}")
    print(f"  indexmap_aligned.png {idx_aligned.shape}")
    print(f"  indexmap_gravity_montage.png {idx_gravity.shape}")
    print(f"  indexmap_gravity_local_montage.png {idx_gravity_local.shape}")


if __name__ == "__main__":
    main()
