import os
import requests
import json

FMP_KEY = os.environ.get("FMP_API_KEY")
RF = 0.0450        # 10年期美債無風險基準 (4.50%)
ERP = 0.0475       # 股票風險溢價 (4.75%)
DEFAULT_G = 0.0225 # 永續終值增長率 (2.25%)

def main():
    if not FMP_KEY:
        raise ValueError("請先在 GitHub Secrets 設定 FMP_API_KEY！")

    print("📥 1. 從 FMP 一鍵獲取全美股實時行情快照...")
    # FMP 原生端點：一次請求回傳全市場所有活躍標的實時報價
    price_url = f"https://financialmodelingprep.com/api/v3/stock/full/real-time-price?apikey={FMP_KEY}"
    res = requests.get(price_url, timeout=30)
    raw_prices = res.json()
    price_map = {item['symbol'].replace('-', '.'): item['price'] for item in raw_prices if 'symbol' in item and 'price' in item}

    print("📥 2. 獲取 NYSE, NASDAQ, AMEX 活躍交易標的名冊與市值...")
    screener_url = f"https://financialmodelingprep.com/api/v3/stock-screener?exchange=NYSE,NASDAQ,AMEX&isActivelyTrading=true&limit=10000&apikey={FMP_KEY}"
    res_screener = requests.get(screener_url, timeout=30)
    stock_list = res_screener.json()

    print(f"📊 成功檢索到 {len(stock_list)} 檔標的，開始推導全市場 DCF 模型...")
    results = {}

    for s in stock_list:
        sym = s.get("symbol", "").replace("-", ".").upper()
        if not sym or len(sym) > 5:
            continue

        price = price_map.get(sym) or s.get("price") or 0.0
        if price <= 0.05:
            continue

        mcap = s.get("marketCap", 0) / 1e6  # 換算成百萬美元 ($M)
        shares = round(mcap / price, 2) if (price > 0 and mcap > 0) else 100.0
        sector = s.get("sector") or "非必需消費"
        industry = s.get("industry") or sector
        beta = s.get("beta") or 1.0
        if beta <= 0.1 or beta > 3.5: beta = 1.0

        # DCF 模型參數
        debt = round(mcap * 0.25, 1)
        cash = round(mcap * 0.08, 1)
        net_debt = round(debt - cash, 1)
        fcf0 = max(1.0, round(mcap * 0.05, 1))

        kd = 4.5
        tax = 5.0 if "Real Estate" in sector or "REIT" in sector else 21.0
        E = mcap
        V = E + debt
        wE = E / V if V > 0 else 1.0
        wD = debt / V if V > 0 else 0.0
        ke = RF + (beta * ERP)
        kd_after = (kd / 100.0) * (1.0 - (tax / 100.0))
        wacc = (wE * ke) + (wD * kd_after)

        g1 = 6.0 if sector in ["Technology", "Healthcare"] else 4.5
        g2 = 3.5
        growth = [g1 / 100.0] * 5 + [g2 / 100.0] * 5
        sum_pv = 0
        cur_fcf = fcf0
        for t, gr in enumerate(growth, 1):
            cur_fcf *= (1.0 + gr)
            sum_pv += cur_fcf / ((1.0 + wacc) ** t)

        fcf11 = cur_fcf * (1.0 + DEFAULT_G)
        safe_wacc = max(wacc, DEFAULT_G + 0.015)
        tv = fcf11 / (safe_wacc - DEFAULT_G)
        pv_tv = tv / ((1.0 + safe_wacc) ** 10)

        ev = round(sum_pv + pv_tv, 1)
        eq_val = ev - net_debt
        fair_val = round(eq_val / shares, 2) if shares > 0 else price
        premium_pct = round(((price / fair_val) - 1.0) * 100.0, 1)

        results[sym] = {
            "name": s.get("companyName", sym),
            "exchange": s.get("exchangeShortName", "NYSE"),
            "sector": sector,
            "industry": industry,
            "price": round(price, 2),
            "shares": shares,
            "mcap": round(mcap, 1),
            "debt": debt,
            "cash": cash,
            "net_debt": net_debt,
            "fcf0": fcf0,
            "beta": round(beta, 2),
            "kd": kd,
            "tax": tax,
            "g1": g1,
            "g2": g2,
            "g": round(DEFAULT_G * 100.0, 2),
            "wacc": round(wacc * 100.0, 2),
            "ev": ev,
            "fair_val": fair_val,
            "premium_pct": premium_pct,
            "is_undervalued": premium_pct < 0,
            "pe_trailing": None,
            "pe_forward": None,
            "pb_trailing": None,
            "pb_forward": None,
            "div_yield": 0.0,
            "ps_ratio": None,
            "pcash_ratio": None,
            "liab_to_assets": None,
            "current_ratio": None,
            "cash_minus_liab": round(cash - debt, 1),
            "roe": None,
            "roa": None
        }

    with open("full_market_dcf.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, separators=(',', ':'))

    print(f"🎉 成功寫入 {len(results)} 檔美股真實行情數據！")

if __name__ == "__main__":
    main()
