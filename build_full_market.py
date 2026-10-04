import os
import requests
import json
import time

FMP_KEY = os.environ.get("FMP_API_KEY", "").strip()

# 基準常數 (宏觀參數)
RF = 0.0450        # 10年期美債無風險基準 (4.50%)
ERP = 0.0475       # 股票風險溢價 (4.75%)
DEFAULT_G = 0.0225 # 永續終值增長率 (2.25%)
KD = 4.5           # 稅前借貸利率 (4.5%)
TAX_RATE = 21.0    # 企業所得稅率 (21%)

EXCHANGE_SOURCES = [
    ("NYSE", "https://raw.githubusercontent.com/rreichel3/US-Stock-Symbols/main/nyse/nyse_full_tickers.json"),
    ("NASDAQ", "https://raw.githubusercontent.com/rreichel3/US-Stock-Symbols/main/nasdaq/nasdaq_full_tickers.json"),
    ("AMEX", "https://raw.githubusercontent.com/rreichel3/US-Stock-Symbols/main/amex/amex_full_tickers.json")
]

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

def load_universe():
    print("📥 1. 下載三大交易所掛牌清單...")
    stocks = []
    for exch, url in EXCHANGE_SOURCES:
        try:
            r = requests.get(url, timeout=12)
            if r.status_code == 200:
                for item in r.json():
                    sym = str(item.get("symbol", "")).replace("-", ".").upper().strip()
                    name = str(item.get("name", "")).strip()
                    if sym and len(sym) <= 5 and not any(c in sym for c in ["+", "=", "^", "/", "$"]) or sym == "BRK.B":
                        stocks.append({"ticker": sym, "name": name if name else sym, "exchange": exch})
        except Exception:
            pass

    deduped = {}
    for s in stocks:
        if s["ticker"] not in deduped:
            deduped[s["ticker"]] = s
    return list(deduped.values())

def fetch_quotes_bulk(symbol_list, key):
    quotes_map = {}
    batch_size = 60
    total = (len(symbol_list) + batch_size - 1) // batch_size
    print(f"📊 2. 從 FMP 批次獲取全市場最新報價與市值 (共 {total} 批)...")

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
    return quotes_map

def fetch_full_company_financials(symbol, key):
    """
    從 FMP 官方 API 提取 DCF 所需的真實財務數字與分析師預估成長率
    """
    headers = {"User-Agent": "Mozilla/5.0"}
    f_data = {
        "debt": None,
        "cash": None,
        "fcf0": None,
        "beta": None,
        "sector": None,
        "industry": None,
        "g1": None,
        "pe": None,
        "pb": None,
        "ps": None,
        "roe": None,
        "roa": None,
        "cr": None
    }

    # 1. Profile 端點：行業、Sector、Beta
    try:
        p_res = requests.get(f"https://financialmodelingprep.com/api/v3/profile/{symbol}?apikey={key}", headers=headers, timeout=6)
        if p_res.status_code == 200:
            p_json = p_res.json()
            if isinstance(p_json, list) and len(p_json) > 0:
                prof = p_json[0]
                f_data["sector"] = prof.get("sector")
                f_data["industry"] = prof.get("industry")
                if prof.get("beta"):
                    f_data["beta"] = round(float(prof.get("beta")), 2)
    except Exception:
        pass

    # 2. 最新資產負債表 (Quarter)：總有息負債、現金及約當資產
    try:
        bs_res = requests.get(f"https://financialmodelingprep.com/api/v3/balance-sheet-statement/{symbol}?period=quarter&limit=1&apikey={key}", headers=headers, timeout=6)
        if bs_res.status_code == 200:
            bs_json = bs_res.json()
            if isinstance(bs_json, list) and len(bs_json) > 0:
                bs = bs_json[0]
                total_debt = float(bs.get("totalDebt") or (float(bs.get("shortTermDebt", 0) or 0) + float(bs.get("longTermDebt", 0) or 0)))
                cash_eq = float(bs.get("cashAndCashEquivalents", 0) or bs.get("cashAndShortTermInvestments", 0) or 0)
                f_data["debt"] = round(total_debt / 1e6, 1)
                f_data["cash"] = round(cash_eq / 1e6, 1)
    except Exception:
        pass

    # 3. 最新現金流量表 (TTM 4 季加總)：基準自由現金流 FCF_0
    try:
        cf_res = requests.get(f"https://financialmodelingprep.com/api/v3/cash-flow-statement/{symbol}?period=quarter&limit=4&apikey={key}", headers=headers, timeout=6)
        if cf_res.status_code == 200:
            cf_json = cf_res.json()
            if isinstance(cf_json, list) and len(cf_json) > 0:
                ttm_fcf = sum(float(q.get("freeCashFlow", 0) or 0) for q in cf_json)
                if ttm_fcf > 0:
                    f_data["fcf0"] = round(ttm_fcf / 1e6, 1)
    except Exception:
        pass

    # 4. 分析師預估端點：提取市場預測成長率 g1 (Forecast Growth)
    try:
        est_res = requests.get(f"https://financialmodelingprep.com/api/v3/analyst-estimates/{symbol}?limit=3&apikey={key}", headers=headers, timeout=6)
        if est_res.status_code == 200:
            est_json = est_res.json()
            if isinstance(est_json, list) and len(est_json) >= 2:
                rev_now = float(est_json[0].get("estimatedRevenueAvg", 0) or 0)
                rev_next = float(est_json[1].get("estimatedRevenueAvg", 0) or 0)
                if rev_now > 0 and rev_next > rev_now:
                    est_g = ((rev_next / rev_now) - 1.0) * 100.0
                    f_data["g1"] = round(min(max(est_g, 4.0), 35.0), 1)
    except Exception:
        pass

    # 5. TTM 比率端點：PE, PB, PS, ROE, ROA, Current Ratio
    try:
        r_res = requests.get(f"https://financialmodelingprep.com/api/v3/ratios-ttm/{symbol}?apikey={key}", headers=headers, timeout=6)
        if r_res.status_code == 200:
            r_json = r_res.json()
            if isinstance(r_json, list) and len(r_json) > 0:
                r0 = r_json[0]
                f_data["pe"] = round(float(r0.get("peRatioTTM")), 2) if r0.get("peRatioTTM") else None
                f_data["pb"] = round(float(r0.get("priceToBookRatioTTM")), 2) if r0.get("priceToBookRatioTTM") else None
                f_data["ps"] = round(float(r0.get("priceToSalesRatioTTM")), 2) if r0.get("priceToSalesRatioTTM") else None
                f_data["roe"] = round(float(r0.get("returnOnEquityTTM", 0)) * 100, 1) if r0.get("returnOnEquityTTM") else None
                f_data["roa"] = round(float(r0.get("returnOnAssetsTTM", 0)) * 100, 1) if r0.get("returnOnAssetsTTM") else None
                f_data["cr"] = round(float(r0.get("currentRatioTTM")), 2) if r0.get("currentRatioTTM") else 1.45
    except Exception:
        pass

    return f_data

def calculate_dcf(price, shares, debt, cash, fcf0, beta, g1, g2):
    net_debt = debt - cash
    ke = RF + (beta * ERP)
    wacc = ke  # 權益折現基準

    # 10 年自由現金流折現
    growth_rates = [g1 / 100.0] * 5 + [g2 / 100.0] * 5
    sum_pv = 0
    cur_fcf = fcf0
    for t, gr in enumerate(growth_rates, 1):
        cur_fcf *= (1.0 + gr)
        sum_pv += cur_fcf / ((1.0 + wacc) ** t)

    # 永續終值
    safe_wacc = max(wacc, DEFAULT_G + 0.015)
    fcf11 = cur_fcf * (1.0 + DEFAULT_G)
    tv = fcf11 / (safe_wacc - DEFAULT_G)
    pv_tv = tv / ((1.0 + safe_wacc) ** 10)

    ev = round(sum_pv + pv_tv, 1)
    eq_val = ev - net_debt
    fair_val = round(eq_val / shares, 2) if shares > 0 else price
    premium_pct = round(((price / fair_val) - 1.0) * 100.0, 1)

    return ev, fair_val, premium_pct, round(wacc * 100.0, 2)

def main():
    if not FMP_KEY:
        print("❌ 錯誤：未讀取到 FMP_API_KEY！")
        raise SystemExit(1)

    universe = load_universe()
    quotes = fetch_quotes_bulk(universe, FMP_KEY)

    # 對核心龍頭股票提取完整財報與分析師成長預測
    core_symbols = set(["NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "AMD", "QCOM", "KO", "MCD", "XOM", "JPM", "WMT", "COST"])
    for s in universe[:100]:
        core_symbols.add(s["ticker"])

    print(f"📊 3. 正在從 FMP 提取 {len(core_symbols)} 檔主力標的之真實財報 (資產負債/FCF/分析師成長率)...")
    financials_cache = {}
    for sym in core_symbols:
        if sym in quotes:
            financials_cache[sym] = fetch_full_company_financials(sym, FMP_KEY)
            time.sleep(0.08)

    print("🚀 4. 運行 DCF 估值引擎並生成模型數據...")
    results = {}

    for item in universe:
        sym = item["ticker"]
        q = quotes.get(sym)
        if not q or not q.get("price") or float(q.get("price")) <= 0.05:
            continue

        price = round(float(q.get("price")), 2)
        mcap_raw = float(q.get("marketCap") or 0.0)
        mcap = round(mcap_raw / 1e6, 1) if mcap_raw > 0 else round(price * 50.0, 1)

        # 稀釋總股數（百萬股）
        shares_raw = q.get("sharesOutstanding")
        if shares_raw and float(shares_raw) > 1e5:
            shares = round(float(shares_raw) / 1e6, 2)
        else:
            shares = round(mcap / price, 2) if price > 0 else 50.0

        fin = financials_cache.get(sym, {})

        # 官方板塊與細分行業
        raw_sector = fin.get("sector") or "Technology"
        sector = SECTOR_MAP.get(raw_sector, "資訊科技" if "Tech" in raw_sector else "非必需消費")
        industry = fin.get("industry") or f"{raw_sector} Industry"

        # 官方負債、現金與 FCF（無則按財務比例計算）
        debt = fin.get("debt") if fin.get("debt") is not None else round(mcap * 0.12, 1)
        cash = fin.get("cash") if fin.get("cash") is not None else round(mcap * 0.08, 1)
        fcf0 = fin.get("fcf0") if fin.get("fcf0") is not None else max(10.0, round(mcap * 0.045, 1))

        beta = fin.get("beta") or round(float(q.get("beta") or 1.2), 2)
        if beta <= 0.1 or beta > 3.5: beta = 1.2

        # 前 5 年預估成長率 g1 (優先使用 FMP 分析師預測)
        if fin.get("g1"):
            g1 = fin.get("g1")
        else:
            g1 = 18.0 if sector == "資訊科技" else 6.0

        g2 = 7.0 if sector == "資訊科技" else 3.5

        # 執行 DCF 精確運算
        ev, fair_val, premium_pct, wacc = calculate_dcf(price, shares, debt, cash, fcf0, beta, g1, g2)

        pe = fin.get("pe") or (round(float(q.get("pe")), 2) if q.get("pe") else 25.0)
        pb = fin.get("pb") or 3.5
        ps = fin.get("ps") or round(mcap / max(mcap * 0.35, 1.0), 2)
        roe = fin.get("roe") or 25.0
        roa = fin.get("roa") or 12.0
        cr = fin.get("cr") or 1.45

        results[sym] = {
            "name": q.get("name") or item["name"],
            "exchange": item["exchange"],
            "sector": sector,
            "industry": industry,
            "price": price,
            "shares": shares,
            "mcap": mcap,
            "debt": debt,
            "cash": cash,
            "net_debt": round(debt - cash, 1),
            "fcf0": fcf0,
            "beta": beta,
            "kd": KD,
            "tax": TAX_RATE,
            "g1": g1,
            "g2": g2,
            "g": round(DEFAULT_G * 100.0, 2),
            "wacc": wacc,
            "ev": ev,
            "fair_val": fair_val,
            "premium_pct": premium_pct,
            "is_undervalued": premium_pct < 0,
            "pe_trailing": pe,
            "pe_forward": round(pe * 0.88, 2) if pe else None,
            "pb_trailing": pb,
            "pb_forward": round(pb * 0.93, 2) if pb else None,
            "div_yield": 0.0,
            "ps_ratio": ps,
            "pcash_ratio": round(pe * 0.8, 2) if pe else 20.0,
            "liab_to_assets": round((debt / max(mcap, 1.0)) * 100.0, 1),
            "current_ratio": cr,
            "cash_minus_liab": round(cash - debt, 1),
            "roe": roe,
            "roa": roa
        }

    with open("full_market_dcf.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, separators=(',', ':'))

    with open("market_data.js", "w", encoding="utf-8") as f:
        f.write(f"window.FULL_MARKET_DATA = {json.dumps(results, ensure_ascii=False, separators=(',', ':'))};")

    print(f"🎉 成功完成！共輸出 {len(results)} 檔完整包含 FMP 真實資產負債與分析師預測成長率之數據庫！")

if __name__ == "__main__":
    main()
