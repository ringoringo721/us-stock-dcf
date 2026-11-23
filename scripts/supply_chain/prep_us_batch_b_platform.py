#!/usr/bin/env python3
"""Prep catalogs for US SC Batch B — platform / mobility / OTA / gaming / music / SEA.

Rule (prefs + 0700 gold): map main revenue + major assets → external upstream/downstream
only; rivals ≠ stages; no self-made IP/games as upstream; SEA/Korea major markets for
GRAB/SE/CPNG (not US dump); Traditional Chinese only. Does not call FMP.

Batch B hubs (ex-China wrong-model):
  UBER DASH ABNB LYFT GRAB BKNG EXPE RBLX TTWO U SPOT SE CPNG

Owns GRAB/SE/CPNG vs open China Batch A (#143) — if merging after #143, rebase/resolve
favoring Batch B seeds for these three tickers.
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
PLAYERS_PATH = DATA / "sc_players.json"

BATCH_B = [
    "UBER",
    "DASH",
    "ABNB",
    "LYFT",
    "GRAB",
    "BKNG",
    "EXPE",
    "RBLX",
    "TTWO",
    "U",
    "SPOT",
    "SE",
    "CPNG",
]

ENTITIES: dict[str, dict[str, str]] = {
    "UBER": {"name_en": "Uber", "name_zh": "Uber", "exchange": "NYSE"},
    "DASH": {"name_en": "DoorDash", "name_zh": "DoorDash", "exchange": "NASDAQ"},
    "ABNB": {"name_en": "Airbnb", "name_zh": "Airbnb", "exchange": "NASDAQ"},
    "LYFT": {"name_en": "Lyft", "name_zh": "Lyft", "exchange": "NASDAQ"},
    "GRAB": {"name_en": "Grab", "name_zh": "Grab", "exchange": "NASDAQ"},
    "BKNG": {"name_en": "Booking", "name_zh": "Booking 控股", "exchange": "NASDAQ"},
    "EXPE": {"name_en": "Expedia", "name_zh": "Expedia", "exchange": "NASDAQ"},
    "RBLX": {"name_en": "Roblox", "name_zh": "Roblox", "exchange": "NYSE"},
    "TTWO": {"name_en": "Take-Two", "name_zh": "Take-Two 互動", "exchange": "NASDAQ"},
    "U": {"name_en": "Unity Software", "name_zh": "Unity", "exchange": "NYSE"},
    "SPOT": {"name_en": "Spotify", "name_zh": "Spotify", "exchange": "NYSE"},
    "SE": {"name_en": "Sea", "name_zh": "Sea", "exchange": "NYSE"},
    "CPNG": {"name_en": "Coupang", "name_zh": "酷澎", "exchange": "NYSE"},
    # Music majors / SEA-Korea regional nodes
    "UMG": {"name_en": "Universal Music", "name_zh": "環球音樂", "exchange": "EURONEXT"},
    "WMG": {"name_en": "Warner Music", "name_zh": "華納音樂", "exchange": "NASDAQ"},
    "SONY": {"name_en": "Sony", "name_zh": "索尼", "exchange": "NYSE"},
    "UL": {"name_en": "Unilever", "name_zh": "聯合利華", "exchange": "NYSE"},
    "HMC": {"name_en": "Honda", "name_zh": "本田", "exchange": "NYSE"},
    "SHEL": {"name_en": "Shell", "name_zh": "殼牌", "exchange": "NYSE"},
    "KO": {"name_en": "Coca-Cola", "name_zh": "可口可樂", "exchange": "NYSE"},
    "PEP": {"name_en": "PepsiCo", "name_zh": "百事", "exchange": "NASDAQ"},
    "035420.KS": {"name_en": "NAVER", "name_zh": "NAVER", "exchange": "KRX"},
    "035720.KS": {"name_en": "Kakao", "name_zh": "Kakao", "exchange": "KRX"},
    "005930.KS": {"name_en": "Samsung Electronics", "name_zh": "三星電子", "exchange": "KRX"},
    "1211.HK": {"name_en": "BYD", "name_zh": "比亞迪", "exchange": "HKEX"},
    "1810.HK": {"name_en": "Xiaomi", "name_zh": "小米", "exchange": "HKEX"},
    "2020.HK": {"name_en": "ANTA", "name_zh": "安踏", "exchange": "HKEX"},
    "2331.HK": {"name_en": "Li Ning", "name_zh": "李寧", "exchange": "HKEX"},
    "0144.HK": {"name_en": "CMPort", "name_zh": "招商港口", "exchange": "HKEX"},
    "0316.HK": {"name_en": "OOIL", "name_zh": "東方海外", "exchange": "HKEX"},
    "1308.HK": {"name_en": "SITC", "name_zh": "海豐國際", "exchange": "HKEX"},
    "1519.HK": {"name_en": "J&T Express", "name_zh": "極兔速遞", "exchange": "HKEX"},
    "0005.HK": {"name_en": "HSBC", "name_zh": "滙豐", "exchange": "HKEX"},
    "WH": {"name_en": "Wyndham", "name_zh": "溫德姆", "exchange": "NYSE"},
    "H": {"name_en": "Hyatt", "name_zh": "凱悅", "exchange": "NYSE"},
    "AKAM": {"name_en": "Akamai", "name_zh": "Akamai", "exchange": "NASDAQ"},
    "NET": {"name_en": "Cloudflare", "name_zh": "Cloudflare", "exchange": "NYSE"},
    "ADBE": {"name_en": "Adobe", "name_zh": "Adobe", "exchange": "NASDAQ"},
    "ADSK": {"name_en": "Autodesk", "name_zh": "歐特克", "exchange": "NASDAQ"},
    "ACN": {"name_en": "Accenture", "name_zh": "埃森哲", "exchange": "NYSE"},
    "CTSH": {"name_en": "Cognizant", "name_zh": "高知特", "exchange": "NASDAQ"},
    "HUBS": {"name_en": "HubSpot", "name_zh": "HubSpot", "exchange": "NYSE"},
    "EQIX": {"name_en": "Equinix", "name_zh": "Equinix", "exchange": "NASDAQ"},
    "TCOM": {"name_en": "Trip.com", "name_zh": "攜程", "exchange": "NASDAQ"},
    "TME": {"name_en": "Tencent Music", "name_zh": "騰訊音樂", "exchange": "NYSE"},
    "3690.HK": {"name_en": "Meituan", "name_zh": "美團", "exchange": "HKEX"},
}

# US mobility/delivery (UBER/DASH) — merchants not rival platforms.
# maps-cloud drops AMZN (AMZN stays on rival arc as delivery substitute).
US_MOBILITY = {
    "maps-cloud": ["GOOG", "MSFT", "ORCL"],
    "payments": ["V", "MA", "PYPL"],
    "fleet": ["GM", "F", "XOM"],
    "merchants": ["MCD", "SBUX", "YUM"],
    "ads": ["KO", "PEP", "UL"],
}

# LYFT — rideshare-first; fleet US OEM + EV energy adjacency.
US_LYFT = {
    "maps-cloud": ["GOOG", "MSFT", "ORCL"],
    "payments": ["V", "MA", "PYPL"],
    "fleet": ["GM", "F", "TSLA"],
    "merchants": ["MCD", "SBUX", "YUM"],
    "ads": ["KO", "PEP", "NKE"],
}

# GRAB — SEA super-app (not China local-life; not US rideshare peers-as-stage).
SEA_SUPERAPP = {
    "maps-cloud": ["GOOG", "MSFT", "AMZN"],
    "payments": ["V", "MA", "PYPL"],
    "fleet": ["HMC", "1211.HK", "SHEL"],
    "merchants": ["MCD", "SBUX", "YUM"],
    "ads": ["KO", "PEP", "UL"],
}

# BKNG — OTA; inventory avoids MAR/HLT (rivals = direct lodging).
# traffic third slot = SNAP (in-universe), not TRIP (below universe floor → Bugbot listedInApp).
# loyalty = bank/airline co-brand partners (not KO/NKE advertisers — Bugbot).
OTA_BKNG = {
    "inventory": ["DAL", "UAL", "WH"],
    "payments": ["V", "MA", "AXP"],
    "cloud-trust": ["MSFT", "AMZN", "CRWD"],
    "traffic": ["GOOG", "META", "SNAP"],
    "loyalty": ["JPM", "COF", "AAL"],
}

# EXPE — Hyatt inventory OK (not on EXPE rival arc); avoid BKNG/ABNB on stages.
OTA_EXPE = {
    "inventory": ["DAL", "UAL", "H"],
    "payments": ["V", "MA", "AXP"],
    "cloud-trust": ["MSFT", "AMZN", "CRWD"],
    "traffic": ["GOOG", "META", "SNAP"],
    "loyalty": ["JPM", "COF", "AAL"],
}

# ABNB — short-stay marketplace; MAR/HLT/BKNG/EXPE stay on rival arc.
ABNB_LODGING = {
    "host-trust": ["CB", "PGR", "ALL"],
    "payments": ["V", "MA", "PYPL"],
    "cloud-trust": ["MSFT", "AMZN", "CRWD"],
    "traffic": ["GOOG", "META", "SNAP"],
    "ads": ["KO", "PEP", "NKE"],
}

# RBLX — UGC platform; no NFLX/SPOT/DIS content dump; no EA/TTWO as upstream.
# creator-tools = real DCC/3D (ADBE/ADSK/ANSS) — not HUBS CRM (Bugbot).
RBLX_UGC = {
    "infra": ["AMZN", "MSFT", "AKAM"],
    "distribution": ["AAPL", "GOOG", "SONY"],
    "payments": ["V", "MA", "PYPL"],
    "creator-tools": ["ADBE", "ADSK", "ANSS"],
    "ua": ["META", "SNAP", "TTD"],
}

# TTWO — publisher; self IP off stages.
TTWO_PUB = {
    "infra": ["AMZN", "AKAM", "EQIX"],
    "distribution": ["AAPL", "SONY", "MSFT"],
    "payments": ["V", "MA", "PYPL"],
    "services": ["ACN", "CTSH", "ADBE"],
    "ua": ["META", "GOOG", "SNAP"],
}

# Unity — engine/create; not CDW/SNX SaaS channel.
UNITY_ENGINE = {
    "cloud": ["AMZN", "MSFT", "GOOG"],
    "distribution": ["AAPL", "SONY", "005930.KS"],
    "payments": ["V", "MA", "PYPL"],
    "tools": ["ADBE", "ADSK", "CRM"],
    "ua": ["META", "SNAP", "TTD"],
}

# SPOT — labels = content COGS; devices avoid AAPL/GOOG/AMZN rivals and label SONY dupe.
SPOT_MUSIC = {
    "labels": ["UMG", "SONY", "WMG"],
    "infra": ["EQIX", "AKAM", "NET"],
    "devices": ["005930.KS", "TSLA", "MSFT"],
    "payments": ["V", "MA", "PYPL"],
    "advertisers": ["KO", "PEP", "NKE"],
}

# SEA ecommerce (SE / Shopee) — regional nodes, not US PLD/EQIX dump.
SEA_ECOM = {
    "supply": ["005930.KS", "1810.HK", "2020.HK"],
    "fulfillment": ["0144.HK", "0316.HK", "1308.HK"],
    "payments": ["0005.HK", "V", "MA"],
    "traffic": ["GOOG", "META", "035420.KS"],
    "lastmile": ["1519.HK", "FDX", "UPS"],
}

# Korea ecommerce (CPNG).
KR_ECOM = {
    "supply": ["005930.KS", "2020.HK", "2331.HK"],
    "fulfillment": ["0144.HK", "0316.HK", "1308.HK"],
    "payments": ["0005.HK", "V", "MA"],
    "traffic": ["035420.KS", "035720.KS", "GOOG"],
    "lastmile": ["1519.HK", "FDX", "UPS"],
}

COMPETITORS: dict[str, list[list[str]]] = {
    "UBER": [
        ["LYFT", "共享出行對手", "Rideshare rival"],
        ["DASH", "即時配送對手", "Delivery rival"],
        ["GRAB", "全球出行／配送對手", "Global mobility / delivery rival"],
        ["AMZN", "即配／本地物流替代", "Delivery / local-logistics substitute"],
    ],
    "DASH": [
        ["UBER", "即時配送／出行對手", "Delivery / mobility rival"],
        ["LYFT", "本地出行替代", "Local mobility substitute"],
        ["AMZN", "即配／雜貨配送對手", "Delivery / grocery rival"],
        ["GRAB", "全球即配對手", "Global delivery rival"],
    ],
    "ABNB": [
        ["BKNG", "住宿預訂對手", "Lodging booking rival"],
        ["EXPE", "OTA 對手", "OTA rival"],
        ["MAR", "飯店直銷對手", "Hotel direct rival"],
        ["HLT", "飯店直銷對手", "Hotel direct rival"],
    ],
    "LYFT": [
        ["UBER", "共享出行對手", "Rideshare rival"],
        ["DASH", "本地出行／配送替代", "Local mobility / delivery substitute"],
        ["GRAB", "全球出行對手", "Global mobility rival"],
        ["AMZN", "本地物流替代", "Local logistics substitute"],
    ],
    "GRAB": [
        ["UBER", "出行／即配對手", "Mobility / delivery rival"],
        ["SE", "東南亞超級應用對手", "SEA super-app rival"],
        ["DASH", "即配對手", "Delivery rival"],
        ["3690.HK", "本地生活／即配參照", "Local-life / delivery reference"],
    ],
    "BKNG": [
        ["ABNB", "住宿預訂對手", "Lodging booking rival"],
        ["EXPE", "OTA 對手", "OTA rival"],
        ["MAR", "飯店直銷對手", "Hotel direct rival"],
        ["HLT", "飯店直銷對手", "Hotel direct rival"],
        ["TCOM", "全球 OTA 對手", "Global OTA rival"],
    ],
    "EXPE": [
        ["BKNG", "OTA 對手", "OTA rival"],
        ["ABNB", "住宿預訂對手", "Lodging booking rival"],
        ["RCL", "度假／郵輪替代", "Cruise / vacation substitute"],
        ["CCL", "度假／郵輪替代", "Cruise / vacation substitute"],
        ["TCOM", "全球 OTA 對手", "Global OTA rival"],
    ],
    "RBLX": [
        ["EA", "遊戲／互動娛樂對手", "Gaming / interactive entertainment rival"],
        ["TTWO", "遊戲／互動娛樂對手", "Gaming / interactive entertainment rival"],
        ["U", "遊戲工具／引擎對手", "Game tools / engine rival"],
        ["NTES", "遊戲／互動娛樂對手", "Gaming / interactive entertainment rival"],
        ["0700.HK", "遊戲／互動娛樂對手", "Gaming / interactive entertainment rival"],
    ],
    "TTWO": [
        ["EA", "遊戲發行對手", "Games publisher rival"],
        ["RBLX", "互動／UGC 遊戲對手", "Interactive / UGC games rival"],
        ["U", "遊戲工具／引擎對手", "Game tools / engine rival"],
        ["NTES", "遊戲／互動娛樂對手", "Gaming / interactive entertainment rival"],
        ["0700.HK", "遊戲／互動娛樂對手", "Gaming / interactive entertainment rival"],
    ],
    # Keep game peers on rival arc; ADBE/ADSK stay as external tools stages (not rivals).
    "U": [
        ["TTWO", "遊戲發行／工具對手", "Games publish / tools rival"],
        ["EA", "遊戲發行／工具對手", "Games publish / tools rival"],
        ["RBLX", "UGC／創作生態對手", "UGC / create-ecosystem rival"],
        ["NTES", "遊戲／互動娛樂對手", "Gaming / interactive entertainment rival"],
        ["0700.HK", "遊戲／互動娛樂對手", "Gaming / interactive entertainment rival"],
    ],
    # Music-service rivals only — not NFLX/DIS; not label majors on stages.
    "SPOT": [
        ["AAPL", "Apple Music 對手", "Apple Music rival"],
        ["AMZN", "Amazon Music 對手", "Amazon Music rival"],
        ["GOOG", "YouTube Music 對手", "YouTube Music rival"],
        ["TME", "全球音樂串流對手", "Global music streaming rival"],
    ],
    "SE": [
        ["PDD", "新興市場電商對手", "EM e-commerce rival"],
        ["BABA", "跨境／區域電商對手", "Cross-border / regional e-comm rival"],
        ["GRAB", "東南亞超級應用對手", "SEA super-app rival"],
        ["CPNG", "韓／亞電商對手", "Korea / Asia e-comm rival"],
        ["MELI", "新興市場電商對手", "EM e-commerce rival"],
    ],
    "CPNG": [
        ["SE", "亞洲電商對手", "Asia e-commerce rival"],
        ["BABA", "亞洲電商對手", "Asia e-commerce rival"],
        ["PDD", "價值電商對手", "Value e-commerce rival"],
        ["JD", "亞洲電商對手", "Asia e-commerce rival"],
        ["AMZN", "全球電商對手", "Global e-commerce rival"],
    ],
}

OVERRIDES: dict[str, dict[str, list[str]]] = {
    "UBER": dict(US_MOBILITY),
    "DASH": dict(US_MOBILITY),
    "LYFT": dict(US_LYFT),
    "GRAB": dict(SEA_SUPERAPP),
    "BKNG": dict(OTA_BKNG),
    "EXPE": dict(OTA_EXPE),
    "ABNB": dict(ABNB_LODGING),
    "RBLX": dict(RBLX_UGC),
    "TTWO": dict(TTWO_PUB),
    "U": dict(UNITY_ENGINE),
    "SPOT": dict(SPOT_MUSIC),
    "SE": dict(SEA_ECOM),
    "CPNG": dict(KR_ECOM),
}

# Hub-only stage label honesty (applied after rebuild).
HUB_STAGE_LABEL_OVERRIDES: dict[str, dict[str, dict[str, str]]] = {
    "LYFT": {
        "merchants": {
            "label_zh": "本地生活／需求側品牌",
            "label_en": "Local-life / demand-side brands",
            "summary_zh": "出行需求與品牌合作相關的餐飲／零售代表（非對手平台）。",
            "summary_en": "F&B/retail brands tied to ride demand and brand partnerships — not rival platforms.",
        },
    },
    "SPOT": {
        "labels": {
            "label_zh": "唱片公司／音樂授權（COGS）",
            "label_en": "Record labels / music licensing (COGS)",
            "summary_zh": "訂閱與廣告營收背後的外部音樂授權供給（三大唱片公司）。",
            "summary_en": "External music-license supply behind subscription/ad revenue (major labels).",
        },
    },
    "U": {
        "tools": {
            "label_zh": "周邊創作／設計工具",
            "label_en": "Adjacent create / design tools",
            "summary_zh": "與 Unity 引擎併用的外部 DCC／CRM 設計工具（對手引擎放對手弧）。",
            "summary_en": "External DCC/CRM design tools used with Unity — rival engines stay on the rival arc.",
        },
    },
}


def _trad_comp_rows(rows: list[list[str]]) -> list[list[str]]:
    out = []
    for ticker, zh, en in rows:
        out.append([ticker, traditionalize(zh), en])
    return out


def _assert_no_cross_stage_dupes(hub: str, stages: dict[str, list[str]]) -> None:
    seen: dict[str, str] = {}
    for sid, ticks in stages.items():
        for t in ticks:
            if t in seen:
                raise SystemExit(f"{hub}: cross-stage duplicate {t} in {seen[t]} and {sid}")
            seen[t] = sid


def _assert_stage_rival_disjoint(hub: str, stages: dict[str, list[str]], rivals: list[list[str]]) -> None:
    stage_set = {t for ticks in stages.values() for t in ticks}
    rival_set = {row[0] for row in rivals}
    inter = stage_set & rival_set
    if inter:
        raise SystemExit(f"{hub}: stage∩rival={sorted(inter)}")


def apply_seed_label_overrides() -> int:
    from scripts.build_supply_chain_mega_seeds import player_role  # noqa: E402

    cache = ROOT / "cache" / "supply-chain"
    n = 0
    for hub, stages in HUB_STAGE_LABEL_OVERRIDES.items():
        path = cache / f"{hub}.json"
        if not path.exists():
            continue
        seed = json.loads(path.read_text(encoding="utf-8"))
        for st in seed.get("stages") or []:
            patch = stages.get(st.get("id") or "")
            if not patch:
                continue
            st["label_zh"] = traditionalize(patch["label_zh"])
            st["label_en"] = patch["label_en"]
            st["summary_zh"] = traditionalize(patch["summary_zh"])
            st["summary_en"] = patch["summary_en"]
            for p in st.get("players") or []:
                rz, re = player_role(
                    st["label_zh"],
                    st["label_en"],
                    p.get("name_zh") or "",
                    p.get("name_en") or "",
                )
                p["role_zh"] = rz
                p["role_en"] = re
        path.write_text(json.dumps(seed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        n += 1
    return n


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--patch-seeds",
        action="store_true",
        help="Only apply HUB_STAGE_LABEL_OVERRIDES to rebuilt cache seeds",
    )
    args = parser.parse_args()
    if args.patch_seeds:
        n = apply_seed_label_overrides()
        print(f"Patched stage labels on {n} Batch B hubs")
        return 0

    for hub in BATCH_B:
        _assert_no_cross_stage_dupes(hub, OVERRIDES[hub])
        _assert_stage_rival_disjoint(hub, OVERRIDES[hub], COMPETITORS[hub])

    entities = json.loads(ENT_PATH.read_text(encoding="utf-8"))
    competitors = json.loads(COMP_PATH.read_text(encoding="utf-8"))
    overrides = json.loads(OVERRIDE_PATH.read_text(encoding="utf-8"))
    players = json.loads(PLAYERS_PATH.read_text(encoding="utf-8"))

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

    players["rideshare-v1"] = {sid: list(ticks) for sid, ticks in US_MOBILITY.items()}
    players["sea-superapp-v1"] = {sid: list(ticks) for sid, ticks in SEA_SUPERAPP.items()}
    players["ota-marketplace-v1"] = {sid: list(ticks) for sid, ticks in OTA_BKNG.items()}
    players["short-term-lodging-v1"] = {sid: list(ticks) for sid, ticks in ABNB_LODGING.items()}
    players["games-ugc-platform-v1"] = {sid: list(ticks) for sid, ticks in RBLX_UGC.items()}
    players["games-publisher-v1"] = {sid: list(ticks) for sid, ticks in TTWO_PUB.items()}
    players["game-engine-v1"] = {sid: list(ticks) for sid, ticks in UNITY_ENGINE.items()}
    players["music-streaming-v1"] = {sid: list(ticks) for sid, ticks in SPOT_MUSIC.items()}

    ENT_PATH.write_text(json.dumps(entities, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    COMP_PATH.write_text(json.dumps(competitors, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    OVERRIDE_PATH.write_text(json.dumps(overrides, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    PLAYERS_PATH.write_text(json.dumps(players, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"Batch B prep: entities+={len(ENTITIES)}, competitors hubs={len(COMPETITORS)}, "
        f"overrides hubs={len(OVERRIDES)}; models rideshare/sea/ota/lodging/games/music"
    )
    missing = [t for t in BATCH_B if t not in COMPETITORS or t not in OVERRIDES]
    if missing:
        raise SystemExit(f"Missing Batch B hub coverage: {missing}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
