import json
import os
from pathlib import Path

from peer_cache import get_stock_peers_cached


def main():
    root = Path(__file__).resolve().parent.parent
    api_key = os.environ.get("FMP_API_KEY")
    if not api_key:
        raise RuntimeError("FMP_API_KEY is required; provider peers were not refreshed")
    market = json.loads((root / "full_market_dcf.json").read_text(encoding="utf-8"))
    errors = []
    for ticker, stock in market.items():
        try:
            stock["peers"] = get_stock_peers_cached(
                ticker, api_key, cache_dir=root / "cache" / "peers", refresh=True, strict=True)
        except RuntimeError as error:
            errors.append(str(error))
    if errors:
        raise RuntimeError(f"{len(errors)}/{len(market)} peer requests failed; market datasets were not overwritten")
    serialized = json.dumps(market, ensure_ascii=False, indent=2)
    (root / "full_market_dcf.json").write_text(serialized, encoding="utf-8")
    (root / "market_data.js").write_text(f"window.FULL_MARKET_DATA = {serialized};", encoding="utf-8")
    print(f"Refreshed provider peers for {len(market)} stocks; all financial values unchanged", flush=True)


if __name__ == "__main__":
    main()
