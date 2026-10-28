#!/usr/bin/env python3
"""Merge only Altman Z / Beneish M fields into market payloads.

Node JSON.stringify turns whole-number floats (e.g. 5252354.0) into ints, which
rewrites unrelated valuation fields and creates noisy diffs against parallel EV
repairs. Python's json module preserves 5.0 vs 5 from the source text, so this
helper applies a precomputed score patch without clobbering other keys.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ZM_KEYS = (
    "z_score",
    "z_score_model",
    "z_score_zone",
    "z_score_breakdown",
    "m_score",
    "m_score_zone",
    "m_score_breakdown",
)


def merge_zm(stock: dict, patch: dict) -> None:
    for key in ZM_KEYS:
        if key in patch:
            stock[key] = patch[key]
    rating = stock.setdefault("ratingSources", {})
    if "ratingSources_zScore" in patch:
        rating["zScore"] = patch["ratingSources_zScore"]
    if "ratingSources_mScore" in patch:
        rating["mScore"] = patch["ratingSources_mScore"]
    if "zScore" in patch.get("ratingSources", {}):
        rating["zScore"] = patch["ratingSources"]["zScore"]
    if "mScore" in patch.get("ratingSources", {}):
        rating["mScore"] = patch["ratingSources"]["mScore"]


def load_market_js(path: Path) -> tuple[str, dict]:
    text = path.read_text(encoding="utf-8")
    prefix = "window.FULL_MARKET_DATA = "
    if not text.startswith(prefix):
        raise SystemExit(f"{path} missing {prefix!r} assignment")
    payload = json.loads(text[len(prefix) :].rstrip().rstrip(";"))
    return prefix, payload


def write_market_js(path: Path, prefix: str, payload: dict) -> None:
    path.write_text(
        prefix + json.dumps(payload, ensure_ascii=False, indent=2) + ";\n",
        encoding="utf-8",
    )


def apply_patch(stocks: dict, patch: dict) -> tuple[int, int, int]:
    z_ok = m_ok = total = 0
    for ticker, fields in patch.items():
        stock = stocks.get(ticker)
        if not isinstance(stock, dict):
            continue
        total += 1
        merge_zm(stock, fields)
        if isinstance(fields.get("z_score"), (int, float)):
            z_ok += 1
        if isinstance(fields.get("m_score"), (int, float)):
            m_ok += 1
    return total, z_ok, m_ok


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--patch", required=True, help="JSON map of ticker → Z/M fields")
    parser.add_argument(
        "--json-out",
        default="full_market_dcf.json",
        help="Pretty JSON market mirror (default: full_market_dcf.json)",
    )
    parser.add_argument(
        "--js-out",
        default="market_data.js",
        help="Browser FULL_MARKET_DATA module (default: market_data.js)",
    )
    args = parser.parse_args(argv)

    root = Path(__file__).resolve().parents[1]
    patch = json.loads(Path(args.patch).read_text(encoding="utf-8"))

    json_path = root / args.json_out
    fm = json.loads(json_path.read_text(encoding="utf-8"))
    total, z_ok, m_ok = apply_patch(fm, patch)
    json_path.write_text(json.dumps(fm, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{args.json_out}: total={total} z={z_ok} m={m_ok}")

    js_path = root / args.js_out
    prefix, payload = load_market_js(js_path)
    apply_patch(payload, patch)
    write_market_js(js_path, prefix, payload)
    print(f"{args.js_out}: total={total} z={z_ok} m={m_ok}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
