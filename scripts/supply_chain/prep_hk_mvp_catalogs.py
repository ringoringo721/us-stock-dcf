#!/usr/bin/env python3
"""Prep entities / competitors / player overrides for HK supply-chain MVP hubs.

Writes into the shared catalog JSONs (same shapes as US mega/mid/remaining).
Does not call FMP. Prefer .HK counters for dual-listed China names.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from scripts.build_supply_chain_mega_seeds import traditionalize  # noqa: E402

DATA = ROOT / "scripts" / "supply_chain" / "data"
ENT_PATH = DATA / "sc_entities.json"
COMP_PATH = DATA / "sc_competitors.json"
OVERRIDE_PATH = DATA / "sc_player_overrides.json"

# Short Traditional Chinese brands (HKEX-style); never Simplified.
ENTITIES: dict[str, dict[str, str]] = {
    "0700.HK": {"name_en": "Tencent", "name_zh": "騰訊", "exchange": "HKEX"},
    "9988.HK": {"name_en": "Alibaba", "name_zh": "阿里巴巴", "exchange": "HKEX"},
    "3690.HK": {"name_en": "Meituan", "name_zh": "美團", "exchange": "HKEX"},
    "1810.HK": {"name_en": "Xiaomi", "name_zh": "小米", "exchange": "HKEX"},
    "1211.HK": {"name_en": "BYD", "name_zh": "比亞迪", "exchange": "HKEX"},
    "0941.HK": {"name_en": "China Mobile", "name_zh": "中國移動", "exchange": "HKEX"},
    "0005.HK": {"name_en": "HSBC", "name_zh": "滙豐", "exchange": "HKEX"},
    "2318.HK": {"name_en": "Ping An", "name_zh": "中國平安", "exchange": "HKEX"},
    "0388.HK": {"name_en": "HKEX", "name_zh": "港交所", "exchange": "HKEX"},
    "0883.HK": {"name_en": "CNOOC", "name_zh": "中海油", "exchange": "HKEX"},
    "1299.HK": {"name_en": "AIA", "name_zh": "友邦", "exchange": "HKEX"},
    "0386.HK": {"name_en": "Sinopec", "name_zh": "中石化", "exchange": "HKEX"},
    # Dual / peer nodes
    "9618.HK": {"name_en": "JD.com", "name_zh": "京東", "exchange": "HKEX"},
    "9888.HK": {"name_en": "Baidu", "name_zh": "百度", "exchange": "HKEX"},
    "9999.HK": {"name_en": "NetEase", "name_zh": "網易", "exchange": "HKEX"},
    "1024.HK": {"name_en": "Kuaishou", "name_zh": "快手", "exchange": "HKEX"},
    "9626.HK": {"name_en": "Bilibili", "name_zh": "嗶哩嗶哩", "exchange": "HKEX"},
    "0762.HK": {"name_en": "China Unicom", "name_zh": "中國聯通", "exchange": "HKEX"},
    "0728.HK": {"name_en": "China Telecom", "name_zh": "中國電信", "exchange": "HKEX"},
    "2015.HK": {"name_en": "Li Auto", "name_zh": "理想汽車", "exchange": "HKEX"},
    "9868.HK": {"name_en": "XPeng", "name_zh": "小鵬", "exchange": "HKEX"},
    "9866.HK": {"name_en": "NIO", "name_zh": "蔚來", "exchange": "HKEX"},
    "0857.HK": {"name_en": "PetroChina", "name_zh": "中國石油", "exchange": "HKEX"},
    "1398.HK": {"name_en": "ICBC", "name_zh": "工商銀行", "exchange": "HKEX"},
    "0939.HK": {"name_en": "CCB", "name_zh": "建設銀行", "exchange": "HKEX"},
    "3988.HK": {"name_en": "Bank of China", "name_zh": "中國銀行", "exchange": "HKEX"},
    "1288.HK": {"name_en": "ABC", "name_zh": "農業銀行", "exchange": "HKEX"},
    "2388.HK": {"name_en": "BOCHK", "name_zh": "中銀香港", "exchange": "HKEX"},
    "2628.HK": {"name_en": "China Life", "name_zh": "中國人壽", "exchange": "HKEX"},
    "2328.HK": {"name_en": "PICC P&C", "name_zh": "人保財險", "exchange": "HKEX"},
    "1339.HK": {"name_en": "PICC Group", "name_zh": "中國人保", "exchange": "HKEX"},
    "0175.HK": {"name_en": "Geely", "name_zh": "吉利汽車", "exchange": "HKEX"},
    "0992.HK": {"name_en": "Lenovo", "name_zh": "聯想", "exchange": "HKEX"},
    "2382.HK": {"name_en": "Sunny Optical", "name_zh": "舜宇光學", "exchange": "HKEX"},
    "0669.HK": {"name_en": "Techtronic", "name_zh": "創科實業", "exchange": "HKEX"},
    "688036.SS": {"name_en": "Transsion", "name_zh": "傳音控股", "exchange": "SSE"},
    "002475.SZ": {"name_en": "Luxshare", "name_zh": "立訊精密", "exchange": "SZSE"},
    "005930.KS": {"name_en": "Samsung Electronics", "name_zh": "三星電子", "exchange": "KRX"},
    "2317.TW": {"name_en": "Hon Hai", "name_zh": "鴻海", "exchange": "TWSE"},
}

# True product/market rivals — prefer .HK when dual-listed; not stage-peer dumps.
COMPETITORS: dict[str, list[list[str]]] = {
    "0700.HK": [
        ["9999.HK", "遊戲／互動娛樂對手", "Games / interactive entertainment rival"],
        ["1024.HK", "短影音／資訊流廣告對手", "Short-video / feed-ads rival"],
        ["9988.HK", "中國互聯網生態對手", "China internet ecosystem rival"],
        ["9888.HK", "搜尋／廣告對手", "Search / advertising rival"],
        ["META", "社交／廣告全球對手", "Global social / ads rival"],
        ["9626.HK", "影音內容對手", "Video content rival"],
    ],
    "9988.HK": [
        ["9618.HK", "中國電商對手", "China e-commerce rival"],
        ["PDD", "下沉市場電商對手", "Value e-commerce rival"],
        ["0700.HK", "中國互聯網生態對手", "China internet ecosystem rival"],
        ["AMZN", "全球電商／雲對手", "Global e-commerce / cloud rival"],
        ["3690.HK", "本地生活／即時零售對手", "Local services / instant retail rival"],
    ],
    "3690.HK": [
        ["9988.HK", "本地生活／即配生態對手（餓了麼等）", "Local services / delivery ecosystem rival"],
        ["9618.HK", "即時零售／物流對手", "Instant retail / logistics rival"],
        ["DASH", "即時配送全球對手", "Global on-demand delivery rival"],
        ["UBER", "出行／配送平台對手", "Mobility / delivery platform rival"],
        ["GRAB", "亞洲出行／本地生活對手", "Asia mobility / local-services rival"],
    ],
    "1810.HK": [
        ["AAPL", "智慧手機／裝置生態對手", "Smartphone / device-ecosystem rival"],
        ["005930.KS", "全球手機對手", "Global handset rival"],
        ["688036.SS", "新興市場量產 Android 對手", "Emerging-market Android OEM rival"],
        ["GOOG", "Android／Pixel 生態對手", "Android / Pixel ecosystem rival"],
        ["0992.HK", "PC／消費電子對手", "PC / consumer electronics rival"],
    ],
    "1211.HK": [
        ["TSLA", "電動車／新能源車對手", "EV / NEV rival"],
        ["2015.HK", "中國新勢力電動車對手", "China EV rival"],
        ["9868.HK", "中國新勢力電動車對手", "China EV rival"],
        ["9866.HK", "中國新勢力電動車對手", "China EV rival"],
        ["TM", "全球整車對手", "Global auto OEM rival"],
        ["0175.HK", "中國整車對手", "China auto OEM rival"],
    ],
    "0941.HK": [
        ["0762.HK", "中國移動通信對手", "China wireless telecom rival"],
        ["0728.HK", "中國移動通信對手", "China wireless telecom rival"],
    ],
    "0005.HK": [
        ["JPM", "全球全能銀行對手", "Global diversified bank rival"],
        ["1398.HK", "中國大型銀行對手", "China megabank rival"],
        ["0939.HK", "中國大型銀行對手", "China megabank rival"],
        ["3988.HK", "中國大型銀行對手", "China megabank rival"],
        ["2388.HK", "香港零售／企業銀行對手", "Hong Kong banking rival"],
    ],
    "2318.HK": [
        ["1299.HK", "壽險／綜合保險對手", "Life / multi-line insurance rival"],
        ["2628.HK", "中國壽險對手", "China life insurance rival"],
        ["2328.HK", "中國產險對手", "China P&C insurance rival"],
        ["1339.HK", "中國保險集團對手", "China insurance group rival"],
        ["MET", "全球壽險對手", "Global life insurance rival"],
    ],
    "0388.HK": [
        ["ICE", "交易所／清算對手", "Exchange / clearing rival"],
        ["CME", "衍生品交易所對手", "Derivatives exchange rival"],
        ["NDAQ", "證券交易所對手", "Securities exchange rival"],
        ["CBOE", "選擇權／交易所對手", "Options exchange rival"],
    ],
    "0883.HK": [
        ["0857.HK", "中國上游油氣對手", "China upstream oil & gas rival"],
        ["0386.HK", "中國油氣一體化對手", "China integrated oil & gas rival"],
        ["XOM", "全球一體化油氣對手", "Global integrated oil & gas rival"],
        ["CVX", "全球一體化油氣對手", "Global integrated oil & gas rival"],
        ["SHEL", "全球一體化油氣對手", "Global integrated oil & gas rival"],
    ],
    "1299.HK": [
        ["2318.HK", "亞洲壽險／綜合保險對手", "Asia life / multi-line insurance rival"],
        ["2628.HK", "中國壽險對手", "China life insurance rival"],
        ["PRU", "全球壽險對手", "Global life insurance rival"],
        ["MET", "全球壽險對手", "Global life insurance rival"],
        ["MFC", "全球壽險對手", "Global life insurance rival"],
    ],
    "0386.HK": [
        ["0857.HK", "中國油氣一體化對手", "China integrated oil & gas rival"],
        ["0883.HK", "中國上游油氣對手", "China upstream oil & gas rival"],
        ["XOM", "全球一體化油氣對手", "Global integrated oil & gas rival"],
        ["CVX", "全球一體化油氣對手", "Global integrated oil & gas rival"],
        ["BP", "全球一體化油氣對手", "Global integrated oil & gas rival"],
    ],
}

# Stage players: China/HK-relevant where possible; scrub rivals off stages.
OVERRIDES: dict[str, dict[str, list[str]]] = {
    "0700.HK": {
        "infra": ["EQIX", "MSFT", "AMZN"],
        "content": ["NFLX", "DIS", "SPOT"],
        "ads": ["TTD", "APP", "SNAP"],
        # Scrub 1810.HK (rival on some arcs / device OEM) — keep device OEMs that aren't rivals.
        "devices": ["AAPL", "005930.KS", "SONY"],
        "commerce": ["V", "MA", "SHOP"],
    },
    "9988.HK": {
        "supply": ["PG", "NKE", "SONY"],
        "fulfillment": ["PLD", "EQIX", "AMT"],
        "payments": ["V", "MA", "PYPL"],
        "traffic": ["GOOG", "META", "APP"],
        "lastmile": ["UPS", "FDX", "EXPD"],
    },
    "3690.HK": {
        "maps-cloud": ["GOOG", "MSFT", "AMZN"],
        "payments": ["V", "MA", "PYPL"],
        "supply": ["1211.HK", "0175.HK", "TM"],
        "platforms": ["LYFT", "AMZN", "SHOP"],  # scrub DASH/UBER/GRAB/9988 rivals
        "monetization": ["GOOG", "META", "APP"],
    },
    "1810.HK": {
        "materials": ["GLW", "AMAT", "ASML"],
        "components": ["TSM", "QCOM", "2382.HK"],
        "assembly": ["2317.TW", "002475.SZ", "4938.TW"],
        "distribution": ["FDX", "UPS", "EXPD"],
        "retail": ["BBY", "T", "VZ"],
    },
    "1211.HK": {
        "materials": ["ALB", "FCX", "NUE"],
        "components": ["000660.KS", "ON", "APH"],
        "assembly": ["JBL", "FLEX", "2317.TW"],
        "dealers": ["KMX", "AN", "PAG"],
        "energy": ["NEE", "ENPH", "FSLR"],
    },
    "0941.HK": {
        "equipment": ["CSCO", "ERIC", "NOK"],
        "towers": ["AMT", "CCI", "SBAC"],
        "devices": ["AAPL", "005930.KS", "1810.HK"],
        "content": ["NFLX", "DIS", "GOOG"],
        "customers": ["AMZN", "MSFT", "0700.HK"],
    },
    "0005.HK": {
        "funding": ["GS", "MS", "BLK"],
        "tech": ["MSFT", "ORCL", "IBM"],
        "payments": ["V", "MA", "FISV"],
        "data-risk": ["SPGI", "MCO", "FICO"],
        "channels": ["SCHW", "AXP", "COF"],
    },
    "2318.HK": {
        "reinsurance": ["EG", "RNR", "RGA"],
        "data": ["VRSK", "SPGI", "MCO"],
        "investments": ["BLK", "BX", "BRK-B"],
        "distribution": ["AON", "MRSH", "AJG"],
        "claims": ["UNH", "HCA", "CI"],
    },
    "0388.HK": {
        # Scrub ICE/CME/NDAQ/CBOE off venues — they sit on the rival arc.
        # Use sell-side liquidity / intermediaries as venue-adjacent players.
        "venues": ["GS", "JPM", "MS"],
        "data": ["SPGI", "MCO", "VRSK"],
        "tech": ["MSFT", "ORCL", "PANW"],
        "buy-side": ["BLK", "BX", "TROW"],
        "issuers": ["0700.HK", "9988.HK", "0005.HK"],
    },
    "0883.HK": {
        "services": ["SLB", "HAL", "BKR"],
        "upstream": ["COP", "EOG", "OXY"],
        "midstream": ["ENB", "PAA", "WES"],
        "refining": ["MPC", "VLO", "PSX"],
        "marketing": ["DAL", "CAT", "UNP"],
    },
    "1299.HK": {
        "reinsurance": ["EG", "RNR", "RGA"],
        "data": ["VRSK", "SPGI", "MCO"],
        "investments": ["BLK", "BX", "BRK-B"],
        "distribution": ["AON", "MRSH", "AJG"],
        "claims": ["UNH", "HCA", "CI"],
    },
    "0386.HK": {
        "services": ["SLB", "HAL", "BKR"],
        "upstream": ["COP", "EOG", "OXY"],
        "midstream": ["ENB", "PAA", "WES"],
        "refining": ["MPC", "VLO", "PSX"],
        "marketing": ["DAL", "CAT", "UNP"],
    },
}


def _trad_comp_rows(rows: list[list[str]]) -> list[list[str]]:
    out = []
    for ticker, zh, en in rows:
        out.append([ticker, traditionalize(zh), en])
    return out


def main() -> int:
    entities = json.loads(ENT_PATH.read_text(encoding="utf-8"))
    competitors = json.loads(COMP_PATH.read_text(encoding="utf-8"))
    overrides = json.loads(OVERRIDE_PATH.read_text(encoding="utf-8"))

    for ticker, meta in ENTITIES.items():
        entities[ticker] = {
            "name_en": meta["name_en"],
            "name_zh": traditionalize(meta["name_zh"]),
            "exchange": meta["exchange"],
        }

    for hub, rows in COMPETITORS.items():
        competitors[hub] = _trad_comp_rows(rows)

    for hub, stages in OVERRIDES.items():
        overrides[hub] = {sid: list(ticks) for sid, ticks in stages.items()}

    ENT_PATH.write_text(json.dumps(entities, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    COMP_PATH.write_text(json.dumps(competitors, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    OVERRIDE_PATH.write_text(json.dumps(overrides, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"Updated entities(+{len(ENTITIES)}), competitors hubs={len(COMPETITORS)}, "
        f"overrides hubs={len(OVERRIDES)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
