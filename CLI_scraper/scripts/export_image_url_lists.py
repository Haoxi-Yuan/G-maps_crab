"""Export deduped URL lists for paris/berlin bulk image download.

Outputs per city:
  <out>/<city>_review.tsv   sha16 \t url      (grass-cs review images, deduped by url-base)
  <out>/<city>_gallery.tsv  sha16 \t url      (photo_categories + business_photos merged,
                                               deduped by url-base, category variant preferred)
Prints exact counts for the size estimate.
"""
import hashlib
import json
import sqlite3
import sys

OUT = sys.argv[1]


def url_base(u):
    return u.rsplit("=", 1)[0] if "=" in u else u


def sha16(s):
    return hashlib.sha256(s.encode()).hexdigest()[:16]


for city in ["paris", "berlin"]:
    conn = sqlite3.connect(f"output/{city}/{city}_reviews.db")
    stats = {}

    # --- review images (table scan, url only) ---
    seen = set()
    n_rows = 0
    with open(f"{OUT}/{city}_review.tsv", "w") as f:
        for (u,) in conn.execute("SELECT url FROM review_images WHERE url IS NOT NULL"):
            n_rows += 1
            b = url_base(u)
            if b in seen:
                continue
            seen.add(b)
            f.write(f"{sha16(b)}\t{u}\n")
    stats["review_rows"] = n_rows
    stats["review_unique"] = len(seen)

    # --- gallery: photo_categories first (bigger thumbs), then business_photos ---
    seen = set()
    n_cat = n_biz = 0
    with open(f"{OUT}/{city}_gallery.tsv", "w") as f:
        for (pc,) in conn.execute(
            "SELECT photo_categories FROM businesses WHERE photo_categories IS NOT NULL"
        ):
            try:
                cats = json.loads(pc)
            except Exception:
                continue
            for c in cats or []:
                for p in c.get("photos") or []:
                    u = p.get("url")
                    if not u or p.get("mediaType") == "video":
                        continue
                    n_cat += 1
                    b = url_base(u)
                    if b in seen:
                        continue
                    seen.add(b)
                    f.write(f"{sha16(b)}\t{u}\n")
        cat_unique = len(seen)
        for (bp,) in conn.execute(
            "SELECT business_photos FROM businesses WHERE business_photos IS NOT NULL"
        ):
            try:
                urls = json.loads(bp)
            except Exception:
                continue
            for u in urls or []:
                n_biz += 1
                b = url_base(u)
                if b in seen:
                    continue
                seen.add(b)
                f.write(f"{sha16(b)}\t{u}\n")
    stats["category_rows"] = n_cat
    stats["category_unique"] = cat_unique
    stats["business_rows"] = n_biz
    stats["business_extra_unique"] = len(seen) - cat_unique
    stats["gallery_unique"] = len(seen)
    conn.close()
    print(city, json.dumps(stats), flush=True)

print("EXPORT_DONE")
