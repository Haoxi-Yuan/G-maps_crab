"""Bulk Google Maps image downloader (runs on ual-strix, writes to NAS).

Usage:
  python3 bulk_image_downloader.py --lists a.tsv,b.tsv --outroot /mnt/home/haoxi/gmaps_images [--workers 24]

Each list line: sha16 \t url . Files land at <outroot>/<listname>/<sha[:2]>/<sha[2:4]>/<sha16>.jpg
Lists are processed strictly in the given order (priority order).
Resume-safe: existing non-empty files are skipped. Atomic writes via .tmp + rename.
Errors appended to <outroot>/logs/<listname>_errors.tsv (sha, code, url).
403 tracked separately (URL-expiry indicator). 429/5xx trigger global backoff.
Stops if NAS free space drops below 300 GB (shared volume, leave headroom).
"""
import argparse
import concurrent.futures
import os
import shutil
import sys
import threading
import time
import urllib.request

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")
MIN_FREE_BYTES = 300 * 1024**3
PROGRESS_EVERY = 30  # seconds

ap = argparse.ArgumentParser()
ap.add_argument("--lists", required=True)
ap.add_argument("--outroot", required=True)
ap.add_argument("--workers", type=int, default=24)
args = ap.parse_args()

os.makedirs(os.path.join(args.outroot, "logs"), exist_ok=True)

stats_lock = threading.Lock()
stats = {"ok": 0, "skip": 0, "e403": 0, "e404": 0, "eother": 0, "bytes": 0}
backoff_until = [0.0]
stop_flag = [False]


def fetch_one(task):
    listname, sha, url, err_f = task
    if stop_flag[0]:
        return
    d1, d2 = sha[:2], sha[2:4]
    dest_dir = os.path.join(args.outroot, listname, d1, d2)
    dest = os.path.join(dest_dir, sha + ".jpg")
    try:
        st = os.stat(dest)
        if st.st_size > 0:
            with stats_lock:
                stats["skip"] += 1
            return
    except FileNotFoundError:
        pass

    now = time.time()
    if now < backoff_until[0]:
        time.sleep(backoff_until[0] - now)

    last_err = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=25) as r:
                data = r.read()
            if not data:
                last_err = "empty"
                continue
            os.makedirs(dest_dir, exist_ok=True)
            tmp = dest + ".tmp"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, dest)
            with stats_lock:
                stats["ok"] += 1
                stats["bytes"] += len(data)
            return
        except urllib.error.HTTPError as e:
            if e.code == 403:
                with stats_lock:
                    stats["e403"] += 1
                err_f.write(f"{sha}\t403\t{url}\n")
                return
            if e.code == 404:
                with stats_lock:
                    stats["e404"] += 1
                err_f.write(f"{sha}\t404\t{url}\n")
                return
            if e.code in (429, 500, 502, 503):
                backoff_until[0] = max(backoff_until[0], time.time() + 15)
                last_err = f"http{e.code}"
                time.sleep(3 * (attempt + 1))
                continue
            last_err = f"http{e.code}"
        except Exception as e:
            last_err = type(e).__name__
            time.sleep(1 + attempt)
    with stats_lock:
        stats["eother"] += 1
    err_f.write(f"{sha}\t{last_err}\t{url}\n")


def progress_loop(total, t0, current_list):
    last_done = 0
    while not stop_flag[0]:
        time.sleep(PROGRESS_EVERY)
        with stats_lock:
            s = dict(stats)
        done = s["ok"] + s["skip"] + s["e403"] + s["e404"] + s["eother"]
        rate = (done - last_done) / PROGRESS_EVERY
        last_done = done
        eta_h = (total - done) / rate / 3600 if rate > 0 else -1
        free_gb = shutil.disk_usage(args.outroot).free / 1024**3
        print(f"[{time.strftime('%m-%d %H:%M:%S')}] list={current_list[0]} "
              f"done={done}/{total} ok={s['ok']} skip={s['skip']} "
              f"403={s['e403']} 404={s['e404']} err={s['eother']} "
              f"rate={rate:.1f}/s GB={s['bytes']/1024**3:.1f} "
              f"eta={eta_h:.1f}h free={free_gb:.0f}GB", flush=True)
        if free_gb * 1024**3 < MIN_FREE_BYTES:
            print("FATAL: NAS free space below 100GB, stopping.", flush=True)
            stop_flag[0] = True


list_files = args.lists.split(",")
total = 0
for lf in list_files:
    with open(lf) as f:
        for _ in f:
            total += 1
print(f"total tasks: {total} across {len(list_files)} lists, workers={args.workers}", flush=True)

t0 = time.time()
current_list = [""]
threading.Thread(target=progress_loop, args=(total, t0, current_list), daemon=True).start()

for lf in list_files:
    if stop_flag[0]:
        break
    listname = os.path.splitext(os.path.basename(lf))[0]
    current_list[0] = listname
    err_path = os.path.join(args.outroot, "logs", f"{listname}_errors.tsv")
    err_f = open(err_path, "a", buffering=1)
    print(f"=== starting list {listname} ===", flush=True)

    def task_gen():
        with open(lf) as f:
            for line in f:
                parts = line.rstrip("\n").split("\t")
                if len(parts) == 2:
                    yield (listname, parts[0], parts[1], err_f)

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        for _ in pool.map(fetch_one, task_gen(), chunksize=64):
            pass
    err_f.close()
    print(f"=== finished list {listname} ===", flush=True)

s = stats
el = time.time() - t0
print(f"ALL DONE in {el/3600:.2f}h  ok={s['ok']} skip={s['skip']} 403={s['e403']} "
      f"404={s['e404']} err={s['eother']} GB={s['bytes']/1024**3:.2f}", flush=True)
