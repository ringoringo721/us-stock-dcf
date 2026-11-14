#!/usr/bin/env python3
"""Prep sc_entities / sc_competitors for remaining US listings (mcap < $50B).

Reuses mid-mega peer groups + entity helpers. Prefer same-(sector, industry)
universe rivals over adjacent curated templates. Specialty ticker overrides for
known Bugbot cases. Never clobber curated CJK name_zh. No live FMP calls.
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
    short_brand_en,
    write_json,
)

ROOT = Path(__file__).resolve().parents[2]

# Only map industries to curated groups when the group is a *true* product/market
# peer set for that industry. Adjacent templates (hotels for restaurants, CDN for
# search, REIT retail for brokerages, etc.) are intentionally omitted → same-industry.
INDUSTRY_TO_GROUP: dict[tuple[str, str], str] = {
    ("Utilities", "Regulated Electric"): "util-reg",
    ("Utilities", "Diversified Utilities"): "util-div",
    ("Utilities", "Independent Power Producers"): "util-ipp",
    ("Utilities", "Regulated Gas"): "util-gas",
    ("Utilities", "Renewable Utilities"): "util-ipp",
    ("Utilities", "Regulated Water"): "util-water",
    ("Financial Services", "Banks - Regional"): "bank-us-reg",
    ("Financial Services", "Banks - Diversified"): "bank-us-reg",
    ("Financial Services", "Banks"): "bank-us-reg",
    ("Financial Services", "Asset Management"): "fund-am",
    ("Financial Services", "Financial - Capital Markets"): "exchanges",
    ("Financial Services", "Investment - Banking & Investment Services"): "custody-am",
    ("Financial Services", "Financial - Data & Stock Exchanges"): "exchanges",
    ("Financial Services", "Financial - Credit Services"): "payments-credit",
    ("Financial Services", "Insurance - Property & Casualty"): "ins-pc",
    ("Financial Services", "Insurance - Life"): "ins-life",
    ("Financial Services", "Insurance - Brokers"): "ins-broker",
    ("Financial Services", "Insurance - Specialty"): "ins-pc",
    ("Financial Services", "Insurance - Reinsurance"): "ins-pc",
    ("Financial Services", "Insurance - Diversified"): "ins-life",
    ("Healthcare", "Biotechnology"): "pharma-big",
    ("Healthcare", "Drug Manufacturers - Specialty & Generic"): "pharma-generic",
    ("Healthcare", "Drug Manufacturers - General"): "pharma-big",
    ("Healthcare", "Medical - Pharmaceuticals"): "pharma-big",
    ("Healthcare", "Medical - Devices"): "medtech-dev",
    ("Healthcare", "Medical - Instruments & Supplies"): "medtech-sup",
    ("Healthcare", "Medical - Diagnostics & Research"): "medtech-dx",
    ("Healthcare", "Medical - Healthcare Plans"): "managed-care",
    # Care facilities / hospitals: same-industry peers (not managed-care insurers).
    ("Healthcare", "Medical - Distribution"): "drug-dist",
    ("Technology", "Software - Infrastructure"): "saas-sec",
    ("Technology", "Information Technology Services"): "it-svc",
    ("Technology", "Electronic Gaming & Multimedia"): "gaming",
    ("Technology", "Technology Distributors"): "tech-dist",
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
    # Rental & Leasing: same-industry (aircraft lessors ≠ URI/CAT construction rental).
    ("Industrials", "Waste Management"): "ind-waste",
    ("Industrials", "Railroads"): "ind-rail",
    ("Industrials", "Airlines, Airports & Air Services"): "disc-air",
    ("Industrials", "Specialty Business Services"): "ind-svc",
    ("Industrials", "Trucking"): "ind-logistics",
    ("Industrials", "Marine Shipping"): "ind-logistics",
    ("Industrials", "Security & Protection Services"): "ind-security",
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
    ("Basic Materials", "Aluminum"): "materials-aluminum",
    ("Consumer Defensive", "Beverages - Non-Alcoholic"): "staples-bev",
    ("Consumer Defensive", "Beverages - Alcoholic"): "staples-beer",
    ("Consumer Defensive", "Packaged Foods"): "staples-snack",
    ("Consumer Defensive", "Household & Personal Products"): "staples-hpc",
    ("Consumer Defensive", "Discount Stores"): "ecom-disc",
    ("Consumer Defensive", "Grocery Stores"): "ecom-disc",
    # Food Distribution / Agricultural Farm: same-industry peers.
    ("Consumer Cyclical", "Auto - Manufacturers"): "auto-oem",
    # Auto - Parts: same-industry Tier-1 (not ORLY aftermarket).
    ("Consumer Cyclical", "Auto - Dealerships"): "disc-auto-deal",
    ("Consumer Cyclical", "Apparel - Footwear & Accessories"): "disc-apparel",
    ("Consumer Cyclical", "Apparel - Retail"): "apparel-off",
    ("Consumer Cyclical", "Apparel - Manufacturers"): "disc-apparel",
    ("Consumer Cyclical", "Specialty Retail"): "ecom-disc",
    ("Consumer Cyclical", "Home Improvement"): "ecom-disc",
    # Restaurants / casinos / travel: same-industry (not hotels/delivery).
    ("Consumer Cyclical", "Travel Lodging"): "disc-hotel",
    ("Communication Services", "Telecommunications Services"): "telecom-cable",
    # Entertainment / Internet / Ad agencies: same-industry (not gaming/CDN/saas-edge).
    ("Real Estate", "REIT - Specialty"): "reit-tower",
    ("Real Estate", "REIT - Industrial"): "reit-dc",
    ("Real Estate", "REIT - Retail"): "reit-retail",
    ("Real Estate", "REIT - Residential"): "reit-residential",
    ("Real Estate", "REIT - Healthcare Facilities"): "reit-healthcare",
    ("Real Estate", "REIT - Diversified"): "reit-retail",
    ("Real Estate", "REIT - Office"): "reit-office",
    ("Real Estate", "REIT - Hotel & Motel"): "reit-hotel",
    ("Real Estate", "REIT - Mortgage"): "reit-mreit",
    # Real Estate - Services (brokerages): same-industry (not retail REIT).
}

INDUSTRY_BASIS: dict[tuple[str, str], tuple[str, str]] = {
    ("Healthcare", "Biotechnology"): ("生物科技／臨床管線對手", "Biotech / pipeline rival"),
    ("Financial Services", "Banks - Regional"): ("區域銀行對手", "Regional bank rival"),
    ("Technology", "Software - Application"): ("應用軟體對手", "Application software rival"),
    ("Technology", "Software - Infrastructure"): ("軟體基礎設施對手", "Software infrastructure rival"),
    ("Technology", "Semiconductors"): ("半導體產品對手", "Semiconductor product rival"),
    ("Technology", "Technology Distributors"): ("電子零件通路對手", "Electronics distributor rival"),
    ("Real Estate", "REIT - Residential"): ("住宅 REIT 對手", "Residential REIT rival"),
    ("Real Estate", "REIT - Healthcare Facilities"): ("醫療 REIT 對手", "Healthcare REIT rival"),
    ("Real Estate", "REIT - Office"): ("辦公／生科園區 REIT 對手", "Office / life-science REIT rival"),
    ("Real Estate", "REIT - Mortgage"): ("抵押 REIT 對手", "Mortgage REIT rival"),
    ("Real Estate", "Real Estate - Services"): ("房地產服務／經紀對手", "Real-estate services / brokerage rival"),
    ("Utilities", "Regulated Gas"): ("受規管天然氣對手", "Regulated gas utility rival"),
    ("Utilities", "Regulated Water"): ("受規管水務對手", "Regulated water utility rival"),
    ("Industrials", "Aerospace & Defense"): ("航太防務對手", "Aerospace & defense rival"),
    ("Industrials", "Rental & Leasing Services"): ("租賃服務對手", "Rental / leasing rival"),
    ("Industrials", "Airlines, Airports & Air Services"): ("航空／機場服務對手", "Airline / airport-services rival"),
    ("Industrials", "Industrial - Distribution"): ("工業通路對手", "Industrial distribution rival"),
    ("Industrials", "Security & Protection Services"): ("安防／防護服務對手", "Security / protection-services rival"),
    ("Basic Materials", "Gold"): ("金礦對手", "Gold mining rival"),
    ("Basic Materials", "Aluminum"): ("鋁業對手", "Aluminum rival"),
    ("Energy", "Oil & Gas Exploration & Production"): ("上游勘探開發對手", "E&P rival"),
    ("Consumer Cyclical", "Gambling, Resorts & Casinos"): ("博弈／渡假村對手", "Gaming / resort rival"),
    ("Consumer Cyclical", "Restaurants"): ("餐飲對手", "Restaurant rival"),
    ("Consumer Cyclical", "Auto - Parts"): ("汽車零組件／Tier-1 對手", "Auto parts / Tier-1 rival"),
    ("Consumer Cyclical", "Leisure"): ("休閒用品對手", "Leisure products rival"),
    ("Consumer Defensive", "Packaged Foods"): ("包裝食品對手", "Packaged-food rival"),
    ("Consumer Defensive", "Agricultural Farm Products"): ("農產品／大宗貿易對手", "Agribusiness / farm-products rival"),
    ("Consumer Defensive", "Food Distribution"): ("食品通路對手", "Food distribution rival"),
    ("Consumer Defensive", "Beverages - Alcoholic"): ("啤酒／酒精飲料對手", "Beer / alcoholic-beverage rival"),
    ("Communication Services", "Internet Content & Information"): ("網路內容／搜尋對手", "Internet content / search rival"),
    ("Communication Services", "Entertainment"): ("娛樂／串流對手", "Entertainment / streaming rival"),
    ("Communication Services", "Advertising Agencies"): ("廣告代理對手", "Advertising-agency rival"),
    ("Healthcare", "Medical - Care Facilities"): ("醫療院所對手", "Care-facilities rival"),
    ("Healthcare", "Medical - Specialties"): ("眼科／專科醫材對手", "Specialty medtech rival"),
}


def industry_basis(sector: str, industry: str) -> tuple[str, str]:
    if (sector, industry) in INDUSTRY_BASIS:
        return INDUSTRY_BASIS[(sector, industry)]
    label = industry or sector or "industry"
    return (f"{label}產品／市場對手", f"{label} product/market rival")


def _has_cjk(text: str) -> bool:
    return bool(re.search(r"[\u4e00-\u9fff]", text or ""))


# Stale / wrong tickers → current listed symbols.
TICKER_ALIAS: dict[str, str] = {
    "GPS": "GAP",
    "SQ": "XYZ",
    "BK": "BNY",
    "MSC": "MSM",
    "ASHTEAD": "URI",  # construction rental peer in-universe; never fake ASHTEAD
    "MMC": "MRSH",
    "WACLY": "WSO",  # never Wacoal-as-Watsco; prefer Watsco if needed elsewhere
}

# Never use as rivals unless hub is intentionally SpaceX-adjacent (none in remaining).
BANNED_RIVAL_TICKERS = {"SPCX"}


def canonicalize_ticker(t: str) -> str | None:
    t = (t or "").strip().upper()
    if not t or t in BANNED_RIVAL_TICKERS:
        return None
    return TICKER_ALIAS.get(t, t)


def rivals_from_group(ticker: str, gid: str, n: int = 5) -> list[tuple[str, str, str]]:
    members, zh, en = GROUP_BY_ID[gid]
    out: list[tuple[str, str, str]] = []
    for peer in members:
        peer = canonicalize_ticker(peer)
        if not peer or peer == ticker:
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
    self_row = next((r for r in rows if r["ticker"] == ticker), None)
    self_mcap = float((self_row or {}).get("marketCap") or 0)
    peers = [r for r in rows if r["ticker"] != ticker]
    peers_mcap = sorted(peers, key=lambda r: -float(r.get("marketCap") or 0))
    peers_near = sorted(peers, key=lambda r: abs(float(r.get("marketCap") or 0) - self_mcap))
    ordered: list[dict] = []
    seen = set()
    for pool in (peers_mcap, peers_near):
        for r in pool:
            t = canonicalize_ticker(r["ticker"])
            if not t or t in seen or t == ticker:
                continue
            seen.add(t)
            ordered.append(r if r["ticker"] == t else {**r, "ticker": t})
            if len(ordered) >= n + 3:
                break
        if len(ordered) >= n + 3:
            break
    zh, en = industry_basis(sector, industry)
    return [(canonicalize_ticker(r["ticker"]) or r["ticker"], zh, en) for r in ordered[:n]]


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
        peer = canonicalize_ticker(peer)
        if not peer or peer in used:
            continue
        out.append((peer, zh, en))
        used.add(peer)
        if len(out) >= n:
            break
    if len(out) < 4:
        sector_peers: list[dict] = []
        for (sec, _ind), rows in by_industry.items():
            if sec == sector:
                sector_peers.extend(rows)
        sector_peers = sorted(sector_peers, key=lambda r: -float(r.get("marketCap") or 0))
        zh, en = industry_basis(sector, industry)
        for r in sector_peers:
            t = canonicalize_ticker(r["ticker"])
            if not t or t in used:
                continue
            out.append((t, zh, en))
            used.add(t)
            if len(out) >= n:
                break
    return out[:n]


# Extra peer groups for remaining universe.
EXTRA_PEER_GROUPS: list[tuple[str, list[str], str, str]] = [
    (
        "payments-credit",
        ["V", "MA", "AXP", "PYPL", "GPN", "AFRM", "COF", "SOFI", "XYZ", "TOST"],
        "支付／消費金融對手",
        "Payments / consumer-finance rival",
    ),
    (
        "auto-lender",
        ["ALLY", "CACC", "SOFI", "COF", "SYF", "OMF", "AFRM"],
        "汽車／消費貸款對手",
        "Auto / consumer-lending rival",
    ),
    (
        "semi-equip-mat",
        ["AMAT", "LRCX", "KLAC", "ENTG", "NVMI", "ONTO", "TER", "KEYS"],
        "半導體設備／製程材料對手",
        "Semi equipment / process-materials rival",
    ),
    (
        "semi-analog",
        ["TXN", "ADI", "ON", "MCHP", "NXPI", "ALGM", "MPWR"],
        "類比／感測半導體對手",
        "Analog / sensor semiconductor rival",
    ),
    (
        "semi-osat",
        ["AMKR", "ASX", "600584.SS", "002156.SZ", "TSM"],
        "封測／先進封裝對手",
        "OSAT / advanced packaging rival",
    ),
    (
        "semi-conn",
        ["ALAB", "AVGO", "MRVL", "CRDO", "MTSI", "AMD"],
        "高速連接／介面半導體對手",
        "High-speed connectivity semi rival",
    ),
    (
        "materials-mining",
        ["BHP", "RIO", "VALE", "FCX", "SCCO", "TECK", "NEM", "B"],
        "大宗礦業對手",
        "Bulk mining rival",
    ),
    (
        "materials-aluminum",
        ["AA", "CENX", "KALU", "NHYDY"],
        "鋁業對手",
        "Aluminum rival",
    ),
    (
        "materials-lithium",
        ["ALB", "SQM", "LAC", "PLL", "SGML"],
        "鋰／電池材料對手",
        "Lithium / battery-materials rival",
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
    (
        "saas-vertical-prop",
        ["APPF", "ZG", "CSGP", "AMT", "COMP"],
        "物業／垂直軟體對手",
        "Proptech / vertical software rival",
    ),
    (
        "payments-soft",
        ["ACIW", "FISV", "GPN", "FIS", "XYZ", "PYPL", "JKHY"],
        "支付軟體／處理對手",
        "Payments software / processing rival",
    ),
    (
        "search-ai",
        ["BIDU", "GOOG", "META", "BABA", "0700.HK", "MSFT"],
        "搜尋／AI 平台對手",
        "Search / AI platform rival",
    ),
    (
        "video-cn",
        ["BILI", "IQ", "HUYA", "NTES", "0700.HK", "META"],
        "影音／互動娛樂對手",
        "Video / interactive entertainment rival",
    ),
    (
        "aviation-lessor",
        ["AER", "AL", "FLY", "BA", "GE", "DAL"],
        "航空機隊租賃對手",
        "Aircraft lessor rival",
    ),
    (
        "util-water",
        ["AWK", "WTRG", "SBS", "CWT", "AWR", "SJW"],
        "受規管水務對手",
        "Regulated water utility rival",
    ),
    (
        "util-gas",
        ["ATO", "NI", "UGI", "SWX", "BKH", "NJR", "SR", "OGS"],
        "受規管天然氣對手",
        "Regulated gas utility rival",
    ),
    (
        "bank-latam",
        ["ITUB", "NU", "BSBR", "BBD", "BBDO", "BAP", "BCH", "CIB", "BSAC"],
        "拉美銀行對手",
        "LatAm bank rival",
    ),
    (
        "tech-dist",
        ["AVT", "ARW", "SNX", "CDW", "NSIT"],
        "電子零件通路對手",
        "Electronics distributor rival",
    ),
    (
        "auto-tier1",
        ["APTV", "BWA", "ALV", "ALSN", "LEA", "MGA", "GNTX"],
        "汽車 Tier-1 零組件對手",
        "Auto Tier-1 components rival",
    ),
    (
        "farm-agri",
        ["ADM", "BG", "INGR", "DAR", "TSN", "CTVA"],
        "農產品／大宗貿易對手",
        "Agribusiness rival",
    ),
    (
        "beer-bev",
        ["ABEV", "BUD", "TAP", "STZ", "SAM", "DEO"],
        "啤酒／酒精飲料對手",
        "Beer / alcoholic-beverage rival",
    ),
    (
        "ophthalmology",
        ["ALC", "COO", "RXRX", "JNJ", "SYK", "EW"],
        "眼科／視力保健對手",
        "Ophthalmology / vision-care rival",
    ),
    (
        "fund-am",
        ["BEN", "TROW", "IVZ", "AMG", "BLK", "AMP"],
        "主動／共同基金資產管理對手",
        "Active / mutual-fund asset-manager rival",
    ),
    (
        "wealth-am",
        ["AMP", "SCHW", "RJF", "LPLA", "MS", "ET"],
        "財富管理對手",
        "Wealth-management rival",
    ),
    (
        "infra-hold",
        ["BIP", "BEP", "NEE", "BEPC", "CWEN"],
        "基建控股對手",
        "Infrastructure holding rival",
    ),
    (
        "reit-residential",
        ["AMH", "INVH", "EQR", "AVB", "UDR", "CPT", "ESS", "MAA"],
        "住宅 REIT 對手",
        "Residential REIT rival",
    ),
    (
        "reit-healthcare",
        ["AHR", "WELL", "VTR", "PEAK", "DOC", "OHI", "CTRE"],
        "醫療 REIT 對手",
        "Healthcare REIT rival",
    ),
    (
        "reit-office",
        ["ARE", "BXP", "VNO", "SLG", "DEI", "KRC"],
        "辦公／生科園區 REIT 對手",
        "Office / life-science REIT rival",
    ),
    (
        "reit-hotel",
        ["HST", "PEB", "RLJ", "PK", "SHO", "CHH"],
        "飯店 REIT／飯店業對手",
        "Hotel REIT / lodging rival",
    ),
    (
        "reit-mreit",
        ["AGNC", "NLY", "STWD", "BXMT", "ARR", "TWO"],
        "抵押 REIT 對手",
        "Mortgage REIT rival",
    ),
    (
        "brokerage-cn",
        ["BEKE", "COMP", "ZG", "OPEN", "RDFN", "UWMC"],
        "房地產經紀／數位房仲對手",
        "Property brokerage / digital realtor rival",
    ),
    (
        "metal-fab",
        ["ATI", "CRS", "HAYN", "MLI", "WOR", "SPXC"],
        "金屬加工／特鋼對手",
        "Metal fabrication / specialty metals rival",
    ),
    (
        "marine-rv",
        ["BC", "PII", "THO", "WGO", "MBUU", "MCFT"],
        "船舶／休閒車對手",
        "Marine / RV rival",
    ),
    (
        "restaurants",
        ["CAKE", "DRI", "EAT", "TXRH", "CMG", "YUM", "DPZ", "WING"],
        "餐飲對手",
        "Restaurant rival",
    ),
    (
        "pharma-generic",
        ["AMRX", "TEVA", "VTRS", "PRGO", "MYL", "ELAN"],
        "學名藥／特用藥對手",
        "Generics / specialty-pharma rival",
    ),
    (
        "airport-ops",
        ["ASR", "PAC", "OMAB", "JBLU", "ALK", "LUV"],
        "機場營運對手",
        "Airport operator rival",
    ),
    (
        "power-conv",
        ["AEIS", "VRT", "ETN", "EMR", "GNRC", "ENPH"],
        "電源轉換／電力電子對手",
        "Power conversion / power-electronics rival",
    ),
    (
        "security-svc",
        ["ADT", "ALLE", "BCO", "MSA", "REZI"],
        "安防服務／產品對手",
        "Security services / products rival",
    ),
    (
        "satellite",
        ["ASTS", "GSAT", "IRDM", "MAXR", "RKLB"],
        "衛星通訊對手",
        "Satellite communications rival",
    ),
    (
        "mi-specialty",
        ["ACT", "ESNT", "MTG", "RDN", "NMIH"],
        "抵押保險對手",
        "Mortgage-insurance rival",
    ),
    (
        "nutrition-chem",
        ["BCPC", "INGR", "DAR", "FMC", "IFF", "ECL"],
        "營養／特用化學對手",
        "Nutrition / specialty-chem rival",
    ),
    (
        "ind-security",
        ["ALLE", "ADT", "BCO", "MSA", "REZI", "JCI"],
        "安防／門禁對手",
        "Security / access-control rival",
    ),
    (
        "energy-ofs-pure",
        ["SLB", "HAL", "BKR", "NOV", "FTI", "WHD", "OII"],
        "油服對手",
        "Oilfield services rival",
    ),
    (
        "disc-hotel-ops",
        ["CHH", "HLT", "MAR", "H", "IHG", "WH"],
        "飯店營運對手",
        "Hotel operator rival",
    ),
    (
        "ind-dist",
        ["AIT", "MSM", "GWW", "FAST", "WCC", "DXPE"],
        "工業通路對手",
        "Industrial distribution rival",
    ),
]

for _gid, _members, _zh, _en in EXTRA_PEER_GROUPS:
    PEER_GROUPS.append((_gid, _members, _zh, _en))
    GROUP_BY_ID[_gid] = (_members, _zh, _en)
    for _t in _members:
        HUB_TO_GROUPS.setdefault(_t, [])
        if _gid not in HUB_TO_GROUPS[_t]:
            HUB_TO_GROUPS[_t].insert(0, _gid)

# Hub → preferred specialty group (wins over industry map / HUB_TO_GROUPS first).
TICKER_GROUP_FORCE: dict[str, str] = {
    "PYPL": "payments-credit",
    "GPN": "payments-credit",
    "AFRM": "payments-credit",
    "SOFI": "payments-credit",
    "XYZ": "payments-credit",
    "TOST": "payments-credit",
    "ALLY": "auto-lender",
    "CACC": "auto-lender",
    "ENTG": "semi-equip-mat",
    "NVMI": "semi-equip-mat",
    "ONTO": "semi-equip-mat",
    "ALGM": "semi-analog",
    "AMKR": "semi-osat",
    "ALAB": "semi-conn",
    "VEEV": "saas-life-sci",
    "HUBS": "saas-crm-collab",
    "ZM": "saas-crm-collab",
    "TEAM": "saas-crm-collab",
    "WDAY": "saas-crm-collab",
    "APPF": "saas-vertical-prop",
    "ACIW": "payments-soft",
    "VALE": "materials-mining",
    "TECK": "materials-mining",
    "AA": "materials-aluminum",
    "ALB": "materials-lithium",
    "BIDU": "search-ai",
    "BILI": "video-cn",
    "AER": "aviation-lessor",
    "AWK": "util-water",
    "WTRG": "util-water",
    "SBS": "util-water",
    "ATO": "util-gas",
    "NI": "util-gas",
    "AVAL": "bank-latam",
    "BAP": "bank-latam",
    "BBD": "bank-latam",
    "BBDO": "bank-latam",
    "BSBR": "bank-latam",
    "BCH": "bank-latam",
    "CIB": "bank-latam",
    "ITUB": "bank-latam",
    "NU": "bank-latam",
    "AVT": "tech-dist",
    "ARW": "tech-dist",
    "APTV": "auto-tier1",
    "ALSN": "auto-tier1",
    "ALV": "auto-tier1",
    "BWA": "auto-tier1",
    "ADM": "farm-agri",
    "BG": "farm-agri",
    "ABEV": "beer-bev",
    "ALC": "ophthalmology",
    "BEN": "fund-am",
    "AMP": "wealth-am",
    "BIP": "infra-hold",
    "AMH": "reit-residential",
    "AHR": "reit-healthcare",
    "ARE": "reit-office",
    "AGNC": "reit-mreit",
    "BEKE": "brokerage-cn",
    "COMP": "brokerage-cn",
    "ATI": "metal-fab",
    "BC": "marine-rv",
    "CAKE": "restaurants",
    "CHH": "disc-hotel-ops",
    "AMRX": "pharma-generic",
    "ASR": "airport-ops",
    "AEIS": "power-conv",
    "ADT": "security-svc",
    "ALLE": "ind-security",
    "ASTS": "satellite",
    "ACT": "mi-specialty",
    "BCPC": "nutrition-chem",
    "AIT": "ind-dist",
    "BKR": "energy-ofs-pure",
    "AEG": "ins-life",
}


def resolve_rivals(
    ticker: str,
    row: dict,
    by_industry: dict[tuple[str, str], list[dict]],
    n: int = 5,
) -> list[tuple[str, str, str]]:
    sector = row.get("sector") or ""
    industry = row.get("industry") or ""

    forced = TICKER_GROUP_FORCE.get(ticker)
    if forced and forced in GROUP_BY_ID:
        riv = rivals_from_group(ticker, forced, n=n)
        if len(riv) >= 4:
            return riv[:n]
        riv = pad_rivals(ticker, sector, industry, riv, by_industry, n=n)
        if len(riv) >= 4:
            return riv[:n]

    riv = rivals_for(ticker, n=n)
    # Filter banned / alias after mid-mega rivals_for
    cleaned = []
    used = {ticker}
    for peer, zh, en in riv:
        peer = canonicalize_ticker(peer)
        if not peer or peer in used:
            continue
        cleaned.append((peer, zh, en))
        used.add(peer)
    riv = cleaned
    if len(riv) >= 4:
        return riv[:n]

    gid = INDUSTRY_TO_GROUP.get((sector, industry))
    if gid and gid in GROUP_BY_ID:
        riv = rivals_from_group(ticker, gid, n=n)
        if len(riv) >= 4:
            return riv[:n]
        riv = pad_rivals(ticker, sector, industry, riv, by_industry, n=n)
        if len(riv) >= 4:
            return riv[:n]

    riv = rivals_same_industry(ticker, sector, industry, by_industry, n=n)
    riv = pad_rivals(ticker, sector, industry, riv, by_industry, n=n)
    return riv[:n]


EXTRA_NAME_EN: dict[str, str] = {
    "CVE": "Cenovus",
    "KDP": "Keurig Dr Pepper",
    "F": "Ford",
    "TEVA": "Teva",
    "VALE": "Vale",
    "PYPL": "PayPal",
    "VEEV": "Veeva",
    "ZBH": "Zimmer Biomet",
    "BSBR": "Banco Santander Brasil",
    "ALAB": "Astera Labs",
    "AVT": "Avnet",
    "ARW": "Arrow Electronics",
    "ABEV": "Ambev",
    "ALC": "Alcon",
    "AMP": "Ameriprise",
    "BKR": "Baker Hughes",
    "AFRM": "Affirm",
    "AS": "Amer Sports",
    "ALLE": "Allegion",
    "BG": "Bunge",
    "BCH": "Banco de Chile",
    "APG": "APi Group",
    "BEN": "Franklin Resources",
    "BIP": "Brookfield Infrastructure",
    "BNY": "BNY Mellon",
    "AHR": "American Healthcare REIT",
    "AMH": "American Homes 4 Rent",
    "AGNC": "AGNC Investment",
    "AEG": "Aegon",
    "ALLY": "Ally Financial",
    "ARMK": "Aramark",
    "ALB": "Albemarle",
    "ASTS": "AST SpaceMobile",
    "AER": "AerCap",
    "BIDU": "Baidu",
    "BEKE": "KE Holdings",
    "AWK": "American Water",
    "ATO": "Atmos Energy",
    "BAP": "Credicorp",
    "BBD": "Banco Bradesco",
    "BBDO": "Banco Bradesco",
    "ATI": "ATI",
    "SPXC": "SPX Technologies",
    "AL": "Air Lease",
    "FLY": "FlyExclusive",
    "AVAL": "Grupo Aval",
    "CHH": "Choice Hotels",
    "CIG": "CEMIG",
    "CACC": "Credit Acceptance",
    "ASB": "Associated Bancorp",
    "BC": "Brunswick",
    "CAKE": "Cheesecake Factory",
    "ALGM": "Allegro MicroSystems",
    "BILI": "Bilibili",
    "ANF": "Abercrombie & Fitch",
    "GAP": "Gap",
    "ACT": "Enact",
    "AN": "AutoNation",
    "BCPC": "Balchem",
    "AAL": "American Airlines",
    "AA": "Alcoa",
    "AIT": "Applied Industrial",
    "MSM": "MSC Industrial",
    "ATR": "AptarGroup",
    "AVTR": "Avantor",
    "ALSN": "Allison Transmission",
    "ALV": "Autoliv",
    "ASR": "Grupo Aeroportuario del Sureste",
    "APTV": "Aptiv",
    "AEIS": "Advanced Energy",
    "AMKR": "Amkor",
    "ARE": "Alexandria Real Estate",
    "AMRX": "Amneal",
    "APPF": "AppFolio",
    "ADT": "ADT",
    "ACIW": "ACI Worldwide",
    "BBUC": "Brookfield Business",
}

# Prefer 繁中; Latin only when that is the intentional brand (Equinix/IBM style).
EXTRA_NAME_ZH: dict[str, str] = {
    "F": "福特",
    "TEVA": "梯瓦藥廠",
    "VALE": "淡水河谷",
    "VEEV": "維瓦系統",
    "ZBH": "捷邁邦美",
    "A": "安捷倫",
    "EQIX": "Equinix",
    "IQV": "艾昆緯",
    "CDNS": "益華電腦",
    "CI": "信諾",
    "TDG": "環球透博",
    "BHP": "必和必拓",
    "IBM": "IBM",
    "IHG": "洲際酒店集團",
    "SKHY": "SK海力士",
    "CRL": "查爾斯河實驗室",
    "SPCX": "SpaceX",
    "COHR": "相干光電",
    "GEHC": "GE醫療",
    "AVT": "艾睿電子",
    "ARW": "安富利",
    "BSBR": "巴西桑坦德銀行",
    "ALAB": "Astera Labs",
    "ABEV": "百威英博美洲",
    "ALC": "愛爾康",
    "BKR": "貝克休斯",
    "BIDU": "百度",
    "BEKE": "貝殼找房",
    "AWK": "美國水務",
    "ATO": "Atmos Energy",
    "BAP": "Credicorp",
    "BBD": "巴西布拉德斯科銀行",
    "BBDO": "巴西布拉德斯科銀行",
    "AER": "AerCap",
    "BILI": "嗶哩嗶哩",
    "GAP": "Gap",
    "AAL": "美國航空",
    "AA": "美國鋁業",
    "AMKR": "艾克爾",
    "AVAL": "Grupo Aval",
    "CHH": "Choice Hotels",
    "CIG": "CEMIG",
    "ASB": "Associated Bancorp",
    "BC": "Brunswick",
    "CAKE": "起司蛋糕工廠",
    "ALGM": "Allegro MicroSystems",
    "CACC": "Credit Acceptance",
}


def ensure_entity_preserving(
    entities: dict,
    ticker: str,
    uni: dict,
    stock_zh: dict,
    file_zh: dict,
    main_ents: dict,
) -> None:
    """Call ensure_entity but never replace an existing good CJK name_zh."""
    prior = dict(entities.get(ticker) or {})
    main_row = main_ents.get(ticker) or {}
    ensure_entity(entities, ticker, uni, stock_zh, file_zh)
    pe = entities.get(ticker) or {}
    # Prefer main curated CJK when present.
    candidates = [
        prior.get("name_zh"),
        main_row.get("name_zh"),
        EXTRA_NAME_ZH.get(ticker),
        pe.get("name_zh"),
    ]
    best_zh = None
    for c in candidates:
        if isinstance(c, str) and c.strip() and _has_cjk(c):
            best_zh = c.strip()
            break
    if best_zh:
        pe["name_zh"] = best_zh
    elif ticker in EXTRA_NAME_ZH:
        pe["name_zh"] = EXTRA_NAME_ZH[ticker]
    if ticker in EXTRA_NAME_EN:
        pe["name_en"] = EXTRA_NAME_EN[ticker]
    elif prior.get("name_en") and prior["name_en"] != ticker:
        # keep prior short brand if ensure_entity mangled
        if pe.get("name_en") in (ticker, "") or pe.get("name_en", "").endswith("-"):
            pe["name_en"] = prior["name_en"]
    # Exchange: never force OTC for in-universe NYSE/NASDAQ names
    row = uni.get(ticker) or {}
    if row.get("exchange"):
        pe["exchange"] = row["exchange"]
    elif prior.get("exchange") and pe.get("exchange") in ("", "OTC"):
        pe["exchange"] = prior["exchange"]
    entities[ticker] = pe


def main() -> int:
    CURATED_NAME_EN.update(EXTRA_NAME_EN)
    # Only merge EXTRA_NAME_ZH CJK / intentional brands into mid-mega map.
    for t, zh in EXTRA_NAME_ZH.items():
        CURATED_NAME_ZH[t] = zh

    entities = load_json(ENT_PATH)
    competitors = load_json(COMP_PATH)
    universe = load_json(UNIVERSE_PATH)
    stocks = universe["stocks"]
    uni = {r["ticker"]: r for r in stocks}
    stock_zh = load_stock_names_zh()
    file_zh = load_json(ZH_NAMES_PATH).get("names") or {}

    # Snapshot main entities to restore clobbered 繁中.
    import subprocess

    try:
        main_ents = json.loads(
            subprocess.check_output(
                ["git", "show", "origin/main:scripts/supply_chain/data/sc_entities.json"],
                cwd=str(ROOT),
            )
        )
    except Exception:
        main_ents = {}

    remaining = [r for r in stocks if float(r.get("marketCap") or 0) < 50e9]
    remaining.sort(key=lambda r: -float(r.get("marketCap") or 0))

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
        ensure_entity_preserving(entities, t, uni, stock_zh, file_zh, main_ents)
        for peer, _, _ in riv:
            ensure_entity_preserving(entities, peer, uni, stock_zh, file_zh, main_ents)

    # Force Bugbot-critical entity rows.
    forced_ents = {
        "CI": ("Cigna", "信諾", "NYSE"),
        "TDG": ("TransDigm", "環球透博", "NYSE"),
        "IBM": ("IBM", "IBM", "NYSE"),
        "EQIX": ("Equinix", "Equinix", "NASDAQ"),
        "IQV": ("IQVIA", "艾昆緯", "NYSE"),
        "CDNS": ("Cadence", "益華電腦", "NASDAQ"),
        "BHP": ("BHP", "必和必拓", "NYSE"),
        "ANSS": ("Ansys", "安西斯", "NASDAQ"),
        "PTC": ("PTC", "參數科技", "NASDAQ"),
        "ADSK": ("Autodesk", "歐特克", "NASDAQ"),
        "LIN": ("Linde", "林德集團", "NASDAQ"),
        "F": ("Ford", "福特", "NYSE"),
        "A": ("Agilent", "安捷倫", "NYSE"),
        "VALE": ("Vale", "淡水河谷", "NYSE"),
        "AVT": ("Avnet", "艾睿電子", "NASDAQ"),
        "ARW": ("Arrow Electronics", "安富利", "NYSE"),
        "VEEV": ("Veeva", "維瓦系統", "NYSE"),
        "ZBH": ("Zimmer Biomet", "捷邁邦美", "NYSE"),
        "IHG": ("IHG", "洲際酒店集團", "NYSE"),
        "SKHY": ("SK hynix", "SK海力士", "NASDAQ"),
        "CRL": ("Charles River", "查爾斯河實驗室", "NYSE"),
        "SPCX": ("SpaceX", "SpaceX", "Private"),
        "COHR": ("Coherent", "相干光電", "NYSE"),
        "GEHC": ("GE HealthCare", "GE醫療", "NASDAQ"),
        "ASB": ("Associated Bancorp", "Associated Bancorp", "NYSE"),
        "AVAL": ("Grupo Aval", "Grupo Aval", "NYSE"),
        "CHH": ("Choice Hotels", "Choice Hotels", "NYSE"),
        "CIG": ("CEMIG", "CEMIG", "NYSE"),
        "AL": ("Air Lease", "Air Lease", "NYSE"),
        "FLY": ("FlyExclusive", "FlyExclusive", "OTC"),
        "SPXC": ("SPX Technologies", "SPX Technologies", "NYSE"),
    }
    for t, (en, zh, ex) in forced_ents.items():
        entities[t] = {
            "name_en": en,
            "name_zh": zh,
            "exchange": (uni.get(t) or {}).get("exchange") or ex,
        }

    # Restore any main CJK that remaining prep still lacks.
    for t, row in main_ents.items():
        zh = (row.get("name_zh") or "").strip()
        if not _has_cjk(zh):
            continue
        pe = entities.get(t) or {}
        if not _has_cjk(pe.get("name_zh") or ""):
            pe["name_zh"] = zh
            pe["name_en"] = pe.get("name_en") or row.get("name_en") or t
            pe["exchange"] = pe.get("exchange") or row.get("exchange") or (uni.get(t) or {}).get("exchange") or ""
            entities[t] = pe

    # Apply EXTRA names without clobbering CJK with English.
    for t, name_en in EXTRA_NAME_EN.items():
        if t not in uni and t not in entities:
            continue
        ensure_entity_preserving(entities, t, uni, stock_zh, file_zh, main_ents)
        entities[t]["name_en"] = name_en
        if t in EXTRA_NAME_ZH:
            zh = EXTRA_NAME_ZH[t]
            cur_zh = entities[t].get("name_zh") or ""
            if _has_cjk(zh) or not _has_cjk(cur_zh):
                entities[t]["name_zh"] = zh

    # Scrub banned rivals from any competitor lists.
    for hub, arr in list(competitors.items()):
        cleaned = []
        seen = {hub}
        for item in arr:
            if not item:
                continue
            peer = canonicalize_ticker(item[0])
            if not peer or peer in seen:
                continue
            cleaned.append([peer, item[1], item[2]])
            seen.add(peer)
        competitors[hub] = cleaned

    write_json(ENT_PATH, entities)
    write_json(COMP_PATH, competitors)

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
