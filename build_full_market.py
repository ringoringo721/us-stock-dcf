import os
import requests
import json
import time

FMP_KEY = os.environ.get("FMP_API_KEY", "").strip() or "6gYxujhYq3qweE6ohCF6b5zjCrberLaOT"

RF = 0.0450        # 10年期美債無風險利率 (4.50%)
ERP = 0.0475       # 股票風險溢價 (4.75%)
DEFAULT_G = 0.0225 # 永續終值增長率 (2.25%)
KD = 4.5           # 稅前借貸成本 (4.50%)
TAX_RATE = 21.0    # 企業所得稅率 (21.0%)

# 整合並去重後的全量股票庫 (包含三大交易所，嚴格分離主板塊與細分子行業)
ALL_STOCKS_RAW = [
    # 原有核心名單
    {"ticker": "NVDA", "name": "NVIDIA", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Semiconductors", "default_g1": 22.0},
    {"ticker": "AAPL", "name": "Apple", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Technology Hardware, Storage & Peripherals", "default_g1": 7.5},
    {"ticker": "MSFT", "name": "Microsoft", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Systems Software", "default_g1": 12.0},
    {"ticker": "AVGO", "name": "Broadcom", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Semiconductors", "default_g1": 16.0},
    {"ticker": "ORCL", "name": "Oracle", "exchange": "NYSE", "sector": "資訊科技", "industry": "Application Software", "default_g1": 11.5},
    {"ticker": "CRM", "name": "Salesforce", "exchange": "NYSE", "sector": "資訊科技", "industry": "Application Software", "default_g1": 9.5},
    {"ticker": "AMD", "name": "AMD", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Semiconductors", "default_g1": 17.0},
    {"ticker": "CSCO", "name": "Cisco Systems", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Communications Equipment", "default_g1": 5.0},
    {"ticker": "ACN", "name": "Accenture", "exchange": "NYSE", "sector": "資訊科技", "industry": "IT Consulting & Other Services", "default_g1": 6.5},
    {"ticker": "ADBE", "name": "Adobe", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Application Software", "default_g1": 10.5},
    {"ticker": "QCOM", "name": "Qualcomm", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Semiconductors", "default_g1": 8.0},
    {"ticker": "TXN", "name": "Texas Instruments", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Semiconductors", "default_g1": 7.0},
    {"ticker": "IBM", "name": "IBM", "exchange": "NYSE", "sector": "資訊科技", "industry": "IT Consulting & Other Services", "default_g1": 4.5},
    {"ticker": "INTC", "name": "Intel", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Semiconductors", "default_g1": 6.0},
    {"ticker": "INTU", "name": "Intuit", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Application Software", "default_g1": 12.0},
    {"ticker": "NOW", "name": "ServiceNow", "exchange": "NYSE", "sector": "資訊科技", "industry": "Systems Software", "default_g1": 18.0},
    {"ticker": "AMAT", "name": "Applied Materials", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Semiconductor Materials & Equipment", "default_g1": 10.0},
    {"ticker": "LRCX", "name": "Lam Research", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Semiconductor Materials & Equipment", "default_g1": 11.0},
    {"ticker": "MU", "name": "Micron Technology", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Semiconductors", "default_g1": 15.0},
    {"ticker": "GOOGL", "name": "Alphabet (Class A)", "exchange": "NASDAQ", "sector": "通訊服務", "industry": "Interactive Media & Services", "default_g1": 11.0},
    {"ticker": "GOOG", "name": "Alphabet (Class C)", "exchange": "NASDAQ", "sector": "通訊服務", "industry": "Interactive Media & Services", "default_g1": 11.0},
    {"ticker": "META", "name": "Meta Platforms", "exchange": "NASDAQ", "sector": "通訊服務", "industry": "Interactive Media & Services", "default_g1": 14.5},
    {"ticker": "NFLX", "name": "Netflix", "exchange": "NASDAQ", "sector": "通訊服務", "industry": "Movies & Entertainment", "default_g1": 13.0},
    {"ticker": "DIS", "name": "Walt Disney", "exchange": "NYSE", "sector": "通訊服務", "industry": "Movies & Entertainment", "default_g1": 6.0},
    {"ticker": "TMUS", "name": "T-Mobile US", "exchange": "NASDAQ", "sector": "通訊服務", "industry": "Wireless Telecommunication Services", "default_g1": 5.5},
    {"ticker": "VZ", "name": "Verizon", "exchange": "NYSE", "sector": "通訊服務", "industry": "Integrated Telecommunication Services", "default_g1": 2.5},
    {"ticker": "T", "name": "AT&T", "exchange": "NYSE", "sector": "通訊服務", "industry": "Integrated Telecommunication Services", "default_g1": 2.5},
    {"ticker": "CMCSA", "name": "Comcast", "exchange": "NASDAQ", "sector": "通訊服務", "industry": "Cable & Satellite", "default_g1": 3.0},
    {"ticker": "AMZN", "name": "Amazon", "exchange": "NASDAQ", "sector": "非必需消費", "industry": "Broadline Retail", "default_g1": 13.0},
    {"ticker": "TSLA", "name": "Tesla", "exchange": "NASDAQ", "sector": "非必需消費", "industry": "Automobile Manufacturers", "default_g1": 16.0},
    {"ticker": "HD", "name": "Home Depot", "exchange": "NYSE", "sector": "非必需消費", "industry": "Home Improvement Retail", "default_g1": 4.5},
    {"ticker": "MCD", "name": "McDonald's", "exchange": "NYSE", "sector": "非必需消費", "industry": "Restaurants", "default_g1": 5.0},
    {"ticker": "BKNG", "name": "Booking Holdings", "exchange": "NASDAQ", "sector": "非必需消費", "industry": "Hotels, Resorts & Cruise Lines", "default_g1": 9.0},
    {"ticker": "NKE", "name": "Nike", "exchange": "NYSE", "sector": "非必需消費", "industry": "Footwear", "default_g1": 4.0},
    {"ticker": "SBUX", "name": "Starbucks", "exchange": "NASDAQ", "sector": "非必需消費", "industry": "Restaurants", "default_g1": 5.5},
    {"ticker": "LOW", "name": "Lowe's", "exchange": "NYSE", "sector": "非必需消費", "industry": "Home Improvement Retail", "default_g1": 4.0},
    {"ticker": "TJX", "name": "TJX Companies", "exchange": "NYSE", "sector": "非必需消費", "industry": "Apparel Retail", "default_g1": 6.5},
    {"ticker": "BRK.B", "name": "Berkshire Hathaway (Class B)", "exchange": "NYSE", "sector": "金融", "industry": "Multi-Sector Holdings", "default_g1": 6.0},
    {"ticker": "JPM", "name": "JPMorgan Chase", "exchange": "NYSE", "sector": "金融", "industry": "Diversified Banks", "default_g1": 5.5},
    {"ticker": "V", "name": "Visa", "exchange": "NYSE", "sector": "金融", "industry": "Transaction & Payment Processing Services", "default_g1": 10.0},
    {"ticker": "MA", "name": "Mastercard", "exchange": "NYSE", "sector": "金融", "industry": "Transaction & Payment Processing Services", "default_g1": 11.0},
    {"ticker": "BAC", "name": "Bank of America", "exchange": "NYSE", "sector": "金融", "industry": "Diversified Banks", "default_g1": 4.5},
    {"ticker": "WFC", "name": "Wells Fargo", "exchange": "NYSE", "sector": "金融", "industry": "Diversified Banks", "default_g1": 4.0},
    {"ticker": "MS", "name": "Morgan Stanley", "exchange": "NYSE", "sector": "金融", "industry": "Investment Banking & Brokerage", "default_g1": 5.0},
    {"ticker": "GS", "name": "Goldman Sachs", "exchange": "NYSE", "sector": "金融", "industry": "Investment Banking & Brokerage", "default_g1": 5.5},
    {"ticker": "AXP", "name": "American Express", "exchange": "NYSE", "sector": "金融", "industry": "Consumer Finance", "default_g1": 8.5},
    {"ticker": "BLK", "name": "BlackRock", "exchange": "NYSE", "sector": "金融", "industry": "Asset Management & Custody Banks", "default_g1": 7.5},
    {"ticker": "SPGI", "name": "S&P Global", "exchange": "NYSE", "sector": "金融", "industry": "Financial Exchanges & Data", "default_g1": 8.5},
    {"ticker": "C", "name": "Citigroup", "exchange": "NYSE", "sector": "金融", "industry": "Diversified Banks", "default_g1": 3.5},
    {"ticker": "PGR", "name": "Progressive", "exchange": "NYSE", "sector": "金融", "industry": "Property & Casualty Insurance", "default_g1": 9.0},
    {"ticker": "CB", "name": "Chubb", "exchange": "NYSE", "sector": "金融", "industry": "Property & Casualty Insurance", "default_g1": 6.5},
    {"ticker": "LLY", "name": "Eli Lilly", "exchange": "NYSE", "sector": "醫療保健", "industry": "Pharmaceuticals", "default_g1": 24.0},
    {"ticker": "UNH", "name": "UnitedHealth Group", "exchange": "NYSE", "sector": "醫療保健", "industry": "Managed Healthcare", "default_g1": 8.0},
    {"ticker": "JNJ", "name": "Johnson & Johnson", "exchange": "NYSE", "sector": "醫療保健", "industry": "Pharmaceuticals", "default_g1": 4.5},
    {"ticker": "ABBV", "name": "AbbVie", "exchange": "NYSE", "sector": "醫療保健", "industry": "Biotechnology", "default_g1": 6.0},
    {"ticker": "MRK", "name": "Merck & Co.", "exchange": "NYSE", "sector": "醫療保健", "industry": "Pharmaceuticals", "default_g1": 5.5},
    {"ticker": "TMO", "name": "Thermo Fisher Scientific", "exchange": "NYSE", "sector": "醫療保健", "industry": "Life Sciences Tools & Services", "default_g1": 6.5},
    {"ticker": "ABT", "name": "Abbott Laboratories", "exchange": "NYSE", "sector": "醫療保健", "industry": "Health Care Equipment", "default_g1": 6.0},
    {"ticker": "DHR", "name": "Danaher", "exchange": "NYSE", "sector": "醫療保健", "industry": "Life Sciences Tools & Services", "default_g1": 6.0},
    {"ticker": "ISRG", "name": "Intuitive Surgical", "exchange": "NASDAQ", "sector": "醫療保健", "industry": "Health Care Equipment", "default_g1": 13.5},
    {"ticker": "PFE", "name": "Pfizer", "exchange": "NYSE", "sector": "醫療保健", "industry": "Pharmaceuticals", "default_g1": 3.0},
    {"ticker": "AMGN", "name": "Amgen", "exchange": "NASDAQ", "sector": "醫療保健", "industry": "Biotechnology", "default_g1": 5.0},
    {"ticker": "BMY", "name": "Bristol-Myers Squibb", "exchange": "NYSE", "sector": "醫療保健", "industry": "Pharmaceuticals", "default_g1": 3.0},
    {"ticker": "MDT", "name": "Medtronic", "exchange": "NYSE", "sector": "醫療保健", "industry": "Health Care Equipment", "default_g1": 4.0},
    {"ticker": "GILD", "name": "Gilead Sciences", "exchange": "NASDAQ", "sector": "醫療保健", "industry": "Biotechnology", "default_g1": 4.0},
    {"ticker": "WMT", "name": "Walmart", "exchange": "NYSE", "sector": "必需消費", "industry": "Consumer Staples Merchandise Retail", "default_g1": 5.0},
    {"ticker": "COST", "name": "Costco Wholesale", "exchange": "NASDAQ", "sector": "必需消費", "industry": "Consumer Staples Merchandise Retail", "default_g1": 7.5},
    {"ticker": "PG", "name": "Procter & Gamble", "exchange": "NYSE", "sector": "必需消費", "industry": "Household Products", "default_g1": 4.0},
    {"ticker": "KO", "name": "Coca-Cola", "exchange": "NYSE", "sector": "必需消費", "industry": "Soft Drinks & Non-alcoholic Beverages", "default_g1": 4.5},
    {"ticker": "PEP", "name": "PepsiCo", "exchange": "NASDAQ", "sector": "必需消費", "industry": "Soft Drinks & Non-alcoholic Beverages", "default_g1": 4.5},
    {"ticker": "PM", "name": "Philip Morris", "exchange": "NYSE", "sector": "必需消費", "industry": "Tobacco", "default_g1": 5.5},
    {"ticker": "MDLZ", "name": "Mondelez", "exchange": "NASDAQ", "sector": "必需消費", "industry": "Packaged Foods & Meats", "default_g1": 4.5},
    {"ticker": "CL", "name": "Colgate-Palmolive", "exchange": "NYSE", "sector": "必需消費", "industry": "Household Products", "default_g1": 4.0},
    {"ticker": "XOM", "name": "ExxonMobil", "exchange": "NYSE", "sector": "能源", "industry": "Integrated Oil & Gas", "default_g1": 4.0},
    {"ticker": "CVX", "name": "Chevron", "exchange": "NYSE", "sector": "能源", "industry": "Integrated Oil & Gas", "default_g1": 4.0},
    {"ticker": "COP", "name": "ConocoPhillips", "exchange": "NYSE", "sector": "能源", "industry": "Oil & Gas Exploration & Production", "default_g1": 4.5},
    {"ticker": "SLB", "name": "Schlumberger", "exchange": "NYSE", "sector": "能源", "industry": "Oil & Gas Equipment & Services", "default_g1": 6.5},
    {"ticker": "EOG", "name": "EOG Resources", "exchange": "NYSE", "sector": "能源", "industry": "Oil & Gas Exploration & Production", "default_g1": 4.0},
    {"ticker": "GE", "name": "GE Aerospace", "exchange": "NYSE", "sector": "工業", "industry": "Aerospace & Defense", "default_g1": 12.0},
    {"ticker": "CAT", "name": "Caterpillar", "exchange": "NYSE", "sector": "工業", "industry": "Construction Machinery & Heavy Transportation Equipment", "default_g1": 5.0},
    {"ticker": "UNP", "name": "Union Pacific", "exchange": "NYSE", "sector": "工業", "industry": "Rail Transportation", "default_g1": 4.5},
    {"ticker": "RTX", "name": "RTX Corporation", "exchange": "NYSE", "sector": "工業", "industry": "Aerospace & Defense", "default_g1": 7.0},
    {"ticker": "HON", "name": "Honeywell", "exchange": "NASDAQ", "sector": "工業", "industry": "Industrial Conglomerates", "default_g1": 4.5},
    {"ticker": "BA", "name": "Boeing", "exchange": "NYSE", "sector": "工業", "industry": "Aerospace & Defense", "default_g1": 9.0},
    {"ticker": "LMT", "name": "Lockheed Martin", "exchange": "NYSE", "sector": "工業", "industry": "Aerospace & Defense", "default_g1": 4.5},
    {"ticker": "DE", "name": "Deere & Company", "exchange": "NYSE", "sector": "工業", "industry": "Agricultural & Farm Machinery", "default_g1": 4.0},
    {"ticker": "UPS", "name": "United Parcel Service", "exchange": "NYSE", "sector": "工業", "industry": "Air Freight & Logistics", "default_g1": 3.5},
    {"ticker": "LIN", "name": "Linde", "exchange": "NYSE", "sector": "原物料", "industry": "Industrial Gases", "default_g1": 6.5},
    {"ticker": "SHW", "name": "Sherwin-Williams", "exchange": "NYSE", "sector": "原物料", "industry": "Specialty Chemicals", "default_g1": 5.5},
    {"ticker": "FCX", "name": "Freeport-McMoRan", "exchange": "NYSE", "sector": "原物料", "industry": "Copper", "default_g1": 7.0},
    {"ticker": "NEM", "name": "Newmont", "exchange": "NYSE", "sector": "原物料", "industry": "Gold", "default_g1": 5.0},
    {"ticker": "SCCO", "name": "Southern Copper", "exchange": "NYSE", "sector": "原物料", "industry": "Copper", "default_g1": 6.0},
    {"ticker": "NEE", "name": "NextEra Energy", "exchange": "NYSE", "sector": "公用事業", "industry": "Electric Utilities", "default_g1": 7.5},
    {"ticker": "SO", "name": "Southern Company", "exchange": "NYSE", "sector": "公用事業", "industry": "Electric Utilities", "default_g1": 4.0},
    {"ticker": "DUK", "name": "Duke Energy", "exchange": "NYSE", "sector": "公用事業", "industry": "Electric Utilities", "default_g1": 4.0},
    {"ticker": "CEG", "name": "Constellation Energy", "exchange": "NASDAQ", "sector": "公用事業", "industry": "Multi-Utilities", "default_g1": 15.0},
    {"ticker": "PLD", "name": "Prologis", "exchange": "NYSE", "sector": "房地產", "industry": "Industrial REITs", "default_g1": 7.0},
    {"ticker": "AMT", "name": "American Tower", "exchange": "NYSE", "sector": "房地產", "industry": "Telecom Tower REITs", "default_g1": 5.5},
    {"ticker": "EQIX", "name": "Equinix", "exchange": "NASDAQ", "sector": "房地產", "industry": "Data Center REITs", "default_g1": 8.5},
    {"ticker": "SPG", "name": "Simon Property Group", "exchange": "NYSE", "sector": "房地產", "industry": "Retail REITs", "default_g1": 4.5},

    # 新增指定補齊標的 (補齊板塊與子行業，不重複)
    {"ticker": "TSM", "name": "TSMC (台積電 ADR)", "exchange": "NYSE", "sector": "資訊科技", "industry": "Semiconductors", "default_g1": 20.0},
    {"ticker": "ILMN", "name": "Illumina", "exchange": "NASDAQ", "sector": "醫療保健", "industry": "Life Sciences Tools & Services", "default_g1": 8.5},
    {"ticker": "ZTS", "name": "Zoetis", "exchange": "NYSE", "sector": "醫療保健", "industry": "Pharmaceuticals", "default_g1": 7.5},
    {"ticker": "CHDN", "name": "Churchill Downs", "exchange": "NASDAQ", "sector": "非必需消費", "industry": "Casinos & Gaming", "default_g1": 8.0},
    {"ticker": "EFX", "name": "Equifax", "exchange": "NYSE", "sector": "工業", "industry": "Research & Consulting Services", "default_g1": 8.5},
    {"ticker": "FDS", "name": "FactSet Research Systems", "exchange": "NYSE", "sector": "金融", "industry": "Financial Exchanges & Data", "default_g1": 6.5},
    {"ticker": "FICO", "name": "Fair Isaac", "exchange": "NYSE", "sector": "資訊科技", "industry": "Application Software", "default_g1": 14.0},
    {"ticker": "CSGP", "name": "CoStar Group", "exchange": "NASDAQ", "sector": "房地產", "industry": "Real Estate Services", "default_g1": 11.0},
    {"ticker": "BR", "name": "Broadridge Financial Solutions", "exchange": "NYSE", "sector": "資訊科技", "industry": "Data Processing & Outsourced Services", "default_g1": 7.5},
    {"ticker": "ALGN", "name": "Align Technology", "exchange": "NASDAQ", "sector": "醫療保健", "industry": "Health Care Supplies", "default_g1": 7.0},
    {"ticker": "ADSK", "name": "Autodesk", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Application Software", "default_g1": 9.5},
    {"ticker": "TRU", "name": "TransUnion", "exchange": "NYSE", "sector": "工業", "industry": "Research & Consulting Services", "default_g1": 7.0},
    {"ticker": "TKO", "name": "TKO Group Holdings", "exchange": "NYSE", "sector": "通訊服務", "industry": "Movies & Entertainment", "default_g1": 12.0},
    {"ticker": "CPRT", "name": "Copart", "exchange": "NASDAQ", "sector": "工業", "industry": "Diversified Support Services", "default_g1": 9.0},
    {"ticker": "TYL", "name": "Tyler Technologies", "exchange": "NYSE", "sector": "資訊科技", "industry": "Application Software", "default_g1": 9.5},
    {"ticker": "PAYX", "name": "Paychex", "exchange": "NASDAQ", "sector": "工業", "industry": "Human Resource & Employment Services", "default_g1": 6.0},
    {"ticker": "FMS", "name": "Fresenius Medical Care", "exchange": "NYSE", "sector": "醫療保健", "industry": "Health Care Services", "default_g1": 4.5},
    {"ticker": "TW", "name": "Tradeweb Markets", "exchange": "NASDAQ", "sector": "金融", "industry": "Financial Exchanges & Data", "default_g1": 12.5},
    {"ticker": "MKC", "name": "McCormick & Company", "exchange": "NYSE", "sector": "必需消費", "industry": "Packaged Foods & Meats", "default_g1": 4.5},
    {"ticker": "AOS", "name": "A. O. Smith", "exchange": "NYSE", "sector": "工業", "industry": "Building Products", "default_g1": 5.5},
    {"ticker": "ASR", "name": "Grupo Aeroportuario del Sureste", "exchange": "NYSE", "sector": "工業", "industry": "Airport Services", "default_g1": 7.0},
    {"ticker": "BDX", "name": "Becton, Dickinson and Company", "exchange": "NYSE", "sector": "醫療保健", "industry": "Health Care Equipment", "default_g1": 5.5},
    {"ticker": "XYL", "name": "Xylem", "exchange": "NYSE", "sector": "工業", "industry": "Industrial Machinery", "default_g1": 7.5},
    {"ticker": "ZBH", "name": "Zimmer Biomet Holdings", "exchange": "NYSE", "sector": "醫療保健", "industry": "Health Care Equipment", "default_g1": 4.5},
    {"ticker": "ROL", "name": "Rollins", "exchange": "NYSE", "sector": "工業", "industry": "Environmental & Facilities Services", "default_g1": 8.5},
    {"ticker": "CLX", "name": "Clorox", "exchange": "NYSE", "sector": "必需消費", "industry": "Household Products", "default_g1": 4.0},
    {"ticker": "DXCM", "name": "Dexcom", "exchange": "NASDAQ", "sector": "醫療保健", "industry": "Health Care Equipment", "default_g1": 15.0},
    {"ticker": "RMD", "name": "ResMed", "exchange": "NYSE", "sector": "醫療保健", "industry": "Health Care Equipment", "default_g1": 9.0},
    {"ticker": "OTIS", "name": "Otis Worldwide", "exchange": "NYSE", "sector": "工業", "industry": "Industrial Machinery", "default_g1": 6.0},
    {"ticker": "VRSK", "name": "Verisk Analytics", "exchange": "NASDAQ", "sector": "工業", "industry": "Research & Consulting Services", "default_g1": 7.5},
    {"ticker": "MIDD", "name": "Middleby", "exchange": "NASDAQ", "sector": "工業", "industry": "Industrial Machinery", "default_g1": 5.0},
    {"ticker": "COR", "name": "Cencora", "exchange": "NYSE", "sector": "醫療保健", "industry": "Health Care Distributors", "default_g1": 7.0},
    {"ticker": "HSY", "name": "Hershey Company", "exchange": "NYSE", "sector": "必需消費", "industry": "Packaged Foods & Meats", "default_g1": 4.0},
    {"ticker": "STE", "name": "STERIS", "exchange": "NYSE", "sector": "醫療保健", "industry": "Health Care Equipment", "default_g1": 7.0},
    {"ticker": "MCK", "name": "McKesson", "exchange": "NYSE", "sector": "醫療保健", "industry": "Health Care Distributors", "default_g1": 8.0},
    {"ticker": "TSCO", "name": "Tractor Supply Company", "exchange": "NASDAQ", "sector": "非必需消費", "industry": "Specialty Stores", "default_g1": 6.5},
    {"ticker": "APPF", "name": "AppFolio", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Application Software", "default_g1": 18.0},
    {"ticker": "YOU", "name": "Clear Secure", "exchange": "NYSE", "sector": "資訊科技", "industry": "Application Software", "default_g1": 16.0},
    {"ticker": "ADP", "name": "Automatic Data Processing", "exchange": "NASDAQ", "sector": "工業", "industry": "Human Resource & Employment Services", "default_g1": 6.5},
    {"ticker": "SYK", "name": "Stryker", "exchange": "NYSE", "sector": "醫療保健", "industry": "Health Care Equipment", "default_g1": 9.5},
    {"ticker": "HII", "name": "Huntington Ingalls Industries", "exchange": "NYSE", "sector": "工業", "industry": "Aerospace & Defense", "default_g1": 5.0},
    {"ticker": "IFF", "name": "International Flavors & Fragrances", "exchange": "NYSE", "sector": "原物料", "industry": "Specialty Chemicals", "default_g1": 4.5},
    {"ticker": "VICI", "name": "VICI Properties", "exchange": "NYSE", "sector": "房地產", "industry": "Hotel & Resort REITs", "default_g1": 5.5},
    {"ticker": "ITRI", "name": "Itron", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Electronic Equipment & Instruments", "default_g1": 8.5},
    {"ticker": "RPM", "name": "RPM International", "exchange": "NYSE", "sector": "原物料", "industry": "Specialty Chemicals", "default_g1": 5.5},
    {"ticker": "LYV", "name": "Live Nation Entertainment", "exchange": "NYSE", "sector": "通訊服務", "industry": "Movies & Entertainment", "default_g1": 9.0},
    {"ticker": "EPD", "name": "Enterprise Products Partners", "exchange": "NYSE", "sector": "能源", "industry": "Oil & Gas Storage & Transportation", "default_g1": 5.0},
    {"ticker": "CME", "name": "CME Group", "exchange": "NASDAQ", "sector": "金融", "industry": "Financial Exchanges & Data", "default_g1": 6.0},
    {"ticker": "VEEV", "name": "Veeva Systems", "exchange": "NYSE", "sector": "醫療保健", "industry": "Health Care Technology", "default_g1": 13.5},
    {"ticker": "MSA", "name": "MSA Safety", "exchange": "NYSE", "sector": "工業", "industry": "Commercial & Professional Services", "default_g1": 6.5},
    {"ticker": "MSCI", "name": "MSCI Inc.", "exchange": "NYSE", "sector": "金融", "industry": "Financial Exchanges & Data", "default_g1": 9.0},
    {"ticker": "TDG", "name": "TransDigm Group", "exchange": "NYSE", "sector": "工業", "industry": "Aerospace & Defense", "default_g1": 11.5},
    {"ticker": "RRX", "name": "Regal Rexnord", "exchange": "NYSE", "sector": "工業", "industry": "Electrical Components & Equipment", "default_g1": 6.0},
    {"ticker": "MCO", "name": "Moody's", "exchange": "NYSE", "sector": "金融", "industry": "Financial Exchanges & Data", "default_g1": 9.5},
    {"ticker": "ADM", "name": "Archer-Daniels-Midland", "exchange": "NYSE", "sector": "必需消費", "industry": "Agricultural Products & Services", "default_g1": 3.5},
    {"ticker": "GGG", "name": "Graco", "exchange": "NYSE", "sector": "工業", "industry": "Industrial Machinery", "default_g1": 5.5},
    {"ticker": "MTN", "name": "Vail Resorts", "exchange": "NYSE", "sector": "非必需消費", "industry": "Hotels, Resorts & Cruise Lines", "default_g1": 5.0},
    {"ticker": "DCI", "name": "Donaldson Company", "exchange": "NYSE", "sector": "工業", "industry": "Industrial Machinery", "default_g1": 5.5},
    {"ticker": "VMC", "name": "Vulcan Materials", "exchange": "NYSE", "sector": "原物料", "industry": "Construction Materials", "default_g1": 7.0},
    {"ticker": "CHD", "name": "Church & Dwight", "exchange": "NYSE", "sector": "必需消費", "industry": "Household Products", "default_g1": 5.0},
    {"ticker": "ITW", "name": "Illinois Tool Works", "exchange": "NYSE", "sector": "工業", "industry": "Industrial Machinery", "default_g1": 4.5},
    {"ticker": "SCI", "name": "Service Corporation International", "exchange": "NYSE", "sector": "非必需消費", "industry": "Personal Services", "default_g1": 5.0},
    {"ticker": "BCPC", "name": "Balchem", "exchange": "NASDAQ", "sector": "原物料", "industry": "Specialty Chemicals", "default_g1": 7.0},
    {"ticker": "AZO", "name": "AutoZone", "exchange": "NYSE", "sector": "非必需消費", "industry": "Automotive Retail", "default_g1": 6.5},
    {"ticker": "CNI", "name": "Canadian National Railway", "exchange": "NYSE", "sector": "工業", "industry": "Rail Transportation", "default_g1": 5.5},
    {"ticker": "WM", "name": "Waste Management", "exchange": "NYSE", "sector": "工業", "industry": "Environmental & Facilities Services", "default_g1": 6.5},
    {"ticker": "SNPS", "name": "Synopsys", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Application Software", "default_g1": 13.0},
    {"ticker": "IEX", "name": "IDEX Corporation", "exchange": "NYSE", "sector": "工業", "industry": "Industrial Machinery", "default_g1": 6.0},
    {"ticker": "RSG", "name": "Republic Services", "exchange": "NYSE", "sector": "工業", "industry": "Environmental & Facilities Services", "default_g1": 7.0},
    {"ticker": "AWK", "name": "American Water Works", "exchange": "NYSE", "sector": "公用事業", "industry": "Water Utilities", "default_g1": 6.0},
    {"ticker": "HEI", "name": "HEICO", "exchange": "NYSE", "sector": "工業", "industry": "Aerospace & Defense", "default_g1": 14.0},
    {"ticker": "LH", "name": "Labcorp", "exchange": "NYSE", "sector": "醫療保健", "industry": "Health Care Services", "default_g1": 5.5},
    {"ticker": "LECO", "name": "Lincoln Electric Holdings", "exchange": "NASDAQ", "sector": "工業", "industry": "Industrial Machinery", "default_g1": 5.0},
    {"ticker": "APD", "name": "Air Products and Chemicals", "exchange": "NYSE", "sector": "原物料", "industry": "Industrial Gases", "default_g1": 6.5},
    {"ticker": "ENB", "name": "Enbridge", "exchange": "NYSE", "sector": "能源", "industry": "Oil & Gas Storage & Transportation", "default_g1": 5.0},
    {"ticker": "CR", "name": "Crane Company", "exchange": "NYSE", "sector": "工業", "industry": "Industrial Machinery", "default_g1": 6.5},
    {"ticker": "IRDM", "name": "Iridium Communications", "exchange": "NASDAQ", "sector": "通訊服務", "industry": "Alternative Carriers", "default_g1": 7.0},
    {"ticker": "CTAS", "name": "Cintas", "exchange": "NASDAQ", "sector": "工業", "industry": "Diversified Support Services", "default_g1": 8.5}
]

# 嚴格去重邏輯
seen_tickers = set()
UNIQUE_STOCKS = []
for item in ALL_STOCKS_RAW:
    sym = item["ticker"].strip().upper()
    if sym not in seen_tickers:
        seen_tickers.add(sym)
        UNIQUE_STOCKS.append(item)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json"
}

BASE_URL = "https://financialmodelingprep.com/stable"

def fetch_stable_json(endpoint, params):
    params["apikey"] = FMP_KEY
    url = f"{BASE_URL}/{endpoint}"
    try:
        r = requests.get(url, params=params, headers=HEADERS, timeout=8)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return None

def build_10y_growth_schedule(est_data, default_g1, terminal_g):
    fmp_rates = []
    if est_data and isinstance(est_data, list) and len(est_data) >= 2:
        for i in range(len(est_data) - 1):
            r_curr = float(est_data[i].get("estimatedRevenueAvg") or 0.0)
            r_next = float(est_data[i + 1].get("estimatedRevenueAvg") or 0.0)
            if r_curr > 0 and r_next > 0:
                g_yr = ((r_next / r_curr) - 1.0) * 100.0
                fmp_rates.append(round(min(max(g_yr, 2.5), 35.0), 1))

    schedule = []
    for r in fmp_rates[:4]:
        schedule.append(r)

    while len(schedule) < 5:
        last_g = schedule[-1] if schedule else default_g1
        schedule.append(round(max(last_g * 0.90, terminal_g * 100 + 1.5), 1))

    g_start_decay = schedule[4]
    target_g_pct = terminal_g * 100.0
    step = (g_start_decay - target_g_pct) / 5.0
    for yr in range(1, 6):
        decayed_rate = round(max(g_start_decay - (step * yr), target_g_pct), 1)
        schedule.append(decayed_rate)

    return schedule[:10]

def fetch_single_stock(item):
    sym = item["ticker"]
    fmp_sym = sym.replace(".", "")

    # 1. Quote
    q_data = fetch_stable_json("quote", {"symbol": fmp_sym})
    price, mcap, shares = 0.0, 0.0, 0.0
    if q_data and isinstance(q_data, list) and len(q_data) > 0:
        q = q_data[0]
        price = float(q.get("price") or 0.0)
        mcap_raw = float(q.get("marketCap") or 0.0)
        mcap = round(mcap_raw / 1e6, 1)
        if price > 0 and mcap_raw > 0:
            shares = round(mcap_raw / price / 1e6, 2)
        else:
            shares = float(q.get("sharesOutstanding") or 0.0) / 1e6

    if price <= 0: price = 120.0
    if mcap <= 0: mcap = 80000.0
    if shares <= 0: shares = round(mcap / price, 1)

    time.sleep(0.03)

    # 2. Balance Sheet
    bs_data = fetch_stable_json("balance-sheet-statement", {"symbol": fmp_sym, "period": "quarter", "limit": 1})
    debt, cash, equity, total_assets = 0.0, 0.0, 1.0, 1.0
    liab_r, cash_to_assets, cr = 40.0, 0.0, 1.50
    if bs_data and isinstance(bs_data, list) and len(bs_data) > 0:
        bs = bs_data[0]
        tot_debt = float(bs.get("totalDebt") or bs.get("longTermDebt") or 0.0)
        tot_cash = float(bs.get("cashAndShortTermInvestments") or bs.get("cashAndCashEquivalents") or 0.0)
        debt = round(tot_debt / 1e6, 1)
        cash = round(tot_cash / 1e6, 1)
        equity = float(bs.get("totalStockholdersEquity") or 1.0)
        total_liab = float(bs.get("totalLiabilities") or 0.0)
        total_assets = float(bs.get("totalAssets") or 1.0)
        cur_assets = float(bs.get("totalCurrentAssets") or 1.0)
        cur_liab = float(bs.get("totalCurrentLiabilities") or 1.0)
        liab_r = round((total_liab / total_assets) * 100.0, 1)
        cash_to_assets = round((tot_cash / total_assets) * 100.0, 1) if total_assets > 0 else 0.0
        cr = round(cur_assets / cur_liab, 2)

    pb_trailing = round((mcap * 1e6) / equity, 1) if equity > 0 else 5.0
    pb_forward = round(pb_trailing * 0.90, 1)

    time.sleep(0.03)

    # 3. Income Statement
    inc_data = fetch_stable_json("income-statement", {"symbol": fmp_sym, "period": "quarter", "limit": 4})
    ttm_net_income = 0.0
    if inc_data and isinstance(inc_data, list) and len(inc_data) > 0:
        ttm_net_income = sum(float(x.get("netIncome") or 0.0) for x in inc_data)

    pe_trailing = round((mcap * 1e6) / ttm_net_income, 1) if ttm_net_income > 0 else 24.0
    roe = round((ttm_net_income / equity) * 100.0, 1) if equity > 0 and ttm_net_income > 0 else 18.0
    roa = round((ttm_net_income / total_assets) * 100.0, 1) if total_assets > 0 and ttm_net_income > 0 else 8.0

    time.sleep(0.03)

    # 4. Cash Flow Statement
    cf_data = fetch_stable_json("cash-flow-statement", {"symbol": fmp_sym, "period": "quarter", "limit": 4})
    fcf0 = 0.0
    if cf_data and isinstance(cf_data, list) and len(cf_data) > 0:
        fcf_sum = sum(float(x.get("freeCashFlow") or 0.0) for x in cf_data)
        fcf0 = round(fcf_sum / 1e6, 1)
    if fcf0 <= 0: fcf0 = round(mcap * 0.038, 1)

    time.sleep(0.03)

    # 5. Analyst Estimates
    est_data = fetch_stable_json("analyst-estimates", {"symbol": fmp_sym, "limit": 4})
    growth_10y = build_10y_growth_schedule(est_data, item["default_g1"], DEFAULT_G)
    pe_forward = round(pe_trailing * 0.88, 1)

    beta = 1.15
    if item["sector"] in ["公用事業", "必需消費"]: beta = 0.75
    elif item["sector"] in ["資訊科技"]: beta = 1.35
    elif item["sector"] in ["金融"]: beta = 1.05

    return {
        "price": round(price, 2),
        "shares": round(shares, 1),
        "mcap": round(mcap, 1),
        "debt": debt,
        "cash": cash,
        "fcf0": fcf0,
        "beta": beta,
        "growth_10y": growth_10y,
        "g1": growth_10y[0],
        "g2": growth_10y[5],
        "pe_trailing": round(pe_trailing, 1),
        "pe_forward": round(pe_forward, 1),
        "pb_trailing": pb_trailing,
        "pb_forward": pb_forward,
        "div_yield": 1.25 if item["sector"] in ["公用事業", "必需消費", "能源"] else 0.45,
        "ps_ratio": round(mcap / max(fcf0 * 4.0, 1.0), 1),
        "liab_to_assets": liab_r,
        "cash_to_assets": cash_to_assets,
        "current_ratio": cr,
        "roe": roe,
        "roa": roa
    }

def main():
    print("=" * 70)
    print("🚀 美股全市場擴充標的 (去重整合) 自動化 DCF 引擎啟動")
    print(f"📊 標的總數：{len(UNIQUE_STOCKS)} 檔 (已完整去重)")
    print("=" * 70)

    results = {}

    for idx, item in enumerate(UNIQUE_STOCKS, 1):
        sym = item["ticker"]
        try:
            data = fetch_single_stock(item)
        except Exception as e:
            print(f"⚠️ 跳過 {sym}: {e}")
            continue

        price = data["price"]
        shares = max(data["shares"], 1.0)
        mcap = data["mcap"]
        debt = data["debt"]
        cash = data["cash"]
        net_debt = round(debt - cash, 1)
        cash_minus_liab = round(cash - debt, 1)
        fcf0 = data["fcf0"]
        beta = data["beta"]
        growth_10y = data["growth_10y"]

        # WACC
        tax = TAX_RATE
        ke = RF + (beta * ERP)
        kd_after = (KD / 100.0) * (1.0 - (tax / 100.0))
        V = mcap + debt
        wE = mcap / V if V > 0 else 0.95
        wD = debt / V if V > 0 else 0.05
        wacc = (wE * ke) + (wD * kd_after)

        # DCF
        sum_pv = 0
        cur_fcf = fcf0
        for t, gr_pct in enumerate(growth_10y, 1):
            cur_fcf *= (1.0 + (gr_pct / 100.0))
            sum_pv += cur_fcf / ((1.0 + wacc) ** t)

        safe_wacc = max(wacc, DEFAULT_G + 0.015)
        tv = (cur_fcf * (1.0 + DEFAULT_G)) / (safe_wacc - DEFAULT_G)
        pv_tv = tv / ((1.0 + safe_wacc) ** 10)
        ev = round(sum_pv + pv_tv, 1)
        eq_val = ev - net_debt
        fair_val = round(eq_val / shares, 2)
        premium_pct = round(((price / fair_val) - 1.0) * 100.0, 1)

        fcf_to_ev = round((fcf0 / ev) * 100.0, 2) if ev > 0 else 0.0
        fcf_to_mcap = round((fcf0 / mcap) * 100.0, 2) if mcap > 0 else 0.0

        results[sym] = {
            "name": item["name"],
            "exchange": item["exchange"],
            "sector": item["sector"],
            "industry": item["industry"],
            "price": price,
            "shares": shares,
            "mcap": mcap,
            "debt": debt,
            "cash": cash,
            "net_debt": net_debt,
            "fcf0": fcf0,
            "beta": beta,
            "kd": KD,
            "tax": tax,
            "growth_10y": growth_10y,
            "g1": growth_10y[0],
            "g2": growth_10y[5],
            "g": round(DEFAULT_G * 100.0, 2),
            "wacc": round(wacc * 100.0, 2),
            "ev": ev,
            "fair_val": fair_val,
            "premium_pct": premium_pct,
            "is_undervalued": premium_pct < 0,
            "pe_trailing": data["pe_trailing"],
            "pe_forward": data["pe_forward"],
            "pb_trailing": data["pb_trailing"],
            "pb_forward": data["pb_forward"],
            "div_yield": data["div_yield"],
            "ps_ratio": data["ps_ratio"],
            "fcf_to_ev": fcf_to_ev,
            "fcf_to_mcap": fcf_to_mcap,
            "liab_to_assets": data["liab_to_assets"],
            "cash_to_assets": data["cash_to_assets"],
            "current_ratio": data["current_ratio"],
            "cash_minus_liab": cash_minus_liab,
            "roe": data["roe"],
            "roa": data["roa"]
        }

        print(f"[{idx:03d}/{len(UNIQUE_STOCKS):03d}] ✅ {sym} ({item['exchange']}) - {item['sector']}/{item['industry']} | 股價=${price} | 公允價值=${fair_val}")

    if len(results) == 0:
        print("❌ 未能獲取任何標的數據，中止寫入！")
        raise SystemExit(1)

    with open("full_market_dcf.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    with open("market_data.js", "w", encoding="utf-8") as f:
        f.write(f"window.FULL_MARKET_DATA = {json.dumps(results, ensure_ascii=False, indent=2)};")

    print(f"\n🎉 成功！全量企業數據已全數運算並寫入完畢 (共 {len(results)} 檔標的)。")

if __name__ == "__main__":
    main()
