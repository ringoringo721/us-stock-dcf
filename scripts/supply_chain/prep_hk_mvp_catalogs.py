#!/usr/bin/env python3
"""Prep entities / competitors / player overrides for HK supply-chain MVP hubs.

China-major-market rule: if a hub’s major market is China (or HK/Asia), stage
players and rivals prefer CN / HK / regional listings — not US-company dumps.
Dual-listed names prefer .HK. Does not call FMP.
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

# Short Traditional Chinese brands; never Simplified.
ENTITIES: dict[str, dict[str, str]] = {
    # MVP hubs
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
    # Internet / content / cloud
    "9618.HK": {"name_en": "JD.com", "name_zh": "京東", "exchange": "HKEX"},
    "9888.HK": {"name_en": "Baidu", "name_zh": "百度", "exchange": "HKEX"},
    "9999.HK": {"name_en": "NetEase", "name_zh": "網易", "exchange": "HKEX"},
    "1024.HK": {"name_en": "Kuaishou", "name_zh": "快手", "exchange": "HKEX"},
    "9626.HK": {"name_en": "Bilibili", "name_zh": "嗶哩嗶哩", "exchange": "HKEX"},
    "3888.HK": {"name_en": "Kingsoft", "name_zh": "金山軟件", "exchange": "HKEX"},
    "9698.HK": {"name_en": "GDS", "name_zh": "萬國數據", "exchange": "HKEX"},
    "0772.HK": {"name_en": "China Literature", "name_zh": "閱文集團", "exchange": "HKEX"},
    "9899.HK": {"name_en": "Cloud Music", "name_zh": "雲音樂", "exchange": "HKEX"},
    "6618.HK": {"name_en": "JD Health", "name_zh": "京東健康", "exchange": "HKEX"},
    # Telco / devices
    "0762.HK": {"name_en": "China Unicom", "name_zh": "中國聯通", "exchange": "HKEX"},
    "0728.HK": {"name_en": "China Telecom", "name_zh": "中國電信", "exchange": "HKEX"},
    "0788.HK": {"name_en": "China Tower", "name_zh": "中國鐵塔", "exchange": "HKEX"},
    "0763.HK": {"name_en": "ZTE", "name_zh": "中興通訊", "exchange": "HKEX"},
    "2342.HK": {"name_en": "Comba", "name_zh": "京信通信", "exchange": "HKEX"},
    "0992.HK": {"name_en": "Lenovo", "name_zh": "聯想", "exchange": "HKEX"},
    "2018.HK": {"name_en": "AAC Technologies", "name_zh": "瑞聲科技", "exchange": "HKEX"},
    "2038.HK": {"name_en": "FIH Mobile", "name_zh": "富智康", "exchange": "HKEX"},
    "2382.HK": {"name_en": "Sunny Optical", "name_zh": "舜宇光學", "exchange": "HKEX"},
    "1478.HK": {"name_en": "Q Technology", "name_zh": "丘鈦科技", "exchange": "HKEX"},
    "0981.HK": {"name_en": "SMIC", "name_zh": "中芯國際", "exchange": "HKEX"},
    "1347.HK": {"name_en": "Hua Hong", "name_zh": "華虹半導體", "exchange": "HKEX"},
    "0522.HK": {"name_en": "ASMPT", "name_zh": "ASMPT", "exchange": "HKEX"},
    # Auto / battery
    "2015.HK": {"name_en": "Li Auto", "name_zh": "理想汽車", "exchange": "HKEX"},
    "9868.HK": {"name_en": "XPeng", "name_zh": "小鵬", "exchange": "HKEX"},
    "9866.HK": {"name_en": "NIO", "name_zh": "蔚來", "exchange": "HKEX"},
    "0175.HK": {"name_en": "Geely", "name_zh": "吉利汽車", "exchange": "HKEX"},
    "2333.HK": {"name_en": "Great Wall Motor", "name_zh": "長城汽車", "exchange": "HKEX"},
    "2238.HK": {"name_en": "GAC", "name_zh": "廣汽集團", "exchange": "HKEX"},
    "1114.HK": {"name_en": "Brilliance", "name_zh": "華晨中國", "exchange": "HKEX"},
    "1316.HK": {"name_en": "Nexteer", "name_zh": "耐世特", "exchange": "HKEX"},
    "1958.HK": {"name_en": "BAIC Motor", "name_zh": "北京汽車", "exchange": "HKEX"},
    "9863.HK": {"name_en": "Leapmotor", "name_zh": "零跑汽車", "exchange": "HKEX"},
    "3750.HK": {"name_en": "CATL", "name_zh": "寧德時代", "exchange": "HKEX"},
    "3800.HK": {"name_en": "GCL Technology", "name_zh": "協鑫科技", "exchange": "HKEX"},
    # Logistics / brands
    "2057.HK": {"name_en": "ZTO Express", "name_zh": "中通快遞", "exchange": "HKEX"},
    "1519.HK": {"name_en": "J&T Express", "name_zh": "極兔速遞", "exchange": "HKEX"},
    "0316.HK": {"name_en": "OOIL", "name_zh": "東方海外", "exchange": "HKEX"},
    "1308.HK": {"name_en": "SITC", "name_zh": "海豐國際", "exchange": "HKEX"},
    "0144.HK": {"name_en": "CMPort", "name_zh": "招商港口", "exchange": "HKEX"},
    "1919.HK": {"name_en": "COSCO Shipping Holdings", "name_zh": "中遠海控", "exchange": "HKEX"},
    "1138.HK": {"name_en": "COSCO Shipping Energy", "name_zh": "中遠海能", "exchange": "HKEX"},
    "2020.HK": {"name_en": "ANTA", "name_zh": "安踏", "exchange": "HKEX"},
    "2331.HK": {"name_en": "Li Ning", "name_zh": "李寧", "exchange": "HKEX"},
    "2319.HK": {"name_en": "Mengniu", "name_zh": "蒙牛", "exchange": "HKEX"},
    "1044.HK": {"name_en": "Hengan", "name_zh": "恒安國際", "exchange": "HKEX"},
    # Banks / insurance / brokers
    "1398.HK": {"name_en": "ICBC", "name_zh": "工商銀行", "exchange": "HKEX"},
    "0939.HK": {"name_en": "CCB", "name_zh": "建設銀行", "exchange": "HKEX"},
    "3988.HK": {"name_en": "Bank of China", "name_zh": "中國銀行", "exchange": "HKEX"},
    "1288.HK": {"name_en": "ABC", "name_zh": "農業銀行", "exchange": "HKEX"},
    "2388.HK": {"name_en": "BOCHK", "name_zh": "中銀香港", "exchange": "HKEX"},
    "2888.HK": {"name_en": "Standard Chartered", "name_zh": "渣打集團", "exchange": "HKEX"},
    "0023.HK": {"name_en": "Bank of East Asia", "name_zh": "東亞銀行", "exchange": "HKEX"},
    "2628.HK": {"name_en": "China Life", "name_zh": "中國人壽", "exchange": "HKEX"},
    "2328.HK": {"name_en": "PICC P&C", "name_zh": "人保財險", "exchange": "HKEX"},
    "1339.HK": {"name_en": "PICC Group", "name_zh": "中國人保", "exchange": "HKEX"},
    "0966.HK": {"name_en": "China Taiping", "name_zh": "中國太平", "exchange": "HKEX"},
    "2601.HK": {"name_en": "CPIC", "name_zh": "中國太保", "exchange": "HKEX"},
    "2378.HK": {"name_en": "Prudential", "name_zh": "保誠", "exchange": "HKEX"},
    "1508.HK": {"name_en": "China Re", "name_zh": "中國再保險", "exchange": "HKEX"},
    "6060.HK": {"name_en": "ZhongAn", "name_zh": "眾安在線", "exchange": "HKEX"},
    "1833.HK": {"name_en": "Ping An Good Doctor", "name_zh": "平安好醫生", "exchange": "HKEX"},
    "6030.HK": {"name_en": "CITIC Securities", "name_zh": "中信證券", "exchange": "HKEX"},
    "6886.HK": {"name_en": "Huatai Securities", "name_zh": "華泰證券", "exchange": "HKEX"},
    "3908.HK": {"name_en": "CICC", "name_zh": "中金公司", "exchange": "HKEX"},
    "1788.HK": {"name_en": "Guotai Junan Intl", "name_zh": "國泰君安國際", "exchange": "HKEX"},
    "1093.HK": {"name_en": "CSPC", "name_zh": "石藥集團", "exchange": "HKEX"},
    "1177.HK": {"name_en": "Sino Biopharm", "name_zh": "中國生物製藥", "exchange": "HKEX"},
    # Energy
    "0857.HK": {"name_en": "PetroChina", "name_zh": "中國石油", "exchange": "HKEX"},
    "2883.HK": {"name_en": "COSL", "name_zh": "中海油服", "exchange": "HKEX"},
    "3337.HK": {"name_en": "Anton Oilfield", "name_zh": "安東油田", "exchange": "HKEX"},
    "1033.HK": {"name_en": "Sinopec Oilfield Service", "name_zh": "中石化油服", "exchange": "HKEX"},
    "0338.HK": {"name_en": "Shanghai Petrochemical", "name_zh": "上海石化", "exchange": "HKEX"},
    "1088.HK": {"name_en": "China Shenhua", "name_zh": "中國神華", "exchange": "HKEX"},
    "1898.HK": {"name_en": "China Coal", "name_zh": "中煤能源", "exchange": "HKEX"},
    "1171.HK": {"name_en": "Yankuang Energy", "name_zh": "兗礦能源", "exchange": "HKEX"},
    "2688.HK": {"name_en": "ENN Energy", "name_zh": "新奧能源", "exchange": "HKEX"},
    "1193.HK": {"name_en": "CR Gas", "name_zh": "華潤燃氣", "exchange": "HKEX"},
    "0384.HK": {"name_en": "China Gas", "name_zh": "中國燃氣", "exchange": "HKEX"},
    "2899.HK": {"name_en": "Zijin Mining", "name_zh": "紫金礦業", "exchange": "HKEX"},
    # Regional non-HK (allowed when they supply/compete in CN market)
    "688036.SS": {"name_en": "Transsion", "name_zh": "傳音控股", "exchange": "SSE"},
    "002475.SZ": {"name_en": "Luxshare", "name_zh": "立訊精密", "exchange": "SZSE"},
    "005930.KS": {"name_en": "Samsung Electronics", "name_zh": "三星電子", "exchange": "KRX"},
    "2317.TW": {"name_en": "Hon Hai", "name_zh": "鴻海", "exchange": "TWSE"},
    "4938.TW": {"name_en": "Pegatron", "name_zh": "和碩", "exchange": "TWSE"},
    "TSM": {"name_en": "TSMC", "name_zh": "台積電", "exchange": "NYSE"},
    "PDD": {"name_en": "PDD", "name_zh": "拼多多", "exchange": "NASDAQ"},
    "TSLA": {"name_en": "Tesla", "name_zh": "特斯拉", "exchange": "NASDAQ"},
    "AAPL": {"name_en": "Apple", "name_zh": "蘋果", "exchange": "NASDAQ"},
    "ICE": {"name_en": "ICE", "name_zh": "洲際交易所", "exchange": "NYSE"},
    "CME": {"name_en": "CME", "name_zh": "芝商所", "exchange": "NASDAQ"},
    "1698.HK": {"name_en": "TME", "name_zh": "騰訊音樂", "exchange": "HKEX"},
    "0425.HK": {"name_en": "Minth", "name_zh": "敏實集團", "exchange": "HKEX"},
    "0868.HK": {"name_en": "Xinyi Glass", "name_zh": "信義玻璃", "exchange": "HKEX"},
    "0179.HK": {"name_en": "Johnson Electric", "name_zh": "德昌電機", "exchange": "HKEX"},
    "0934.HK": {"name_en": "Sinopec Kantons", "name_zh": "中石化冠德", "exchange": "HKEX"},
    "1060.HK": {"name_en": "Ali Pictures", "name_zh": "阿里影業", "exchange": "HKEX"},
    "2799.HK": {"name_en": "China CITIC Financial AMC", "name_zh": "中國中信金融資產", "exchange": "HKEX"},
}

# Product/market rivals — China/HK first; dual-list prefer .HK.
COMPETITORS: dict[str, list[list[str]]] = {
    "0700.HK": [
        ["9999.HK", "遊戲／互動娛樂對手", "Games / interactive entertainment rival"],
        ["1024.HK", "短影音／資訊流廣告對手", "Short-video / feed-ads rival"],
        ["9988.HK", "中國互聯網生態對手", "China internet ecosystem rival"],
        ["9888.HK", "搜尋／廣告對手", "Search / advertising rival"],
        ["9626.HK", "影音內容對手", "Video content rival"],
    ],
    "9988.HK": [
        ["9618.HK", "中國電商對手", "China e-commerce rival"],
        ["PDD", "下沉市場電商對手", "Value e-commerce rival"],
        ["0700.HK", "中國互聯網生態對手", "China internet ecosystem rival"],
        ["3690.HK", "本地生活／即時零售對手", "Local services / instant retail rival"],
        ["6618.HK", "醫藥電商／健康零售對手", "Health e-commerce rival"],
    ],
    "3690.HK": [
        ["9988.HK", "本地生活／即配生態對手（餓了麼等）", "Local services / delivery ecosystem rival"],
        ["9618.HK", "即時零售／物流對手", "Instant retail / logistics rival"],
        ["6618.HK", "即時零售／健康電商對手", "Instant retail / health commerce rival"],
        ["2057.HK", "快遞／末端配送對手", "Express / last-mile rival"],
        ["1519.HK", "快遞／末端配送對手", "Express / last-mile rival"],
    ],
    "1810.HK": [
        ["AAPL", "智慧手機／裝置生態對手（中國亦直接競爭）", "Smartphone rival also active in China"],
        ["005930.KS", "全球／中國手機對手", "Handset rival in China / global"],
        ["688036.SS", "新興市場量產 Android 對手", "Emerging-market Android OEM rival"],
        ["0992.HK", "PC／消費電子對手", "PC / consumer electronics rival"],
    ],
    "1211.HK": [
        ["2015.HK", "中國新勢力電動車對手", "China EV rival"],
        ["9868.HK", "中國新勢力電動車對手", "China EV rival"],
        ["9866.HK", "中國新勢力電動車對手", "China EV rival"],
        ["9863.HK", "中國新勢力電動車對手", "China EV rival"],
        ["0175.HK", "中國整車對手", "China auto OEM rival"],
        ["TSLA", "在華銷售之電動車對手", "EV rival with China sales"],
    ],
    "0941.HK": [
        ["0762.HK", "中國移動通信對手", "China wireless telecom rival"],
        ["0728.HK", "中國移動通信對手", "China wireless telecom rival"],
    ],
    "0005.HK": [
        ["2388.HK", "香港零售／企業銀行對手", "Hong Kong banking rival"],
        ["2888.HK", "亞洲國際銀行對手", "Asia international banking rival"],
        ["0023.HK", "香港銀行對手", "Hong Kong banking rival"],
        ["1398.HK", "中國大型銀行對手", "China megabank rival"],
        ["0939.HK", "中國大型銀行對手", "China megabank rival"],
    ],
    "2318.HK": [
        ["1299.HK", "壽險／綜合保險對手", "Life / multi-line insurance rival"],
        ["2628.HK", "中國壽險對手", "China life insurance rival"],
        ["2601.HK", "中國綜合保險對手", "China multi-line insurance rival"],
        ["2328.HK", "中國產險對手", "China P&C insurance rival"],
        ["0966.HK", "中國保險集團對手", "China insurance group rival"],
    ],
    "0388.HK": [
        # Thin international peers only — stages are HK capital-markets ecosystem.
        ["ICE", "國際交易所／清算對手", "International exchange / clearing peer"],
        ["CME", "國際衍生品交易所對手", "International derivatives exchange peer"],
    ],
    "0883.HK": [
        ["0857.HK", "中國上游油氣對手", "China upstream oil & gas rival"],
        ["0386.HK", "中國油氣一體化對手", "China integrated oil & gas rival"],
        ["1088.HK", "中國能源上游對手", "China energy upstream rival"],
        ["1171.HK", "中國能源上游對手", "China energy upstream rival"],
    ],
    "1299.HK": [
        ["2318.HK", "亞洲壽險／綜合保險對手", "Asia life / multi-line insurance rival"],
        ["2628.HK", "中國壽險對手", "China life insurance rival"],
        ["2601.HK", "中國綜合保險對手", "China multi-line insurance rival"],
        ["0966.HK", "中國保險集團對手", "China insurance group rival"],
        ["2378.HK", "亞洲壽險對手（港股）", "Asia life insurance rival (.HK)"],
    ],
    "0386.HK": [
        ["0857.HK", "中國油氣一體化對手", "China integrated oil & gas rival"],
        ["0883.HK", "中國上游油氣對手", "China upstream oil & gas rival"],
        ["1088.HK", "中國能源對手", "China energy rival"],
        ["1171.HK", "中國能源上游對手", "China energy upstream rival"],
    ],
}

# Default players for china-superapp-v1 (also written into sc_players.json).
CHINA_SUPERAPP_PLAYERS: dict[str, list[str]] = {
    "infra": ["9698.HK", "3888.HK", "0788.HK"],
    "content-ip": ["0772.HK", "1698.HK", "3888.HK"],  # 閱文／騰訊音樂／金山內容工具
    "distribution": ["0941.HK", "0762.HK", "1810.HK"],
    "fintech": ["0005.HK", "1398.HK", "6060.HK"],
    "advertisers": ["2020.HK", "2331.HK", "2319.HK"],
}

# Stage players: must fit the stage role for China/HK major market; rivals≠stage.
OVERRIDES: dict[str, dict[str, list[str]]] = {
    "0700.HK": {
        # china-superapp-v1 — WeChat/games/ads/fintech flow (not US internet dump).
        "infra": ["9698.HK", "3888.HK", "0788.HK"],
        "content-ip": ["0772.HK", "1698.HK", "3888.HK"],
        "distribution": ["0941.HK", "0762.HK", "1810.HK"],
        "fintech": ["0005.HK", "1398.HK", "6060.HK"],
        "advertisers": ["2020.HK", "2331.HK", "2319.HK"],
    },
    "9988.HK": {
        "supply": ["2020.HK", "2331.HK", "2319.HK"],
        "fulfillment": ["2057.HK", "1519.HK", "0144.HK"],
        "payments": ["6060.HK", "0388.HK", "0005.HK"],
        "traffic": ["9888.HK", "1024.HK", "9626.HK"],
        "lastmile": ["2057.HK", "1519.HK", "1308.HK"],
    },
    "3690.HK": {
        "maps-cloud": ["9888.HK", "3888.HK", "9698.HK"],
        "payments": ["6060.HK", "0388.HK", "0005.HK"],
        "supply": ["1211.HK", "0175.HK", "2333.HK"],
        "platforms": ["2319.HK", "2020.HK", "1044.HK"],  # CPG merchants on delivery, not rival apps
        "monetization": ["2020.HK", "2331.HK", "1044.HK"],
    },
    "1810.HK": {
        "materials": ["0981.HK", "1347.HK", "2899.HK"],
        "components": ["TSM", "2382.HK", "2018.HK"],
        "assembly": ["2317.TW", "002475.SZ", "2038.HK"],  # FIH = ODM supplier, not rival
        "distribution": ["1308.HK", "0316.HK", "0144.HK"],
        "retail": ["0762.HK", "0728.HK", "0941.HK"],
    },
    "1211.HK": {
        "materials": ["3750.HK", "2899.HK", "0868.HK"],
        "components": ["1316.HK", "0425.HK", "2018.HK"],
        "assembly": ["0425.HK", "0868.HK", "0179.HK"],  # Tier-1 parts — not rival OEMs
        "dealers": ["2688.HK", "1193.HK", "0384.HK"],  # energy/charging retail channels
        "energy": ["3750.HK", "2688.HK", "1193.HK"],
    },
    "0941.HK": {
        "equipment": ["0763.HK", "2342.HK", "0522.HK"],
        "towers": ["0788.HK", "2342.HK", "0763.HK"],
        "devices": ["1810.HK", "0992.HK", "2018.HK"],
        "content": ["0700.HK", "0772.HK", "1698.HK"],
        "customers": ["9988.HK", "3888.HK", "1398.HK"],
    },
    "0005.HK": {
        "funding": ["0388.HK", "6030.HK", "3908.HK"],
        "tech": ["0700.HK", "9988.HK", "3888.HK"],  # bank cloud/fintech — not SMIC foundry
        "payments": ["0700.HK", "6060.HK", "0388.HK"],
        "data-risk": ["0388.HK", "6030.HK", "2799.HK"],
        "channels": ["6030.HK", "6886.HK", "1788.HK"],
    },
    "2318.HK": {
        "reinsurance": ["1508.HK", "6060.HK", "0388.HK"],
        "data": ["0388.HK", "6030.HK", "0700.HK"],
        "investments": ["1398.HK", "0939.HK", "0388.HK"],
        "distribution": ["1398.HK", "0939.HK", "3988.HK"],
        "claims": ["1833.HK", "1093.HK", "1177.HK"],
    },
    "0388.HK": {
        "venues": ["6030.HK", "6886.HK", "3908.HK"],
        "data": ["6030.HK", "1788.HK", "3908.HK"],
        "tech": ["3888.HK", "0700.HK", "6060.HK"],  # not SMIC
        "buy-side": ["0005.HK", "1299.HK", "2318.HK"],
        "issuers": ["0700.HK", "9988.HK", "1810.HK"],
    },
    "0883.HK": {
        "services": ["2883.HK", "3337.HK", "1033.HK"],
        "upstream": ["2883.HK", "3337.HK", "1138.HK"],  # oilfield + crude shipping — not coal/miners
        "midstream": ["1138.HK", "1919.HK", "0316.HK"],
        "refining": ["0338.HK", "0934.HK", "2688.HK"],
        "marketing": ["2688.HK", "1193.HK", "0384.HK"],
    },
    "1299.HK": {
        "reinsurance": ["1508.HK", "6060.HK", "0388.HK"],
        "data": ["0388.HK", "6030.HK", "0700.HK"],
        "investments": ["0005.HK", "1398.HK", "0388.HK"],
        "distribution": ["0005.HK", "2388.HK", "2888.HK"],
        "claims": ["1833.HK", "1093.HK", "1177.HK"],
    },
    "0386.HK": {
        "services": ["1033.HK", "2883.HK", "3337.HK"],
        "upstream": ["2883.HK", "3337.HK", "1138.HK"],  # not coal/miners as fake upstream
        "midstream": ["1138.HK", "1919.HK", "0316.HK"],
        "refining": ["0338.HK", "0934.HK", "2688.HK"],  # 0338 = affiliate plant on stage, not rival
        "marketing": ["2688.HK", "1193.HK", "0384.HK"],
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

    players["china-superapp-v1"] = {sid: list(ticks) for sid, ticks in CHINA_SUPERAPP_PLAYERS.items()}

    ENT_PATH.write_text(json.dumps(entities, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    COMP_PATH.write_text(json.dumps(competitors, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    OVERRIDE_PATH.write_text(json.dumps(overrides, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    PLAYERS_PATH.write_text(json.dumps(players, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"Updated entities(+{len(ENTITIES)}), competitors hubs={len(COMPETITORS)}, "
        f"overrides hubs={len(OVERRIDES)}, model china-superapp-v1 players"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
