#!/usr/bin/env python3
"""
audit_payloads.py

Read a UI-geometry capture (manifest.json + bodies/) produced by
TEST/src/js/capture/audit-ui-geometry.js, classify each unique response body,
group requests by URL pattern, compare candidate binary payloads against the
existing photometa.bin baseline for the same panoid, and emit a human-readable
audit report.

This is a discovery / classification step only — it does NOT write any parser.

Inputs:
  --raw-dir   path to data/raw/google_maps/ui_geometry/<panoid>/<ts>/
  --photometa-ref  optional explicit photometa.bin to compare against; if
                   omitted, will try to locate one under
                   data/raw/google_maps/temporal/<panoid>/.../captures/.../photometa.bin
  --out-dir   override derived output dir (default mirrors panoid/ts under
              data/derived/ui_geometry_audit/)

Outputs (in derived/ui_geometry_audit/<panoid>/<ts>/):
  payload_classes.json    per-sha1 classification + URL/phase breakdown
  url_patterns.json       per-URL-pattern aggregation
  vs_photometa.json       size/structure comparison vs photometa baseline
  audit_report.md         human summary (the read-this artifact)
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import math
import re
import shutil
import struct
import subprocess
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse, parse_qs


TEST_ROOT = Path(__file__).resolve().parents[4]


MAGIC_RULES = [
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF8", "image/gif"),
    (b"RIFF", "image/webp-or-riff"),
    (b"\x1f\x8b", "gzip"),
    (b"\x28\xb5\x2f\xfd", "zstd"),
    (b"\x42\x5a\x68", "bzip2"),
    (b"PK\x03\x04", "zip"),
    (b"%PDF-", "pdf"),
    (b"OggS", "ogg"),
    (b"glTF", "gltf-binary"),
    (b"DRACO", "draco-mesh"),
]


def shannon_entropy(buf: bytes, sample_cap: int = 65536) -> float:
    if not buf:
        return 0.0
    if len(buf) > sample_cap:
        buf = buf[:sample_cap]
    counts = collections.Counter(buf)
    total = len(buf)
    ent = 0.0
    for c in counts.values():
        p = c / total
        ent -= p * math.log2(p)
    return round(ent, 3)


def looks_like_protobuf(buf: bytes, sample_cap: int = 4096) -> tuple[bool, dict]:
    """
    Cheap heuristic: try to walk the first few protobuf top-level fields.
    A valid protobuf message body decodes as a stream of (tag, wire_type, value)
    where wire_type in {0,1,2,5} (3,4 are deprecated groups). If we can read
    >= 3 well-formed records covering > 75% of the sampled bytes, call it
    protobuf-ish.
    """
    if not buf:
        return False, {}
    sample = buf[:sample_cap]
    i = 0
    fields_seen = []

    def read_varint(b, pos):
        result = 0
        shift = 0
        start = pos
        while pos < len(b):
            byte = b[pos]
            result |= (byte & 0x7F) << shift
            pos += 1
            if not (byte & 0x80):
                return result, pos
            shift += 7
            if shift > 70:
                return None, start
        return None, start

    while i < len(sample):
        tag, ni = read_varint(sample, i)
        if tag is None:
            break
        wire = tag & 0x07
        field_no = tag >> 3
        if field_no == 0 or wire in (3, 4, 6, 7):
            break
        i = ni
        if wire == 0:
            v, i2 = read_varint(sample, i)
            if v is None:
                break
            i = i2
        elif wire == 1:
            if i + 8 > len(sample):
                break
            i += 8
        elif wire == 2:
            ln, i2 = read_varint(sample, i)
            if ln is None or ln > len(buf):
                break
            i = i2 + ln
            if i > len(sample):
                # length-delimited segment runs past the sampled window — still
                # accept the field number but stop the walk.
                fields_seen.append((field_no, wire))
                break
        elif wire == 5:
            if i + 4 > len(sample):
                break
            i += 4
        fields_seen.append((field_no, wire))

    coverage = i / len(sample) if sample else 0.0
    is_pb = len(fields_seen) >= 3 and coverage >= 0.75
    return is_pb, {
        "fields_walked": len(fields_seen),
        "coverage": round(coverage, 3),
        "top_fields": fields_seen[:24],
    }


def classify_body(buf: bytes) -> dict:
    head = buf[:32]
    head_hex = head.hex()
    info: dict[str, Any] = {
        "size": len(buf),
        "magic_hex_32": head_hex,
        "entropy": shannon_entropy(buf),
    }

    # 1) text first — JSON / )]}' prefixed JSON / plain text
    stripped = buf.lstrip(b"\r\n\t ")
    if stripped.startswith(b")]}'"):
        info["jsonp_prefixed"] = True
        try:
            payload = stripped.split(b"\n", 1)[1]
            json.loads(payload.decode("utf-8", errors="replace"))
            info["type"] = "json-with-anti-hijack-prefix"
            return info
        except Exception:
            pass
    if stripped[:1] in (b"{", b"["):
        try:
            json.loads(buf.decode("utf-8", errors="replace"))
            info["type"] = "json"
            return info
        except Exception:
            pass

    # 2) magic bytes
    for prefix, label in MAGIC_RULES:
        if buf.startswith(prefix):
            info["type"] = label
            return info

    # 3) protobuf-ish?
    is_pb, pb_info = looks_like_protobuf(buf)
    if is_pb:
        info["type"] = "protobuf-ish"
        info["protobuf"] = pb_info
        return info

    # 4) high-entropy unknown binary vs low-entropy text-ish
    try:
        as_text = buf[:4096].decode("utf-8")
        printable = sum(1 for c in as_text if c.isprintable() or c in "\r\n\t ")
        if printable / max(len(as_text), 1) > 0.95:
            info["type"] = "text-like"
            return info
    except UnicodeDecodeError:
        pass

    info["type"] = "unknown-binary"
    return info


def url_pattern(u: str) -> str:
    """
    Reduce a URL to a coarse pattern: scheme://host/path-with-numeric-segments-collapsed
    Drops query string entirely (kept separately).
    """
    try:
        p = urlparse(u)
    except Exception:
        return u
    parts = [seg for seg in p.path.split("/") if seg]
    out = []
    for seg in parts:
        # numeric or short hex → placeholder
        if re.fullmatch(r"\d+", seg):
            out.append("<int>")
        elif re.fullmatch(r"[0-9a-f]{6,}", seg):
            out.append("<hex>")
        else:
            out.append(seg)
    return f"{p.scheme}://{p.netloc}/" + "/".join(out)


def query_keys(u: str) -> list[str]:
    try:
        return sorted(parse_qs(urlparse(u).query).keys())
    except Exception:
        return []


def find_photometa_ref(panoid: str) -> Optional[Path]:
    base = TEST_ROOT / "data" / "raw" / "google_maps" / "temporal" / panoid
    if not base.exists():
        return None
    candidates = list(base.rglob("photometa.bin"))
    # prefer the capture whose directory name contains the focal panoid
    for f in candidates:
        if panoid in f.parent.name:
            return f
    # fall back to the most recent (mtime) capture rather than alphabetical first
    if candidates:
        return max(candidates, key=lambda p: p.stat().st_mtime)
    return None


def try_protoc_decode_raw(path: Path) -> Optional[str]:
    if not shutil.which("protoc"):
        return None
    try:
        out = subprocess.run(
            ["protoc", "--decode_raw"],
            stdin=open(path, "rb"),
            capture_output=True,
            timeout=10,
        )
        if out.returncode == 0:
            return out.stdout.decode("utf-8", errors="replace")
    except Exception:
        return None
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw-dir", required=True, help="raw/google_maps/ui_geometry/<panoid>/<ts>/")
    ap.add_argument("--photometa-ref", default=None)
    ap.add_argument("--out-dir", default=None)
    args = ap.parse_args()

    raw = Path(args.raw_dir).resolve()
    if not (raw / "manifest.json").exists():
        print(f"[audit] manifest.json not found under {raw}")
        return 2
    manifest = json.loads((raw / "manifest.json").read_text())
    panoid = manifest.get("panoid") or raw.parent.name
    ts = manifest.get("timestamp") or raw.name

    if args.out_dir:
        out = Path(args.out_dir).resolve()
    else:
        out = TEST_ROOT / "data" / "derived" / "ui_geometry_audit" / panoid / ts
    out.mkdir(parents=True, exist_ok=True)

    # ---- Photometa baseline ----
    if args.photometa_ref:
        ref_path = Path(args.photometa_ref)
    else:
        ref_path = find_photometa_ref(panoid)
    ref_info: dict[str, Any] = {}
    if ref_path and ref_path.exists():
        ref_bytes = ref_path.read_bytes()
        ref_info = {
            "path": str(ref_path),
            "size": len(ref_bytes),
            "classify": classify_body(ref_bytes),
        }
    else:
        ref_info = {"path": None, "note": "no photometa.bin reference found"}

    # ---- Group requests by sha1 ----
    requests = manifest.get("requests", [])
    by_sha: dict[str, dict] = {}
    by_pattern: dict[str, dict] = {}

    for r in requests:
        sha = r.get("body_sha1")
        url = r.get("url")
        ph = r.get("phase_at_request") or "pre"
        ct = r.get("content_type")
        size = r.get("body_size")
        saved = r.get("body_saved")
        pat = url_pattern(url)
        qk = query_keys(url)

        # by-pattern aggregation: every request, body or no
        bp = by_pattern.setdefault(pat, {
            "pattern": pat,
            "n_requests": 0,
            "phases": collections.Counter(),
            "content_types": collections.Counter(),
            "statuses": collections.Counter(),
            "body_sizes": [],
            "saved_body_sha1s": set(),
            "query_keys_seen": set(),
            "example_urls": [],
        })
        bp["n_requests"] += 1
        bp["phases"][ph] += 1
        if ct:
            bp["content_types"][ct] += 1
        bp["statuses"][r.get("status")] += 1
        if size is not None:
            bp["body_sizes"].append(size)
        if sha and saved:
            bp["saved_body_sha1s"].add(sha)
        bp["query_keys_seen"].update(qk)
        if len(bp["example_urls"]) < 3:
            bp["example_urls"].append(url)

        # by-sha1 aggregation: only saved bodies
        if sha and saved:
            bs = by_sha.setdefault(sha, {
                "sha1": sha,
                "size": size,
                "content_types": collections.Counter(),
                "phases": collections.Counter(),
                "url_patterns": collections.Counter(),
                "example_urls": [],
                "saved_path": saved,
                "classify": None,
            })
            bs["content_types"][ct or ""] += 1
            bs["phases"][ph] += 1
            bs["url_patterns"][pat] += 1
            if len(bs["example_urls"]) < 3:
                bs["example_urls"].append(url)

    # Classify each saved body
    for sha, info in by_sha.items():
        body_path = raw / info["saved_path"]
        if body_path.exists():
            try:
                buf = body_path.read_bytes()
                info["classify"] = classify_body(buf)
            except Exception as e:
                info["classify"] = {"error": str(e)}

    # Convert Counters/sets to JSON-friendly forms
    def serialize_pattern(bp: dict) -> dict:
        sizes = bp["body_sizes"]
        return {
            "pattern": bp["pattern"],
            "n_requests": bp["n_requests"],
            "phases": dict(bp["phases"]),
            "content_types": dict(bp["content_types"]),
            "statuses": dict(bp["statuses"]),
            "body_size_min": min(sizes) if sizes else None,
            "body_size_max": max(sizes) if sizes else None,
            "body_size_total": sum(s for s in sizes if s),
            "unique_saved_bodies": sorted(bp["saved_body_sha1s"]),
            "query_keys_seen": sorted(bp["query_keys_seen"]),
            "example_urls": bp["example_urls"],
        }

    patterns_out = sorted(
        (serialize_pattern(bp) for bp in by_pattern.values()),
        key=lambda x: -x["n_requests"],
    )

    def serialize_sha(bs: dict) -> dict:
        return {
            "sha1": bs["sha1"],
            "size": bs["size"],
            "content_types": dict(bs["content_types"]),
            "phases": dict(bs["phases"]),
            "url_patterns": dict(bs["url_patterns"]),
            "example_urls": bs["example_urls"],
            "saved_path": bs["saved_path"],
            "classify": bs["classify"],
        }

    classes_out = sorted(
        (serialize_sha(bs) for bs in by_sha.values()),
        key=lambda x: -(x.get("size") or 0),
    )

    # ---- vs photometa: highlight candidate binary payloads ----
    candidates = []
    if ref_info.get("classify"):
        ref_size = ref_info["classify"].get("size")
    else:
        ref_size = None

    for bs in classes_out:
        cls = bs.get("classify") or {}
        t = cls.get("type")
        if t in ("image/png", "image/jpeg", "image/gif", "image/webp-or-riff"):
            continue  # tile-like, separate channel
        # We're hunting for "looks like geometry data": protobuf-ish, gltf, draco,
        # gzip/zstd-wrapped binary, large unknown-binary, or octet-stream JSON
        # blobs that aren't photometa-shaped.
        cand_score = 0
        reasons = []
        if t == "protobuf-ish":
            cand_score += 3
            reasons.append("protobuf-ish payload")
        if t in ("gltf-binary", "draco-mesh"):
            cand_score += 5
            reasons.append(f"explicit 3D format: {t}")
        if t == "gzip" or t == "zstd":
            cand_score += 2
            reasons.append(f"compressed binary ({t}) — unwrap and reclassify")
        if t == "unknown-binary" and (bs.get("size") or 0) > 4096:
            cand_score += 1
            reasons.append("large unknown binary")
        if t in ("json", "json-with-anti-hijack-prefix") and (bs.get("size") or 0) > 8192:
            cand_score += 1
            reasons.append("large JSON — possible vector/annotation channel")
        # bonus: not also seen on the photometa URL pattern
        on_photometa = any("photometa" in p for p in bs["url_patterns"].keys())
        if on_photometa:
            cand_score -= 2
            reasons.append("served by photometa endpoint — already covered")
        if cand_score > 0:
            candidates.append({
                "sha1": bs["sha1"],
                "size": bs["size"],
                "type": t,
                "score": cand_score,
                "reasons": reasons,
                "url_patterns": bs["url_patterns"],
                "example_urls": bs["example_urls"],
                "phases": bs["phases"],
                "saved_path": bs["saved_path"],
            })
    candidates.sort(key=lambda x: (-x["score"], -(x["size"] or 0)))

    # Try protoc-decode-raw on the top protobuf-ish candidate AND on photometa, side-by-side
    pb_decoded = {}
    for c in candidates[:3]:
        if c["type"] == "protobuf-ish":
            txt = try_protoc_decode_raw(raw / c["saved_path"])
            if txt:
                pb_decoded[c["sha1"]] = txt[:4000]
    if ref_path and ref_path.exists():
        txt = try_protoc_decode_raw(ref_path)
        if txt:
            pb_decoded["photometa_ref"] = txt[:4000]

    # Write JSON outputs
    (out / "url_patterns.json").write_text(json.dumps(patterns_out, indent=2))
    (out / "payload_classes.json").write_text(json.dumps(classes_out, indent=2))
    (out / "vs_photometa.json").write_text(json.dumps({
        "photometa_ref": ref_info,
        "candidates": candidates,
        "protoc_decode_raw_excerpts": pb_decoded,
    }, indent=2))

    # ---- Markdown report ----
    md: list[str] = []
    md.append(f"# UI geometry audit — `{panoid}` @ `{ts}`")
    md.append("")
    md.append(f"- raw_dir: `{raw}`")
    md.append(f"- url: `{manifest.get('url')}`")
    summary = manifest.get("summary", {})
    md.append(f"- total requests: {summary.get('total_requests')}")
    md.append(f"- saved bodies: {summary.get('saved_bodies')} ({summary.get('unique_body_hashes')} unique)")
    md.append(f"- total response bytes: {summary.get('total_response_bytes')}")
    md.append("")
    md.append("## Per-phase activity")
    md.append("")
    md.append("| phase | requests | saved bodies | bytes |")
    md.append("|---|---|---|---|")
    for ph, st in (summary.get("per_phase") or {}).items():
        md.append(f"| {ph} | {st.get('requests')} | {st.get('saved_bodies')} | {st.get('bytes')} |")
    md.append("")

    md.append("## Photometa reference")
    md.append("")
    if ref_info.get("path"):
        md.append(f"- path: `{ref_info['path']}`")
        md.append(f"- size: {ref_info['size']}")
        cls = ref_info.get("classify", {})
        md.append(f"- classify.type: `{cls.get('type')}`")
        if cls.get("protobuf"):
            md.append(f"- protobuf.fields_walked: {cls['protobuf']['fields_walked']}, coverage: {cls['protobuf']['coverage']}")
            md.append(f"- protobuf.top_fields: {cls['protobuf']['top_fields'][:12]}")
    else:
        md.append("(no reference found)")
    md.append("")

    md.append("## Candidate non-photometa geometry payloads")
    md.append("")
    if not candidates:
        md.append("**No candidates flagged.** Photometa appears to be the canonical UI geometry channel for this panoid.")
    else:
        md.append("| score | type | size | phases | url pattern (1st) | sha1 |")
        md.append("|---|---|---|---|---|---|")
        for c in candidates[:20]:
            patterns = list(c["url_patterns"].keys())
            md.append(
                f"| {c['score']} | `{c['type']}` | {c['size']} | "
                f"{','.join(c['phases'].keys())} | `{patterns[0] if patterns else '?'}` | "
                f"`{c['sha1'][:12]}` |"
            )
        md.append("")
        md.append("### Reasons")
        md.append("")
        for c in candidates[:10]:
            md.append(f"- `{c['sha1'][:12]}` — {'; '.join(c['reasons'])}")
        md.append("")

    md.append("## Top URL patterns (by request count)")
    md.append("")
    md.append("| n | host+path | content-types | phases | size min..max |")
    md.append("|---|---|---|---|---|")
    for p in patterns_out[:25]:
        cts = ",".join(p["content_types"].keys())[:80]
        phs = ",".join(p["phases"].keys())
        smin = p["body_size_min"]
        smax = p["body_size_max"]
        md.append(f"| {p['n_requests']} | `{p['pattern'][:80]}` | {cts} | {phs} | {smin}..{smax} |")
    md.append("")

    if pb_decoded:
        md.append("## Protobuf decode_raw excerpts")
        for k, v in pb_decoded.items():
            md.append(f"### {k}")
            md.append("```")
            md.append(v[:1500])
            md.append("```")
            md.append("")

    (out / "audit_report.md").write_text("\n".join(md))
    print(f"[audit] wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
