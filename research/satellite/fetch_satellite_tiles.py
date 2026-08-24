"""Fetch satellite tile stitches for PlacePulse 2017 AlphaEarth coordinates.

Logic mirrors the reference image at TEST/docs/images/photometa_vs_google_satellite.png:
download an NxN grid of XYZ tiles centered on a lat/lon and stitch into a single
PNG per point. Source is Esri World Imagery (free, no API key, similar visual
quality to Google satellite at zoom 17-19).
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import io
import math
import random
import signal
import sys
import time
from pathlib import Path

import aiohttp
import pandas as pd
from PIL import Image

CSV_DIR = Path("/Users/yuan/Downloads/placepulse_alphaearth_2017")
OUT_ROOT = Path("/Volumes/Data/CLI_scraper/satellite_tiles_for_alphaearth/tiles")

REGIONS = [
    "africa_middle_east",
    "asia",
    "europe",
    "north_america",
    "oceania",
    "south_america",
]

ESRI_URL = (
    "https://server.arcgisonline.com/ArcGIS/rest/services/"
    "World_Imagery/MapServer/tile/{z}/{y}/{x}"
)
USER_AGENT = "PlacePulseSatelliteFetcher/1.0 (research; lat/lon stitching)"

TILE_SIZE = 256


def latlon_to_tile_xy(lat: float, lon: float, zoom: int) -> tuple[float, float]:
    """Return fractional tile coordinates for a lat/lon at given zoom."""
    lat_rad = math.radians(lat)
    n = 2.0**zoom
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi) / 2.0 * n
    return x, y


async def fetch_tile(
    session: aiohttp.ClientSession,
    z: int,
    x: int,
    y: int,
    *,
    max_retries: int = 4,
) -> Image.Image | None:
    url = ESRI_URL.format(z=z, x=x, y=y)
    last_err = None
    for attempt in range(max_retries):
        try:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=20)) as r:
                if r.status == 200:
                    data = await r.read()
                    return Image.open(io.BytesIO(data)).convert("RGB")
                if r.status in (429, 500, 502, 503, 504):
                    last_err = f"HTTP {r.status}"
                else:
                    # 404 etc. — tile genuinely missing, don't retry
                    return None
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            last_err = repr(e)
        await asyncio.sleep((2**attempt) * 0.5 + random.random() * 0.3)
    print(f"  ! tile {z}/{x}/{y} failed: {last_err}", file=sys.stderr)
    return None


async def fetch_stitched(
    session: aiohttp.ClientSession,
    lat: float,
    lon: float,
    zoom: int,
    grid: int,
) -> Image.Image | None:
    """Fetch an NxN tile grid centered on the point and stitch."""
    xf, yf = latlon_to_tile_xy(lat, lon, zoom)
    cx, cy = int(math.floor(xf)), int(math.floor(yf))
    half = grid // 2

    coros = []
    positions = []
    for dy in range(-half, grid - half):
        for dx in range(-half, grid - half):
            tx, ty = cx + dx, cy + dy
            positions.append((dx + half, dy + half))
            coros.append(fetch_tile(session, zoom, tx, ty))
    tiles = await asyncio.gather(*coros)

    if any(t is None for t in tiles):
        return None

    out = Image.new("RGB", (grid * TILE_SIZE, grid * TILE_SIZE))
    for (gx, gy), tile in zip(positions, tiles):
        out.paste(tile, (gx * TILE_SIZE, gy * TILE_SIZE))
    return out


def load_dedup_points(region: str) -> pd.DataFrame:
    """Return unique (lat, lon) rows for a region, keeping one place_id / image_id per coord."""
    path = CSV_DIR / f"placepulse_alphaearth_2017_{region}.csv"
    df = pd.read_csv(path, usecols=["lat", "lon", "place_id", "image_id"])
    df = df.drop_duplicates(subset=["lat", "lon"]).reset_index(drop=True)
    return df


def out_path(region: str, row: pd.Series) -> Path:
    return OUT_ROOT / region / f"{row['image_id']}.jpg"


async def worker(
    name: int,
    queue: asyncio.Queue,
    session: aiohttp.ClientSession,
    zoom: int,
    grid: int,
    stats: dict,
):
    while True:
        item = await queue.get()
        if item is None:
            queue.task_done()
            return
        region, row = item
        path = out_path(region, row)
        try:
            if path.exists():
                stats["skipped"] += 1
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                img = await fetch_stitched(session, row["lat"], row["lon"], zoom, grid)
                if img is None:
                    stats["failed"] += 1
                else:
                    img.save(path, "JPEG", quality=88)
                    stats["downloaded"] += 1
            stats["done"] += 1
            if stats["done"] % 25 == 0:
                elapsed = time.time() - stats["t0"]
                rate = stats["done"] / max(elapsed, 1e-6)
                eta = (stats["total"] - stats["done"]) / max(rate, 1e-6)
                print(
                    f"  [{stats['done']}/{stats['total']}] "
                    f"dl={stats['downloaded']} skip={stats['skipped']} fail={stats['failed']} "
                    f"rate={rate:.1f}/s eta={eta/60:.1f}min",
                    flush=True,
                )
        except Exception as e:
            print(f"  ! worker {name} error on {row.get('image_id')}: {e!r}", file=sys.stderr)
            stats["failed"] += 1
            stats["done"] += 1
        finally:
            queue.task_done()


async def run(args):
    regions = args.regions or REGIONS

    all_jobs: list[tuple[str, pd.Series]] = []
    for region in regions:
        df = load_dedup_points(region)
        if args.limit:
            df = df.head(args.limit)
        for _, row in df.iterrows():
            all_jobs.append((region, row))
        print(f"  {region}: queued {len(df)} unique points")

    stats = {
        "total": len(all_jobs),
        "done": 0,
        "downloaded": 0,
        "skipped": 0,
        "failed": 0,
        "t0": time.time(),
    }
    print(f"\nTotal jobs: {stats['total']} | concurrency: {args.concurrency} | "
          f"zoom: {args.zoom} | grid: {args.grid}x{args.grid}\n")

    queue: asyncio.Queue = asyncio.Queue()
    for job in all_jobs:
        queue.put_nowait(job)
    for _ in range(args.concurrency):
        queue.put_nowait(None)

    connector = aiohttp.TCPConnector(limit=args.concurrency)
    headers = {"User-Agent": USER_AGENT, "Referer": "https://www.arcgis.com/"}
    async with aiohttp.ClientSession(connector=connector, headers=headers) as session:
        workers = [
            asyncio.create_task(worker(i, queue, session, args.zoom, args.grid, stats))
            for i in range(args.concurrency)
        ]
        await queue.join()
        for w in workers:
            await w

    elapsed = time.time() - stats["t0"]
    print(
        f"\nDone in {elapsed/60:.1f}min. "
        f"downloaded={stats['downloaded']} skipped={stats['skipped']} failed={stats['failed']}",
        flush=True,
    )


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--regions", nargs="*", help="subset of regions (default: all)")
    p.add_argument("--limit", type=int, default=0, help="per-region cap (0=unlimited)")
    p.add_argument("--zoom", type=int, default=18)
    p.add_argument("--grid", type=int, default=3, help="N for NxN tile grid")
    p.add_argument("--concurrency", type=int, default=16)
    args = p.parse_args()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
