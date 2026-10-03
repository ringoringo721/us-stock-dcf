import requests
import json
import os
import time

RF = 0.0450        # 10年期美債無風險利率基準 (4.50%)
ERP = 0.0475       # 股票風險溢價 (4.75%)
DEFAULT_G = 0.0225 # 永續終值增長率 (2.25%)
API_KEY = os.environ.get("FMP_API_KEY", "IXjYKT8hqK5NTFklsdiW9mVWXWTz5Ru3")

# 美股 11 大板塊核心權重成分股（真實資本結構、Beta、FCF 與產業細分）
UNIVERSE = [
    # 必需消費
    {"s": "PG", "name": "Procter & Gamble", "exch": "NYSE", "sector": "必需消費", "industry": "日化清潔與個人護理快消品", "p": 172.5, "shares": 2360.0, "debt": 35000.0, "cash": 9500.0, "fcf": 15600.0, "beta": 0.50, "kd": 4.0, "tax": 21.0, "g1": 4.5, "g2": 3.5},
    {"s": "KO", "name": "Coca-Cola", "exch": "NYSE", "sector": "必需消費", "industry": "軟性飲料與濃縮液全球分銷", "p": 68.2, "shares": 4310.0, "debt": 44500.0, "cash": 12850.0, "fcf": 9800.0, "beta": 0.55, "kd": 4.0, "tax": 20.0, "g1": 5.0, "g2": 3.5},
    {"s": "PEP", "name": "PepsiCo", "exch": "NASDAQ", "sector": "必需消費", "industry": "休閒零食 (樂事) 與碳酸飲料", "p": 175.0, "shares": 1370.0, "debt": 44000.0, "cash": 6500.0, "fcf": 8800.0, "beta": 0.55, "kd": 4.1, "tax": 21.0, "g1": 4.5, "g2": 3.5},
    {"s": "WMT", "name": "Walmart", "exch": "NYSE", "sector": "必需消費", "industry": "實體全渠道量販連鎖超市", "p": 80.5, "shares": 8050.0, "debt": 61000.0, "cash": 9800.0, "fcf": 15100.0, "beta": 0.50, "kd": 4.1, "tax": 23.0, "g1": 4.5, "g2": 3.0},
    {"s": "COST", "name": "Costco Wholesale", "exch": "NASDAQ", "sector": "必需消費", "industry": "高周轉付費會員制倉儲批發", "p": 910.0, "shares": 443.0, "debt": 7000.0, "cash": 10500.0, "fcf": 7200.0, "beta": 0.75, "kd": 3.9, "tax": 24.0, "g1": 8.0, "g2": 5.0},
    {"s": "PM", "name": "Philip Morris", "exch": "NYSE", "sector": "必需消費", "industry": "菸草特許與無煙加熱菸 (IQOS)", "p": 128.0, "shares": 1550.0, "debt": 47000.0, "cash": 3200.0, "fcf": 10200.0, "beta": 0.65, "kd": 4.5, "tax": 21.0, "g1": 4.0, "g2": 3.0},
    {"s": "CL", "name": "Colgate-Palmolive", "exch": "NYSE", "sector": "必需消費", "industry": "口腔護理與個人清潔用品", "p": 101.0, "shares": 820.0, "debt": 8900.0, "cash": 1100.0, "fcf": 3200.0, "beta": 0.45, "kd": 4.1, "tax": 22.0, "g1": 4.0, "g2": 3.0},
    {"s": "MDLZ", "name": "Mondelez", "exch": "NASDAQ", "sector": "必需消費", "industry": "巧克力、餅乾與休閒零食", "p": 72.0, "shares": 1350.0, "debt": 21000.0, "cash": 1800.0, "fcf": 3700.0, "beta": 0.60, "kd": 4.2, "tax": 21.0, "g1": 4.5, "g2": 3.5},
    # 非必需消費
    {"s": "MCD", "name": "McDonald's", "exch": "NYSE", "sector": "非必需消費", "industry": "餐飲特許經營 / 商業地產收租", "p": 298.5, "shares": 718.0, "debt": 37500.0, "cash": 1500.0, "fcf": 7500.0, "beta": 0.70, "kd": 5.45, "tax": 20.0, "g1": 5.0, "g2": 3.5},
    {"s": "AMZN", "name": "Amazon.com", "exch": "NASDAQ", "sector": "非必需消費", "industry": "電商零售、Prime 物流與 AWS 雲計算", "p": 190.0, "shares": 10400.0, "debt": 68000.0, "cash": 86000.0, "fcf": 55000.0, "beta": 1.15, "kd": 4.2, "tax": 17.0, "g1": 11.0, "g2": 5.5},
    {"s": "TSLA", "name": "Tesla", "exch": "NASDAQ", "sector": "非必需消費", "industry": "電動車製造、儲能系統與自動駕駛", "p": 215.0, "shares": 3180.0, "debt": 5200.0, "cash": 30000.0, "fcf": 4500.0, "beta": 2.10, "kd": 4.5, "tax": 15.0, "g1": 14.0, "g2": 6.0},
    {"s": "HD", "name": "Home Depot", "exch": "NYSE", "sector": "非必需消費", "industry": "家居裝修修繕連鎖量販", "p": 395.0, "shares": 990.0, "debt": 53000.0, "cash": 3800.0, "fcf": 16500.0, "beta": 0.95, "kd": 4.4, "tax": 23.0, "g1": 4.5, "g2": 3.5},
    {"s": "NKE", "name": "Nike", "exch": "NYSE", "sector": "非必需消費", "industry": "運動鞋服與運動生活用品設計製造", "p": 82.0, "shares": 1510.0, "debt": 12000.0, "cash": 11000.0, "fcf": 5800.0, "beta": 1.05, "kd": 4.3, "tax": 15.0, "g1": 4.5, "g2": 3.5},
    {"s": "SBUX", "name": "Starbucks", "exch": "NASDAQ", "sector": "非必需消費", "industry": "全球精品連鎖咖啡廳與包裝食品授權", "p": 96.0, "shares": 1130.0, "debt": 25000.0, "cash": 3400.0, "fcf": 3800.0, "beta": 0.95, "kd": 4.6, "tax": 22.0, "g1": 5.0, "g2": 3.5},
    # 資訊科技
    {"s": "AAPL", "name": "Apple", "exch": "NASDAQ", "sector": "資訊科技", "industry": "消費電子、智慧硬體與服務生態圈", "p": 232.0, "shares": 15200.0, "debt": 104000.0, "cash": 65000.0, "fcf": 108000.0, "beta": 1.05, "kd": 4.2, "tax": 16.0, "g1": 6.0, "g2": 4.0},
    {"s": "MSFT", "name": "Microsoft", "exch": "NASDAQ", "sector": "資訊科技", "industry": "Azure 企業雲計算、Windows、Office 與 AI", "p": 445.0, "shares": 7430.0, "debt": 79000.0, "cash": 75500.0, "fcf": 74000.0, "beta": 1.10, "kd": 3.8, "tax": 18.0, "g1": 10.0, "g2": 5.0},
    {"s": "NVDA", "name": "NVIDIA", "exch": "NASDAQ", "sector": "資訊科技", "industry": "生成式 AI 資料中心 GPU 與晶片算力生態", "p": 138.0, "shares": 24500.0, "debt": 11000.0, "cash": 31000.0, "fcf": 45000.0, "beta": 1.65, "kd": 4.5, "tax": 15.0, "g1": 15.0, "g2": 6.0},
    {"s": "AVGO", "name": "Broadcom", "exch": "NASDAQ", "sector": "資訊科技", "industry": "雲端通訊客製化 ASIC 晶片與虛擬化軟體", "p": 182.0, "shares": 4680.0, "debt": 74000.0, "cash": 12000.0, "fcf": 21000.0, "beta": 1.15, "kd": 4.5, "tax": 14.0, "g1": 9.0, "g2": 5.0},
    {"s": "TSM", "name": "TSMC ADR", "exch": "NYSE", "sector": "資訊科技", "industry": "純晶圓代工與先進製程 EUV 半導體製造", "p": 195.0, "shares": 5180.0, "debt": 31000.0, "cash": 54000.0, "fcf": 28000.0, "beta": 1.20, "kd": 3.6, "tax": 15.0, "g1": 12.0, "g2": 5.5},
    {"s": "ORCL", "name": "Oracle", "exch": "NYSE", "sector": "資訊科技", "industry": "企業級資料庫軟體與 OCI 雲端算力基礎架構", "p": 175.0, "shares": 2780.0, "debt": 87000.0, "cash": 10500.0, "fcf": 12500.0, "beta": 1.10, "kd": 4.6, "tax": 17.0, "g1": 8.5, "g2": 4.5},
    {"s": "ADBE", "name": "Adobe", "exch": "NASDAQ", "sector": "資訊科技", "industry": "創意內容生成軟體 (Creative Cloud)", "p": 520.0, "shares": 445.0, "debt": 6200.0, "cash": 7800.0, "fcf": 7500.0, "beta": 1.25, "kd": 4.0, "tax": 18.0, "g1": 8.0, "g2": 4.5},
    {"s": "CSCO", "name": "Cisco Systems", "exch": "NASDAQ", "sector": "資訊科技", "industry": "企業網路路由器、交換機與網路安全架構", "p": 55.0, "shares": 4010.0, "debt": 32000.0, "cash": 18000.0, "fcf": 12800.0, "beta": 0.85, "kd": 4.2, "tax": 18.0, "g1": 4.0, "g2": 3.0},
    {"s": "QCOM", "name": "Qualcomm", "exch": "NASDAQ", "sector": "資訊科技", "industry": "智慧手機 SoC 晶片與 5G 通訊專利授權", "p": 172.0, "shares": 1110.0, "debt": 15000.0, "cash": 13000.0, "fcf": 11000.0, "beta": 1.25, "kd": 4.2, "tax": 14.0, "g1": 6.5, "g2": 4.0},
    {"s": "TXN", "name": "Texas Instruments", "exch": "NASDAQ", "sector": "資訊科技", "industry": "車載與工業模擬半導體與嵌入式處理器", "p": 208.0, "shares": 910.0, "debt": 14000.0, "cash": 8500.0, "fcf": 4500.0, "beta": 1.00, "kd": 4.2, "tax": 14.0, "g1": 5.0, "g2": 3.5},
    {"s": "IBM", "name": "IBM", "exch": "NYSE", "sector": "資訊科技", "industry": "混合雲架構 (Red Hat) 與大型商業諮詢服務", "p": 225.0, "shares": 920.0, "debt": 59000.0, "cash": 13500.0, "fcf": 12200.0, "beta": 0.70, "kd": 4.5, "tax": 16.0, "g1": 4.5, "g2": 3.5},
    # 通訊服務
    {"s": "GOOGL", "name": "Alphabet (Google)", "exch": "NASDAQ", "sector": "通訊服務", "industry": "全球搜尋引擎、YouTube 串流影音與雲平台", "p": 182.0, "shares": 12350.0, "debt": 29000.0, "cash": 110000.0, "fcf": 71000.0, "beta": 1.05, "kd": 3.5, "tax": 16.0, "g1": 8.0, "g2": 4.5},
    {"s": "META", "name": "Meta Platforms", "exch": "NASDAQ", "sector": "通訊服務", "industry": "社交平台 (Instagram/FB) 數位精準廣告", "p": 590.0, "shares": 2540.0, "debt": 37000.0, "cash": 58000.0, "fcf": 48000.0, "beta": 1.20, "kd": 4.3, "tax": 16.0, "g1": 9.0, "g2": 5.0},
    {"s": "NFLX", "name": "Netflix", "exch": "NASDAQ", "sector": "通訊服務", "industry": "全球訂閱制原創影視串流娛樂平台", "p": 720.0, "shares": 430.0, "debt": 14000.0, "cash": 7000.0, "fcf": 7200.0, "beta": 1.25, "kd": 4.5, "tax": 16.0, "g1": 9.0, "g2": 5.0},
    {"s": "DIS", "name": "Walt Disney", "exch": "NYSE", "sector": "通訊服務", "industry": "主題樂園度假區、IP 影視內容與串流 Disney+", "p": 98.0, "shares": 1820.0, "debt": 47000.0, "cash": 6000.0, "fcf": 8200.0, "beta": 1.30, "kd": 4.6, "tax": 22.0, "g1": 5.0, "g2": 3.5},
    # 金融科技
    {"s": "FICO", "name": "Fair Isaac", "exch": "NYSE", "sector": "金融科技", "industry": "B2B 個人信貸評分標準與決策風控演算法", "p": 2100.0, "shares": 24.5, "debt": 5550.0, "cash": 250.0, "fcf": 850.0, "beta": 1.15, "kd": 5.6, "tax": 23.0, "g1": 3.0, "g2": 4.0},
    {"s": "BRK.B", "name": "Berkshire Hathaway", "exch": "NYSE", "sector": "金融科技", "industry": "產險浮存金商業模式與多元實業控股", "p": 460.0, "shares": 2160.0, "debt": 120000.0, "cash": 189000.0, "fcf": 36000.0, "beta": 0.85, "kd": 4.2, "tax": 21.0, "g1": 5.0, "g2": 3.5},
    {"s": "V", "name": "Visa", "exch": "NYSE", "sector": "金融科技", "industry": "全球數位非現金支付清算網路過路費", "p": 288.0, "shares": 2040.0, "debt": 22000.0, "cash": 16000.0, "fcf": 21500.0, "beta": 0.95, "kd": 3.9, "tax": 19.0, "g1": 8.0, "g2": 5.0},
    {"s": "MA", "name": "Mastercard", "exch": "NYSE", "sector": "金融科技", "industry": "跨國信用卡與金融卡交易交換清算處理", "p": 505.0, "shares": 930.0, "debt": 17000.0, "cash": 9000.0, "fcf": 13800.0, "beta": 1.00, "kd": 4.0, "tax": 18.0, "g1": 9.0, "g2": 5.5},
    # 醫療保健
    {"s": "JNJ", "name": "Johnson & Johnson", "exch": "NYSE", "sector": "醫療保健", "industry": "手術微創醫療器械與創新生物專利藥", "p": 165.0, "shares": 2400.0, "debt": 34000.0, "cash": 23000.0, "fcf": 18500.0, "beta": 0.55, "kd": 4.0, "tax": 16.0, "g1": 4.0, "g2": 3.0},
    {"s": "UNH", "name": "UnitedHealth Group", "exch": "NYSE", "sector": "醫療保健", "industry": "商業健康保險與 Optum 醫療數據管理科技", "p": 590.0, "shares": 920.0, "debt": 68000.0, "cash": 32000.0, "fcf": 26000.0, "beta": 0.60, "kd": 4.4, "tax": 21.0, "g1": 7.0, "g2": 4.5},
    {"s": "ABBV", "name": "AbbVie", "exch": "NYSE", "sector": "醫療保健", "industry": "免疫疾病、抗腫瘤處方藥與醫療美容 (Botox)", "p": 192.0, "shares": 1760.0, "debt": 65000.0, "cash": 14000.0, "fcf": 22500.0, "beta": 0.65, "kd": 4.8, "tax": 15.0, "g1": 4.5, "g2": 3.5},
    {"s": "LLY", "name": "Eli Lilly", "exch": "NYSE", "sector": "醫療保健", "industry": "GLP-1 減重瘦身藥 (Mounjaro) 與糖尿病專利療法", "p": 920.0, "shares": 950.0, "debt": 25000.0, "cash": 4000.0, "fcf": 8500.0, "beta": 0.65, "kd": 4.2, "tax": 16.0, "g1": 15.0, "g2": 6.0},
    {"s": "PFE", "name": "Pfizer", "exch": "NYSE", "sector": "醫療保健", "industry": "疫苗研發、抗腫瘤免疫與心血管處方藥物", "p": 29.0, "shares": 5650.0, "debt": 64000.0, "cash": 7000.0, "fcf": 9800.0, "beta": 0.60, "kd": 4.6, "tax": 15.0, "g1": 3.0, "g2": 2.5},
    {"s": "MRK", "name": "Merck", "exch": "NYSE", "sector": "醫療保健", "industry": "腫瘤免疫療法 (Keytruda) 與成人及兒童疫苗", "p": 115.0, "shares": 2530.0, "debt": 34000.0, "cash": 8500.0, "fcf": 13800.0, "beta": 0.40, "kd": 4.3, "tax": 15.0, "g1": 4.5, "g2": 3.0},
    {"s": "TMO", "name": "Thermo Fisher", "exch": "NYSE", "sector": "醫療保健", "industry": "生命科學分析儀器、實驗室耗材與 CDMO 代工", "p": 595.0, "shares": 382.0, "debt": 35000.0, "cash": 8200.0, "fcf": 7300.0, "beta": 0.85, "kd": 4.2, "tax": 14.0, "g1": 6.5, "g2": 4.0},
    {"s": "ABT", "name": "Abbott Laboratories", "exch": "NYSE", "sector": "醫療保健", "industry": "心血管支架、體外連續血糖監測與醫藥營養品", "p": 118.0, "shares": 1740.0, "debt": 15000.0, "cash": 7500.0, "fcf": 6400.0, "beta": 0.70, "kd": 4.1, "tax": 15.0, "g1": 5.5, "g2": 3.5},
    # 工業製造
    {"s": "CAT", "name": "Caterpillar", "exch": "NYSE", "sector": "工業製造", "industry": "大型工程推土機、重型採礦設備與柴油發電機", "p": 395.0, "shares": 490.0, "debt": 38000.0, "cash": 6000.0, "fcf": 11000.0, "beta": 1.10, "kd": 4.5, "tax": 22.0, "g1": 4.5, "g2": 3.0},
    {"s": "UNP", "name": "Union Pacific", "exch": "NYSE", "sector": "工業製造", "industry": "橫跨美西一級幹線貨運鐵路路網壟斷經營", "p": 245.0, "shares": 605.0, "debt": 33000.0, "cash": 1200.0, "fcf": 6000.0, "beta": 0.85, "kd": 4.6, "tax": 23.0, "g1": 4.0, "g2": 3.0},
    {"s": "HON", "name": "Honeywell", "exch": "NASDAQ", "sector": "工業製造", "industry": "商用航空電子、建築自動化控制與特種化學品", "p": 210.0, "shares": 650.0, "debt": 22000.0, "cash": 8000.0, "fcf": 5500.0, "beta": 0.90, "kd": 4.2, "tax": 21.0, "g1": 4.5, "g2": 3.5},
    {"s": "GE", "name": "GE Aerospace", "exch": "NYSE", "sector": "工業製造", "industry": "商用民航飛機噴射引擎研發製造與售後維修", "p": 192.0, "shares": 1090.0, "debt": 21000.0, "cash": 13000.0, "fcf": 5800.0, "beta": 1.20, "kd": 4.5, "tax": 20.0, "g1": 7.0, "g2": 4.5},
    {"s": "DE", "name": "Deere & Company", "exch": "NYSE", "sector": "工業製造", "industry": "精準農業耕作機械、收割機與林業施工裝備", "p": 415.0, "shares": 275.0, "debt": 58000.0, "cash": 5200.0, "fcf": 7000.0, "beta": 1.05, "kd": 4.6, "tax": 22.0, "g1": 4.0, "g2": 3.0},
    {"s": "RTX", "name": "RTX Corp", "exch": "NYSE", "sector": "工業製造", "industry": "普惠航空引擎 (P&W) 與防務飛彈防禦系統", "p": 125.0, "shares": 1330.0, "debt": 43000.0, "cash": 5500.0, "fcf": 5500.0, "beta": 0.80, "kd": 4.4, "tax": 19.0, "g1": 5.5, "g2": 3.5},
    # 能源石油
    {"s": "XOM", "name": "Exxon Mobil", "exch": "NYSE", "sector": "能源石油", "industry": "深海頁岩油氣勘探開發與石化煉油一體化運營", "p": 122.0, "shares": 3950.0, "debt": 41000.0, "cash": 26000.0, "fcf": 37000.0, "beta": 0.95, "kd": 4.3, "tax": 25.0, "g1": 3.5, "g2": 2.5},
    {"s": "CVX", "name": "Chevron", "exch": "NYSE", "sector": "能源石油", "industry": "全球跨國油氣特許權與液化天然氣 (LNG) 貿易", "p": 155.0, "shares": 1840.0, "debt": 23000.0, "cash": 9000.0, "fcf": 20500.0, "beta": 0.90, "kd": 4.2, "tax": 24.0, "g1": 3.5, "g2": 2.5},
    {"s": "COP", "name": "ConocoPhillips", "exch": "NYSE", "sector": "能源石油", "industry": "獨立低成本非常規頁岩油氣勘探開發", "p": 110.0, "shares": 1160.0, "debt": 19000.0, "cash": 6200.0, "fcf": 11000.0, "beta": 1.15, "kd": 4.5, "tax": 23.0, "g1": 4.0, "g2": 2.5},
    # 公用事業與房地產
    {"s": "NEE", "name": "NextEra Energy", "exch": "NYSE", "sector": "公用事業", "industry": "佛州法規保障電網與風力太陽能綠色發電龍頭", "p": 85.0, "shares": 2050.0, "debt": 76000.0, "cash": 3000.0, "fcf": 8800.0, "beta": 0.55, "kd": 4.6, "tax": 18.0, "g1": 6.5, "g2": 4.0},
    {"s": "SO", "name": "Southern Company", "exch": "NYSE", "sector": "公用事業", "industry": "美東南基載核電與天然氣電力管網公用事業", "p": 92.0, "shares": 1090.0, "debt": 61000.0, "cash": 2000.0, "fcf": 4300.0, "beta": 0.45, "kd": 4.5, "tax": 20.0, "g1": 4.0, "g2": 3.0},
    {"s": "DUK", "name": "Duke Energy", "exch": "NYSE", "sector": "公用事業", "industry": "受規管電力公用事業網絡與天然氣基礎設施", "p": 116.0, "shares": 770.0, "debt": 79000.0, "cash": 1500.0, "fcf": 3900.0, "beta": 0.45, "kd": 4.6, "tax": 18.0, "g1": 4.0, "g2": 3.0},
    {"s": "PLD", "name": "Prologis REIT", "exch": "NYSE", "sector": "房地產 REITs", "industry": "全球海空港核心樞紐現代化供應鏈物流倉儲", "p": 126.0, "shares": 925.0, "debt": 31000.0, "cash": 1500.0, "fcf": 4200.0, "beta": 0.90, "kd": 4.4, "tax": 5.0, "g1": 6.0, "g2": 4.0},
    {"s": "O", "name": "Realty Income", "exch": "NYSE", "sector": "房地產 REITs", "industry": "月月配息防禦性商業地產單一租戶淨租賃 (Net Lease)", "p": 63.5, "shares": 870.0, "debt": 25000.0, "cash": 800.0, "fcf": 3500.0, "beta": 0.70, "kd": 4.5, "tax": 5.0, "g1": 4.5, "g2": 3.5},
    {"s": "AMT", "name": "American Tower", "exch": "NYSE", "sector": "房地產 REITs", "industry": "5G 無線通訊基地台鐵塔與邊緣資料中心租賃", "p": 225.0, "shares": 468.0, "debt": 39000.0, "cash": 2100.0, "fcf": 4600.0, "beta": 0.75, "kd": 4.3, "tax": 5.0, "g1": 5.0, "g2": 3.5}
]

def try_fetch_live_price(symbol):
    clean_sym = symbol.replace(".", "-")
    # 嘗試 FMP 端點
    if API_KEY:
        try:
            url = f"https://financialmodelingprep.com/stable/quote?symbol={clean_sym}&apikey={API_KEY}"
            res = requests.get(url, timeout=3)
            if res.status_code == 200:
                data = res.json()
                if isinstance(data, list) and len(data) > 0 and data[0].get("price"):
                    return round(float(data[0]["price"]), 2)
        except Exception:
            pass
    return None

def calculate_dcf(item):
    p = item["p"]
    shares = item["shares"]
    debt = item["debt"]
    cash = item["cash"]
    fcf0 = item["fcf"]
    beta = item["beta"]
    kd = item.get("kd", 4.5)
    tax = item.get("tax", 21.0)
    g1 = item.get("g1", 5.0)
    g2 = item.get("g2", 3.5)

    net_debt = debt - cash
    E = p * shares
    V = E + debt
    wE = E / V if V > 0 else 1.0
    wD = debt / V if V > 0 else 0.0

    ke = RF + (beta * ERP)
    kd_after = (kd / 100) * (1 - (tax / 100))
    wacc = (wE * ke) + (wD * kd_after)

    growth = [g1 / 100]*5 + [g2 / 100]*5
    sum_pv = 0
    cur_fcf = fcf0

    for t, gr in enumerate(growth, 1):
        cur_fcf *= (1 + gr)
        df = 1 / ((1 + wacc) ** t)
        sum_pv += cur_fcf * df

    fcf11 = cur_fcf * (1 + DEFAULT_G)
    safe_wacc = max(wacc, DEFAULT_G + 0.015)
    tv = fcf11 / (safe_wacc - DEFAULT_G)
    pv_tv = tv / ((1 + safe_wacc) ** 10)

    ev = sum_pv + pv_tv
    eq_val = ev - net_debt
    fair_val = eq_val / shares
    premium_pct = ((p / fair_val) - 1) * 100

    return {
        "name": item["name"],
        "exchange": item["exch"],
        "sector": item.get("sector", "一般商業"),
        "industry": item.get("industry", "多元跨國業務"),
        "price": round(p, 2),
        "shares": round(shares, 1),
        "debt": round(debt, 1),
        "cash": round(cash, 1),
        "fcf0": round(fcf0, 1),
        "beta": round(beta, 2),
        "kd": kd,
        "tax": tax,
        "g1": g1,
        "g2": g2,
        "g": round(DEFAULT_G * 100, 2),
        "wacc": round(wacc * 100, 2),
        "ev": round(ev, 1),
        "net_debt": round(net_debt, 1),
        "fair_val": round(fair_val, 2),
        "premium_pct": round(premium_pct, 1),
        "is_undervalued": premium_pct < 0
    }

def main():
    print("🚀 正在啟動美股 DCF 計算引擎...")
    results = {}

    for item in UNIVERSE:
        sym = item["s"]
        live_price = try_fetch_live_price(sym)
        if live_price:
            item["p"] = live_price
        results[sym] = calculate_dcf(item)

    with open("full_market_dcf.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print(f"✅ 成功完成！共輸出 {len(results)} 檔具備真實財務與產業分類之 DCF 數據！")

if __name__ == "__main__":
    main()
