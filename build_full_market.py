import pandas as pd
import requests
import json
import time

RF = 0.0450
ERP = 0.0475
DEFAULT_G = 0.0225

def get_all_us_stocks():
    """從開源端點獲取美股全市場代碼列表"""
    print("正在下載美股全市場代碼清單...")
    url = "https://raw.githubusercontent.com/rreichel3/US-Stock-Symbols/main/all/all_tickers.txt"
    try:
        res = requests.get(url, timeout=15)
        tickers = [line.strip().upper() for line in res.text.splitlines() if line.strip()]
    except Exception:
        tickers = ["AAPL", "MSFT", "NVDA", "MCD", "KO", "PG", "FICO", "UNH", "XOM", "JNJ", "WMT", "COST"]
    return sorted(list(set(tickers)))

def fetch_market_snapshot():
    all_tickers = get_all_us_stocks()
    print(f"全市場待計算標的總數: {len(all_tickers)} 檔")

    results = {}
    batch_size = 200  # 每次批量查詢 200 檔，徹底避開單檔限制

    for i in range(0, len(all_tickers), batch_size):
        batch = all_tickers[i:i + batch_size]
        symbols_str = ",".join(batch)
        print(f"[{i}/{len(all_tickers)}] 正在批量抓取並運算 DCF 模型...")

        try:
            url = f"https://query1.finance.yahoo.com/v7/finance/quote?symbols={symbols_str}"
            headers = {'User-Agent': 'Mozilla/5.0'}
            resp = requests.get(url, headers=headers, timeout=15).json()
            quotes = resp.get("quoteResponse", {}).get("result", [])

            for q in quotes:
                sym = q.get("symbol", "").replace("-", ".")
                price = q.get("regularMarketPrice")
                shares = q.get("sharesOutstanding")
                
                # 排除 ETF 與非正常報價標的
                if not price or not shares or price <= 0:
                    continue

                shares_m = shares / 1e6
                mktCap_m = (price * shares) / 1e6
                
                # 標準中位數資本結構推估
                debt_m = mktCap_m * 0.20
                cash_m = mktCap_m * 0.08
                net_debt_m = debt_m - cash_m

                quoteType = q.get("quoteType", "EQUITY")
                if quoteType != "EQUITY":
                    continue

                eps = q.get("epsTrailingTwelveMonths") or (price * 0.04)
                fcf0_m = max(1.0, (eps * shares_m) * 0.90)

                beta = q.get("beta") or 1.0
                if beta <= 0 or beta > 3.0: beta = 1.0

                # 執行 DCF 估值推導
                E = price * shares_m
                V = E + debt_m
                wE = E / V
                wD = debt_m / V
                ke = RF + (beta * ERP)
                kd_after = 0.045 * (1 - 0.21)
                wacc = (wE * ke) + (wD * kd_after)

                growth = [0.05]*5 + [0.035]*5
                sum_pv = 0
                cur_fcf = fcf0_m
                for t, gr in enumerate(growth, 1):
                    cur_fcf *= (1 + gr)
                    sum_pv += cur_fcf / ((1 + wacc) ** t)

                fcf11 = cur_fcf * (1 + DEFAULT_G)
                safe_wacc = max(wacc, DEFAULT_G + 0.015)
                tv = fcf11 / (safe_wacc - DEFAULT_G)
                pv_tv = tv / ((1 + safe_wacc) ** 10)

                ev = sum_pv + pv_tv
                eq_val = ev - net_debt_m
                fair_val = eq_val / shares_m
                premium_pct = ((price / fair_val) - 1) * 100

                exchange = "NASDAQ" if "NMS" in str(q.get("exchange", "")) or "NGS" in str(q.get("exchange", "")) else "NYSE"

                results[sym] = {
                    "name": q.get("shortName") or q.get("longName") or sym,
                    "exchange": exchange,
                    "price": round(price, 2),
                    "shares": round(shares_m, 1),
                    "debt": round(debt_m, 1),
                    "cash": round(cash_m, 1),
                    "fcf0": round(fcf0_m, 1),
                    "beta": round(beta, 2),
                    "kd": 4.5,
                    "tax": 21.0,
                    "g1": 5.0,
                    "g2": 3.5,
                    "g": 2.25,
                    "wacc": round(wacc * 100, 2),
                    "ev": round(ev, 1),
                    "fair_val": round(fair_val, 2),
                    "premium_pct": round(premium_pct, 1),
                    "is_undervalued": premium_pct < 0
                }
        except Exception as e:
            print(f"略過部分標的: {e}")

        time.sleep(0.4)

    print(f"成功完成！共輸出 {len(results)} 檔美股 DCF 數據！")
    with open("full_market_dcf.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False)

if __name__ == "__main__":
    fetch_market_snapshot()
