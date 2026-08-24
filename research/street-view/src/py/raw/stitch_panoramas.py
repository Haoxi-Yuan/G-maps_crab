#!/usr/bin/env python3
"""Stitch street-view tiles into a single equirectangular JPEG per panoid.

For each high-detail panoid in <run_dir>/neighbor_photometas/, fetch the tile grid
at the requested zoom from streetviewpixels-pa.googleapis.com, stitch, and save as
<run_dir>/panoramas/<panoid>.jpg.

Default zoom is 5 (per-pano probed extent, ~13312x6656 for typical SG panos, 1.6x
linear of z=4). For z>=5 grid extent is variable per pano so we probe x=0 and y=0
axes to find dimensions, then fetch all tiles. Corner tiles may be 256x256
(Google compacts low-content tiles); they are upscaled to match content tiles.

For z<=4 a fixed grid is used:
  z=4: 16x8 = 8192x4096
  z=3: 8x4
  z=2: 4x2

Tiles whose request returns 404/non-image are filled black. The final image is
normalized back to 2:1 equirectangular aspect because some Google tile grids
include a partial bottom row.

Usage:
  python3 stitch_panoramas.py <run_dir> [--zoom 5] [--max-panos 20] [--workers 8]
"""
import argparse
import io
import json
import os
import sys
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

from PIL import Image

TILE_TPL = ('https://streetviewpixels-pa.googleapis.com/v1/tile'
            '?cb_client=maps_sv.tactile&panoid={panoid}&x={x}&y={y}&zoom={zoom}&nbt=1&fover=2')

UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
      'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')


def get_num_planes(parsed):
    try:
        node = parsed[1][0][5][0][5]
        if not node:
            return 0
        import base64
        s = node[1][2]
        s += '=' * ((4 - len(s) % 4) % 4)
        # Photometa uses base64url variant ("-" "_" instead of "+" "/")
        b1 = base64.urlsafe_b64decode(s)
        return int.from_bytes(b1[1:3], 'little')
    except Exception:
        return 0


def fetch_tile(panoid, x, y, zoom=4, retries=2, timeout=15):
    url = TILE_TPL.format(panoid=panoid, x=x, y=y, zoom=zoom)
    last_err = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': UA,
                'Referer': 'https://www.google.com/maps/',
                'Accept': 'image/*',
            })
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                if resp.status != 200:
                    return None, f'http {resp.status}'
                data = resp.read()
                img = Image.open(io.BytesIO(data))
                return img, None
        except urllib.error.HTTPError as e:
            last_err = f'http {e.code}'
            if e.code == 404:
                return None, 'http 404'
        except Exception as e:
            last_err = str(e)
        time.sleep(0.5 * (attempt + 1))
    return None, last_err


def probe_extent(panoid, zoom, max_n=64):
    """Empirically find (nx, ny) at this zoom by probing along x=0 and y=0 axes.

    z=5 panos have variable extents per panoid (Google compacts low-content panos).
    Returns (nx, ny) or (0, 0) if pano not present at this zoom.
    """
    nx = 0
    for x in range(max_n):
        img, err = fetch_tile(panoid, x, 0, zoom)
        if img is None:
            break
        nx = x + 1
    ny = 0
    for y in range(max_n):
        img, err = fetch_tile(panoid, 0, y, zoom)
        if img is None:
            break
        ny = y + 1
    return nx, ny


def normalize_equirect_aspect(canvas):
    """Return (image, action) with exact 2:1 equirectangular aspect.

    Some compact Street View grids expose, for example, 13 x 7 z=4 tiles. The
    last row is only half real content, so a naive 13*512 by 7*512 stitch leaves
    a black 256 px bottom band. Downstream equirect samplers assume H = W/2, so
    crop/pad here instead of letting that poison geometry overlays.
    """
    w, h = canvas.size
    target_h = max(1, w // 2)
    if h == target_h:
        return canvas, 'unchanged'
    if h > target_h:
        return canvas.crop((0, 0, w, target_h)), f'cropped_height_{h}_to_{target_h}'
    out = Image.new('RGB', (w, target_h), (0, 0, 0))
    out.paste(canvas, (0, 0))
    return out, f'padded_height_{h}_to_{target_h}'


def normalize_existing_pano(out_fp):
    """Normalize a cached panorama file in place and return output metadata."""
    with Image.open(out_fp) as im:
        img = im.convert('RGB')
        normalized, aspect_action = normalize_equirect_aspect(img)
        if aspect_action != 'unchanged':
            normalized.save(out_fp, format='JPEG', quality=85, optimize=True)
        w, h = normalized.size
    return {
        'output_w': w,
        'output_h': h,
        'aspect_action': aspect_action,
    }


def stitch_pano(panoid, out_fp, zoom=4, workers=8):
    # Always probe extent: even at z=4 some panos return 13x7 etc., not the
    # textbook 16x8. Fixed-grid stitching pads the missing tiles with black,
    # corrupting ~34% of the JPG and breaking downstream alignment metrics.
    TX, TY = probe_extent(panoid, zoom)
    if TX == 0 or TY == 0:
        return [(0, 0, f'no tiles at zoom={zoom}')]

    coords = [(x, y) for y in range(TY) for x in range(TX)]
    tiles = {}
    failed = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(fetch_tile, panoid, x, y, zoom): (x, y) for x, y in coords}
        for fut in as_completed(futures):
            x, y = futures[fut]
            img, err = fut.result()
            if img is None:
                failed.append((x, y, err))
                continue
            tiles[(x, y)] = img

    # Determine canvas tile size from largest tile (z>=5 mixes 256/512)
    if tiles:
        max_w = max(im.size[0] for im in tiles.values())
        max_h = max(im.size[1] for im in tiles.values())
    else:
        max_w = max_h = 512
    canvas = Image.new('RGB', (TX * max_w, TY * max_h), (0, 0, 0))
    for (x, y), img in tiles.items():
        if img.size != (max_w, max_h):
            img = img.resize((max_w, max_h), Image.LANCZOS)
        try:
            canvas.paste(img, (x * max_w, y * max_h))
        except Exception as e:
            failed.append((x, y, str(e)))
    canvas, aspect_action = normalize_equirect_aspect(canvas)
    canvas.save(out_fp, format='JPEG', quality=85, optimize=True)
    return failed, {
        'tile_grid_x': TX,
        'tile_grid_y': TY,
        'tile_w': max_w,
        'tile_h': max_h,
        'output_w': canvas.size[0],
        'output_h': canvas.size[1],
        'aspect_action': aspect_action,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('run_dir')
    ap.add_argument('--max-panos', type=int, default=999, help='Limit panos for testing')
    ap.add_argument('--workers', type=int, default=8)
    ap.add_argument('--zoom', type=int, default=5,
                    help='5 = ~13312x6656 (default, ~1.6x linear of z=4); 4 = 8192x4096 (legacy)')
    ap.add_argument('--min-planes', type=int, default=10,
                    help='Skip panos with fewer than N planes (low-detail stubs)')
    args = ap.parse_args()

    run = args.run_dir
    nb_dir = os.path.join(run, 'neighbor_photometas')
    if not os.path.isdir(nb_dir):
        print(f'Missing neighbor_photometas/ in {run}', file=sys.stderr)
        sys.exit(2)
    out_dir = os.path.join(run, 'panoramas')
    os.makedirs(out_dir, exist_ok=True)

    # Build candidate list from neighbor_photometas + parent photometa_0/_1
    candidates = []
    # Parent panoramas first
    for i in range(0, 6):
        fp = os.path.join(run, f'photometa_{i}_parsed.json')
        if not os.path.exists(fp):
            continue
        parsed = json.load(open(fp))
        try:
            pid = parsed[1][0][1][1]
        except (IndexError, KeyError, TypeError):
            continue
        np = get_num_planes(parsed)
        candidates.append((pid, np))

    # Neighbors
    for fname in sorted(os.listdir(nb_dir)):
        if not fname.endswith('.parsed.json'):
            continue
        fp = os.path.join(nb_dir, fname)
        parsed = json.load(open(fp))
        try:
            pid = parsed[1][0][1][1]
        except (IndexError, KeyError, TypeError):
            continue
        np = get_num_planes(parsed)
        candidates.append((pid, np))

    # Dedup + filter
    seen = set()
    uniq = []
    for pid, np in candidates:
        if pid in seen:
            continue
        seen.add(pid)
        if np >= args.min_planes:
            uniq.append((pid, np))

    print(f'Candidates: {len(candidates)} total · {len(seen)} unique · {len(uniq)} ≥ {args.min_planes} planes')
    uniq = uniq[:args.max_panos]

    summary = []
    t0 = time.time()
    for i, (pid, np) in enumerate(uniq):
        out_fp = os.path.join(out_dir, f'{pid}.jpg')
        if os.path.exists(out_fp) and os.path.getsize(out_fp) > 5000:
            stitch_meta = normalize_existing_pano(out_fp)
            dims = f'{stitch_meta["output_w"]}x{stitch_meta["output_h"]}'
            action = stitch_meta['aspect_action']
            print(f'  [{i + 1}/{len(uniq)}] {pid[:12]}…  cached  {dims}  {action}')
            summary.append({
                'panoid': pid, 'planes': np, 'status': 'cached',
                'fail_count': 0,
                'size_mb': round(os.path.getsize(out_fp) / 1e6, 2),
                **stitch_meta,
            })
            continue
        t = time.time()
        failed, stitch_meta = stitch_pano(pid, out_fp, zoom=args.zoom, workers=args.workers)
        dt = time.time() - t
        size_mb = os.path.getsize(out_fp) / 1e6
        ok = len(failed) == 0
        msg = 'OK' if ok else f'partial (failed {len(failed)})'
        dims = f'{stitch_meta["output_w"]}x{stitch_meta["output_h"]}'
        print(f'  [{i + 1}/{len(uniq)}] {pid[:12]}…  {np} planes  {dt:.1f}s  {size_mb:.2f}MB  {dims}  {msg}')
        summary.append({
            'panoid': pid, 'planes': np, 'status': msg,
            'fail_count': len(failed), 'duration_s': round(dt, 2),
            'size_mb': round(size_mb, 2),
            **stitch_meta,
        })

    with open(os.path.join(out_dir, 'stitch_summary.json'), 'w') as f:
        json.dump({'panoids': summary, 'total_s': round(time.time() - t0, 2)}, f, indent=2)
    print(f'\nDone. {len(uniq)} panoramas in {round(time.time() - t0, 1)}s. → {out_dir}')


if __name__ == '__main__':
    main()
