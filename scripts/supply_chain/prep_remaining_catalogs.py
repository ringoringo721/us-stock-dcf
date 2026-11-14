#!/usr/bin/env python3
"""Prep sc_entities / sc_competitors for remaining US listings (mcap < $50B).

Reuses mid-mega peer groups + entity helpers. For hubs not in curated groups,
assigns same-(sector, industry) universe rivals (true product/market peers by
industry screen — not FMP stock-peers as a value chain). No live FMP calls.
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path

from scripts.supply_chain.prep_mid_mega_catalogs import (  # noqa: E402
    COMP_PATH,
    CURATED_NAME_EN,
    CURATED_NAME_ZH,
    DATA,
    ENT_PATH,
    GROUP_BY_ID,
    HUB_TO_GROUPS,
    PEER_GROUPS,
    UNIVERSE_PATH,
    ZH_NAMES_PATH,
    ensure_entity,
    load_json,
    load_stock_names_zh,
    rivals_for,
    write_json,
)

ROOT = Path(__file__).resolve().parents[2]

# Map (sector, industry) → preferred curated peer-group id when hub is absent
# from HUB_TO_GROUPS. First match wins quality over raw same-industry padding.
INDUSTRY_TO_GROUP: dict[tuple[str, str], str] = {
    ("Utilities", "Regulated Electric"): "util-reg",
    ("Utilities", "Diversified Utilities"): "util-div",
    ("Utilities", "Independent Power Producers"): "util-ipp",
    ("Utilities", "Regulated Gas"): "util-reg",
    ("Utilities", "Renewable Utilities"): "util-ipp",
    ("Utilities", "Regulated Water"): "util-div",
    ("Financial Services", "Banks - Regional"): "bank-us-reg",
    ("Financial Services", "Banks - Diversified"): "bank-us-reg",
    ("Financial Services", "Banks"): "bank-us-reg",
    ("Financial Services", "Asset Management"): "alt-am",
    ("Financial Services", "Financial - Capital Markets"): "exchanges",
    ("Financial Services", "Investment - Banking & Investment Services"): "brokerage",
    ("Financial Services", "Financial - Data & Stock Exchanges"): "exchanges",
    ("Financial Services", "Financial - Credit Services"): "payments-credit",
    ("Financial Services", "Insurance - Property & Casualty"): "ins-pc",
    ("Financial Services", "Insurance - Life"): "ins-life",
    ("Financial Services", "Insurance - Brokers"): "ins-broker",
    ("Financial Services", "Insurance - Specialty"): "ins-pc",
    ("Financial Services", "Insurance - Reinsurance"): "ins-pc",
    ("Financial Services", "Insurance - Diversified"): "ins-pc",
    ("Healthcare", "Biotechnology"): "pharma-big",
    ("Healthcare", "Drug Manufacturers - Specialty & Generic"): "pharma-big",
    ("Healthcare", "Drug Manufacturers - General"): "pharma-big",
    ("Healthcare", "Medical - Pharmaceuticals"): "pharma-big",
    ("Healthcare", "Medical - Devices"): "medtech-dev",
    ("Healthcare", "Medical - Instruments & Supplies"): "medtech-sup",
    ("Healthcare", "Medical - Diagnostics & Research"): "medtech-dx",
    ("Healthcare", "Medical - Healthcare Plans"): "managed-care",
    ("Healthcare", "Medical - Care Facilities"): "managed-care",
    ("Healthcare", "Medical - Distribution"): "drug-dist",
    ("Healthcare", "Medical - Healthcare Information Services"): "saas-data",
    # Application software: prefer same-industry mcap peers (CRM/collab/vertical mix).
    # Do not force all apps into data-cloud (SNOW/DDOG) — that over-generalizes.
    ("Technology", "Software - Infrastructure"): "saas-sec",
    ("Technology", "Software - Services"): "saas-data",
    # Semiconductors: default fabless/analog; equipment names overridden via EXTRA_GROUPS.
    ("Technology", "Information Technology Services"): "it-svc",
    ("Technology", "Hardware, Equipment & Parts"): "hw-server",
    ("Technology", "Computer Hardware"): "hw-server",
    ("Technology", "Communication Equipment"): "hw-radio",
    ("Technology", "Consumer Electronics"): "hw-gps",
    ("Technology", "Electronic Gaming & Multimedia"): "gaming",
    ("Technology", "Technology Distributors"): "hw-server",
    ("Energy", "Oil & Gas Exploration & Production"): "energy-e&p",
    ("Energy", "Oil & Gas Midstream"): "energy-mid",
    ("Energy", "Oil & Gas Refining & Marketing"): "energy-refine",
    ("Energy", "Oil & Gas Integrated"): "energy-int",
    ("Energy", "Oil & Gas Equipment & Services"): "energy-ofs",
    ("Energy", "Oil & Gas Drilling"): "energy-ofs",
    ("Industrials", "Aerospace & Defense"): "aero-prime",
    ("Industrials", "Industrial - Machinery"): "ind-mach",
    ("Industrials", "Electrical Equipment & Parts"): "ind-elec",
    ("Industrials", "Engineering & Construction"): "ind-epc",
    ("Industrials", "Integrated Freight & Logistics"): "ind-logistics",
    ("Industrials", "Industrial - Distribution"): "ind-dist",
    ("Industrials", "Rental & Leasing Services"): "ind-rental",
    ("Industrials", "Waste Management"): "ind-waste",
    ("Industrials", "Railroads"): "ind-rail",
    ("Industrials", "Airlines, Airports & Air Services"): "disc-air",
    ("Industrials", "Specialty Business Services"): "ind-svc",
    ("Industrials", "Trucking"): "ind-logistics",
    ("Industrials", "Marine Shipping"): "ind-logistics",
    ("Basic Materials", "Gold"): "materials-gold",
    ("Basic Materials", "Other Precious Metals"): "materials-gold",
    ("Basic Materials", "Silver"): "materials-gold",
    ("Basic Materials", "Copper"): "materials-cu",
    ("Basic Materials", "Steel"): "materials-steel",
    ("Basic Materials", "Construction Materials"): "materials-build",
    ("Basic Materials", "Chemicals - Specialty"): "materials-chem",
    ("Basic Materials", "Chemicals"): "materials-chem",
    ("Basic Materials", "Agricultural Inputs"): "materials-chem",
    ("Basic Materials", "Industrial Materials"): "materials-mining",
    ("Consumer Defensive", "Beverages - Non-Alcoholic"): "staples-bev",
    ("Consumer Defensive", "Beverages - Alcoholic"): "staples-spirits",
    ("Consumer Defensive", "Packaged Foods"): "staples-snack",
    ("Consumer Defensive", "Household & Personal Products"): "staples-hpc",
    ("Consumer Defensive", "Discount Stores"): "ecom-disc",
    ("Consumer Defensive", "Grocery Stores"): "ecom-disc",
    ("Consumer Defensive", "Food Distribution"): "staples-snack",
    ("Consumer Cyclical", "Auto - Manufacturers"): "auto-oem",
    ("Consumer Cyclical", "Auto - Parts"): "ecom-auto-parts",
    ("Consumer Cyclical", "Auto - Dealerships"): "disc-auto-deal",
    ("Consumer Cyclical", "Apparel - Footwear & Accessories"): "disc-apparel",
    ("Consumer Cyclical", "Apparel - Retail"): "apparel-off",
    ("Consumer Cyclical", "Apparel - Manufacturers"): "disc-apparel",
    ("Consumer Cyclical", "Specialty Retail"): "ecom-disc",
    ("Consumer Cyclical", "Home Improvement"): "ecom-disc",
    ("Consumer Cyclical", "Restaurants"): "disc-hotel",
    ("Consumer Cyclical", "Travel Lodging"): "disc-hotel",
    ("Consumer Cyclical", "Travel Services"): "disc-delivery",
    ("Consumer Cyclical", "Gambling, Resorts & Casinos"): "disc-hotel",
    ("Communication Services", "Telecommunications Services"): "telecom-cable",
    ("Communication Services", "Entertainment"): "gaming",
    ("Communication Services", "Internet Content & Information"): "saas-edge",
    ("Communication Services", "Advertising Agencies"): "saas-edge",
    ("Communication Services", "Publishing"): "ind-info",
    ("Real Estate", "REIT - Specialty"): "reit-tower",
    ("Real Estate", "REIT - Industrial"): "reit-dc",
    ("Real Estate", "REIT - Retail"): "reit-retail",
    ("Real Estate", "REIT - Residential"): "reit-storage",
    ("Real Estate", "REIT - Healthcare Facilities"): "reit-storage",
    ("Real Estate", "REIT - Diversified"): "reit-retail",
    ("Real Estate", "REIT - Office"): "reit-dc",
    ("Real Estate", "REIT - Hotel & Motel"): "reit-retail",
    ("Real Estate", "Real Estate - Services"): "reit-retail",
}

# Fallback basis copy when using same-industry universe peers.
INDUSTRY_BASIS: dict[tuple[str, str], tuple[str, str]] = {
    ("Healthcare", "Biotechnology"): ("生物科技／臨床管線對手", "Biotech / pipeline rival"),
    ("Financial Services", "Banks - Regional"): ("美國區域銀行對手", "US regional bank rival"),
    ("Technology", "Software - Application"): ("應用軟體對手", "Application software rival"),
    ("Technology", "Software - Infrastructure"): ("軟體基礎設施對手", "Software infrastructure rival"),
    ("Technology", "Semiconductors"): ("半導體產品對手", "Semiconductor product rival"),
    ("Real Estate", "REIT - Residential"): ("住宅 REIT 對手", "Residential REIT rival"),
    ("Utilities", "Regulated Gas"): ("受規管天然氣對手", "Regulated gas utility rival"),
    ("Industrials", "Aerospace & Defense"): ("航太防務對手", "Aerospace & defense rival"),
    ("Basic Materials", "Gold"): ("金礦對手", "Gold mining rival"),
    ("Energy", "Oil & Gas Exploration & Production"): ("上游勘探開發對手", "E&P rival"),
    ("Consumer Cyclical", "Gambling, Resorts & Casinos"): ("博弈／渡假村對手", "Gaming / resort rival"),
    ("Consumer Defensive", "Packaged Foods"): ("包裝食品對手", "Packaged-food rival"),
}


def industry_basis(sector: str, industry: str) -> tuple[str, str]:
    if (sector, industry) in INDUSTRY_BASIS:
        return INDUSTRY_BASIS[(sector, industry)]
    label = industry or sector or "industry"
    return (f"{label}產品／市場對手", f"{label} product/market rival")


def rivals_from_group(ticker: str, gid: str, n: int = 5) -> list[tuple[str, str, str]]:
    members, zh, en = GROUP_BY_ID[gid]
    out: list[tuple[str, str, str]] = []
    for peer in members:
        if peer == ticker:
            continue
        out.append((peer, zh, en))
        if len(out) >= n:
            break
    return out


def rivals_same_industry(
    ticker: str,
    sector: str,
    industry: str,
    by_industry: dict[tuple[str, str], list[dict]],
    n: int = 5,
) -> list[tuple[str, str, str]]:
    rows = list(by_industry.get((sector, industry)) or [])
    # Prefer larger peers, then nearby mcap; exclude self.
    self_row = next((r for r in rows if r["ticker"] == ticker), None)
    self_mcap = float((self_row or {}).get("marketCap") or 0)
    peers = [r for r in rows if r["ticker"] != ticker]
    peers.sort(
        key=lambda r: (
            abs(float(r.get("marketCap") or 0) - self_mcap),
            -float(r.get("marketCap") or 0),
        )
    )
    # Prefer higher-mcap names first when distance ties poorly; re-rank by mcap desc for quality.
    peers_mcap = sorted(peers, key=lambda r: -float(r.get("marketCap") or 0))
    # Interleave: top mcap + mcap-proximate for diversity within industry.
    ordered: list[dict] = []
    seen = set()
    for pool in (peers_mcap, peers):
        for r in pool:
            t = r["ticker"]
            if t in seen:
                continue
            seen.add(t)
            ordered.append(r)
            if len(ordered) >= n + 3:
                break
        if len(ordered) >= n + 3:
            break
    zh, en = industry_basis(sector, industry)
    return [(r["ticker"], zh, en) for r in ordered[:n]]


def pad_rivals(
    ticker: str,
    sector: str,
    industry: str,
    partial: list[tuple[str, str, str]],
    by_industry: dict[tuple[str, str], list[dict]],
    n: int = 5,
) -> list[tuple[str, str, str]]:
    used = {ticker} | {p for p, _, _ in partial}
    out = list(partial)
    for peer, zh, en in rivals_same_industry(ticker, sector, industry, by_industry, n=n + 6):
        if peer in used:
            continue
        out.append((peer, zh, en))
        used.add(peer)
        if len(out) >= n:
            break
    # Last resort: same sector any industry
    if len(out) < 4:
        sector_peers: list[dict] = []
        for (sec, _ind), rows in by_industry.items():
            if sec == sector:
                sector_peers.extend(rows)
        sector_peers = sorted(sector_peers, key=lambda r: -float(r.get("marketCap") or 0))
        zh, en = industry_basis(sector, industry)
        for r in sector_peers:
            t = r["ticker"]
            if t in used:
                continue
            out.append((t, zh, en))
            used.add(t)
            if len(out) >= n:
                break
    return out[:n]


def resolve_rivals(
    ticker: str,
    row: dict,
    by_industry: dict[tuple[str, str], list[dict]],
    n: int = 5,
) -> list[tuple[str, str, str]]:
    sector = row.get("sector") or ""
    industry = row.get("industry") or ""

    # 0) Explicit specialty force (payments, semi-equip, vertical SaaS, mining).
    forced = TICKER_GROUP_FORCE.get(ticker)
    if forced and forced in GROUP_BY_ID:
        riv = rivals_from_group(ticker, forced, n=n)
        if len(riv) >= 4:
            return riv[:n]
        riv = pad_rivals(ticker, sector, industry, riv, by_industry, n=n)
        if len(riv) >= 4:
            return riv[:n]

    # 1) Curated peer-group membership (mid-mega / mega catalogs).
    riv = rivals_for(ticker, n=n)
    if len(riv) >= 4:
        return riv[:n]

    # 2) Industry → curated group (hub may not be a member yet).
    gid = INDUSTRY_TO_GROUP.get((sector, industry))
    if gid and gid in GROUP_BY_ID:
        riv = rivals_from_group(ticker, gid, n=n)
        if len(riv) >= 4:
            return riv[:n]
        riv = pad_rivals(ticker, sector, industry, riv, by_industry, n=n)
        if len(riv) >= 4:
            return riv[:n]

    # 3) Same-industry universe peers.
    riv = rivals_same_industry(ticker, sector, industry, by_industry, n=n)
    riv = pad_rivals(ticker, sector, industry, riv, by_industry, n=n)
    return riv[:n]


# Extra peer groups for remaining universe (appended so HUB_TO_GROUPS picks them up
# when we register below). Keep true product/market rivals only.
EXTRA_PEER_GROUPS: list[tuple[str, list[str], str, str]] = [
    (
        "payments-credit",
        ["V", "MA", "AXP", "PYPL", "GPN", "AFRM", "COF", "SOFI", "XYZ", "TOST"],
        "支付／消費金融對手",
        "Payments / consumer-finance rival",
    ),
    (
        "semi-equip-mat",
        ["AMAT", "LRCX", "KLAC", "ENTG", "NVMI", "ONTO", "TER", "KEYS"],
        "半導體設備／製程材料對手",
        "Semi equipment / process-materials rival",
    ),
    (
        "materials-mining",
        ["BHP", "RIO", "VALE", "FCX", "SCCO", "TECK", "NEM", "B"],
        "大宗礦業對手",
        "Bulk mining rival",
    ),
    (
        "saas-crm-collab",
        ["CRM", "NOW", "WDAY", "TEAM", "HUBS", "ZM", "MSFT", "ORCL"],
        "企業協作／CRM 軟體對手",
        "Enterprise collab / CRM software rival",
    ),
    (
        "saas-life-sci",
        ["VEEV", "IQV", "TMO", "DHR", "CRM", "NOW", "MSFT"],
        "生命科學雲／臨床軟體對手",
        "Life-science cloud / clinical software rival",
    ),
]

# Register extra groups into mid-mega tables before rivals_for / INDUSTRY_TO_GROUP use.
for _gid, _members, _zh, _en in EXTRA_PEER_GROUPS:
    PEER_GROUPS.append((_gid, _members, _zh, _en))
    GROUP_BY_ID[_gid] = (_members, _zh, _en)
    for _t in _members:
        # Prefer these specialty groups: insert at front so rivals_for primary pick is correct.
        HUB_TO_GROUPS.setdefault(_t, [])
        if _gid not in HUB_TO_GROUPS[_t]:
            HUB_TO_GROUPS[_t].insert(0, _gid)

# Explicit hub → group for specialty names that would otherwise inherit a weak industry default.
TICKER_GROUP_FORCE: dict[str, str] = {
    "PYPL": "payments-credit",
    "GPN": "payments-credit",
    "AFRM": "payments-credit",
    "SOFI": "payments-credit",
    "XYZ": "payments-credit",
    "TOST": "payments-credit",
    "ENTG": "semi-equip-mat",
    "NVMI": "semi-equip-mat",
    "ONTO": "semi-equip-mat",
    "VEEV": "saas-life-sci",
    "HUBS": "saas-crm-collab",
    "ZM": "saas-crm-collab",
    "TEAM": "saas-crm-collab",
    "WDAY": "saas-crm-collab",
    "VALE": "materials-mining",
    "TECK": "materials-mining",
}


# Extra curated brands for remaining hubs / common peers (Bugbot lessons).
EXTRA_NAME_EN: dict[str, str] = {
    "CVE": "Cenovus",
    "KDP": "Keurig Dr Pepper",
    "F": "Ford",
    "TEVA": "Teva",
    "VALE": "Vale",
    "PYPL": "PayPal",
    "VEEV": "Veeva",
    "FNV": "Franco-Nevada",
    "LITE": "Lumentum",
    "RIVN": "Rivian",
    "DD": "DuPont",
    "CDW": "CDW",
    "LYB": "LyondellBasell",
    "ENTG": "Entegris",
    "EXE": "Expand Energy",
    "BCH": "Banco de Chile",
    "FTV": "Fortive",
    "BG": "Bunge",
    "SNA": "Snap-on",
    "HUBS": "HubSpot",
    "SCI": "Service Corporation",
    "PCVX": "Vaxcyte",
    "NVMI": "Nova",
    "TTC": "Toro",
    "UHAL": "U-Haul",
    "BPOP": "Popular",
    "BWA": "BorgWarner",
    "FRT": "Federal Realty",
    "BCE": "BCE",
    "ZBH": "Zimmer Biomet",
    "SBAC": "SBA Communications",
    "A": "Agilent",
    "LCID": "Lucid",
    "NIO": "NIO",
    "XPEV": "XPeng",
    "LI": "Li Auto",
}

EXTRA_NAME_ZH: dict[str, str] = {
    "CVE": "Cenovus",
    "KDP": "Keurig Dr Pepper",
    "F": "福特",
    "TEVA": "梯瓦藥廠",
    "VALE": "淡水河谷",
    "PYPL": "PayPal",
    "VEEV": "Veeva",
    "FNV": "Franco-Nevada",
    "RIVN": "Rivian",
    "DD": "杜邦",
    "LYB": "LyondellBasell",
    "ENTG": "Entegris",
    "HUBS": "HubSpot",
    "ZBH": "Zimmer Biomet",
    "SBAC": "SBA Communications",
    "A": "安捷倫",
    "EQIX": "Equinix",
    "IQV": "艾昆緯",
    "CDNS": "益華電腦",
    "CI": "信諾",
    "TDG": "環球透博",
    "BHP": "必和必拓",
    "IBM": "IBM",
}


def main() -> int:
    # Merge extra curated names into mid-mega maps for ensure_entity paths that read them.
    CURATED_NAME_EN.update(EXTRA_NAME_EN)
    CURATED_NAME_ZH.update(EXTRA_NAME_ZH)

    entities = load_json(ENT_PATH)
    competitors = load_json(COMP_PATH)
    universe = load_json(UNIVERSE_PATH)
    stocks = universe["stocks"]
    uni = {r["ticker"]: r for r in stocks}
    stock_zh = load_stock_names_zh()
    file_zh = load_json(ZH_NAMES_PATH).get("names") or {}

    seeded = {
        p.stem
        for p in (ROOT / "cache" / "supply-chain").glob("*.json")
        if not p.name.endswith(".quotes.json") and not p.name.startswith("_")
    }
    # Remaining batch = mcap < $50B (after mega/mid-mega). Refresh competitor catalogs
    # even when seed JSON already exists so quality fixes can re-run before rebuild.
    remaining = [r for r in stocks if float(r.get("marketCap") or 0) < 50e9]
    remaining.sort(key=lambda r: -float(r.get("marketCap") or 0))
    _ = seeded  # membership still useful for summaries / future skip modes

    by_industry: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for r in stocks:
        by_industry[(r.get("sector") or "", r.get("industry") or "")].append(r)

    missing_rivals = []
    added_comp = 0
    for row in remaining:
        t = row["ticker"]
        riv = resolve_rivals(t, row, by_industry, n=5)
        if len(riv) < 4:
            missing_rivals.append((t, len(riv), [x[0] for x in riv], row.get("industry")))
            continue
        competitors[t] = [[a, b, c] for a, b, c in riv]
        added_comp += 1
        ensure_entity(entities, t, uni, stock_zh, file_zh)
        for peer, _, _ in riv:
            ensure_entity(entities, peer, uni, stock_zh, file_zh)

    # Force Bugbot-critical entity rows (never regress collisions).
    entities["CI"] = {"name_en": "Cigna", "name_zh": "信諾", "exchange": "NYSE"}
    entities["TDG"] = {"name_en": "TransDigm", "name_zh": "環球透博", "exchange": "NYSE"}
    entities["IBM"] = {"name_en": "IBM", "name_zh": "IBM", "exchange": "NYSE"}
    entities["EQIX"] = {"name_en": "Equinix", "name_zh": "Equinix", "exchange": "NASDAQ"}
    entities["IQV"] = {"name_en": "IQVIA", "name_zh": "艾昆緯", "exchange": "NYSE"}
    entities["CDNS"] = {"name_en": "Cadence", "name_zh": "益華電腦", "exchange": "NASDAQ"}
    entities["BHP"] = {"name_en": "BHP", "name_zh": "必和必拓", "exchange": "NYSE"}
    entities["ANSS"] = {"name_en": "Ansys", "name_zh": "安西斯", "exchange": "NASDAQ"}
    entities["PTC"] = {"name_en": "PTC", "name_zh": "參數科技", "exchange": "NASDAQ"}
    entities["ADSK"] = {"name_en": "Autodesk", "name_zh": "歐特克", "exchange": "NASDAQ"}
    entities["LIN"] = {"name_en": "Linde", "name_zh": "林德集團", "exchange": "NASDAQ"}
    entities["F"] = {"name_en": "Ford", "name_zh": "福特", "exchange": "NYSE"}
    entities["A"] = {"name_en": "Agilent", "name_zh": "安捷倫", "exchange": "NYSE"}
    entities["VALE"] = {"name_en": "Vale", "name_zh": "淡水河谷", "exchange": "NYSE"}

    for t, name_en in EXTRA_NAME_EN.items():
        if t in uni or t in entities:
            ensure_entity(entities, t, uni, stock_zh, file_zh)
            if t in EXTRA_NAME_EN:
                entities[t]["name_en"] = EXTRA_NAME_EN[t]
            if t in EXTRA_NAME_ZH:
                entities[t]["name_zh"] = EXTRA_NAME_ZH[t]

    write_json(ENT_PATH, entities)
    write_json(COMP_PATH, competitors)

    # Band counts for PR planning
    bands = {"20-50B": 0, "10-20B": 0, "<10B": 0}
    for r in remaining:
        mc = float(r.get("marketCap") or 0)
        if mc >= 20e9:
            bands["20-50B"] += 1
        elif mc >= 10e9:
            bands["10-20B"] += 1
        else:
            bands["<10B"] += 1

    summary = {
        "remainingTotal": len(remaining),
        "competitorsWritten": added_comp,
        "missingRivals": missing_rivals,
        "entityCount": len(entities),
        "bands": bands,
        "tickers": [r["ticker"] for r in remaining],
    }
    write_json(DATA / "_remaining_prep_summary.json", summary)
    print(
        json.dumps(
            {
                k: summary[k]
                for k in (
                    "remainingTotal",
                    "competitorsWritten",
                    "missingRivals",
                    "entityCount",
                    "bands",
                )
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 1 if missing_rivals else 0


if __name__ == "__main__":
    raise SystemExit(main())
