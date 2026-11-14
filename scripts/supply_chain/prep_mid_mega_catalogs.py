#!/usr/bin/env python3
"""Prep sc_entities / sc_competitors for US mid-mega ($50–100B) supply-chain seeds.

Extends mega catalogs with curated product/market rival sets and entity metadata.
Does not call FMP. Prefer Traditional Chinese name_zh; Latin brands OK when no
verified 繁中 short name exists (never English legal dumps).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(__file__).resolve().parent / "data"
UNIVERSE_PATH = ROOT / "cache" / "us_universe.json"
ZH_NAMES_PATH = ROOT / "cache" / "us_chinese_names.json"
INDEX_HTML = ROOT / "index.html"

ENT_PATH = DATA / "sc_entities.json"
COMP_PATH = DATA / "sc_competitors.json"

LEGAL_EN_NAME_RE = re.compile(
    r"\b(Inc\.?|Corp\.?|Corporation|Company|Ltd\.?|Limited|Holdings|PLC|N\.?V\.?|Group)\b",
    re.I,
)
LEGAL_EN_SUFFIX_STRIP_RE = re.compile(
    r"\b(Inc\.?|Incorporated|Corp\.?|Corporation|Company|Ltd\.?|Limited|Holdings|PLC|Group)\b",
    re.I,
)
STOCK_NAMES_BLOCK = re.compile(r"const STOCK_NAMES_ZH = \{([\s\S]*?)\n  \};")
STOCK_NAMES_ENTRY = re.compile(r'"([A-Z0-9.]+)":\s*"([^"]*)"')


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def short_brand_en(name_en: str, ticker: str) -> str:
    raw = (name_en or "").strip() or ticker
    # Hyphenated legal tails: "Associated Banc-Corp" → "Associated Bancorp"
    cleaned = re.sub(r"\b([Bb]anc)-Corp(?:oration)?\b", r"\1orp", raw)
    cleaned = re.sub(r"-\s*Corp(?:oration)?\.?\b", " ", cleaned, flags=re.I)
    cleaned = LEGAL_EN_SUFFIX_STRIP_RE.sub("", cleaned)
    cleaned = re.sub(r"\s+[.,](?=\s|$)", "", cleaned)
    cleaned = re.sub(r"(?:\s+&|\s+and)\s*$", "", cleaned, flags=re.I)
    cleaned = re.sub(r"[,\s]+$", "", cleaned).strip()
    cleaned = re.sub(r"\s{2,}", " ", cleaned)
    cleaned = re.sub(r"-$", "", cleaned).strip()
    if re.match(r"^The\s+\S+$", cleaned, flags=re.I):
        cleaned = re.sub(r"^The\s+", "", cleaned, flags=re.I).strip()
    return cleaned or ticker


def looks_like_english_legal_name(text: str) -> bool:
    raw = (text or "").strip()
    if not raw:
        return False
    if re.search(r"[\u4e00-\u9fff]", raw):
        return False
    if LEGAL_EN_NAME_RE.search(raw):
        return True
    words = [w for w in re.split(r"[\s&]+", raw) if w]
    if len(words) >= 4:
        return True
    return len(words) >= 3 and len(raw) >= 24


def load_stock_names_zh() -> dict[str, str]:
    block = STOCK_NAMES_BLOCK.search(INDEX_HTML.read_text(encoding="utf-8"))
    if not block:
        return {}
    return dict(STOCK_NAMES_ENTRY.findall(block.group(1)))


# Curated short English brands when universe legal names collapse to ticker stubs.
CURATED_NAME_EN: dict[str, str] = {
    "BNY": "BNY Mellon",
    "MRSH": "Marsh McLennan",
    "ASX": "ASE Technology",
    "MET": "MetLife",
    "AFL": "Aflac",
    "MFC": "Manulife",
    "AJG": "Arthur J. Gallagher",
    "AON": "Aon",
    "WTW": "WTW",
    "BRO": "Brown & Brown",
    "NTRS": "Northern Trust",
    "PRU": "Prudential Financial",
    "LNC": "Lincoln National",
    "SMFG": "SMFG",
    "ING": "ING",
    "ITUB": "Itaú Unibanco",
    "BCS": "Barclays",
    "LYG": "Lloyds",
    "DB": "Deutsche Bank",
    "NU": "Nubank",
    "RELX": "RELX",
    "NGG": "National Grid",
    "E": "Eni",
    "SU": "Suncor",
    "IMO": "Imperial Oil",
    "TAK": "Takeda",
    "ARGX": "argenx",
    "AMX": "América Móvil",
    "BAM": "Brookfield Asset Management",
    "BN": "Brookfield",
    "HOOD": "Robinhood",
    "MSI": "Motorola Solutions",
    "HWM": "Howmet",
    "PWR": "Quanta Services",
    "VRT": "Vertiv",
    "GWW": "Grainger",
    "FAST": "Fastenal",
    "URI": "United Rentals",
    "CRH": "CRH",
    "CTAS": "Cintas",
    "TT": "Trane Technologies",
    "WCN": "Waste Connections",
    "CLH": "Clean Harbors",
    "CWST": "Casella",
    "SRCL": "Stericycle",
    "UNF": "UniFirst",
    "ARMK": "Aramark",
    "ROL": "Rollins",
    "ABM": "ABM",
    "HCSG": "HCSG",
    "ADDYY": "Adidas",
    "UAA": "Under Armour",
    "DECK": "Deckers",
    "LULU": "Lululemon",
    "NOV": "NOV",
    "HAL": "Halliburton",
    "BKR": "Baker Hughes",
    "600584.SS": "JCET",
    "002156.SZ": "Tongfu Microelectronics",
    # short_brand_en mangled leftovers (Bugbot)
    "DE": "Deere",
    "SO": "Southern",
    "AIG": "AIG",
    "LLY": "Eli Lilly",
    "UNH": "UnitedHealth",
    "BA": "Boeing",
    "CG": "Carlyle",
    "GS": "Goldman Sachs",
    "HSY": "Hershey",
    "KO": "Coca-Cola",
    "MA": "Mastercard",
    "PGR": "Progressive",
    "QCOM": "Qualcomm",
    "SCHW": "Charles Schwab",
    "WFC": "Wells Fargo",
    "TMO": "Thermo Fisher",
    "ANSS": "Ansys",
    "PTC": "PTC",
    "FIG": "Figma",
    "CANVA": "Canva",
    "ADP": "ADP",
    "ASML": "ASML",
    "IBM": "IBM",
    "KKR": "KKR",
    "RTX": "RTX",
    "CSX": "CSX",
    "WTW": "WTW",
    "X": "U.S. Steel",
    "ALK": "Alaska Air",
    "PLUG": "Plug Power",
    "FCEL": "FuelCell Energy",
    "ASHTEAD": "Ashtead",
    "HEES": "H&E Equipment",
    "MSC": "MSC Industrial",
    "MYRG": "MYR Group",
    "NSA": "National Storage Affiliates",
    "GPI": "Group 1 Automotive",
    "GPC": "Genuine Parts",
    "KGC": "Kinross",
    "AU": "AngloGold Ashanti",
    "GFI": "Gold Fields",
    "ABM": "ABM",
    "HCSG": "HCSG",
    "VRSK": "Verisk",
}

# Curated 繁中 / Latin brands for mid-mega hubs + common peers (Bugbot lessons).
CURATED_NAME_ZH: dict[str, str] = {
    "ADBE": "Adobe",
    "AEM": "阿格納鷹礦業",
    "AEP": "美國電力",
    "AFL": "美國家庭人壽",
    "AJG": "Arthur J. Gallagher",
    "ALL": "Allstate",
    "AME": "AMETEK",
    "AMT": "美國電塔",
    "AMX": "美洲移動",
    "AON": "怡安",
    "APD": "空氣產品",
    "APO": "Apollo",
    "ARGX": "argenx",
    "ASX": "日月光投控",
    "600584.SS": "長電科技",
    "002156.SZ": "通富微電",
    "ANSS": "安西斯",
    "PTC": "參數科技",
    "FIG": "Figma",
    "CANVA": "Canva",
    "TMO": "賽默飛世爾",
    "ADSK": "歐特克",
    "CRM": "賽富時",
    "INTU": "直覺電腦",
    "CDNS": "益華電腦",
    "SNPS": "新思科技",
    "FTNT": "飛塔資訊",
    "PANW": "派拓網路",
    "ORCL": "甲骨文",
    "EA": "美商藝電",
    "NKE": "耐吉",
    "LULU": "露露檸檬",
    "ROST": "羅斯百貨",
    "HLT": "希爾頓",
    "GM": "通用汽車",
    "USB": "美國合眾銀行",
    "DUK": "杜克能源",
    "AEP": "美國電力",
    "WM": "廢品管理",
    "TEL": "泰科電子",
    "AZO": "汽車地帶",
    "ORLY": "奧萊利汽車",
    "COR": "信卡拉",
    "TTWO": "Take-Two 互動",
    "VRSK": "Verisk",
    "X": "美國鋼鐵",
    "ALK": "阿拉斯加航空",
    "PLUG": "Plug Power",
    "FCEL": "FuelCell Energy",
    "ASHTEAD": "Ashtead",
    "HEES": "H&E Equipment",
    "MSC": "MSC Industrial",
    "MYRG": "MYR Group",
    "NSA": "National Storage",
    "GPI": "Group 1 Automotive",
    "GPC": "GPC／NAPA",
    "KGC": "金羅斯",
    "AU": "安格洛黃金",
    "GFI": "金田",
    "B": "巴里克黃金",
    "BAM": "Brookfield Asset Management",
    "BCS": "巴克萊",
    "BDX": "碧迪",
    "BE": "Bloom Energy",
    "BN": "Brookfield",
    "BNY": "紐約梅隆銀行",
    "BSX": "波士頓科學",
    "CAH": "卡地納健康",
    "CCEP": "可口可樂歐洲太平洋",
    "CDNS": "Cadence",
    "CEG": "星座能源",
    "CI": "信諾",
    "CL": "高露潔",
    "CMCSA": "康卡斯特",
    "CMI": "康明斯",
    "CNI": "加拿大國家鐵路",
    "COR": "Cencora",
    "CP": "加拿大太平洋鐵路",
    "CRH": "CRH",
    "CSX": "CSX",
    "CTAS": "Cintas",
    "CVNA": "Carvana",
    "D": "Dominion Energy",
    "DAL": "達美航空",
    "DASH": "DoorDash",
    "DB": "德意志銀行",
    "DDOG": "Datadog",
    "DEO": "帝亞吉歐",
    "DLR": "Digital Realty",
    "DUK": "杜克能源",
    "E": "埃尼",
    "EBAY": "eBay",
    "ECL": "藝康",
    "ELV": "Elevance Health",
    "EMR": "艾默生",
    "EOG": "EOG Resources",
    "EPD": "Enterprise Products",
    "ETR": "Entergy",
    "EW": "Edwards Lifesciences",
    "FANG": "Diamondback",
    "FAST": "Fastenal",
    "FCX": "自由港麥克莫蘭",
    "FDX": "聯邦快遞",
    "FTNT": "Fortinet",
    "GD": "通用動力",
    "GLW": "康寧",
    "GM": "通用汽車",
    "GRMN": "Garmin",
    "GWW": "固安捷",
    "HLT": "希爾頓",
    "HON": "霍尼韋爾",
    "HOOD": "Robinhood",
    "HPE": "慧與",
    "HUM": "Humana",
    "HWM": "Howmet",
    "ICE": "洲際交易所",
    "IDXX": "IDEXX",
    "IMO": "Imperial Oil",
    "INFY": "Infosys",
    "ING": "ING 集團",
    "INTU": "Intuit",
    "ITUB": "Itaú Unibanco",
    "ITW": "伊利諾工具",
    "JCI": "江森自控",
    "KKR": "KKR",
    "KMI": "Kinder Morgan",
    "LNG": "Cheniere",
    "LYG": "勞埃德銀行",
    "MCO": "穆迪",
    "MDLZ": "億滋",
    "MELI": "MercadoLibre",
    "MET": "大都會人壽",
    "MFC": "宏利",
    "MMM": "3M",
    "MNST": "怪獸飲料",
    "MPLX": "MPLX",
    "MPWR": "Monolithic Power",
    "MRSH": "威達信",
    "MSI": "摩托羅拉解決方案",
    "MSTR": "MicroStrategy",
    "NDAQ": "納斯達克",
    "NET": "Cloudflare",
    "NGG": "國家電網",
    "NKE": "耐克",
    "NOC": "諾斯洛普·格魯曼",
    "NSC": "諾福克南方",
    "NTES": "網易",
    "NU": "Nubank",
    "NUE": "紐柯",
    "NXPI": "恩智浦",
    "O": "Realty Income",
    "OKE": "ONEOK",
    "ORLY": "O'Reilly",
    "OXY": "西方石油",
    "PCAR": "Paccar",
    "PNC": "PNC 金融",
    "PSA": "Public Storage",
    "PSX": "Phillips 66",
    "PWR": "Quanta Services",
    "RACE": "法拉利",
    "RCL": "皇家加勒比",
    "REGN": "再生元",
    "RELX": "RELX",
    "ROST": "Ross Stores",
    "RSG": "Republic Services",
    "SHW": "宣偉",
    "SLB": "斯倫貝謝",
    "SMFG": "三井住友金融",
    "SNOW": "Snowflake",
    "SNPS": "Synopsys",
    "SPG": "西蒙地產",
    "SRE": "Sempra",
    "SU": "Suncor",
    "TAK": "武田藥品",
    "TDG": "環球透博",
    "TEL": "TE Connectivity",
    "TFC": "Truist",
    "TGT": "塔吉特",
    "TRGP": "Targa Resources",
    "TRP": "TC Energy",
    "TRV": "旅行者",
    "TT": "Trane Technologies",
    "URI": "United Rentals",
    "USB": "美國合眾銀行",
    "VLO": "Valero",
    "VRT": "Vertiv",
    "WDC": "威騰電子",
    "WM": "Waste Management",
    "WMB": "Williams",
    "WPM": "惠頓貴金屬",
    "XEL": "Xcel Energy",
    # Extra peers often referenced
    "UAL": "聯合航空",
    "AAL": "美國航空",
    "LUV": "西南航空",
    "MAR": "萬豪",
    "CCL": "嘉年華郵輪",
    "NCLH": "挪威郵輪",
    "LULU": "Lululemon",
    "DECK": "Deckers",
    "SKX": "Skechers",
    "CHTR": "Charter",
    "DISH": "Dish",
    "WBD": "華納兄弟探索",
    "SNAP": "Snap",
    "BIDU": "百度",
    "CTSH": "高知特",
    "WIT": "Wipro",
    "TEAM": "Atlassian",
    "ZM": "Zoom",
    "CRWD": "CrowdStrike",
    "PANW": "Palo Alto Networks",
    "OKTA": "Okta",
    "ZS": "Zscaler",
    "HUBS": "HubSpot",
    "WDAY": "Workday",
    "NOW": "ServiceNow",
    "CRM": "Salesforce",
    "SAP": "SAP",
    "ORCL": "甲骨文",
    "IBM": "IBM",
    "ACN": "埃森哲",
    "CSCO": "思科",
    "JNPR": "瞻博網路",
    "HPQ": "惠普",
    "DELL": "戴爾",
    "SMCI": "超微電腦",
    "STX": "希捷",
    "SNDK": "SanDisk",
    "GFS": "GlobalFoundries",
    "AMKR": "Amkor",
    "KEYS": "是德科技",
    "TER": "泰瑞達",
    "ROK": "羅克韋爾",
    "PH": "派克漢尼汾",
    "ETN": "伊頓",
    "DOW": "陶氏",
    "VALE": "淡水河谷",
    "RIO": "力拓",
    "SCCO": "南方銅業",
    "GOLD": "巴里克（GOLD）",
    "NEM": "紐蒙特",
    "EQIX": "Equinix",
    "PLD": "普洛斯",
    "VTR": "Ventas",
    "DOC": "Healthpeak",
    "EQNR": "Equinor",
    "BP": "BP",
    "SHEL": "殼牌",
    "TTE": "道達爾能源",
    "CVX": "雪佛龍",
    "XOM": "艾克森美孚",
    "COP": "康菲",
    "HAL": "哈里伯頓",
    "BKR": "貝克休斯",
    "DVN": "Devon",
    "HES": "Hess",
    "MPC": "馬拉松石油",
    "PBF": "PBF Energy",
    "CNC": "Centene",
    "CVS": "CVS Health",
    "MCK": "麥克森",
    "WBA": "Walgreens",
    "ISRG": "直覺外科",
    "MDT": "美敦力",
    "SYK": "史賽克",
    "ZBH": "Zimmer Biomet",
    "JNJ": "嬌生",
    "PFE": "輝瑞",
    "MRK": "默沙東",
    "ABBV": "艾伯維",
    "BMY": "必治妥施貴寶",
    "AMGN": "安進",
    "LLY": "禮來",
    "NVO": "諾和諾德",
    "SNY": "賽諾菲",
    "VRTX": "Vertex",
    "GILD": "吉利德",
    "BA": "波音",
    "LMT": "洛克希德·馬丁",
    "RTX": "RTX",
    "GE": "通用電氣",
    "RKLB": "Rocket Lab",
    "LHX": "L3Harris",
    "TXT": "德事隆",
    "HEI": "HEICO",
    "AXON": "Axon",
    "CB": "丘博保險",
    "PGR": "Progressive",
    "AIG": "美國國際集團",
    "BRK-B": "波克夏·海瑟威",
    "BX": "黑石",
    "BLK": "貝萊德",
    "STT": "道富",
    "TROW": "T. Rowe Price",
    "CG": "凱雷集團",
    "SCHW": "嘉信理財",
    "IBKR": "盈透證券",
    "GS": "高盛",
    "MS": "摩根士丹利",
    "JPM": "摩根大通",
    "BAC": "美國銀行",
    "WFC": "富國銀行",
    "C": "花旗集團",
    "UBS": "瑞銀",
    "RY": "加拿大皇家銀行",
    "TD": "多倫多道明銀行",
    "MFG": "瑞穗金融",
    "MUFG": "三菱日聯",
    "SO": "南方公司",
    "NEE": "NextEra Energy",
    "EXC": "Exelon",
    "PEG": "PSEG",
    "WEC": "WEC Energy",
    "ED": "Con Edison",
    "PCG": "PG&E",
    "DTE": "DTE Energy",
    "ES": "Eversource",
    "FE": "FirstEnergy",
    "CMS": "CMS Energy",
    "NI": "NiSource",
    "LNT": "Alliant",
    "ATO": "Atmos",
    "CNP": "CenterPoint",
    "VST": "Vistra",
    "UNP": "聯合太平洋",
    "CAT": "卡特彼勒",
    "DE": "迪爾",
    "CNHI": "CNH 工業",
    "AGCO": "愛科",
    "ODFL": "Old Dominion",
    "XPO": "XPO",
    "JBHT": "J.B. Hunt",
    "CHRW": "C.H. Robinson",
    "EXPD": "Expeditors",
    "KMB": "金百利",
    "EL": "雅詩蘭黛",
    "KO": "可口可樂",
    "PEP": "百事",
    "BUD": "百威英博",
    "KHC": "卡夫亨氏",
    "GIS": "通用磨坊",
    "HSY": "好時",
    "TSN": "泰森食品",
    "SYY": "Sysco",
    "KR": "Kroger",
    "BJ": "BJ's",
    "COST": "好市多",
    "WMT": "沃爾瑪",
    "AMZN": "亞馬遜",
    "BABA": "阿里巴巴",
    "PDD": "拼多多",
    "LOW": "勞氏",
    "HD": "家得寶",
    "FND": "Floor & Decor",
    "BBY": "百思買",
    "TM": "豐田",
    "F": "福特",
    "HMC": "本田",
    "RIVN": "Rivian",
    "LYFT": "Lyft",
    "UBER": "Uber",
    "ABNB": "Airbnb",
    "BKNG": "Booking",
    "SPOT": "Spotify",
    "NFLX": "網飛",
    "DIS": "迪士尼",
    "META": "Meta (臉書)",
    "GOOG": "Alphabet（Google）",
    "MSFT": "微軟",
    "AAPL": "蘋果",
    "NVDA": "輝達",
    "AMD": "超微半導體",
    "INTC": "英特爾",
    "AVGO": "博通",
    "QCOM": "高通",
    "MRVL": "邁威爾",
    "ARM": "Arm",
    "MU": "美光",
    "TSM": "台積電",
    "AMAT": "應用材料",
    "LRCX": "拉姆研究",
    "KLAC": "科磊",
    "ASML": "ASML",
    "TXN": "德州儀器",
    "ADI": "亞德諾",
    "ON": "安森美",
    "MCHP": "微芯科技",
    "SWKS": "Skyworks",
    "QRVO": "Qorvo",
    "STM": "意法半導體",
    "IFX.DE": "英飛凌",
    "2303.TW": "聯電",
    "3711.TW": "日月光投控",
    "005930.KS": "三星電子",
    "000660.KS": "SK 海力士",
    "1211.HK": "比亞迪",
    "0700.HK": "騰訊",
    "005380.KS": "現代汽車",
    "8035.T": "東京威力科創",
    "4063.T": "信越化學",
    "2317.TW": "鴻海",
    "4938.TW": "和碩",
    "002475.SZ": "立訊精密",
    "AVT": "艾睿電子",
    "ARW": "安富利",
    "SNX": "SYNNEX",
    "PAYX": "培沛客",
    "ADP": "ADP",
    "FIS": "Fidelity National Info",
    "FISV": "Fiserv",
    "GPN": "Global Payments",
    "PYPL": "PayPal",
    "AXP": "美國運通",
    "V": "Visa",
    "MA": "Mastercard",
    "COF": "Capital One",
    "DFS": "Discover",
    "SE": "Sea",
    "SHOP": "Shopify",
    "SQ": "Block",
    "AFRM": "Affirm",
    "TOST": "Toast",
    "RBLX": "Roblox",
    "EA": "電子藝界",
    "TTWO": "Take-Two",
    "U": "Unity",
    "ZG": "Zillow",
    "CSGP": "CoStar",
    "CBRE": "CBRE",
    "JLL": "仲量聯行",
    "WY": "Weyerhaeuser",
    "CCI": "Crown Castle",
    "SBAC": "SBA Communications",
    "IRM": "Iron Mountain",
    "VICI": "VICI Properties",
    "EXR": "Extra Space",
    "AVB": "AvalonBay",
    "EQR": "Equity Residential",
    "WELL": "Welltower",
    "INVH": "Invitation Homes",
    "MAA": "Mid-America Apartment",
    "ESS": "Essex",
    "UDR": "UDR",
    "CPT": "Camden",
    "ARE": "Alexandria",
    "BXP": "Boston Properties",
    "SLG": "SL Green",
    "KIM": "Kimco",
    "REG": "Regency Centers",
    "FRT": "Federal Realty",
    "MAC": "Macerich",
    "NNN": "NNN REIT",
    "ADC": "Agree Realty",
    "WPC": "W. P. Carey",
    "STOR": "STORE Capital",
    "GLPI": "Gaming and Leisure Properties",
}


# Peer groups: true product/market rivals. Order = preference.
PEER_GROUPS: list[tuple[str, list[str], str, str]] = [
    # (group_id unused; list, basis_zh, basis_en)
    ("util-reg", ["DUK", "NEE", "SO", "AEP", "D", "NGG", "XEL", "ETR", "EXC", "PEG"], "受規管電力對手", "Regulated electric rival"),
    ("util-div", ["SRE", "D", "NEE", "AEP", "XEL", "PCG", "ED"], "多元公用事業對手", "Diversified utility rival"),
    ("util-ipp", ["CEG", "VST", "NEE", "SO", "DUK", "AEP"], "獨立發電／潔淨發電對手", "IPP / clean-generation rival"),
    ("bank-us-reg", ["USB", "PNC", "TFC", "BAC", "WFC", "C", "JPM"], "美國區域／綜合銀行對手", "US regional/diversified bank rival"),
    ("bank-eu", ["ING", "BCS", "LYG", "DB", "UBS", "SAN", "HSBC"], "歐洲銀行對手", "European bank rival"),
    ("bank-latam", ["ITUB", "NU", "BCS", "C", "JPM", "BAC"], "拉美數位／綜合銀行對手", "LatAm digital/diversified bank rival"),
    ("bank-jp", ["SMFG", "MUFG", "MFG", "JPM", "HSBC"], "日本綜合銀行對手", "Japanese mega-bank rival"),
    ("custody-am", ["BNY", "STT", "BLK", "JPM", "BAC", "NTRS"], "託管／資產服務對手", "Custody / asset-servicing rival"),
    ("exchanges", ["ICE", "NDAQ", "CBOE", "CME", "SPGI", "MCO"], "交易所／市場基礎設施對手", "Exchange / market-infra rival"),
    ("ratings", ["MCO", "SPGI", "MSCI", "ICE", "NDAQ"], "評級／指數數據對手", "Ratings / index-data rival"),
    ("brokerage", ["HOOD", "SCHW", "IBKR", "MS", "GS"], "零售券商／交易對手", "Retail brokerage / trading rival"),
    ("alt-am", ["KKR", "BX", "APO", "BN", "BAM", "CG", "BLK"], "另類資產管理對手", "Alternative asset-manager rival"),
    ("ins-pc", ["TRV", "ALL", "PGR", "CB", "AIG", "BRK-B"], "產險對手", "P&C insurance rival"),
    ("ins-life", ["MET", "AFL", "MFC", "PRU", "LNC", "AIG"], "壽險對手", "Life insurance rival"),
    ("ins-broker", ["MRSH", "AON", "AJG", "WTW", "BRO"], "保險經紀對手", "Insurance brokerage rival"),
    ("managed-care", ["ELV", "UNH", "CI", "HUM", "CNC", "CVS"], "醫療保險對手", "Managed-care rival"),
    ("drug-dist", ["COR", "CAH", "MCK", "CVS", "WBA"], "藥品通路對手", "Drug distribution rival"),
    ("pharma-big", ["REGN", "VRTX", "AMGN", "GILD", "ABBV", "LLY", "MRK", "PFE"], "生物製藥對手", "Biopharma rival"),
    ("pharma-jp", ["TAK", "NVS", "SNY", "PFE", "MRK", "JNJ", "BMY"], "Specialty／全球藥廠對手", "Specialty / global pharma rival"),
    ("pharma-eu-biotech", ["ARGX", "REGN", "VRTX", "BNTX", "MRNA", "AMGN"], "免疫／生物製藥對手", "Immunology / biotech rival"),
    ("medtech-dev", ["BSX", "MDT", "SYK", "ABT", "EW", "ZBH", "ISRG"], "醫療器材對手", "Medtech device rival"),
    ("medtech-dx", ["IDXX", "TMO", "DHR", "BDX", "A", "IQV"], "診斷／生命科學工具對手", "Diagnostics / life-science tools rival"),
    ("medtech-sup", ["BDX", "ABT", "MDT", "SYK", "BAX", "RMD"], "醫療耗材對手", "Medical supplies rival"),
    # More-specific SaaS peer sets first — HUB_TO_GROUPS keeps the first registration.
    ("saas-eda", ["CDNS", "SNPS", "ANSS", "KEYS", "TER"], "EDA／設計軟體對手", "EDA / design software rival"),
    ("saas-cad", ["ADSK", "ANSS", "PTC", "MSFT", "ORCL"], "設計／工程軟體對手", "Design / engineering software rival"),
    ("saas-sec", ["FTNT", "CRWD", "PANW", "ZS", "OKTA", "NET"], "資安對手", "Cybersecurity rival"),
    ("saas-data", ["SNOW", "DDOG", "PLTR", "MSFT", "GOOG", "AMZN", "MDB"], "資料雲／觀測對手", "Data cloud / observability rival"),
    ("saas-edge", ["NET", "AMZN", "MSFT", "GOOG", "AKAM", "FTNT"], "邊緣雲／CDN 安全對手", "Edge cloud / CDN security rival"),
    ("saas-fin", ["INTU", "ADP", "PAYX", "MSFT", "ORCL", "SAP"], "財稅／中小企業軟體對手", "Fintech / SMB software rival"),
    ("saas-bi", ["MSTR", "MSFT", "GOOG", "SNOW", "PLTR", "IBM"], "商業智慧／分析軟體對手", "BI / analytics software rival"),
    # Creative Cloud / design-tool rivals only — no CAE/PLM (ANSS/PTC) and no general SaaS.
    ("saas-creative", ["ADBE", "ADSK", "FIG", "CANVA", "AFFINITY", "CORELDRAW"], "創意／設計軟體對手", "Creative / design software rival"),
    ("it-svc", ["INFY", "ACN", "CTSH", "IBM", "WIT", "MSFT"], "IT 服務對手", "IT services rival"),
    ("semi-fabless", ["NXPI", "TXN", "ADI", "ON", "MCHP", "IFX.DE", "STM"], "車用／工業類比半導體對手", "Auto/industrial analog semi rival"),
    ("semi-power", ["MPWR", "TXN", "ADI", "ON", "NXPI", "IFX.DE"], "電源管理半導體對手", "Power-management semi rival"),
    # ASX is the ADR of 3711.TW (日月光) — never list them as rivals of each other.
    ("semi-osat", ["ASX", "AMKR", "600584.SS", "002156.SZ", "TSM", "GFS"], "封測／先進封裝對手", "OSAT / advanced packaging rival"),
    ("semi-mem", ["WDC", "STX", "MU", "SNDK", "000660.KS", "005930.KS"], "儲存／記憶體對手", "Storage / memory rival"),
    ("hw-conn", ["TEL", "APH", "GLW", "AMAT", "KEYS"], "連接器／材料對手", "Connectivity / materials rival"),
    ("hw-glass", ["GLW", "APH", "TEL", "AMAT", "ASML"], "特種玻璃／光學材料對手", "Specialty glass / optics materials rival"),
    ("hw-radio", ["MSI", "CSCO", "ERIC", "NOK", "JNPR", "ANET"], "任務通訊／網路設備對手", "Mission-critical comms / networking rival"),
    ("hw-server", ["HPE", "DELL", "HPQ", "IBM", "SMCI", "NTAP"], "伺服器／企業硬體對手", "Server / enterprise hardware rival"),
    ("hw-gps", ["GRMN", "AAPL", "GOOG", "005930.KS", "SONY"], "穿戴／消費電子對手", "Wearables / CE rival"),
    ("aero-prime", ["GD", "NOC", "LMT", "RTX", "BA", "HII"], "航太防務主承包對手", "Aerospace & defense prime rival"),
    ("aero-tier", ["HWM", "TDG", "BA", "RTX", "GE", "LHX"], "航太結構／零件對手", "Aero structures / parts rival"),
    ("aero-tdg", ["TDG", "HWM", "HEI", "BA", "RTX", "GE"], "航太後市場零件對手", "Aero aftermarket parts rival"),
    ("energy-refine", ["VLO", "PSX", "MPC", "XOM", "CVX", "PBF"], "煉油／行銷對手", "Refining / marketing rival"),
    ("energy-e&p", ["EOG", "OXY", "FANG", "COP", "DVN", "HES", "XOM"], "上游勘探開發對手", "E&P rival"),
    ("energy-mid", ["WMB", "EPD", "KMI", "OKE", "TRP", "TRGP", "MPLX", "LNG"], "中游管線／天然氣對手", "Midstream / gas infrastructure rival"),
    ("energy-lng", ["LNG", "SHEL", "BP", "TTE", "XOM", "CVX"], "LNG 出口對手", "LNG export rival"),
    ("energy-int", ["E", "SU", "IMO", "XOM", "CVX", "SHEL", "BP", "TTE"], "綜合石油對手", "Integrated oil rival"),
    ("energy-ofs", ["SLB", "HAL", "BKR", "NOV", "XOM", "CVX"], "油服對手", "Oilfield services rival"),
    # Prefer listing ticker B (Barrick Mining); gold peers only — no copper names (SCCO/FCX).
    ("materials-gold", ["AEM", "NEM", "WPM", "B", "KGC", "AU", "GFI"], "金礦／貴金屬對手", "Gold / precious-metals rival"),
    ("materials-cu", ["FCX", "SCCO", "BHP", "RIO", "TECK", "NEM"], "銅礦對手", "Copper mining rival"),
    # Industrial-gas hubs first so APD/LIN do not inherit coatings rivals from materials-chem.
    ("materials-indgas", ["APD", "LIN", "AIQUY", "NPNYY", "4091.T"], "工業氣體對手", "Industrial gases rival"),
    ("materials-chem", ["ECL", "SHW", "PPG", "DD", "DOW", "CTVA"], "特用化學／塗料對手", "Specialty chem / coatings rival"),
    ("materials-steel", ["NUE", "X", "CLF", "STLD", "MT"], "鋼鐵對手", "Steel rival"),
    ("materials-build", ["CRH", "VMC", "MLM", "SHW", "APD"], "建材對手", "Building materials rival"),
    ("ind-mach", ["EMR", "HON", "TT", "ITW", "ETN", "ROK", "PH", "CMI", "PCAR"], "工業自動化／機械對手", "Industrial automation / machinery rival"),
    ("ind-hvac", ["TT", "JCI", "CARR", "HON", "EMR"], "暖通空調對手", "HVAC rival"),
    ("ind-powertrain", ["CMI", "PCAR", "CAT", "DE", "ETN"], "動力總成／重卡對手", "Powertrain / heavy truck rival"),
    ("ind-truck", ["PCAR", "CMI", "CAT", "DE", "VOLV-B.ST"], "重卡對手", "Heavy truck rival"),
    ("ind-conglom", ["MMM", "HON", "GE", "ITW", "EMR"], "工業綜合企業對手", "Industrial conglomerate rival"),
    ("ind-waste", ["WM", "RSG", "WCN", "CLH", "CWST", "SRCL"], "廢棄物管理對手", "Waste management rival"),
    ("ind-logistics", ["UPS", "FDX", "AMZN", "JBHT", "ODFL", "XPO"], "快遞／物流對手", "Parcel / logistics rival"),
    ("ind-rail", ["CSX", "UNP", "NSC", "CP", "CNI"], "北美一級鐵路對手", "North America Class I rail rival"),
    ("ind-dist", ["GWW", "FAST", "MSC", "WMT", "AMZN"], "工業通路對手", "Industrial distribution rival"),
    ("ind-rental", ["URI", "ASHTEAD", "HEES", "CAT", "DE"], "設備租賃對手", "Equipment rental rival"),
    ("ind-epc", ["PWR", "EME", "MYRG", "ETN", "VRT"], "電力基建 EPC 對手", "Power-infra EPC rival"),
    ("ind-datacenter", ["VRT", "ETN", "EMR", "HON", "CEG"], "資料中心電力／冷卻對手", "Datacenter power / cooling rival"),
    ("ind-fuelcell", ["BE", "PLUG", "FCEL", "ETN", "GEV"], "燃料電池／潔淨電力對手", "Fuel-cell / clean-power rival"),
    ("ind-elec", ["AME", "ETN", "EMR", "ROK", "PH"], "精密電氣／儀器對手", "Precision electrical / instruments rival"),
    ("ind-svc", ["CTAS", "UNF", "ARMK", "ROL", "ABM", "HCSG"], "制服／設施服務對手", "Uniform / facility-services rival"),
    ("ind-info", ["RELX", "TRI", "SPGI", "MCO", "ICE", "NDAQ"], "專業資訊／風險數據對手", "Professional info / risk-data rival"),
    ("staples-bev", ["MNST", "KO", "PEP", "CELH", "KDP", "CCEP"], "非酒精飲料對手", "Non-alcoholic beverage rival"),
    ("staples-ccep", ["CCEP", "KO", "PEP", "MNST", "KDP"], "瓶裝／飲料通路對手", "Bottler / beverage-channel rival"),
    ("staples-snack", ["MDLZ", "HSY", "GIS", "KHC", "PEP", "KO"], "零食／包裝食品對手", "Snacks / packaged-food rival"),
    ("staples-hpc", ["CL", "PG", "UL", "KMB", "EL"], "日用品對手", "Household / personal-care rival"),
    ("staples-spirits", ["DEO", "STZ", "BF-B", "BUD", "TAP"], "烈酒對手", "Spirits rival"),
    ("disc-cruise", ["RCL", "CCL", "NCLH", "MAR", "HLT"], "郵輪／休閒旅遊對手", "Cruise / leisure-travel rival"),
    ("disc-hotel", ["HLT", "MAR", "H", "IHG", "ABNB"], "飯店對手", "Hotel rival"),
    ("disc-apparel", ["NKE", "LULU", "DECK", "UAA", "ADDYY"], "運動鞋服對手", "Athletic apparel rival"),
    ("disc-air", ["DAL", "UAL", "AAL", "LUV", "ALK"], "航空公司對手", "Airline rival"),
    ("disc-auto-deal", ["CVNA", "KMX", "AN", "GPI", "PAG"], "汽車零售對手", "Auto retail rival"),
    ("disc-delivery", ["DASH", "UBER", "LYFT", "AMZN", "ABNB"], "即時配送／出行對手", "Delivery / mobility rival"),
    ("auto-oem", ["GM", "F", "TM", "TSLA", "HMC", "RACE", "1211.HK"], "整車對手", "Auto OEM rival"),
    ("auto-luxury", ["RACE", "TM", "GM", "BMW.DE", "MBG.DE", "TSLA"], "超跑／豪華車對手", "Supercar / luxury OEM rival"),
    ("ecom-latam", ["MELI", "AMZN", "BABA", "SE", "SHOP"], "電商平台對手", "E-commerce platform rival"),
    # GPC = Genuine Parts (NAPA); never WACLY (Wacoal ADR ≠ Watsco).
    ("ecom-auto-parts", ["ORLY", "AZO", "AAP", "GPC", "AMZN"], "汽車售後零件對手", "Auto aftermarket parts rival"),
    ("ecom-disc", ["TGT", "WMT", "COST", "AMZN", "DG", "DLTR"], "折扣零售對手", "Discount retail rival"),
    ("ecom-market", ["EBAY", "AMZN", "SHOP", "ETSY", "BABA"], "線上市集對手", "Online marketplace rival"),
    ("apparel-off", ["ROST", "TJX", "BURL", "GPS", "ANF"], "平價服飾零售對手", "Off-price apparel retail rival"),
    ("telecom-cable", ["CMCSA", "CHTR", "T", "VZ", "TMUS", "DISH"], "有線／寬頻對手", "Cable / broadband rival"),
    ("telecom-latam", ["AMX", "T", "VZ", "TMUS", "TEF"], "拉美電信對手", "LatAm telecom rival"),
    ("reit-tower", ["AMT", "CCI", "SBAC", "EQIX", "DLR"], "電塔／通訊基礎設施對手", "Tower / comms-infra REIT rival"),
    ("reit-dc", ["DLR", "EQIX", "AMT", "PLD", "IRM"], "資料中心 REIT 對手", "Datacenter REIT rival"),
    ("reit-storage", ["PSA", "EXR", "CUBE", "NSA", "PLD"], "自助倉儲 REIT 對手", "Self-storage REIT rival"),
    ("reit-retail", ["SPG", "O", "KIM", "REG", "FRT", "NNN"], "零售 REIT 對手", "Retail REIT rival"),
    ("gaming", ["NTES", "0700.HK", "EA", "TTWO", "RBLX", "U"], "遊戲／互動娛樂對手", "Gaming / interactive entertainment rival"),
]


# Explicit hub → preferred peer-group membership (first matching group used as primary).
HUB_TO_GROUPS: dict[str, list[str]] = {}
for gid, members, _zh, _en in PEER_GROUPS:
    for t in members:
        HUB_TO_GROUPS.setdefault(t, []).append(gid)

GROUP_BY_ID = {gid: (members, zh, en) for gid, members, zh, en in PEER_GROUPS}


def mid_mega_rows(stocks: list[dict]) -> list[dict]:
    rows = [r for r in stocks if 50e9 <= float(r.get("marketCap") or 0) < 100e9]
    rows.sort(key=lambda r: -float(r["marketCap"]))
    return rows


def rivals_for(ticker: str, n: int = 5) -> list[tuple[str, str, str]]:
    """Pick 4–6 product/market rivals from peer groups; pad from related groups."""
    seen: list[tuple[str, str, str]] = []
    used = {ticker}
    # First registered group is the primary industry peer set (see PEER_GROUPS order).
    group_ids = (HUB_TO_GROUPS.get(ticker) or [])[:1]
    for gid in group_ids:
        members, zh, en = GROUP_BY_ID[gid]
        for peer in members:
            if peer in used:
                continue
            seen.append((peer, zh, en))
            used.add(peer)
            if len(seen) >= n:
                return seen[:n]
    # Pad from other groups sharing peers already picked
    if len(seen) < 4:
        for gid, members, zh, en in PEER_GROUPS:
            if ticker not in members and not any(p in members for p, _, _ in seen):
                continue
            for peer in members:
                if peer in used:
                    continue
                seen.append((peer, zh, en))
                used.add(peer)
                if len(seen) >= n:
                    return seen[:n]
    return seen[:n]


def resolve_name_zh(ticker: str, name_en: str, stock_zh: dict, file_zh: dict) -> str:
    # Hard fixes always win (wrong STOCK_NAMES collisions, required 繁中 brands).
    hard = {
        "CI": "信諾",
        "TDG": "環球透博",  # never Trimble 天寶
        "EQIX": "Equinix",  # Latin — never IQVIA 艾昆緯 / Cadence 易華電腦
        "IQV": "艾昆緯",
        "CDNS": "益華電腦",
        "BHP": "必和必拓",
        "ANSS": "安西斯",
        "PTC": "參數科技",
        "ADSK": "歐特克",
        "IBM": "IBM",
        "LIN": "林德集團",
        "AIQUY": "液化空氣",
        "NPNYY": "日本酸素",
        "4091.T": "日本酸素控股",
    }
    if ticker in hard:
        return hard[ticker]

    def _cjk(text: str) -> bool:
        return bool(re.search(r"[\u4e00-\u9fff]", text or ""))

    # Prefer verified STOCK_NAMES_ZH / us_chinese_names when they already have 繁中.
    for cand in (
        stock_zh.get(ticker),
        (file_zh.get(ticker) or {}).get("name_zh") if isinstance(file_zh.get(ticker), dict) else file_zh.get(ticker),
        CURATED_NAME_ZH.get(ticker),
    ):
        if isinstance(cand, str) and cand.strip() and _cjk(cand):
            # Block known wrong collision even if it slipped into stock map.
            if ticker == "TDG" and "天寶" in cand:
                return "環球透博"
            return cand.strip()

    if ticker in CURATED_NAME_ZH:
        return CURATED_NAME_ZH[ticker]
    short = short_brand_en(name_en, ticker)
    if looks_like_english_legal_name(short):
        return ticker
    return short


def _looks_mangled_brand(name_en: str) -> bool:
    raw = (name_en or "").strip()
    if not raw:
        return True
    if raw.endswith("&") or re.search(r"\band$", raw, re.I):
        return True
    if re.match(r"^The\s+\S+$", raw, re.I):
        return True
    if re.search(r"\bIncorporated\b", raw, re.I):
        return True
    return False


def ensure_entity(entities: dict, ticker: str, uni: dict, stock_zh: dict, file_zh: dict) -> None:
    if ticker.startswith("_"):
        return
    pe = entities.get(ticker) or {}
    row = uni.get(ticker) or {}
    if ticker in CURATED_NAME_EN:
        name_en = CURATED_NAME_EN[ticker]
    else:
        name_en = (pe.get("name_en") or "").strip() or row.get("name") or ticker
        if looks_like_english_legal_name(name_en) or _looks_mangled_brand(name_en):
            # Prefer universe legal → improved short_brand_en when pe already mangled.
            src = row.get("name") or name_en
            name_en = short_brand_en(src, ticker)
            if looks_like_english_legal_name(name_en) or _looks_mangled_brand(name_en):
                name_en = ticker
    name_zh = resolve_name_zh(ticker, name_en, stock_zh, file_zh)
    if looks_like_english_legal_name(name_zh):
        name_zh = CURATED_NAME_ZH.get(ticker) or ticker
    exchange = pe.get("exchange") or row.get("exchange") or ""
    # Off-universe peers: keep prior exchange or mark common ADR/foreign
    if not exchange:
        if ticker.endswith(".TW"):
            exchange = "TWSE"
        elif ticker.endswith(".KS"):
            exchange = "KRX"
        elif ticker.endswith(".HK"):
            exchange = "HKEX"
        elif ticker.endswith(".SS") or ticker.endswith(".SZ"):
            exchange = "SSE" if ticker.endswith(".SS") else "SZSE"
        elif ticker.endswith(".T"):
            exchange = "TSE"
        elif ticker.endswith(".DE") or ticker.endswith(".ST"):
            exchange = ticker.rsplit(".", 1)[-1]
        elif ticker in CURATED_NAME_ZH or ticker in uni:
            exchange = row.get("exchange") or "NYSE"
        else:
            exchange = "OTC"
    entities[ticker] = {
        "name_en": name_en,
        "name_zh": name_zh,
        "exchange": exchange,
    }
    if looks_like_english_legal_name(entities[ticker]["name_en"]) and ticker not in CURATED_NAME_EN:
        entities[ticker]["name_en"] = short_brand_en(entities[ticker]["name_en"], ticker)
        if looks_like_english_legal_name(entities[ticker]["name_en"]):
            entities[ticker]["name_en"] = ticker


def main() -> int:
    entities = load_json(ENT_PATH)
    competitors = load_json(COMP_PATH)
    universe = load_json(UNIVERSE_PATH)
    stocks = universe["stocks"]
    uni = {r["ticker"]: r for r in stocks}
    stock_zh = load_stock_names_zh()
    file_zh = load_json(ZH_NAMES_PATH).get("names") or {}

    mid = mid_mega_rows(stocks)
    mid_tickers = [r["ticker"] for r in mid]

    missing_rivals = []
    added_comp = 0
    for t in mid_tickers:
        riv = rivals_for(t, n=5)
        if len(riv) < 4:
            missing_rivals.append((t, len(riv), [x[0] for x in riv]))
            continue
        competitors[t] = [[a, b, c] for a, b, c in riv]
        added_comp += 1
        # Ensure entity metadata for hub + rivals
        ensure_entity(entities, t, uni, stock_zh, file_zh)
        for peer, _, _ in riv:
            ensure_entity(entities, peer, uni, stock_zh, file_zh)

    # Also ensure all CURATED_NAME_ZH tickers have entity rows when in universe or used
    for t in CURATED_NAME_ZH:
        if t in uni or t in entities:
            ensure_entity(entities, t, uni, stock_zh, file_zh)

    # Force known Bugbot fixes
    entities["CI"] = {"name_en": "Cigna", "name_zh": "信諾", "exchange": "NYSE"}
    entities["TDG"] = {"name_en": "TransDigm", "name_zh": "環球透博", "exchange": "NYSE"}
    entities["IBM"] = {"name_en": "IBM", "name_zh": "IBM", "exchange": "NYSE"}
    entities["BN"] = {"name_en": "Brookfield", "name_zh": "Brookfield", "exchange": "NYSE"}
    entities["MET"]["name_zh"] = "大都會人壽"
    entities["EQIX"] = {"name_en": "Equinix", "name_zh": "Equinix", "exchange": "NASDAQ"}
    entities["IQV"] = {"name_en": "IQVIA", "name_zh": "艾昆緯", "exchange": "NYSE"}
    entities["CDNS"] = {"name_en": "Cadence", "name_zh": "益華電腦", "exchange": "NASDAQ"}
    entities["BHP"] = {"name_en": "BHP", "name_zh": "必和必拓", "exchange": "NYSE"}
    entities["ANSS"] = {"name_en": "Ansys", "name_zh": "安西斯", "exchange": "NASDAQ"}
    entities["FIG"] = {
        "name_en": CURATED_NAME_EN.get("FIG", "Figma"),
        "name_zh": "Figma",
        "exchange": (uni.get("FIG") or {}).get("exchange") or "NYSE",
    }
    entities["CANVA"] = {"name_en": "Canva", "name_zh": "Canva", "exchange": "Private"}
    entities["AFFINITY"] = {"name_en": "Affinity (Serif)", "name_zh": "Affinity", "exchange": "Private"}
    entities["CORELDRAW"] = {"name_en": "CorelDRAW", "name_zh": "CorelDRAW", "exchange": "Private"}
    entities["PTC"] = {"name_en": "PTC", "name_zh": "參數科技", "exchange": "NASDAQ"}
    entities["ADSK"] = {"name_en": "Autodesk", "name_zh": "歐特克", "exchange": "NASDAQ"}
    entities["GPC"] = {"name_en": "Genuine Parts", "name_zh": "GPC／NAPA", "exchange": "NYSE"}
    entities["KGC"] = {"name_en": "Kinross", "name_zh": "金羅斯", "exchange": "NYSE"}
    entities["AU"] = {"name_en": "AngloGold Ashanti", "name_zh": "安格洛黃金", "exchange": "NYSE"}
    entities["GFI"] = {"name_en": "Gold Fields", "name_zh": "金田", "exchange": "NYSE"}
    entities["AIQUY"] = {"name_en": "Air Liquide", "name_zh": "液化空氣", "exchange": "OTC"}
    entities["NPNYY"] = {"name_en": "Nippon Sanso", "name_zh": "日本酸素", "exchange": "OTC"}
    entities["4091.T"] = {"name_en": "Nippon Sanso Holdings", "name_zh": "日本酸素控股", "exchange": "TSE"}
    entities["LIN"] = {"name_en": "Linde", "name_zh": "林德集團", "exchange": "NASDAQ"}
    # Drop wrong Watsco mapping if present (WACLY is Wacoal ADR).
    if entities.get("WACLY", {}).get("name_en") == "Watsco" or "Watsco" in (
        entities.get("WACLY", {}).get("name_zh") or ""
    ):
        entities.pop("WACLY", None)

    write_json(ENT_PATH, entities)
    write_json(COMP_PATH, competitors)

    summary = {
        "midTotal": len(mid_tickers),
        "competitorsWritten": added_comp,
        "missingRivals": missing_rivals,
        "entityCount": len(entities),
        "tickers": mid_tickers,
    }
    write_json(DATA / "_mid_mega_prep_summary.json", summary)
    print(json.dumps({k: summary[k] for k in ("midTotal", "competitorsWritten", "missingRivals", "entityCount")}, ensure_ascii=False, indent=2))
    return 1 if missing_rivals else 0


if __name__ == "__main__":
    raise SystemExit(main())
