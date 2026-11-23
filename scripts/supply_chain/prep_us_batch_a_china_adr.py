#!/usr/bin/env python3
"""Prep catalogs for US SC Batch A — China/Asia ADR hubs (China-centric redo).

Rule (prefs + 0700 gold): major market China/HK/Asia → CN/HK/regional stage nodes;
dual-list prefer .HK for ecosystem nodes; rivals ≠ stage; no self-IP as upstream;
Traditional Chinese only. Does not call FMP.

Batch A hubs:
  BABA PDD NTES SE JD CPNG BIDU BEKE YUMC HTHT TME ZTO FUTU GRAB
  LI XPEV YMM EDU BZ LU NIO VIPS TAL BILI
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

BATCH_A = [
    "BABA",
    "PDD",
    "NTES",
    "SE",
    "JD",
    "CPNG",
    "BIDU",
    "BEKE",
    "YUMC",
    "HTHT",
    "TME",
    "ZTO",
    "FUTU",
    "GRAB",
    "LI",
    "XPEV",
    "YMM",
    "EDU",
    "BZ",
    "LU",
    "NIO",
    "VIPS",
    "TAL",
    "BILI",
]

ENTITIES: dict[str, dict[str, str]] = {
    "BABA": {"name_en": "Alibaba", "name_zh": "阿里巴巴", "exchange": "NYSE"},
    "PDD": {"name_en": "PDD", "name_zh": "拼多多", "exchange": "NASDAQ"},
    "NTES": {"name_en": "NetEase", "name_zh": "網易", "exchange": "NASDAQ"},
    "SE": {"name_en": "Sea", "name_zh": "Sea", "exchange": "NYSE"},
    "JD": {"name_en": "JD.com", "name_zh": "京東", "exchange": "NASDAQ"},
    "CPNG": {"name_en": "Coupang", "name_zh": "酷澎", "exchange": "NYSE"},
    "BIDU": {"name_en": "Baidu", "name_zh": "百度", "exchange": "NASDAQ"},
    "BEKE": {"name_en": "KE Holdings", "name_zh": "貝殼找房", "exchange": "NYSE"},
    "YUMC": {"name_en": "Yum China", "name_zh": "百勝中國", "exchange": "NYSE"},
    "HTHT": {"name_en": "H World", "name_zh": "華住", "exchange": "NASDAQ"},
    "TME": {"name_en": "Tencent Music", "name_zh": "騰訊音樂", "exchange": "NYSE"},
    "ZTO": {"name_en": "ZTO Express", "name_zh": "中通快遞", "exchange": "NYSE"},
    "FUTU": {"name_en": "Futu", "name_zh": "富途", "exchange": "NASDAQ"},
    "GRAB": {"name_en": "Grab", "name_zh": "Grab", "exchange": "NASDAQ"},
    "LI": {"name_en": "Li Auto", "name_zh": "理想汽車", "exchange": "NASDAQ"},
    "XPEV": {"name_en": "XPeng", "name_zh": "小鵬", "exchange": "NYSE"},
    "YMM": {"name_en": "Full Truck Alliance", "name_zh": "滿幫", "exchange": "NYSE"},
    "EDU": {"name_en": "New Oriental", "name_zh": "新東方", "exchange": "NYSE"},
    "BZ": {"name_en": "Kanzhun", "name_zh": "BOSS直聘", "exchange": "NASDAQ"},
    "LU": {"name_en": "Lufax", "name_zh": "陸金所", "exchange": "NYSE"},
    "NIO": {"name_en": "NIO", "name_zh": "蔚來", "exchange": "NYSE"},
    "VIPS": {"name_en": "Vipshop", "name_zh": "唯品會", "exchange": "NYSE"},
    "TAL": {"name_en": "TAL Education", "name_zh": "好未來", "exchange": "NYSE"},
    "BILI": {"name_en": "Bilibili", "name_zh": "嗶哩嗶哩", "exchange": "NASDAQ"},
    "2423.HK": {"name_en": "KE Holdings", "name_zh": "貝殼找房", "exchange": "HKEX"},
    "1109.HK": {"name_en": "CR Land", "name_zh": "華潤置地", "exchange": "HKEX"},
    "0688.HK": {"name_en": "China Overseas", "name_zh": "中國海外發展", "exchange": "HKEX"},
    "0960.HK": {"name_en": "Longfor", "name_zh": "龍湖集團", "exchange": "HKEX"},
    "2007.HK": {"name_en": "Country Garden", "name_zh": "碧桂園", "exchange": "HKEX"},
    "0017.HK": {"name_en": "New World Dev", "name_zh": "新世界發展", "exchange": "HKEX"},
    "1200.HK": {"name_en": "Midland", "name_zh": "美聯集團", "exchange": "HKEX"},
    # 0014.HK = Hysan（希慎興業）— NOT China Merchants Shekou (001979.SZ).
    "0014.HK": {"name_en": "Hysan", "name_zh": "希慎興業", "exchange": "HKEX"},
    "0823.HK": {"name_en": "Link REIT", "name_zh": "領展房產基金", "exchange": "HKEX"},
    "1997.HK": {"name_en": "Wharf REIC", "name_zh": "九龍倉置業", "exchange": "HKEX"},
    # Optional A-share property arm if used elsewhere; not on BEKE housing (prefer HK landlords).
    "001979.SZ": {"name_en": "CM Shekou", "name_zh": "招商蛇口", "exchange": "SZSE"},
    "0670.HK": {"name_en": "China Eastern", "name_zh": "東方航空", "exchange": "HKEX"},
    "0753.HK": {"name_en": "Air China", "name_zh": "中國國航", "exchange": "HKEX"},
    "0293.HK": {"name_en": "Cathay Pacific", "name_zh": "國泰航空", "exchange": "HKEX"},
    "0669.HK": {"name_en": "Techtronic", "name_zh": "創科實業", "exchange": "HKEX"},
    "0322.HK": {"name_en": "Tingyi", "name_zh": "康師傅", "exchange": "HKEX"},
    "0151.HK": {"name_en": "Want Want", "name_zh": "旺旺", "exchange": "HKEX"},
    "6862.HK": {"name_en": "Haidilao", "name_zh": "海底撈", "exchange": "HKEX"},
    "9987.HK": {"name_en": "Yum China", "name_zh": "百勝中國", "exchange": "HKEX"},
    "1179.HK": {"name_en": "H World", "name_zh": "華住", "exchange": "HKEX"},
    "035420.KS": {"name_en": "NAVER", "name_zh": "NAVER", "exchange": "KRX"},
    "035720.KS": {"name_en": "Kakao", "name_zh": "Kakao", "exchange": "KRX"},
    "TCOM": {"name_en": "Trip.com", "name_zh": "攜程", "exchange": "NASDAQ"},
    "TM": {"name_en": "Toyota", "name_zh": "豐田", "exchange": "NYSE"},
    "HMC": {"name_en": "Honda", "name_zh": "本田", "exchange": "NYSE"},
    # Music majors / China game co-publish / IDC (Bugbot partner honesty).
    "UMG": {"name_en": "Universal Music", "name_zh": "環球音樂", "exchange": "EURONEXT"},
    "0777.HK": {"name_en": "NetDragon", "name_zh": "網龍", "exchange": "HKEX"},
    "0799.HK": {"name_en": "IGG", "name_zh": "IGG", "exchange": "HKEX"},
    "1119.HK": {"name_en": "iDreamSky", "name_zh": "創夢天地", "exchange": "HKEX"},
    "EQIX": {"name_en": "Equinix", "name_zh": "Equinix", "exchange": "NASDAQ"},
    "DLR": {"name_en": "Digital Realty", "name_zh": "Digital Realty", "exchange": "NYSE"},
    "ADP": {"name_en": "ADP", "name_zh": "ADP", "exchange": "NASDAQ"},
    "WDAY": {"name_en": "Workday", "name_zh": "Workday", "exchange": "NASDAQ"},
    "PAYX": {"name_en": "Paychex", "name_zh": "Paychex", "exchange": "NASDAQ"},
    "SHEL": {"name_en": "Shell", "name_zh": "殼牌", "exchange": "NYSE"},
    "KO": {"name_en": "Coca-Cola", "name_zh": "可口可樂", "exchange": "NYSE"},
    "PEP": {"name_en": "PepsiCo", "name_zh": "百事", "exchange": "NASDAQ"},
    "UL": {"name_en": "Unilever", "name_zh": "聯合利華", "exchange": "NYSE"},
}

CN_ECOM = {
    "supply": ["2020.HK", "2331.HK", "2319.HK"],
    "fulfillment": ["0144.HK", "0316.HK", "1308.HK"],
    "payments": ["0005.HK", "1398.HK", "6060.HK"],
    "traffic": ["9888.HK", "1024.HK", "9626.HK"],
    "lastmile": ["2057.HK", "1519.HK", "2618.HK"],
}

# JD owns 2618 logistics — keep lastmile on peer express only (no fulfillment/port dupes).
CN_ECOM_JD = {
    **CN_ECOM,
    "lastmile": ["2057.HK", "1519.HK"],
}

# BIDU — online marketing + AI Cloud (china-platform skeleton, ads/cloud framing — not WeChat clone copy).
# Infra = true IDC/cloud (GDS / Kingsoft Cloud peers / Equinix) — not China Tower.
CN_BIDU = {
    "infra": ["9698.HK", "3888.HK", "EQIX"],
    "distribution": ["0941.HK", "0762.HK", "1810.HK"],
    "payments": ["0005.HK", "1398.HK", "6060.HK"],
    "advertisers": ["2020.HK", "2331.HK", "2319.HK"],
}

# BABA — Taobao/Tmall GMV + Cloud + Cainiao (broad marketplace + logistics partners).
CN_BABA = {
    "supply": ["2020.HK", "2331.HK", "2319.HK"],
    "fulfillment": ["0144.HK", "0316.HK", "1308.HK"],
    "payments": ["0005.HK", "1398.HK", "6060.HK"],
    "traffic": ["9888.HK", "1024.HK", "9626.HK"],
    "lastmile": ["2057.HK", "1519.HK", "2618.HK"],
}

# PDD — Temu/PDD GMV value commerce; social traffic heavier, less port-centric fulfillment.
CN_PDD = {
    "supply": ["2020.HK", "2331.HK", "0151.HK"],
    "fulfillment": ["0316.HK", "1308.HK", "0144.HK"],
    "payments": ["0005.HK", "1398.HK", "6060.HK"],
    "traffic": ["1024.HK", "9626.HK", "0700.HK"],
    "lastmile": ["2057.HK", "1519.HK", "2618.HK"],
}

# VIPS — brand-outlet / apparel-heavy inventory commerce.
CN_VIPS = {
    "supply": ["2020.HK", "2331.HK", "1044.HK"],
    "fulfillment": ["0144.HK", "0316.HK", "1308.HK"],
    "payments": ["0005.HK", "1398.HK", "6060.HK"],
    "traffic": ["9888.HK", "1024.HK", "9626.HK"],
    "lastmile": ["2057.HK", "1519.HK"],
}

# JD owns 2618 logistics — peer express only on lastmile.
CN_JD = {
    "supply": ["2020.HK", "2331.HK", "2319.HK"],
    "fulfillment": ["0144.HK", "0316.HK", "1308.HK"],
    "payments": ["0005.HK", "1398.HK", "6060.HK"],
    "traffic": ["9888.HK", "1024.HK", "9626.HK"],
    "lastmile": ["2057.HK", "1519.HK"],
}

CN_EV = {
    "materials": ["2899.HK", "3800.HK"],
    "components": ["3750.HK", "1316.HK", "2018.HK"],
    "assembly": ["0425.HK", "0868.HK", "0179.HK"],
    "dealers": ["0881.HK", "1268.HK", "3669.HK"],
    "energy": ["2688.HK", "1193.HK", "0384.HK"],
}

EXPRESS_DEFAULTS = {
    "equipment": ["0669.HK", "2018.HK", "3888.HK"],
    "linehaul": ["0670.HK", "0753.HK", "0293.HK"],
    "shippers": ["9988.HK", "9618.HK", "PDD"],
    "packaging": ["2319.HK", "1044.HK", "0151.HK"],
    "settlement": ["0005.HK", "1398.HK", "6060.HK"],
}

FREIGHT_DEFAULTS = {
    "capacity": ["1211.HK", "0175.HK", "2333.HK"],
    "fuel": ["0386.HK", "0857.HK", "2688.HK"],
    "fintech": ["6060.HK", "0005.HK", "1398.HK"],
    "shippers": ["2020.HK", "2331.HK", "2319.HK"],
    "maps-data": ["9888.HK", "3888.HK", "9698.HK"],
}

# NTES — games ~80%+: cloud → carrier/device → top-up rails → UA/co-publish (not WeChat ads clone).
CN_GAMES = {
    "infra": ["9698.HK", "EQIX", "DLR"],
    "distribution": ["0941.HK", "0762.HK", "1810.HK"],
    "payments": ["0005.HK", "1398.HK", "6060.HK"],
    # External UA media + licensed co-publish partners (rivals 0700/BILI/SE stay off stages).
    "ua-publish": ["1024.HK", "GOOG", "TTWO"],
}

# TME — music sub + social + ads: label majors are core COGS (UMG/SONY/WMG — not Disney).
CN_MUSIC = {
    "labels": ["UMG", "SONY", "WMG"],
    "infra": ["9698.HK", "EQIX", "DLR"],
    "distribution": ["0941.HK", "0762.HK", "1810.HK"],
    "payments": ["0005.HK", "1398.HK", "6060.HK"],
    "advertisers": ["2020.HK", "2331.HK", "2319.HK"],
}

# BILI — VAS + ads + games: China co-publish (not TTWO/RBLX/Unity dump).
CN_VIDEO = {
    "infra": ["9698.HK", "EQIX", "DLR"],
    "distribution": ["0941.HK", "0762.HK", "1810.HK"],
    "payments": ["0005.HK", "1398.HK", "6060.HK"],
    "advertisers": ["2020.HK", "2331.HK", "2319.HK"],
    "game-publish": ["1119.HK", "0777.HK", "0799.HK"],
}

# BZ — employer-paid recruitment (not WeChat advertisers clone).
CN_RECRUIT = {
    # China traffic only — not NAVER. Carriers as acquisition reach (rivals BIDU/0700/BABA off stages).
    "traffic": ["1024.HK", "9626.HK", "0941.HK"],
    "employers": ["1810.HK", "1211.HK", "2318.HK"],
    # Real HR-tech / payroll / HCM — not Kingsoft/GDS/RELX role mismatch.
    "hr-tools": ["ADP", "WDAY", "PAYX"],
    "payments": ["0005.HK", "1398.HK", "6060.HK"],
    "branding": ["2020.HK", "2331.HK", "2319.HK"],
}

# EDU/TAL — tutoring fees: mainland campus landlords (not HK mall REITs).
CN_EDU = {
    "traffic": ["1024.HK", "9626.HK", "9888.HK"],
    "content": ["0772.HK", "PSO", "RELX"],
    "facilities": ["1109.HK", "0688.HK", "0960.HK"],
    "payments": ["0005.HK", "1398.HK", "6060.HK"],
    "distribution": ["0941.HK", "0762.HK", "1810.HK"],
}

# SEA ecommerce (SE) — Shopee GMV-centric regional partners.
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

# GRAB — SEA super-app (sea-superapp-v1): SEA merchants/ads/fleet — not China CPG or china-local-life.
SEA_SUPERAPP = {
    "maps-cloud": ["GOOG", "MSFT", "AMZN"],
    "payments": ["V", "MA", "PYPL"],
    # Honda scooters (SEA two-wheel), BYD e-mobility, Shell fuel/energy — not Hyundai/GCL/ENN.
    "fleet": ["HMC", "1211.HK", "SHEL"],
    "merchants": ["MCD", "SBUX", "YUM"],
    "ads": ["KO", "PEP", "UL"],
}

COMPETITORS: dict[str, list[list[str]]] = {
    "BABA": [
        ["JD", "中國電商對手", "China e-commerce rival"],
        ["PDD", "下沉市場電商對手", "Value e-commerce rival"],
        ["0700.HK", "中國互聯網生態對手", "China internet ecosystem rival"],
        ["3690.HK", "本地生活／即時零售對手", "Local services / instant retail rival"],
        ["VIPS", "品牌特賣電商對手", "Brand-outlet e-commerce rival"],
    ],
    "PDD": [
        ["BABA", "中國電商對手", "China e-commerce rival"],
        ["JD", "中國電商對手", "China e-commerce rival"],
        ["SE", "新興市場電商對手", "EM e-commerce rival"],
        ["3690.HK", "本地生活／即配對手", "Local services rival"],
        ["VIPS", "特賣電商對手", "Outlet e-commerce rival"],
    ],
    "JD": [
        ["BABA", "中國電商對手", "China e-commerce rival"],
        ["PDD", "下沉市場電商對手", "Value e-commerce rival"],
        ["3690.HK", "本地生活／即時零售對手", "Local services / instant retail rival"],
        ["VIPS", "品牌特賣電商對手", "Brand-outlet e-commerce rival"],
        ["0700.HK", "中國互聯網生態對手", "China internet ecosystem rival"],
    ],
    "VIPS": [
        ["BABA", "中國電商對手", "China e-commerce rival"],
        ["JD", "中國電商對手", "China e-commerce rival"],
        ["PDD", "下沉市場電商對手", "Value e-commerce rival"],
        ["3690.HK", "本地生活對手", "Local services rival"],
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
    ],
    "NTES": [
        # Product overlap = games / interactive entertainment (not generic internet peers).
        ["0700.HK", "遊戲／互動娛樂對手", "Games / interactive entertainment rival"],
        ["BILI", "遊戲／互動娛樂對手", "Games / interactive entertainment rival"],
        ["SE", "東南亞／全球遊戲對手", "SEA / global games rival"],
        ["RBLX", "互動娛樂／UGC 遊戲對手", "Interactive / UGC games rival"],
    ],
    "BIDU": [
        # China major-market search/ads/cloud peers — not GOOG (no material China search).
        ["0700.HK", "搜尋／線上行銷對手", "Search / online-marketing rival"],
        ["1024.HK", "資訊流廣告對手", "Feed-ads rival"],
        ["BABA", "數字營銷／雲對手", "Digital marketing / cloud rival"],
        ["BILI", "內容／流量對手", "Content / traffic rival"],
    ],
    "TME": [
        # 0700 = Tencent parent of TME — never a product rival.
        ["SPOT", "串流音樂對手", "Music streaming rival"],
        ["NTES", "雲音樂對手", "Cloud music rival"],
        ["1024.HK", "短影音音樂／內容對手", "Short-video music / content rival"],
        ["BILI", "影音內容對手", "Video content rival"],
    ],
    "BILI": [
        ["1024.HK", "長／短影音社區對手", "Long/short-video community rival"],
        ["NTES", "遊戲／內容對手", "Games / content rival"],
        ["0700.HK", "影音／互動娛樂對手", "Video / interactive entertainment rival"],
        ["TME", "音樂／直播內容對手", "Music / live content rival"],
    ],
    "BZ": [
        # Recruitment product overlap — not generic internet traffic peers as rivals.
        ["BIDU", "招聘／資訊服務對手", "Recruiting / info-services rival"],
        ["0700.HK", "招聘流量／資訊服務對手", "Recruiting traffic / info-services rival"],
        ["BABA", "本地生活／服務招聘鄰接對手", "Local-services recruiting adjacent rival"],
    ],
    "LI": [
        ["XPEV", "中國新能源車對手", "China EV rival"],
        ["NIO", "中國新能源車對手", "China EV rival"],
        ["1211.HK", "中國新能源車對手", "China EV rival"],
        ["0175.HK", "中國乘用車對手", "China passenger-auto rival"],
        ["TSLA", "在華銷售電動車對手", "EV rival with China sales"],
    ],
    "XPEV": [
        ["LI", "中國新能源車對手", "China EV rival"],
        ["NIO", "中國新能源車對手", "China EV rival"],
        ["1211.HK", "中國新能源車對手", "China EV rival"],
        ["0175.HK", "中國乘用車對手", "China passenger-auto rival"],
        ["TSLA", "在華銷售電動車對手", "EV rival with China sales"],
    ],
    "NIO": [
        ["LI", "中國新能源車對手", "China EV rival"],
        ["XPEV", "中國新能源車對手", "China EV rival"],
        ["1211.HK", "中國新能源車對手", "China EV rival"],
        ["0175.HK", "中國乘用車對手", "China passenger-auto rival"],
        ["TSLA", "在華銷售電動車對手", "EV rival with China sales"],
    ],
    "ZTO": [
        ["1519.HK", "中國快遞對手", "China express rival"],
        ["2618.HK", "電商物流對手", "E-comm logistics rival"],
        ["3690.HK", "即配／本地物流對手", "Instant delivery / local logistics rival"],
        ["FDX", "國際快遞對手", "International express rival"],
    ],
    "YMM": [
        ["ZTO", "幹線／物流鄰接對手", "Trunk / logistics adjacent rival"],
        ["2618.HK", "電商物流對手", "E-comm logistics rival"],
        ["1519.HK", "快遞／運力對手", "Express / capacity rival"],
        ["3690.HK", "本地即配對手", "Local delivery rival"],
    ],
    "BEKE": [
        # China housing brokerage peers — not US Zillow/Compass dump.
        ["1200.HK", "中國住宅經紀對手", "China residential brokerage rival"],
        ["1109.HK", "開發商自銷／渠道對手", "Developer channel rival"],
        ["0688.HK", "開發商自銷／渠道對手", "Developer channel rival"],
    ],
    "YUMC": [
        ["MCD", "中國餐飲對手", "China restaurant rival"],
        ["SBUX", "中國餐飲對手", "China restaurant rival"],
        ["6862.HK", "中國餐飲對手", "China restaurant rival"],
        ["3690.HK", "本地生活／到店對手", "Local services / dine-out rival"],
    ],
    "HTHT": [
        ["MAR", "飯店對手", "Hotel rival"],
        ["HLT", "飯店對手", "Hotel rival"],
        ["IHG", "飯店對手", "Hotel rival"],
        ["ABNB", "短租／住宿對手", "Short-stay / lodging rival"],
    ],
    "FUTU": [
        ["IBKR", "零售券商對手", "Retail brokerage rival"],
        ["SCHW", "零售券商對手", "Retail brokerage rival"],
        ["6030.HK", "中資券商對手", "China broker rival"],
        ["6886.HK", "中資券商對手", "China broker rival"],
        ["3908.HK", "中資券商對手", "China broker rival"],
    ],
    "GRAB": [
        ["UBER", "共享出行／即配對手", "Rideshare / delivery rival"],
        ["SE", "東南亞超級應用對手", "SEA super-app rival"],
        ["DASH", "即時配送對手", "Instant delivery rival"],
        ["3690.HK", "本地生活／即配對手", "Local services / delivery rival"],
    ],
    "EDU": [
        ["TAL", "中國教育培訓對手", "China education rival"],
        ["BILI", "線上學習／內容鄰接對手", "Online learning / content adjacent rival"],
    ],
    "TAL": [
        ["EDU", "中國教育培訓對手", "China education rival"],
        ["BILI", "線上學習／內容鄰接對手", "Online learning / content adjacent rival"],
    ],
    "LU": [
        ["6060.HK", "互聯網金融對手", "Internet-finance rival"],
        ["2318.HK", "綜合金融對手", "Diversified finance rival"],
        ["FUTU", "線上財富／經紀對手", "Online wealth / brokerage rival"],
        ["PYPL", "消費金融／支付對手", "Consumer-finance / payments rival"],
    ],
}

OVERRIDES: dict[str, dict[str, list[str]]] = {
    "BABA": dict(CN_BABA),
    "PDD": dict(CN_PDD),
    "JD": dict(CN_JD),
    "VIPS": dict(CN_VIPS),
    "SE": dict(SEA_ECOM),
    "CPNG": dict(KR_ECOM),
    "NTES": dict(CN_GAMES),
    "BIDU": dict(CN_BIDU),
    "TME": dict(CN_MUSIC),
    "BILI": dict(CN_VIDEO),
    "BZ": dict(CN_RECRUIT),
    "LI": dict(CN_EV),
    "XPEV": dict(CN_EV),
    # NIO BaaS/swap — energy partners tilt to fuel+gas/charging (label patched); keep off materials/components.
    "NIO": {
        **CN_EV,
        "energy": ["2688.HK", "0386.HK", "0857.HK"],
    },
    "ZTO": {
        **EXPRESS_DEFAULTS,
        # Hub dual-list 2057.HK must not appear on own stages; shippers stay external e-comm.
        "shippers": ["9988.HK", "9618.HK", "PDD"],
    },
    "YMM": dict(FREIGHT_DEFAULTS),
    "BEKE": {
        "traffic": ["0700.HK", "9888.HK", "1024.HK"],
        # Midland + big developers are rivals — agents = other developers as 新盤分銷夥伴 (label patch).
        "agents": ["0960.HK", "2007.HK", "0017.HK"],
        "transaction": ["0005.HK", "1398.HK", "0939.HK"],
        "proptech": ["3888.HK", "6060.HK", "9698.HK"],
        # Housing / mall demand — HK landlords (0014=Hysan 希慎; not CMPort 0144; not mislabeled Shekou).
        "housing": ["0014.HK", "0823.HK", "1997.HK"],
    },
    "YUMC": {
        "inputs": ["2319.HK", "0322.HK", "0151.HK"],
        "logistics": ["2057.HK", "1519.HK", "2618.HK"],
        "stores": ["0144.HK", "1109.HK", "0688.HK"],
        "payments": ["0005.HK", "1398.HK", "6060.HK"],
        # 3690 is rival — keep traffic on non-rival media/platforms.
        "traffic": ["0700.HK", "1024.HK", "9888.HK"],
    },
    "HTHT": {
        "inputs": ["2319.HK", "0322.HK", "1044.HK"],
        "logistics": ["2057.HK", "1519.HK", "0316.HK"],
        "stores": ["1109.HK", "0688.HK", "0960.HK"],
        "payments": ["0005.HK", "1398.HK", "6060.HK"],
        "traffic": ["TCOM", "0700.HK", "3690.HK"],
    },
    "FUTU": {
        # Venues = HKEX only; banks on data; insurers on buy-side; no cross-stage dups.
        "venues": ["0388.HK"],
        "data": ["0005.HK", "2388.HK", "1398.HK"],
        "tech": ["3888.HK", "6060.HK", "9698.HK"],
        "buy-side": ["1299.HK", "2318.HK"],
        "issuers": ["0700.HK", "9988.HK", "1810.HK"],
    },
    "GRAB": dict(SEA_SUPERAPP),
    "EDU": dict(CN_EDU),
    "TAL": dict(CN_EDU),
    "LU": {
        # Split bank rails vs platform partners — no cross-stage player dupes.
        "issuers": ["0005.HK", "1398.HK", "0939.HK"],
        "acquirers": ["0700.HK", "9988.HK", "1810.HK"],
        "merchant-tech": ["3888.HK", "9698.HK", "0788.HK"],
        "consumer": ["3690.HK", "2020.HK", "2331.HK"],
        "settlement": ["1288.HK", "3988.HK", "2388.HK"],
    },
}


def _trad_comp_rows(rows: list[list[str]]) -> list[list[str]]:
    out = []
    for ticker, zh, en in rows:
        out.append([ticker, traditionalize(zh), en])
    return out


# Applied after seed rebuild (hub-only label honesty).
HUB_STAGE_LABEL_OVERRIDES: dict[str, dict[str, dict[str, str]]] = {
    "FUTU": {
        "venues": {
            "label_zh": "交易場所／清算",
            "label_en": "Venue / clearing",
            "summary_zh": "港交所等交易場所與清算基礎設施（非對手券商）。",
            "summary_en": "HKEX venue/clearing infra — rival brokers stay on the rival arc.",
        },
        "data": {
            "label_zh": "結算／託管銀行",
            "label_en": "Settlement / custody banks",
            "summary_zh": "清算交收與託管銀行夥伴。",
            "summary_en": "Clearing/settlement and custody banks.",
        },
    },
    "BEKE": {
        "agents": {
            "label_zh": "新盤分銷夥伴",
            "label_en": "New-home distribution partners",
            "summary_zh": "外部新盤分銷／渠道夥伴（對手經紀與對手放在對手弧）。",
            "summary_en": "External new-home distribution partners — rival brokerages stay on the rival arc.",
        },
        "housing": {
            "label_zh": "住房／商場需求",
            "label_en": "Housing / retail demand",
            "summary_zh": "商場與物業需求週期代表（非對手開發商）。",
            "summary_en": "Mall/property demand-cycle proxies — rival developers stay on the rival arc.",
        },
    },
    "BIDU": {
        "infra": {
            "label_zh": "AI 雲／IDC 基建",
            "label_en": "AI Cloud / IDC infrastructure",
            "summary_zh": "支撐百度廣告與 AI 雲營收的外部雲／IDC／GPU 基建。",
            "summary_en": "External cloud/IDC/GPU under Baidu ads + AI Cloud revenue.",
        },
        "advertisers": {
            "label_zh": "搜尋／資訊流廣告主",
            "label_en": "Search / feed advertisers",
            "summary_zh": "在搜尋與資訊流投放的品牌廣告主（線上行銷主營收）。",
            "summary_en": "Brand advertisers on search/feed — core online-marketing revenue.",
        },
    },
    "NIO": {
        "energy": {
            "label_zh": "換電／充電能源",
            "label_en": "Battery-swap / charging energy",
            "summary_zh": "換電與充電網絡相關的外部能源／加氣充電夥伴（非自有換電站名單）。",
            "summary_en": "External energy partners for swap/charging networks — not own swap-station pads.",
        },
    },
}


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
        print(f"Patched stage labels on {n} Batch A hubs")
        return 0

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

    # Model defaults for new / corrected models.
    players["express-logistics-v1"] = {
        sid: list(ticks) for sid, ticks in EXPRESS_DEFAULTS.items()
    }
    players["freight-platform-v1"] = {
        sid: list(ticks) for sid, ticks in FREIGHT_DEFAULTS.items()
    }
    players["china-games-operator-v1"] = {
        sid: list(ticks) for sid, ticks in CN_GAMES.items()
    }
    players["china-music-platform-v1"] = {
        sid: list(ticks) for sid, ticks in CN_MUSIC.items()
    }
    players["china-video-community-v1"] = {
        sid: list(ticks) for sid, ticks in CN_VIDEO.items()
    }
    players["online-recruitment-v1"] = {
        sid: list(ticks) for sid, ticks in CN_RECRUIT.items()
    }
    players["china-education-services-v1"] = {
        sid: list(ticks) for sid, ticks in CN_EDU.items()
    }
    players["sea-superapp-v1"] = {
        sid: list(ticks) for sid, ticks in SEA_SUPERAPP.items()
    }
    # Fix rideshare default: platforms = fleet equipment, not rival apps.
    players["rideshare-v1"] = {
        "maps-cloud": ["GOOG", "MSFT", "AMZN"],
        "payments": ["V", "MA", "PYPL"],
        "supply": ["GM", "F", "TM"],
        "platforms": ["1211.HK", "3800.HK", "2688.HK"],
        "monetization": ["GOOG", "META", "AMZN"],
    }
    # china-platform-builder defaults (BIDU-shaped ads+cloud skeleton).
    players["china-platform-builder-v1"] = {
        sid: list(ticks) for sid, ticks in CN_BIDU.items()
    }

    ENT_PATH.write_text(json.dumps(entities, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    COMP_PATH.write_text(json.dumps(competitors, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    OVERRIDE_PATH.write_text(json.dumps(overrides, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    PLAYERS_PATH.write_text(json.dumps(players, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"Batch A prep: entities+={len(ENTITIES)}, competitors hubs={len(COMPETITORS)}, "
        f"overrides hubs={len(OVERRIDES)}; models sea-superapp/games/music/video/recruit/edu defaults"
    )
    missing = [t for t in BATCH_A if t not in COMPETITORS or t not in OVERRIDES]
    if missing:
        raise SystemExit(f"Missing Batch A hub coverage: {missing}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
