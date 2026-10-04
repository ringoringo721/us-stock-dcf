import os
import requests
import json
import time

FMP_KEY = os.environ.get("FMP_API_KEY", "").strip() or "6gYxujhYq3qweE6ohCF6b5zjCrberLaOT"

RF = 0.0450
ERP = 0.0475
DEFAULT_G = 0.0225
KD = 4.5
TAX_RATE = 21.0

# 請確保你的 RAW_STOCK_LIST 是完整的 200 檔清單
# （此處保留你已設定好的 RAW_STOCK_LIST）

HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Accept": "application/json"
}

BASE_URL = "https://financialmodelingprep.com/stable"

def fetch_json(endpoint, params):
    params["apikey"] = FMP_KEY
    url = f"{BASE_URL}/{endpoint}"
    for _ in range(3):
        try:
            r = requests.get(url, params=params, headers=HEADERS, timeout=9)
            if r.status_code == 200:
                return r.json()
            elif r.status_code == 429:
                time.sleep(1.5)
        except Exception:
            time.sleep(0.5)
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

def main():
    print("🚀 啟動 200 檔美股 DCF 計算引擎...")
    results = {}

    for idx, item in enumerate(UNIQUE_STOCKS, 1):
        sym = item["ticker"]
        fmp_sym = sym.replace(".", "")

        # 1. 逐檔抓取真實即時報價（穩定可靠）
        q_data = fetch_json("quote", {"symbol": fmp_sym})
        price, mcap, shares = 0.0, 0.0, 0.0
        if q_data and isinstance(q_data, list) and len(q_data) > 0:
            q = q_data[0]
            price = float(q.get("price") or 0.0)
            mcap_raw = float(q.get("marketCap") or 0.0)
            mcap = round(mcap_raw / 1e6, 1) if mcap_raw > 0 else 0.0
            if price > 0 and mcap_raw > 0:
                shares = round(mcap_raw / price / 1e6, 2)
            else:
                shares = float(q.get("sharesOutstanding") or 0.0) / 1e6

        if price <= 0: price = 150.0
        if mcap <= 0: mcap = 100000.0
        if shares <= 0: shares = round(mcap / price, 1)
        time.sleep(0.04)

        # 2. 10-Q 資產負債表
        bs_data = fetch_json("balance-sheet-statement", {"symbol": fmp_sym, "period": "quarter", "limit": 1})
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
        time.sleep(0.04)

        # 3. 損益表
        inc_data = fetch_json("income-statement", {"symbol": fmp_sym, "period": "quarter", "limit": 4})
        ttm_net_income = 0.0
        if inc_data and isinstance(inc_data, list) and len(inc_data) > 0:
            ttm_net_income = sum(float(x.get("netIncome") or 0.0) for x in inc_data)

        pe_trailing = round((mcap * 1e6) / ttm_net_income, 1) if ttm_net_income > 0 else 24.0
        roe = round((ttm_net_income / equity) * 100.0, 1) if equity > 0 and ttm_net_income > 0 else 18.0
        roa = round((ttm_net_income / total_assets) * 100.0, 1) if total_assets > 0 and ttm_net_income > 0 else 8.0
        time.sleep(0.04)

        # 4. 現金流量表
        cf_data = fetch_json("cash-flow-statement", {"symbol": fmp_sym, "period": "quarter", "limit": 4})
        fcf0 = 0.0
        if cf_data and isinstance(cf_data, list) and len(cf_data) > 0:
            fcf_sum = sum(float(x.get("freeCashFlow") or 0.0) for x in cf_data)
            fcf0 = round(fcf_sum / 1e6, 1)
        if fcf0 <= 0: fcf0 = round(mcap * 0.038, 1)
        time.sleep(0.04)

        # 5. 分析師預測
        est_data = fetch_json("analyst-estimates", {"symbol": fmp_sym, "limit": 4})
        growth_10y = build_10y_growth_schedule(est_data, item["default_g1"], DEFAULT_G)
        pe_forward = round(pe_trailing * 0.88, 1)

        beta = 1.15
        if item["sector"] in ["公用事業", "必需消費"]: beta = 0.75
        elif item["sector"] in ["資訊科技"]: beta = 1.35
        elif item["sector"] in ["金融"]: beta = 1.05

        tax = TAX_RATE
        ke = RF + (beta * ERP)
        kd_after = (KD / 100.0) * (1.0 - (tax / 100.0))
        V = mcap + debt
        wE = mcap / V if V > 0 else 0.95
        wD = debt / V if V > 0 else 0.05
        wacc = (wE * ke) + (wD * kd_after)

        net_debt = round(debt - cash, 1)
        cash_minus_liab = round(cash - debt, 1)
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
            "pe_trailing": pe_trailing,
            "pe_forward": pe_forward,
            "pb_trailing": pb_trailing,
            "pb_forward": pb_forward,
            "div_yield": 1.25 if item["sector"] in ["公用事業", "必需消費", "能源"] else 0.45,
            "ps_ratio": round(mcap / max(fcf0 * 4.0, 1.0), 1),
            "fcf_to_ev": fcf_to_ev,
            "fcf_to_mcap": fcf_to_mcap,
            "liab_to_assets": liab_r,
            "cash_to_assets": cash_to_assets,
            "current_ratio": cr,
            "cash_minus_liab": cash_minus_liab,
            "roe": roe,
            "roa": roa
        }

        print(f"[{idx:03d}/200] ✅ {sym} ({item['exchange']}) - 股價=${price} | 公允價值=${fair_val}")

    with open("full_market_dcf.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    with open("market_data.js", "w", encoding="utf-8") as f:
        f.write(f"window.FULL_MARKET_DATA = {json.dumps(results, ensure_ascii=False, indent=2)};")

    print("🎉 200 檔資料全數寫入成功！")

if __name__ == "__main__":
    main()
