#!/usr/bin/env python3
"""Batch-capture US expansion financials for net-new >$5B tickers (no Gemini remoat).

Reads /tmp/us_5b_net_new.json (or --tickers-file). Processes ≤20 symbols per
build_full_market.py invocation, then ingest/package/integrate into the repo.
Omits GEMINI/GCP so moat stays analysisUnavailable for Actions remoat later.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TICKERS = Path("/tmp/us_5b_net_new.json")
DEFAULT_PROGRESS = Path("/tmp/us_5b_expansion_progress.json")


def load_tickers(path: Path) -> list[str]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(raw, list):
        return [str(item).strip().upper() for item in raw if str(item).strip()]
    raise SystemExit(f"Expected ticker list JSON in {path}")


def load_progress(path: Path) -> dict:
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"done": [], "failed": [], "batches": []}


def save_progress(path: Path, progress: dict) -> None:
    path.write_text(json.dumps(progress, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def run_batch(symbols: list[str], batch_idx: int, work_root: Path) -> dict:
    out = work_root / f"batch-{batch_idx:02d}"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    env = os.environ.copy()
    # Financials only — remoat via Actions (GCP) when AI Studio prepaid is empty.
    env.pop("GEMINI_API_KEY", None)
    env.pop("GCP_SA_KEY", None)
    env["US_EXPANSION_SYMBOLS"] = ",".join(symbols)
    env["US_EXPANSION_OUTPUT"] = str(out)
    env["MAX_US_MOAT_GEMINI"] = "0"
    env["MAX_US_DESC_GEMINI"] = "0"
    log_path = out / "build.log"
    started = time.time()
    with log_path.open("w", encoding="utf-8") as log:
        proc = subprocess.run(
            [sys.executable, "-u", str(ROOT / "build_full_market.py")],
            cwd=ROOT,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            check=False,
        )
    build_seconds = round(time.time() - started, 1)
    if proc.returncode != 0 and not (out / "market.json").exists():
        return {
            "batch": batch_idx,
            "symbols": symbols,
            "ok": False,
            "build_seconds": build_seconds,
            "error": f"build_full_market exit {proc.returncode}; see {log_path}",
        }
    if proc.returncode != 0 and (out / "market.json").exists():
        # Partial batch — still ingest what we got; leftover symbols stay for retry.
        pass
    # Copy financials into repo cache before ingest (ingest reads cache/financials).
    fin_src = out / "cache" / "financials"
    if fin_src.exists():
        dest = ROOT / "cache" / "financials"
        dest.mkdir(parents=True, exist_ok=True)
        for file in fin_src.glob("*.json"):
            shutil.copy2(file, dest / file.name)
    # Also copy any company/price caches produced beside market.json if present.
    for folder in ("us_companies", "price_charts", "company"):
        src = out / "cache" / folder
        if not src.exists():
            continue
        dest = ROOT / "cache" / folder
        dest.mkdir(parents=True, exist_ok=True)
        for file in src.glob("*"):
            if file.is_file():
                shutil.copy2(file, dest / file.name)
    for command in (
        ["node", str(ROOT / "scripts" / "build_us_expansion.cjs"), "ingest", str(out / "market.json"), str(out)],
        ["node", str(ROOT / "scripts" / "build_us_expansion.cjs"), "package", str(out)],
        ["node", str(ROOT / "scripts" / "build_us_expansion.cjs"), "integrate", str(out)],
    ):
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            return {
                "batch": batch_idx,
                "symbols": symbols,
                "ok": False,
                "build_seconds": build_seconds,
                "error": f"{' '.join(command)} failed: {result.stderr or result.stdout}",
            }
    market = json.loads((out / "market.json").read_text(encoding="utf-8"))
    skipped = []
    skipped_path = out / "skipped.json"
    if skipped_path.exists():
        skipped = [item.get("ticker") for item in json.loads(skipped_path.read_text()).get("stocks", [])]
    return {
        "batch": batch_idx,
        "symbols": symbols,
        "ok": True,
        "build_seconds": build_seconds,
        "available": sorted(market.keys()),
        "skipped": skipped,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tickers-file", type=Path, default=DEFAULT_TICKERS)
    parser.add_argument("--progress-file", type=Path, default=DEFAULT_PROGRESS)
    parser.add_argument("--work-root", type=Path, default=Path("/tmp/us-5b-expansion-work"))
    parser.add_argument("--batch-size", type=int, default=20)
    parser.add_argument("--max-batches", type=int, default=0, help="0 = all remaining")
    parser.add_argument("--start-batch", type=int, default=0)
    args = parser.parse_args()
    if not (1 <= args.batch_size <= 20):
        raise SystemExit("--batch-size must be 1-20")
    tickers = load_tickers(args.tickers_file)
    progress = load_progress(args.progress_file)
    done = set(progress.get("done") or [])
    remaining = [ticker for ticker in tickers if ticker not in done]
    batches = [remaining[i : i + args.batch_size] for i in range(0, len(remaining), args.batch_size)]
    if args.start_batch:
        batches = batches[args.start_batch :]
    if args.max_batches:
        batches = batches[: args.max_batches]
    args.work_root.mkdir(parents=True, exist_ok=True)
    print(
        f"net-new={len(tickers)} done={len(done)} remaining={len(remaining)} "
        f"this_run_batches={len(batches)} size={args.batch_size}",
        flush=True,
    )
    for offset, symbols in enumerate(batches):
        batch_idx = args.start_batch + offset
        print(f"=== batch {batch_idx} ({len(symbols)}): {','.join(symbols)} ===", flush=True)
        result = run_batch(symbols, batch_idx, args.work_root)
        progress.setdefault("batches", []).append(result)
        if result["ok"]:
            progress["done"] = sorted(set(progress.get("done") or []) | set(result["available"]))
            if result.get("skipped"):
                progress["failed"] = sorted(set(progress.get("failed") or []) | set(result["skipped"]))
            print(
                f"OK batch {batch_idx}: available={len(result['available'])} "
                f"skipped={result.get('skipped')} in {result['build_seconds']}s",
                flush=True,
            )
        else:
            progress["failed"] = sorted(set(progress.get("failed") or []) | set(symbols))
            print(f"FAIL batch {batch_idx}: {result.get('error')}", flush=True)
        save_progress(args.progress_file, progress)
    print(json.dumps({
        "done": len(progress.get("done") or []),
        "failed": progress.get("failed") or [],
        "remaining": len([t for t in tickers if t not in set(progress.get("done") or [])]),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
