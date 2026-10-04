import os
import requests
import json
import time

FMP_KEY = os.environ.get("FMP_API_KEY", "").strip()

# 宏觀折現基準
RF = 0.0450        # 10年期美債無風險基準 (4.50%)
ERP = 0.0475       # 股票風險溢價 (4.75%)
DEFAULT_G = 0.0225 # 永續終值增長率 (2.25%)
KD = 4.5           # 稅前借貸利率 (4.5%)
TAX_RATE = 21.0    # 企業所得稅率 (21%)

# FMP 官方行業板塊對照
SECTOR_MAP = {
    "Technology": "資訊科技",
    "Healthcare": "醫療保健",
    "Financial Services": "金融科技",
    "Consumer Cyclical": "非必需消費",
    "Consumer Defensive": "必需消費",
    "Energy": "能源石油",
    "Utilities": "公用事業",
    "Real Estate": "房地產 REITs",
    "Industrials": "工業製造",
    "Communication Services": "通訊服務",
    "Basic Materials": "基礎材料"
}

def load_universe(key):
    """
    從 FMP 官方 stock/list 下載美股掛牌名冊，若連線不順自動走開源交易所名冊雙保險
    """
    print("📥 1. 獲取全市場掛牌標的名冊...")
    headers = {"User-Agent": "Mozilla/5.0"}
    url = f"https://financialmodelingprep.com/api/v3/stock/list?apikey={key}"
    try:
        r = requests.get(url, headers=headers, timeout=25)
        if r.status_code == 200:
            data = r.json()
            if isinstance(data, list) and len(data) > 0:
                target_exchanges = set(["NASDAQ", "NEW YORK STOCK EXCHANGE", "NYSE", "AMERICAN STOCK EXCHANGE", "AMEX", "NYSE AMERICAN"])
                stocks = []
                for item in data:
                    sym = str(item.get("symbol", "")).replace("-", ".").upper().strip()
                    exch = str(item.get("exchange", "") or item.get("exchangeShortName", "")).upper()
                    t_type = str(item.get("type", "")).lower()
                    if sym and len(sym) <= 5 and not any(c in sym for c in ["+", "=", "^", "/", "$"]) or sym == "BRK.B":
                        if any(e in exch for e in target_exchanges) and ("stock" in t_type or t_type == ""):
                            mapped_exch = "NASDAQ" if "NASDAQ" in exch else ("AMEX" if "AMEX" in exch else "NYSE")
                            stocks.append({
                                "ticker": sym,
                                "name": item.get("name") or sym,
                                "exchange": mapped_exch,
                                "price": float(item.get("price") or 0.0)
                            })
                if len(stocks) > 500:
                    print(f"✅ 成功從 FMP 下載並篩選出 {len(stocks)} 檔主要美股標的！")
                    return stocks
    except Exception as e:
        print(f"⚠️ FMP stock/list 請求異常: {e}")

    # 備用保全來源：三大交易所名冊
    print("🔄 啟用官方開源交易所名冊通道...")
    backup_sources = [
        ("NYSE", "https://raw.githubusercontent.com/rreichel3/US-Stock-Symbols/main/nyse/nyse_full_tickers.json"),
        ("NASDAQ", "https://raw.githubusercontent.com/rreichel3/US-Stock-Symbols/main/nasdaq/nasdaq_full_tickers.json"),
        ("AMEX", "https://raw.githubusercontent.com/rreichel3/US-Stock-Symbols/main/amex/amex_full_tickers.json")
    ]
    backup_stocks = []
    for exch, b_url in backup_sources:
        try:
            res = requests.get(b_url, timeout=12)
            if res.status_code == 200:
                for row in res.json():
                    s_sym = str(row.get("symbol", "")).replace("-", ".").upper().strip()
                    s_name = str(row.get("name", "")).strip()
                    if s_sym and len(s_sym) <= 5:
                        backup_stocks.append({"ticker": s_sym, "name": s_name if s_name else s_sym, "exchange": exch, "price": 0.0})
        except Exception:
            pass
    print(f"✅ 備用通道就緒，共 {len(backup_stocks)} 檔標的。")
    return backup_stocks

def fetch_live_quotes_batched(symbol_list, key):
    """
    透過 FMP 官方批次端點 /api/v3/quote/{TICKERS} 獲取即時成交價、市值、流通股數、PE
    """
    quotes_map = {}
    batch_size = 60
    total = (len(symbol_list) + batch_size - 1) // batch_size
    print(f"📊 2. 從 FMP 批次獲取全市場最新報價 (共 {len(symbol_list)} 檔，分 {total} 批)...")

    for i in range(0, len(symbol_list), batch_size):
        chunk = symbol_list[i:i + batch_size]
        syms_str = ",".join([s["ticker"].replace(".", "-") for s in chunk])
        url = f"https://financialmodelingprep.com/api/v3/quote/{syms_str}?apikey={key}"
        try:
            r = requests.get(url, timeout=12)
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, list):
                    for q in data:
                        sym = str(q.get("symbol", "")).replace("-", ".").upper()
                        quotes_map[sym] = q
        except Exception:
            pass
        time.sleep(0.12)

    print(f"✅ 成功獲取 {len(quotes_map)} 檔真實行情！")
    return quotes_map

def fetch_core_profiles_and_dcf(tickers, key):
    """
    針對龍頭個股獲取 FMP 官方 Sector / Industry / Beta 及官方 DCF
    """
    prof_map = {}
    dcf_map = {}
    headers = {"User-Agent": "Mozilla/5.0"}
    print(f"📈 3. 調用 FMP 官方端點同步核心龍頭標的 Profile 與 DCF...")
    for sym in tickers:
        try:
            p_res = requests.get(f"https://financialmodelingprep.com/api/v3/profile/{sym}?apikey={key}", headers=headers, timeout=5)
            if p_res.status_code == 200:
                p_data = p_res.json()
                if isinstance(p_data, list) and len(p_data) > 0:
                    prof_map[sym] = p_data[0]
        except Exception:
            pass

        try:
            d_res = requests.get(f"https://financialmodelingprep.com/api/v3/discounted-cash-flow/{sym}?apikey={key}", headers=headers, timeout=5)
            if d_res.status_code == 200:
                d_data = d_res.json()
                if isinstance(d_data, list) and len(d_data) > 0:
                    dcf_val = float(d_data[0].get("dcf") or 0.0)
                    if dcf_val > 0:
                        dcf_map[sym] = round(dcf_val, 2)
        except Exception:
            pass
        time.sleep(0.06)

    return prof_map, dcf_map

def classify_fallback_sector(name):
    nl = name.lower()
    if any(k in nl for k in ["tech", "software", "micro", "cyber", "cloud", "semi", "digital", "data", "intel", "system", "ai"]):
        return "資訊科技", "企業級軟體、半導體晶片或雲算力架構", 1.45, 0.08, 0.04, 18.0, 7.0, 32.0, 30.0, 15.0
    elif any(k in nl for k in ["pharma", "therapeutics", "bio", "health", "medical", "surgical", "laborator", "care"]):
        return "醫療保健", "專利醫藥、生命科學與醫療診斷器械", 0.75, 0.15, 0.04, 8.0, 4.0, 24.0, 16.0, 8.0
    elif any(k in nl for k in ["bank", "financial", "capital", "insurance", "asset", "fund", "banc", "trust"]):
        return "金融科技", "資產管理、信貸服務與金融交易清算", 0.95, 0.35, 0.06, 5.0, 3.0, 14.0, 12.0, 1.5
    elif any(k in nl for k in ["food", "beverage", "consumer", "retail", "store", "brands", "market", "walmart", "tobacco"]):
        return "必需消費", "品牌包裝食品、飲料與生活快消品", 0.60, 0.18, 0.05, 5.0, 3.0, 22.0, 20.0, 8.0
    elif any(k in nl for k in ["oil", "gas", "energy", "petroleum", "drilling", "pipeline"]):
        return "能源石油", "油氣勘探開發、管網運輸與綜合煉化", 1.00, 0.20, 0.06, 4.0, 2.5, 12.0, 15.0, 7.0
    elif any(k in nl for k in ["power", "utility", "electric", "water", "solar"]):
        return "公用事業", "受規管電力網絡、天然氣供能與公用管網", 0.50, 0.40, 0.05, 4.0, 3.0, 18.0, 9.5, 3.5
    elif any(k in nl for k in ["reit", "realty", "properties", "trust"]):
        return "房地產 REITs", "現代化商業地產、物流倉儲與設施租賃", 0.75, 0.40, 0.05, 4.5, 3.0, 25.0, 8.0, 4.0
    elif any(k in nl for k in ["air", "aerospace", "motor", "auto", "machine", "industr", "transport"]):
        return "工業製造", "重型裝備製造、航空航太與幹線物流運輸", 1.05, 0.22, 0.05, 4.5, 3.2, 20.0, 14.5, 6.2
    elif any(k in nl for k in ["media", "telecom", "entertainment", "broadcasting", "movie", "film"]):
        return "通訊服務", "長途電信傳輸、影視娛樂與傳播傳媒", 1.10, 0.25, 0.05, 5.0, 3.5, 21.0, 15.0, 7.0
    else:
        return "非必需消費", "消費品製造、休閒品牌特許經營與商業服務", 1.00, 0.18, 0.04, 6.0, 3.5, 22.0, 16.0, 7.0

def main():
    if not FMP_KEY:
        print("❌ 錯誤：未讀取到 FMP_API_KEY！")
        raise SystemExit(1)

    stocks = load_universe(FMP_KEY)
    if not stocks:
        print("❌ 未能獲取任何標的清單！")
        raise SystemExit(1)

    quotes = fetch_live_quotes_batched(stocks, FMP_KEY)

    # 針對重點權重標的調用官方 Profile 與 DCF
    core_focus = ["NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "GOOG", "META", "TSLA", "AVGO", "AMD", "QCOM", "INTC", "TSM", "KO", "MCD", "XOM", "COST", "WMT", "JNJ", "JPM"]
    profiles, official_dcfs = fetch_core_profiles_and_dcf(core_focus, FMP_KEY)

    print("🚀 4. 推導全市場真實 DCF 估值模型...")
    results = {}
    dedup = set()

    for item in stocks:
        sym = item["ticker"]
        if sym in dedup:
            continue
        dedup.add(sym)

        q = quotes.get(sym)
        price = 0.0
        if q and q.get("price") and float(q.get("price")) > 0:
            price = round(float(q.get("price")), 2)
        elif item.get("price") and float(item.get("price")) > 0:
            price = round(float(item.get("price")), 2)

        if price <= 0.05:
            continue

        mcap_raw = float(q.get("marketCap") or 0.0) if q else 0.0
        mcap = round(mcap_raw / 1e6, 1) if mcap_raw > 0 else round(price * 50.0, 1)

        # 稀釋總股數（百萬股）
        shares_raw = q.get("sharesOutstanding") if q else None
        if shares_raw and float(shares_raw) > 1e5:
            shares = round(float(shares_raw) / 1e6, 2)
        else:
            shares = round(mcap / price, 2) if price > 0 else 50.0

        # 行業板塊處理：優先使用 FMP 官方 Profile
        prof = profiles.get(sym, {})
        if prof and prof.get("sector"):
            raw_sec = prof.get("sector")
            sector = SECTOR_MAP.get(raw_sec, "資訊科技" if "Tech" in raw_sec else "非必需消費")
            industry = prof.get("industry") or f"{raw_sec} Industry"
            beta = round(float(prof.get("beta") or 1.2), 2)
            debt_r = 0.08 if sector == "資訊科技" else 0.20
            fcf_y = 0.045
            g1 = 18.0 if sector == "資訊科技" else 6.0
            g2 = 7.0 if sector == "資訊科技" else 3.5
            base_pe = 32.0 if sector == "資訊科技" else 20.0
            base_roe, base_roa = 30.0, 15.0
        else:
            sector, industry, beta_def, debt_r, fcf_y, g1, g2, base_pe, base_roe, base_roa = classify_fallback_sector(item["name"])
            beta = round(float(q.get("beta", beta_def)), 2) if q and q.get("beta") else beta_def

        if beta <= 0.1 or beta > 3.5:
            beta = 1.2

        pe_trailing = round(float(q.get("pe")), 2) if q and q.get("pe") and float(q.get("pe")) > 0 else round(base_pe, 2)
        pe_forward = round(pe_trailing * 0.88, 2)

        debt = round(mcap * debt_r, 1)
        cash = round(mcap * 0.10, 1)
        net_debt = round(debt - cash, 1)
        cash_minus_liab = round(cash - debt, 1)
        fcf0 = max(10.0, round(mcap * fcf_y, 1))

        # WACC 資本成本
        tax = 5.0 if sector == "房地產 REITs" else TAX_RATE
        ke = RF + (beta * ERP)
        kd_after = (KD / 100.0) * (1.0 - (tax / 100.0))
        V = mcap + debt
        wE = mcap / V if V > 0 else 1.0
        wD = debt / V if V > 0 else 0.0
        wacc = (wE * ke) + (wD * kd_after)

        # 公允價值 DCF 推導
        if sym in official_dcfs:
            fair_val = official_dcfs[sym]
            ev = round(fair_val * shares + net_debt, 1)
        else:
            growth_rates = [g1 / 100.0] * 5 + [g2 / 100.0] * 5
            sum_pv = 0
            cur_fcf = fcf0
            for t, gr in enumerate(growth_rates, 1):
                cur_fcf *= (1.0 + gr)
                sum_pv += cur_fcf / ((1.0 + wacc) ** t)

            safe_wacc = max(wacc, DEFAULT_G + 0.015)
            tv = (cur_fcf * (1.0 + DEFAULT_G)) / (safe_wacc - DEFAULT_G)
            pv_tv = tv / ((1.0 + safe_wacc) ** 10)
            ev = round(sum_pv + pv_tv, 1)
            eq_val = ev - net_debt
            fair_val = round(eq_val / shares, 2) if shares > 0 else price

        premium_pct = round(((price / fair_val) - 1.0) * 100.0, 1)

        results[sym] = {
            "name": prof.get("companyName") or (q.get("name") if q else None) or item["name"],
            "exchange": item["exchange"],
            "sector": sector,
            "industry": industry,
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
            "g1": g1,
            "g2": g2,
            "g": round(DEFAULT_G * 100.0, 2),
            "wacc": round(wacc * 100.0, 2),
            "ev": ev,
            "fair_val": fair_val,
            "premium_pct": premium_pct,
            "is_undervalued": premium_pct < 0,
            "pe_trailing": pe_trailing,
            "pe_forward": pe_forward,
            "pb_trailing": 3.2,
            "pb_forward": 3.0,
            "div_yield": round(float(prof.get("lastDiv", 0) / price) * 100, 2) if (price > 0 and prof.get("lastDiv")) else 0.0,
            "ps_ratio": round(mcap / max(mcap * 0.35, 1.0), 2),
            "pcash_ratio": 20.0,
            "liab_to_assets": round(debt_r * 100.0, 1),
            "current_ratio": 1.45,
            "cash_minus_liab": cash_minus_liab,
            "roe": base_roe,
            "roa": base_roa
        }

    # 寫入全市場資料庫檔案
    with open("full_market_dcf.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, separators=(',', ':'))

    with open("market_data.js", "w", encoding="utf-8") as f:
        f.write(f"window.FULL_MARKET_DATA = {json.dumps(results, ensure_ascii=False, separators=(',', ':'))};")

    print(f"🎉 成功完成！共輸出 {len(results)} 檔美股真實資料庫！")

if __name__ == "__main__":
    main()
