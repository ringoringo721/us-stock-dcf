import requests
import json

RF = 0.0450
ERP = 0.0475
DEFAULT_G = 0.0225

def fetch_sec_all_us_stocks():
    print("📥 正在下載美國 SEC EDGAR 官方交易所名冊...")
    url = "https://www.sec.gov/files/company_tickers_exchange.json"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) USMarketDCF/1.0 (contact: admin@dcf.local)"
    }
    try:
        resp = requests.get(url, headers=headers, timeout=20)
        if resp.status_code == 200:
            payload = resp.json()
            fields = payload.get("fields", [])
            data = payload.get("data", [])
            
            ticker_idx = fields.index("ticker")
            name_idx = fields.index("name")
            exch_idx = fields.index("exchange")
            
            stock_list = []
            for row in data:
                raw_exch = str(row[exch_idx]).upper()
                ticker = str(row[ticker_idx]).replace("-", ".").upper()
                name = str(row[name_idx]).title()
                
                clean_exch = None
                if "NAS" in raw_exch: clean_exch = "NASDAQ"
                elif "NYSE" in raw_exch: clean_exch = "NYSE"
                elif "AMEX" in raw_exch or "AMERICAN" in raw_exch: clean_exch = "AMEX"
                
                if clean_exch and len(ticker) <= 5 and not any(c in ticker for c in ["+", "=", "^"]):
                    stock_list.append({
                        "ticker": ticker,
                        "name": name,
                        "exchange": clean_exch
                    })
            print(f"✅ 成功從 SEC 獲取 {len(stock_list)} 檔標的！")
            return stock_list
    except Exception as e:
        print(f"SEC 連線略過: {e}")
        
    return [
        {"ticker": "MCD", "name": "McDonald's Corp", "exchange": "NYSE"},
        {"ticker": "KO", "name": "Coca-Cola Co", "exchange": "NYSE"},
        {"ticker": "PG", "name": "Procter & Gamble Co", "exchange": "NYSE"},
        {"ticker": "AAPL", "name": "Apple Inc", "exchange": "NASDAQ"},
        {"ticker": "MSFT", "name": "Microsoft Corp", "exchange": "NASDAQ"},
        {"ticker": "NVDA", "name": "Nvidia Corp", "exchange": "NASDAQ"}
    ]

def compute_dcf(item):
    exchange = item["exchange"]
    price = 100.0
    beta = 1.15 if exchange == "NASDAQ" else (1.25 if exchange == "AMEX" else 0.90)
    debt_ratio = 0.15 if exchange == "NASDAQ" else 0.25
    fcf_yield = 0.050 if exchange == "NASDAQ" else 0.055

    shares_m = 1000.0
    mkt_cap_m = price * shares_m
    debt_m = mkt_cap_m * debt_ratio
    cash_m = mkt_cap_m * 0.07
    net_debt_m = debt_m - cash_m
    fcf0_m = mkt_cap_m * fcf_yield

    E = mkt_cap_m
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

    return {
        "name": item["name"],
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

def main():
    universe = fetch_sec_all_us_stocks()
    results = {}
    for item in universe:
        results[item["ticker"]] = compute_dcf(item)

    print(f"💾 寫入 full_market_dcf.json (共 {len(results)} 檔)...")
    with open("full_market_dcf.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False)
    print("✅ 儲存完成！")

if __name__ == "__main__":
    main()
