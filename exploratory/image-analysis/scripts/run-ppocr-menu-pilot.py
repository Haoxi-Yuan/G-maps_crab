#!/usr/bin/env python3
"""Run PP-OCRv6 on a deterministic menu-image sample and persist text boxes."""

from __future__ import annotations

import argparse
import json
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample-db", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--run-id", default="ppocr_smoke_v1")
    parser.add_argument("--limit", type=int, default=8)
    parser.add_argument("--device", default="gpu:0")
    parser.add_argument("--selection-db")
    parser.add_argument("--selection-run-id", default="luna_smoke_v1")
    args = parser.parse_args()
    if args.limit < 1:
        parser.error("--limit must be positive")
    return args


def jsonable(value: Any) -> Any:
    if hasattr(value, "tolist"):
        return value.tolist()
    if isinstance(value, dict):
        return {key: jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(item) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def result_payload(result: Any) -> dict[str, Any]:
    payload = getattr(result, "json", None)
    if callable(payload):
        payload = payload()
    if payload is None:
        payload = getattr(result, "res", result)
    if isinstance(payload, str):
        payload = json.loads(payload)
    payload = jsonable(payload)
    return payload.get("res", payload)


def create_schema(db: sqlite3.Connection) -> None:
    db.executescript(
        """
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS runs (
          run_id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          source_sample_db TEXT NOT NULL,
          selection_db TEXT,
          selection_run_id TEXT,
          device TEXT NOT NULL,
          model TEXT NOT NULL,
          requested_count INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS results (
          run_id TEXT NOT NULL,
          sample_id TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          latency_ms INTEGER,
          line_count INTEGER,
          raw_json TEXT,
          error TEXT,
          PRIMARY KEY (run_id, sample_id)
        );
        CREATE TABLE IF NOT EXISTS text_lines (
          run_id TEXT NOT NULL,
          sample_id TEXT NOT NULL,
          line_index INTEGER NOT NULL,
          text_raw TEXT NOT NULL,
          confidence REAL,
          polygon_json TEXT NOT NULL,
          x_min REAL,
          y_min REAL,
          x_max REAL,
          y_max REAL,
          PRIMARY KEY (run_id, sample_id, line_index)
        );
        """
    )


def selected_rows(sample_db: sqlite3.Connection, args: argparse.Namespace) -> list[sqlite3.Row]:
    sample_db.row_factory = sqlite3.Row
    if args.selection_db:
        chosen = sqlite3.connect(args.selection_db)
        ids = [
            row[0]
            for row in chosen.execute(
                "SELECT sample_id FROM results WHERE run_id=? AND status='completed' ORDER BY sample_id LIMIT ?",
                (args.selection_run_id, args.limit),
            )
        ]
        chosen.close()
        return [
            sample_db.execute("SELECT * FROM samples WHERE sample_id=?", (sample_id,)).fetchone()
            for sample_id in ids
        ]
    return list(sample_db.execute("SELECT * FROM samples ORDER BY sample_id LIMIT ?", (args.limit,)))


def save_lines(
    db: sqlite3.Connection,
    run_id: str,
    sample_id: str,
    payload: dict[str, Any],
) -> int:
    texts = payload.get("rec_texts", [])
    scores = payload.get("rec_scores", [])
    polygons = payload.get("rec_polys", payload.get("dt_polys", []))
    db.execute("DELETE FROM text_lines WHERE run_id=? AND sample_id=?", (run_id, sample_id))
    for index, text in enumerate(texts):
        polygon = polygons[index] if index < len(polygons) else []
        points = [point for point in polygon if isinstance(point, list) and len(point) >= 2]
        xs = [float(point[0]) for point in points]
        ys = [float(point[1]) for point in points]
        score = float(scores[index]) if index < len(scores) else None
        db.execute(
            "INSERT INTO text_lines VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                run_id,
                sample_id,
                index,
                str(text),
                score,
                json.dumps(polygon, ensure_ascii=False),
                min(xs) if xs else None,
                min(ys) if ys else None,
                max(xs) if xs else None,
                max(ys) if ys else None,
            ),
        )
    return len(texts)


def main() -> None:
    args = parse_args()
    from paddleocr import PaddleOCR

    sample_path = str(Path(args.sample_db).resolve())
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    source = sqlite3.connect(sample_path)
    rows = selected_rows(source, args)
    out = sqlite3.connect(out_path)
    create_schema(out)
    out.execute(
        "INSERT OR IGNORE INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            args.run_id,
            utc_now(),
            sample_path,
            str(Path(args.selection_db).resolve()) if args.selection_db else None,
            args.selection_run_id if args.selection_db else None,
            args.device,
            "PP-OCRv6_medium",
            len(rows),
        ),
    )
    out.commit()
    print(json.dumps({"event": "run_started", "run_id": args.run_id, "count": len(rows)}), flush=True)
    ocr = PaddleOCR(
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        device=args.device,
    )
    for index, row in enumerate(rows, 1):
        sample_id = row["sample_id"]
        existing = out.execute(
            "SELECT status FROM results WHERE run_id=? AND sample_id=?", (args.run_id, sample_id)
        ).fetchone()
        if existing and existing[0] == "completed":
            continue
        started_at = utc_now()
        started_ms = time.monotonic_ns() // 1_000_000
        out.execute(
            """
            INSERT INTO results(run_id, sample_id, status, started_at)
            VALUES (?, ?, 'running', ?)
            ON CONFLICT(run_id, sample_id) DO UPDATE SET
              status='running', started_at=excluded.started_at, error=NULL
            """,
            (args.run_id, sample_id, started_at),
        )
        out.commit()
        print(json.dumps({"event": "image_started", "index": index, "sample_id": sample_id}), flush=True)
        try:
            predictions = list(ocr.predict(row["local_path"]))
            if not predictions:
                raise RuntimeError("PP-OCR returned no prediction")
            payload = result_payload(predictions[0])
            line_count = save_lines(out, args.run_id, sample_id, payload)
            latency_ms = time.monotonic_ns() // 1_000_000 - started_ms
            out.execute(
                """
                UPDATE results SET status='completed', completed_at=?, latency_ms=?,
                  line_count=?, raw_json=?, error=NULL WHERE run_id=? AND sample_id=?
                """,
                (
                    utc_now(),
                    latency_ms,
                    line_count,
                    json.dumps(payload, ensure_ascii=False),
                    args.run_id,
                    sample_id,
                ),
            )
            out.commit()
            print(
                json.dumps(
                    {
                        "event": "image_completed",
                        "index": index,
                        "sample_id": sample_id,
                        "latency_ms": latency_ms,
                        "line_count": line_count,
                    }
                ),
                flush=True,
            )
        except Exception as error:  # noqa: BLE001 - persist per-image failures
            out.execute(
                """
                UPDATE results SET status='failed', completed_at=?, latency_ms=?, error=?
                WHERE run_id=? AND sample_id=?
                """,
                (
                    utc_now(),
                    time.monotonic_ns() // 1_000_000 - started_ms,
                    str(error),
                    args.run_id,
                    sample_id,
                ),
            )
            out.commit()
            print(json.dumps({"event": "image_failed", "sample_id": sample_id, "error": str(error)}), flush=True)
    summary = list(
        out.execute(
            """
            SELECT status, COUNT(*), SUM(line_count), ROUND(AVG(latency_ms), 1)
            FROM results WHERE run_id=? GROUP BY status ORDER BY status
            """,
            (args.run_id,),
        )
    )
    print(json.dumps({"event": "run_completed", "run_id": args.run_id, "summary": summary}), flush=True)
    source.close()
    out.close()


if __name__ == "__main__":
    main()
