import json
import os
import re
import time

import requests


def parse_peers(payload, ticker):
    def key(symbol):
        return re.sub(r"[.-]", "", symbol.upper())

    if isinstance(payload, dict) and isinstance(payload.get("peersList"), list):
        values = payload["peersList"]
    elif isinstance(payload, list):
        values = []
        for row in payload:
            if isinstance(row, str):
                values.append(row)
            elif isinstance(row, dict) and isinstance(row.get("peersList"), list):
                values.extend(row["peersList"])
            elif isinstance(row, dict) and isinstance(row.get("symbol"), str):
                values.append(row["symbol"])
            else:
                raise ValueError("Unrecognized peer response entry")
    else:
        raise ValueError("Unrecognized peer response format")
    peers = []
    seen = {key(ticker)}
    for value in values:
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*", value.strip()):
            raise ValueError("Invalid peer symbol")
        value = value.strip().upper()
        if key(value) not in seen:
            peers.append(value)
            seen.add(key(value))
    return peers


def get_stock_peers_cached(ticker, api_key, cache_dir="cache/peers", refresh=False, strict=False):
    cache_file = os.path.join(cache_dir, f"{ticker}.json")
    cached = []
    if os.path.exists(cache_file):
        try:
            with open(cache_file, encoding="utf-8") as source:
                cached = parse_peers(json.load(source), ticker)
        except (OSError, ValueError) as error:
            print(f"[{ticker}] Invalid peer cache ({type(error).__name__}); requesting fresh data", flush=True)
        if cached and not refresh:
            return cached
    try:
        if not api_key:
            raise ValueError("FMP API key is required to refresh provider peers")
        clean_symbol = ticker if ticker.endswith(".HK") else ticker.replace(".", "")
        response = requests.get(
            "https://financialmodelingprep.com/stable/stock-peers",
            params={"symbol": clean_symbol, "apikey": api_key}, timeout=15
        )
        time.sleep(0.04)
        if response.status_code != 200:
            raise ValueError(f"FMP peer request HTTP {response.status_code}")
        peers = parse_peers(response.json(), ticker)
        os.makedirs(cache_dir, exist_ok=True)
        with open(cache_file, "w", encoding="utf-8") as destination:
            json.dump(peers, destination, ensure_ascii=False, indent=2)
        return peers
    except (requests.RequestException, OSError, ValueError) as error:
        # Request exception text can include the API key in its URL.
        detail = str(error) if isinstance(error, ValueError) else type(error).__name__
        print(f"[{ticker}] Provider peer refresh failed: {detail}; retaining {len(cached)} cached peers", flush=True)
        if strict:
            raise RuntimeError(f"{ticker}: provider peer refresh failed ({detail})") from None
        return cached
