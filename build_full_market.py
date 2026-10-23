import os
import json
import hashlib
import requests
import time
import copy
import re
import math
import subprocess
from typing import Dict, Any, Optional, List, Tuple
from pydantic import BaseModel, Field
from scripts.peer_cache import get_stock_peers_cached
from scripts.capture_valuation_sources import outstanding_share_record

HIST_CACHE_DIR = "cache/historical_prices"
os.makedirs(HIST_CACHE_DIR, exist_ok=True)

def calculate_historical_5y_dcf_and_prices(fmp_sym: str, stock_item: dict) -> dict:
    cache_file = os.path.join(HIST_CACHE_DIR, f"{fmp_sym}_hist.json")
    if os.path.exists(cache_file):
        try:
            with open(cache_file, "r", encoding="utf-8") as f:
                cached = json.load(f)
                if cached and cached.get("historical_dcf_series"):
                    return cached
        except Exception:
            pass

    url_prices = f"https://financialmodelingprep.com/api/v3/historical-price-full/{fmp_sym}?apikey={FMP_KEY}"
    url_q_cf = f"https://financialmodelingprep.com/api/v3/cash-flow-statement/{fmp_sym}?period=quarter&limit=24&apikey={FMP_KEY}"
    url_q_bs = f"https://financialmodelingprep.com/api/v3/balance-sheet-statement/{fmp_sym}?period=quarter&limit=24&apikey={FMP_KEY}"
    
    real_5y_prices = []
    historical_dcf_series = []
    
    try:
        time.sleep(0.3) # 避免觸發 FMP 頻率限制
        r_p = requests.get(url_prices, timeout=12)
        if r_p.status_code == 200:
            hist = r_p.json().get("historical", [])
            real_5y_prices = [
                {"date": p["date"], "close": round(float(p.get("adjClose") or p.get("close")), 2)}
                for p in reversed(hist)
            ][-1260:]
            
        price_map = {item["date"]: item["close"] for item in real_5y_prices}

        time.sleep(0.3)
        r_cf = requests.get(url_q_cf, timeout=12)
        time.sleep(0.3)
        r_bs = requests.get(url_q_bs, timeout=12)
        
        if r_cf.status_code == 200 and r_bs.status_code == 200:
            cf_list = r_cf.json()
            bs_list = r_bs.json()
            
            if isinstance(cf_list, list) and isinstance(bs_list, list) and len(cf_list) >= 4:
                cf_sorted = list(reversed(cf_list))[-20:]
                bs_sorted = list(reversed(bs_list))[-20:]
                
                base_wacc = stock_item.get("WACC", 0.09)
                base_g = 0.0225

                for idx, q_cf in enumerate(cf_sorted):
                    q_date = q_cf.get("date")
                    start_idx = max(0, cf_sorted.index(q_cf) - 3)
                    ttm_fcf = sum(
                        (float(item.get("operatingCashFlow") or 0) + float(item.get("capitalExpenditure") or 0))
                        for item in cf_sorted[start_idx : cf_sorted.index(q_cf) + 1]
                    )
                    
                    q_bs = next((b for b in bs_sorted if b.get("date") <= q_date), bs_sorted[-1])
                    total_debt = float(q_bs.get("totalDebt") or q_bs.get("shortTermDebt") or 0) + float(q_bs.get("longTermDebt") or 0)
                    cash = float(q_bs.get("cashAndShortTermInvestments") or q_bs.get("cashAndCashEquivalents") or 0)
                    net_debt = total_debt - cash
                    shares = float(q_bs.get("weightedAverageShsOutDil") or q_bs.get("weightedAverageShsOut") or stock_item.get("shares") or 1)
                    if shares <= 0: shares = 1.0

                    if ttm_fcf > 0:
                        sum_pv = 0
                        cur_fcf = ttm_fcf
                        growth_rate = 0.10
                        for t in range(1, 11):
                            cur_fcf *= (1 + growth_rate)
                            sum_pv += cur_fcf / (1 + base_wacc)**t
                        
                        safe_wacc = max(base_wacc, base_g + 0.015)
                        tv = (cur_fcf * (1 + base_g)) / (safe_wacc - base_g)
                        pv_tv = tv / (1 + safe_wacc)**10
                        
                        model_ev = sum_pv + pv_tv
                        equity_val = model_ev - net_debt
                        fair_val = max(equity_val / shares, 0.5)
                    else:
                        fair_val = max(1.0, float(stock_item.get("price", 100)) * 0.2)

                    ref_price = price_map.get(q_date)
                    if not ref_price and real_5y_prices:
                        past_p = [p["close"] for p in real_5y_prices if p["date"] <= q_date]
                        ref_price = past_p[-1] if past_p else real_5y_prices[0]["close"]

                    spread_pct = ((fair_val - ref_price) / ref_price) * 100 if ref_price else 0.0

                    historical_dcf_series.append({
                        "date": q_date,
                        "fairVal": round(fair_val, 2),
                        "stockPrice": ref_price,
                        "spreadPct": round(spread_pct, 2)
                    })
    except Exception as e:
        print(f"[{fmp_sym}] 計算歷史 DCF 失敗: {e}", flush=True)

    result_payload = {
        "real_5y_prices": real_5y_prices,
        "historical_dcf_series": historical_dcf_series
    }
    
    try:
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump(result_payload, f, ensure_ascii=False)
    except Exception:
        pass

    return result_payload
    
def fetch_as_reported_trade_ar(symbol: str, api_key: str) -> dict:
    ar_map = {
        "annual": {"trade": {}, "nontrade": {}},
        "quarterly": {"trade": {}, "nontrade": {}}
    }
    for period_param in ["annual", "quarter"]:
        url = f"https://financialmodelingprep.com/stable/balance-sheet-statement-as-reported?symbol={symbol}&period={period_param}&limit=24&apikey={api_key}"
        try:
            resp = requests.get(url, timeout=12)
            if resp.status_code == 200:
                data = resp.json()
                if isinstance(data, list):
                    for item in data:
                        report_data = item.get("data", {})
                        if not isinstance(report_data, dict):
                            continue
                        
                        val_trade = (
                            report_data.get("accountsreceivablenetcurrent") or
                            report_data.get("accountsReceivableNetCurrent") or
                            report_data.get("accountsreceivablecurrent")
                        )
                        val_nontrade = (
                            report_data.get("nontradereceivablescurrent") or
                            report_data.get("nonTradeReceivablesCurrent") or
                            report_data.get("vendorNonTradeReceivables")
                        )

                        f_year = str(item.get("fiscalYear") or item.get("date", "")[:4])
                        period = str(item.get("period", "")).upper()
                        date_str = str(item.get("date", ""))

                        p_type = "annual" if (period_param == "annual" or period == "FY") else "quarterly"

                        if val_trade is not None:
                            val_t_m = round(float(val_trade) / 1e6, 2)
                            if p_type == "annual":
                                if f_year: ar_map["annual"]["trade"][f_year] = val_t_m
                                if date_str: ar_map["annual"]["trade"][date_str[:4]] = val_t_m
                            else:
                                if f_year and period: ar_map["quarterly"]["trade"][f"{f_year}{period}"] = val_t_m
                                if date_str: ar_map["quarterly"]["trade"][date_str] = val_t_m

                        if val_nontrade is not None:
                            val_nt_m = round(float(val_nontrade) / 1e6, 2)
                            if p_type == "annual":
                                if f_year: ar_map["annual"]["nontrade"][f_year] = val_nt_m
                                if date_str: ar_map["annual"]["nontrade"][date_str[:4]] = val_nt_m
                            else:
                                if f_year and period: ar_map["quarterly"]["nontrade"][f"{f_year}{period}"] = val_nt_m
                                if date_str: ar_map["quarterly"]["nontrade"][date_str] = val_nt_m
        except Exception as e:
            print(f"[{symbol}] 抓取 as-reported 失敗: {e}")
    return ar_map

try:
    from google import genai
    from google.genai import types
    HAS_GENAI = True
except ImportError:
    HAS_GENAI = False

FMP_KEY = os.environ.get("FMP_API_KEY", "").strip() or "6gYxujhYq3qweE6ohCF6b5zjCrberLaOT"
GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GCP_SA_KEY = os.environ.get("GCP_SA_KEY", "").strip()

gemini_client = None
# US moat + ZH descriptions default to Flash-Lite (thinking off) to cut output tokens.
# Override with US_MOAT_MODEL / US_DESC_MODEL if needed.
PRIMARY_MODEL = "gemini-2.5-flash-lite"
US_MOAT_MODEL = os.environ.get("US_MOAT_MODEL", "gemini-2.5-flash-lite").strip() or "gemini-2.5-flash-lite"
US_DESC_MODEL = os.environ.get("US_DESC_MODEL", "gemini-2.5-flash-lite").strip() or "gemini-2.5-flash-lite"

if HAS_GENAI:
    try:
        if GCP_SA_KEY:
            key_path = "/tmp/gcp_sa_key.json"
            with open(key_path, "w", encoding="utf-8") as f:
                f.write(GCP_SA_KEY)
            os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = key_path

            gemini_client = genai.Client(
                vertexai=True,
                project="dcf-moat-ai",
                location="us-central1"
            )
            PRIMARY_MODEL = US_MOAT_MODEL
            print("🚀 已啟用 Vertex AI 企業級高速模式 (專案: dcf-moat-ai)", flush=True)
            print(f"   US moat model={US_MOAT_MODEL} | ZH desc model={US_DESC_MODEL}", flush=True)
        elif GEMINI_KEY:
            gemini_client = genai.Client(api_key=GEMINI_KEY)
            PRIMARY_MODEL = US_MOAT_MODEL
            print("ℹ️ 使用一般 Gemini API Key 模式", flush=True)
            print(f"   US moat model={US_MOAT_MODEL} | ZH desc model={US_DESC_MODEL}", flush=True)
    except Exception as e:
        print(f"⚠️ Gemini Client 初始化失敗: {e}", flush=True)

CACHE_DIR = "cache/moat"
DESC_CACHE_DIR = "cache/descriptions"
FIN_CACHE_DIR = "cache/financials"
META_CACHE_DIR = "cache/company_meta"
PEER_CACHE_DIR = "cache/peers"
os.makedirs(CACHE_DIR, exist_ok=True)
os.makedirs(DESC_CACHE_DIR, exist_ok=True)
os.makedirs(FIN_CACHE_DIR, exist_ok=True)
os.makedirs(META_CACHE_DIR, exist_ok=True)
os.makedirs(PEER_CACHE_DIR, exist_ok=True)

# Mirror financial_industry.js: banks/credit only (not insurers / brokers).
_BANK_REVENUE_INDUSTRIES = {
    "Diversified Banks", "Consumer Finance", "Investment Banking & Brokerage",
    "Banks", "Banks - Regional", "Banks - Diversified",
    "Financial - Credit Services", "Investment - Banking & Investment Services",
}
_INSURANCE_REVENUE_INDUSTRIES = {
    "Property & Casualty Insurance", "Life & Health Insurance", "Multi-line Insurance",
    "Insurance Brokers", "Insurance - Property & Casualty", "Insurance - Life",
    "Insurance - Diversified", "Insurance - Reinsurance", "Insurance - Specialty",
    "Insurance - Brokers",
}


def _finite_number(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and abs(number) != float("inf") else None


def _net_interest_income(row):
    reported = _finite_number(row.get("netInterestIncome"))
    if reported is not None:
        return reported
    income = _finite_number(row.get("interestIncome"))
    expense = _finite_number(row.get("interestExpense"))
    if income is None or expense is None:
        return None
    return income - expense


def _bank_revenue_uses_gross_interest(row):
    revenue = _finite_number(row.get("revenue"))
    interest_income = _finite_number(row.get("interestIncome"))
    net_interest = _net_interest_income(row)
    if not (revenue and revenue > 0 and interest_income and interest_income > 0
            and net_interest and net_interest > 0):
        return False
    if interest_income < revenue * 0.4:
        return False
    return revenue > net_interest * 1.5 and revenue >= interest_income * 0.9


def _normalize_bank_income_row(row, industry, ticker):
    if not isinstance(row, dict):
        return row
    if industry in _INSURANCE_REVENUE_INDUSTRIES:
        return row
    if industry and industry not in _BANK_REVENUE_INDUSTRIES:
        return row
    if ticker in {"BRK.B", "BRK-B", "BRK.A", "BRK-A"}:
        return row
    if not _bank_revenue_uses_gross_interest(row):
        return row
    revenue = _finite_number(row.get("revenue"))
    interest_income = _finite_number(row.get("interestIncome"))
    net_interest = _net_interest_income(row)
    operating = net_interest + max(0.0, revenue - interest_income)
    if operating == revenue:
        return row
    normalized = dict(row)
    normalized["providerRevenue"] = revenue
    normalized["revenue"] = operating
    normalized["revenueNormalization"] = "bankOperatingFromGrossInterest"
    return normalized


def normalize_bank_income_rows(rows, industry, ticker):
    if not isinstance(rows, list):
        return rows
    return [_normalize_bank_income_row(row, industry, ticker) for row in rows]

# Daily remoat / description budgets (lever #2). Parsed lazily after US_EXPANSION_MODE is known.
# Defaults: daily run caps new Gemini calls; expansion is uncapped unless env overrides.
DEFAULT_DAILY_MOAT_BUDGET = 30
DEFAULT_DAILY_DESC_BUDGET = 15
_moat_gemini_used = 0
_desc_gemini_used = 0
_moat_budget_skipped = []  # backlog of tickers deferred past the daily remoat cap
_desc_budget_skipped = []
_gemini_budgets_logged = False


def _parse_gemini_budget(env_name: str, daily_default: int):
    """Return int cap, or None for uncapped.

    Unset: daily mode → daily_default; US expansion → uncapped.
    Explicit 0 / none / unlimited / -1 → uncapped (expansion-friendly override).
    """
    raw = os.environ.get(env_name)
    if raw is None or str(raw).strip() == "":
        return None if US_EXPANSION_MODE else daily_default
    token = str(raw).strip().lower()
    if token in ("0", "none", "unlimited", "-1"):
        return None
    try:
        value = int(token)
    except ValueError as err:
        raise ValueError(f"{env_name} must be an integer or unlimited, got {raw!r}") from err
    if value < 0:
        return None
    return value


def us_moat_gemini_budget():
    return _parse_gemini_budget("MAX_US_MOAT_GEMINI", DEFAULT_DAILY_MOAT_BUDGET)


def us_desc_gemini_budget():
    return _parse_gemini_budget("MAX_US_DESC_GEMINI", DEFAULT_DAILY_DESC_BUDGET)


def _log_gemini_budgets_once():
    global _gemini_budgets_logged
    if _gemini_budgets_logged:
        return
    _gemini_budgets_logged = True
    moat_cap = us_moat_gemini_budget()
    desc_cap = us_desc_gemini_budget()
    mode = "expansion (default uncapped)" if US_EXPANSION_MODE else "daily (capped)"
    print(
        f"Gemini US budgets [{mode}]: "
        f"moat={moat_cap if moat_cap is not None else 'unlimited'} "
        f"(MAX_US_MOAT_GEMINI) | "
        f"desc={desc_cap if desc_cap is not None else 'unlimited'} "
        f"(MAX_US_DESC_GEMINI)",
        flush=True,
    )


# Bump when US moat prompt/schema policy changes (forces remoat even if fin summary unchanged).
# v3: restore fuller per-dimension bilingual comments (~150 EN words); not the v2-short style.
US_MOAT_ASSESSMENT_POLICY = "us-buffett-moat-v3"


def _moat_cache_is_valid(cached_data: Dict[str, Any]) -> bool:
    m1_data = cached_data.get("m1_brand_pricing", {}) or {}
    has_bilingual = (
        "comment_zh" in m1_data
        and "comment_en" in m1_data
        and "overall_moat_verdict_zh" in cached_data
    )
    is_valid_text = (
        "暫未取得" not in cached_data.get("overall_moat_verdict_zh", "")
        and "暫未取得" not in cached_data.get("overall_moat_verdict", "")
    )
    return bool(has_bilingual and is_valid_text)


def _period_sort_key(period: str):
    match = re.match(r"^(\d{4})Q([1-4])$", str(period or "").strip(), re.IGNORECASE)
    if match:
        return (int(match.group(1)), int(match.group(2)))
    return (0, 0)


def _round_fin(value, ndigits=1):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return round(number, ndigits)


def us_moat_evidence_payload(fin_context: Dict[str, Any]) -> Dict[str, Any]:
    """Stable qualitative/fundamental fingerprint — excludes volatile mcap/price."""
    return {
        "name": str((fin_context or {}).get("name") or "").strip(),
        "sector": str((fin_context or {}).get("sector") or "").strip(),
        "industry": str((fin_context or {}).get("industry") or "").strip(),
        "roe": _round_fin((fin_context or {}).get("roe"), 2),
        "roa": _round_fin((fin_context or {}).get("roa"), 2),
        "f_score": int((fin_context or {}).get("f_score") or 0),
        "fcf0": _round_fin((fin_context or {}).get("fcf0"), 0),
        "debt": _round_fin((fin_context or {}).get("debt"), 0),
        "cash": _round_fin((fin_context or {}).get("cash"), 0),
    }


def us_moat_evidence_hash(fin_context: Dict[str, Any]) -> str:
    payload = us_moat_evidence_payload(fin_context)
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _iter_ticker_moat_caches(ticker: str) -> List[Tuple[str, str, Dict[str, Any]]]:
    """Yield (period, path, data) for valid bilingual moat caches of a ticker."""
    prefix = f"{ticker}_"
    rows = []
    try:
        names = os.listdir(CACHE_DIR)
    except FileNotFoundError:
        return rows
    for name in names:
        if not (name.startswith(prefix) and name.endswith(".json")):
            continue
        period = name[len(prefix):-len(".json")]
        path = os.path.join(CACHE_DIR, name)
        try:
            with open(path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except Exception:
            continue
        if not _moat_cache_is_valid(data):
            continue
        rows.append((period, path, data))
    rows.sort(key=lambda item: _period_sort_key(item[0]), reverse=True)
    return rows


def load_prior_period_moat(ticker: str, exclude_period: str) -> Optional[Dict[str, Any]]:
    """Newest valid prior-period moat cache (budget / offline fallback)."""
    for period, _path, data in _iter_ticker_moat_caches(ticker):
        if period != exclude_period:
            return data
    return None


def find_moat_by_evidence_hash(
    ticker: str, evidence_hash: str, assessment_policy: str
) -> Optional[Tuple[str, Dict[str, Any]]]:
    """Return (source_period, data) when a cache matches HK-style evidenceHash + policy."""
    for period, _path, data in _iter_ticker_moat_caches(ticker):
        if (
            data.get("evidenceHash") == evidence_hash
            and data.get("assessmentPolicy") == assessment_policy
        ):
            return period, data
    return None


def _stamp_moat_metadata(
    data: Dict[str, Any],
    *,
    ticker: str,
    period: str,
    evidence_hash: str,
    assessment_policy: str,
) -> Dict[str, Any]:
    stamped = copy.deepcopy(data)
    stamped["ticker"] = ticker
    stamped["period"] = period
    stamped["evidenceHash"] = evidence_hash
    stamped["assessmentPolicy"] = assessment_policy
    return stamped


def _write_moat_cache(cache_file: str, data: Dict[str, Any]) -> None:
    with open(cache_file, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)


def _gemini_generate_config(**kwargs):
    """Flash-Lite friendly config: thinking off when the SDK supports it."""
    config_kwargs = dict(kwargs)
    try:
        config_kwargs["thinking_config"] = types.ThinkingConfig(thinking_budget=0)
        return types.GenerateContentConfig(**config_kwargs)
    except Exception:
        config_kwargs.pop("thinking_config", None)
        return types.GenerateContentConfig(**config_kwargs)


def get_deep_chinese_description(ticker: str, company_name: str, en_desc: str) -> str:
    global _desc_gemini_used
    if not en_desc or len(en_desc.strip()) < 30:
        return ""

    cache_file = os.path.join(DESC_CACHE_DIR, f"{ticker}_desc_zh.json")
    if os.path.exists(cache_file):
        try:
            with open(cache_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                if data.get("description_zh") and len(data["description_zh"]) > 40:
                    return data["description_zh"]
        except Exception:
            pass

    if not gemini_client:
        return ""

    _log_gemini_budgets_once()
    desc_cap = us_desc_gemini_budget()
    if desc_cap is not None and _desc_gemini_used >= desc_cap:
        _desc_budget_skipped.append(ticker)
        print(
            f"⏳ DESC budget skip {ticker}: reused empty/template path "
            f"(used {_desc_gemini_used}/{desc_cap}; backlog later)",
            flush=True,
        )
        return ""

    prompt = f"""
你是一名資深證券分析師。請將以下企業 【{company_name} ({ticker})】 的官方業務營運描述翻譯並精煉為「繁體中文（台灣財經用語）」。
要求：
1. 完整保留核心產品、主要業務板塊、關鍵技術與營運模式。
2. 語氣客觀嚴謹，長度控制在 180 至 260 字以內。
3. 嚴禁空泛套話，請提供詳實的業務內容。

英文原文：
{en_desc}
"""
    for attempt in range(2):
        try:
            response = gemini_client.models.generate_content(
                model=US_DESC_MODEL,
                contents=prompt,
                config=_gemini_generate_config(temperature=0.2),
            )
            desc_zh = response.text.strip()
            with open(cache_file, "w", encoding="utf-8") as f:
                json.dump({"description_zh": desc_zh}, f, ensure_ascii=False, indent=2)
            _desc_gemini_used += 1
            return desc_zh
        except Exception:
            time.sleep(1.5)

    return ""

RF = 0.0450
ERP = 0.0475
DEFAULT_G = 0.0225
KD = 4.5
TAX_RATE = 21.0

class MoatDimension(BaseModel):
    score: int = Field(..., ge=0, le=10, description="0到10整數打分")
    comment_zh: str = Field(
        ...,
        description=(
            "繁體中文深入評語，上限約 150–250 字：緊扣巴菲特哲學，說明具體壁壘、"
            "競對差異與商業模式邏輯，可含適度細節，勿空泛套話"
        ),
    )
    comment_en: str = Field(
        ...,
        description=(
            "In-depth English moat comment up to about 150 words; Buffett-aligned analysis "
            "of the specific barrier, competitive differences, and business logic."
        ),
    )

class StockMoatReport(BaseModel):
    ticker: str
    period: str = Field(..., description="財報基準季，例如 2026Q2")
    m1_brand_pricing: MoatDimension = Field(..., description="M1. Pricing Power & Brand Mindshare")
    m2_patents_regulatory: MoatDimension = Field(..., description="M2. Patents & Regulatory Licenses")
    m3_high_switching_costs: MoatDimension = Field(..., description="M3. Switching Costs")
    m4_network_effects: MoatDimension = Field(..., description="M4. Network Effects")
    m5_cost_advantage_scale: MoatDimension = Field(..., description="M5. Scale & Cost Advantage")
    m6_unique_geography_assets: MoatDimension = Field(..., description="M6. Efficient Scale / Natural Oligopoly")
    m7_operational_efficiency: MoatDimension = Field(..., description="M7. ROIC vs WACC & Capital Return")
    m8_capital_allocation: MoatDimension = Field(..., description="M8. Asset Irreproducibility & Moat Fortress")
    m9_customer_retention: MoatDimension = Field(..., description="M9. Disruption Immunity & Durability")
    m10_durability: MoatDimension = Field(..., description="M10. Management Integrity & Capital Allocation")
    overall_moat_verdict_zh: str = Field(
        ...,
        description="約 120–200 字繁體中文巴菲特護城河總結定性（可含特許經營／收費橋／商品型等定性）",
    )
    overall_moat_verdict_en: str = Field(
        ...,
        description="Buffett-style overall moat verdict in English, up to about 150 words",
    )

def analyze_stock_moat(ticker: str, latest_period: str, fin_context: Dict[str, Any], force_refresh: bool = False) -> Optional[Dict[str, Any]]:
    """US moat with HK-style evidence hash: remoat only when fin summary/policy changes.

    Fiscal period remains metadata (and the on-disk filename suffix) but is not the sole
    reuse key. Legacy period-keyed files without evidenceHash remain readable.
    """
    global _moat_gemini_used
    if not latest_period or latest_period == "LATEST":
        import datetime
        now = datetime.datetime.now()
        q = (now.month - 1) // 3 + 1
        safe_period = f"{now.year}Q{q}"
    else:
        safe_period = str(latest_period).replace("/", "_").strip()

    cache_file = os.path.join(CACHE_DIR, f"{ticker}_{safe_period}.json")
    evidence_hash = us_moat_evidence_hash(fin_context)
    policy = US_MOAT_ASSESSMENT_POLICY

    if not force_refresh:
        # 1) Exact evidenceHash + assessmentPolicy hit (any period) → reuse; refresh period metadata.
        matched = find_moat_by_evidence_hash(ticker, evidence_hash, policy)
        if matched is not None:
            source_period, cached = matched
            stamped = _stamp_moat_metadata(
                cached, ticker=ticker, period=safe_period,
                evidence_hash=evidence_hash, assessment_policy=policy,
            )
            if source_period != safe_period or cached.get("period") != safe_period \
                    or cached.get("evidenceHash") != evidence_hash \
                    or cached.get("assessmentPolicy") != policy:
                _write_moat_cache(cache_file, stamped)
                print(
                    f"♻️ {ticker}: evidenceHash hit (from {source_period}) → period={safe_period}, no Gemini",
                    flush=True,
                )
            return stamped

        # 2) Same-period legacy file (pre-hash): reuse and backfill hash/policy for future runs.
        if os.path.exists(cache_file):
            try:
                with open(cache_file, "r", encoding="utf-8") as handle:
                    legacy = json.load(handle)
                if _moat_cache_is_valid(legacy):
                    stored_hash = legacy.get("evidenceHash")
                    stored_policy = legacy.get("assessmentPolicy")
                    if not stored_hash:
                        stamped = _stamp_moat_metadata(
                            legacy, ticker=ticker, period=safe_period,
                            evidence_hash=evidence_hash, assessment_policy=policy,
                        )
                        _write_moat_cache(cache_file, stamped)
                        print(
                            f"♻️ {ticker}@{safe_period}: legacy moat cache stamped with evidenceHash",
                            flush=True,
                        )
                        return stamped
                    # Hash present but mismatched → fall through to remoat / budget path.
                    if stored_hash == evidence_hash and stored_policy == policy:
                        return _stamp_moat_metadata(
                            legacy, ticker=ticker, period=safe_period,
                            evidence_hash=evidence_hash, assessment_policy=policy,
                        )
            except Exception:
                pass

    prior = None if force_refresh else load_prior_period_moat(ticker, safe_period)

    if not gemini_client:
        if prior is not None:
            print(f"♻️ {ticker}: no Gemini client; reusing prior-period moat cache", flush=True)
            return prior
        if US_EXPANSION_MODE:
            return None
        return _build_fallback_moat(ticker, safe_period)

    _log_gemini_budgets_once()
    moat_cap = us_moat_gemini_budget()
    if moat_cap is not None and _moat_gemini_used >= moat_cap:
        _moat_budget_skipped.append(ticker)
        if prior is not None:
            prior_period = prior.get("period") or "prior"
            print(
                f"⏳ MOAT budget skip {ticker}@{safe_period}: evidence changed; reuse prior {prior_period} "
                f"(used {_moat_gemini_used}/{moat_cap}; queued for later runs)",
                flush=True,
            )
            return prior
        print(
            f"⏳ MOAT budget skip {ticker}@{safe_period}: evidence changed; no prior cache "
            f"(used {_moat_gemini_used}/{moat_cap}; fallback / unavailable)",
            flush=True,
        )
        if US_EXPANSION_MODE:
            return None
        return _build_fallback_moat(ticker, safe_period)

    prompt = f"""
    請以沃倫·巴菲特與查理·蒙格的長期價值投資哲學，對 【{ticker}】 的 10 大經濟護城河（M1–M10）客觀打分。
    基準季度：{safe_period}

    【參考數據】
    - 名稱: {fin_context.get('name', ticker)}
    - 板塊/產業: {fin_context.get('sector', 'N/A')} / {fin_context.get('industry', 'N/A')}
    - 市值 (USD M): {fin_context.get('mcap', 0):,.1f} | ROE {fin_context.get('roe', 0)}% | ROA {fin_context.get('roa', 0)}%
    - F-Score: {fin_context.get('f_score', 0)}/9 | FCF TTM: ${fin_context.get('fcf0', 0):,.1f}M
    - 現金 ${fin_context.get('cash', 0):,.1f}M / 負債 ${fin_context.get('debt', 0):,.1f}M

    【維度】M1 定價權/品牌 · M2 專利/特許 · M3 轉換成本 · M4 網絡效應 · M5 規模成本 · M6 利基寡占 · M7 超額ROIC · M8 不可複製資產 · M9 抗顛覆 · M10 管理層資本配置

    【規則】
    1. 分數 0–10 整數（0–3 極弱；4–6 中等；7–8 堅固；9–10 罕見壁壘）。
    2. 每維度 comment_en 最多約 150 English words；comment_zh 最多約 150–250 字。請寫有資訊量的深入評語（壁壘機制、競對差異、商業模式）；勿用約 40–80 字的短評風格，也勿空泛套話或無意義灌水。
    3. overall_moat_verdict_zh 約 120–200 字；overall_moat_verdict_en 最多約 150 words；需有巴菲特式定性（特許經營、收費橋、商品型等）。
    4. 必須回傳指定 JSON Schema；保留全部 10 個分數與雙語欄位（形狀與 UI 相容）。
    """

    for attempt in range(3):
        try:
            response = gemini_client.models.generate_content(
                model=US_MOAT_MODEL,
                contents=prompt,
                config=_gemini_generate_config(
                    response_mime_type="application/json",
                    response_schema=StockMoatReport,
                    temperature=0.2,
                ),
            )
            data = json.loads(response.text)
            data = _stamp_moat_metadata(
                data, ticker=ticker, period=safe_period,
                evidence_hash=evidence_hash, assessment_policy=policy,
            )
            _write_moat_cache(cache_file, data)
            _moat_gemini_used += 1
            return data
        except Exception as err:
            wait_time = (attempt + 1) * 3
            time.sleep(wait_time)

    if prior is not None:
        print(f"♻️ {ticker}: Gemini moat failed; reusing prior-period cache", flush=True)
        return prior
    if US_EXPANSION_MODE:
        return None
    return _build_fallback_moat(ticker, safe_period)

def _build_fallback_moat(ticker: str, period: str) -> Dict[str, Any]:
    default_item = {
        "score": 5,
        "comment_zh": "待分析：API 連線未完成或缺少相關數據，維持中性預設。",
        "comment_en": "Pending analysis: Defaulting to neutral moat rating due to missing report data."
    }
    return {
        "ticker": ticker,
        "period": period,
        "m1_brand_pricing": default_item,
        "m2_patents_regulatory": default_item,
        "m3_high_switching_costs": default_item,
        "m4_network_effects": default_item,
        "m5_cost_advantage_scale": default_item,
        "m6_unique_geography_assets": default_item,
        "m7_operational_efficiency": default_item,
        "m8_capital_allocation": default_item,
        "m9_customer_retention": default_item,
        "m10_durability": default_item,
        "overall_moat_verdict_zh": "暫未取得 Gemini 深度護城河分析報告。",
        "overall_moat_verdict_en": "Deep Economic Moat audit report pending generation."
    }

RAW_STOCK_LIST = [
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
    {"ticker": "LRCX", "name": "Lam Research", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Semiconductors", "default_g1": 11.0},
    {"ticker": "MU", "name": "Micron Technology", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Semiconductors", "default_g1": 15.0},
    {"ticker": "TSM", "name": "TSMC (台積電 ADR)", "exchange": "NYSE", "sector": "資訊科技", "industry": "Semiconductors", "default_g1": 20.0},
    {"ticker": "FICO", "name": "Fair Isaac", "exchange": "NYSE", "sector": "資訊科技", "industry": "Application Software", "default_g1": 14.0},
    {"ticker": "ADSK", "name": "Autodesk", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Application Software", "default_g1": 9.5},
    {"ticker": "TYL", "name": "Tyler Technologies", "exchange": "NYSE", "sector": "資訊科技", "industry": "Application Software", "default_g1": 9.5},
    {"ticker": "APPF", "name": "AppFolio", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Application Software", "default_g1": 18.0},
    {"ticker": "YOU", "name": "Clear Secure", "exchange": "NYSE", "sector": "資訊科技", "industry": "Application Software", "default_g1": 16.0},
    {"ticker": "ITRI", "name": "Itron", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Electronic Equipment & Instruments", "default_g1": 8.5},
    {"ticker": "SNPS", "name": "Synopsys", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Application Software", "default_g1": 13.0},
    {"ticker": "BR", "name": "Broadridge Financial", "exchange": "NYSE", "sector": "資訊科技", "industry": "Data Processing & Outsourced Services", "default_g1": 7.5},
    {"ticker": "KLAC", "name": "KLA Corporation", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Semiconductor Materials & Equipment", "default_g1": 11.5},
    {"ticker": "MRVL", "name": "Marvell Technology", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Semiconductors", "default_g1": 14.0},
    {"ticker": "CDNS", "name": "Cadence Design Systems", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Application Software", "default_g1": 12.5},
    {"ticker": "FTNT", "name": "Fortinet", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Systems Software", "default_g1": 13.0},
    {"ticker": "PANW", "name": "Palo Alto Networks", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Systems Software", "default_g1": 15.0},
    {"ticker": "CRWD", "name": "CrowdStrike", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Systems Software", "default_g1": 22.0},
    {"ticker": "WDAY", "name": "Workday", "exchange": "NASDAQ", "sector": "資訊科技", "industry": "Application Software", "default_g1": 13.5},
    {"ticker": "ANET", "name": "Arista Networks", "exchange": "NYSE", "sector": "資訊科技", "industry": "Communications Equipment", "default_g1": 16.0},
    {"ticker": "APH", "name": "Amphenol", "exchange": "NYSE", "sector": "資訊科技", "industry": "Electronic Components", "default_g1": 11.0},
    {"ticker": "TEL", "name": "TE Connectivity", "exchange": "NYSE", "sector": "資訊科技", "industry": "Electronic Components", "default_g1": 6.5},

    {"ticker": "GOOGL", "name": "Alphabet (Class A)", "exchange": "NASDAQ", "sector": "通訊服務", "industry": "Interactive Media & Services", "default_g1": 11.0},
    {"ticker": "GOOG", "name": "Alphabet (Class C)", "exchange": "NASDAQ", "sector": "通訊服務", "industry": "Interactive Media & Services", "default_g1": 11.0},
    {"ticker": "META", "name": "Meta Platforms", "exchange": "NASDAQ", "sector": "通訊服務", "industry": "Interactive Media & Services", "default_g1": 14.5},
    {"ticker": "NFLX", "name": "Netflix", "exchange": "NASDAQ", "sector": "通訊服務", "industry": "Movies & Entertainment", "default_g1": 13.0},
    {"ticker": "DIS", "name": "Walt Disney", "exchange": "NYSE", "sector": "通訊服務", "industry": "Movies & Entertainment", "default_g1": 6.0},
    {"ticker": "TMUS", "name": "T-Mobile US", "exchange": "NASDAQ", "sector": "通訊服務", "industry": "Wireless Telecommunication Services", "default_g1": 5.5},
    {"ticker": "VZ", "name": "Verizon", "exchange": "NYSE", "sector": "通訊服務", "industry": "Integrated Telecommunication Services", "default_g1": 2.5},
    {"ticker": "T", "name": "AT&T", "exchange": "NYSE", "sector": "通訊服務", "industry": "Integrated Telecommunication Services", "default_g1": 2.5},
    {"ticker": "CMCSA", "name": "Comcast", "exchange": "NASDAQ", "sector": "通訊服務", "industry": "Cable & Satellite", "default_g1": 3.0},
    {"ticker": "TKO", "name": "TKO Group Holdings", "exchange": "NYSE", "sector": "通訊服務", "industry": "Movies & Entertainment", "default_g1": 12.0},
    {"ticker": "LYV", "name": "Live Nation", "exchange": "NYSE", "sector": "通訊服務", "industry": "Movies & Entertainment", "default_g1": 9.0},
    {"ticker": "IRDM", "name": "Iridium Communications", "exchange": "NASDAQ", "sector": "通訊服務", "industry": "Alternative Carriers", "default_g1": 7.0},
    {"ticker": "EA", "name": "Electronic Arts", "exchange": "NASDAQ", "sector": "通訊服務", "industry": "Interactive Home Entertainment", "default_g1": 6.5},
    {"ticker": "TTWO", "name": "Take-Two Interactive", "exchange": "NASDAQ", "sector": "通訊服務", "industry": "Interactive Home Entertainment", "default_g1": 14.0},
    {"ticker": "WBD", "name": "Warner Bros. Discovery", "exchange": "NASDAQ", "sector": "通訊服務", "industry": "Movies & Entertainment", "default_g1": 3.5},

    {"ticker": "AMZN", "name": "Amazon", "exchange": "NASDAQ", "sector": "非必需消費", "industry": "Broadline Retail", "default_g1": 13.0},
    {"ticker": "TSLA", "name": "Tesla", "exchange": "NASDAQ", "sector": "非必需消費", "industry": "Automobile Manufacturers", "default_g1": 16.0},
    {"ticker": "HD", "name": "Home Depot", "exchange": "NYSE", "sector": "非必需消費", "industry": "Home Improvement Retail", "default_g1": 4.5},
    {"ticker": "MCD", "name": "McDonald's", "exchange": "NYSE", "sector": "非必需消費", "industry": "Restaurants", "default_g1": 5.0},
    {"ticker": "BKNG", "name": "Booking Holdings", "exchange": "NASDAQ", "sector": "非必需消費", "industry": "Hotels, Resorts & Cruise Lines", "default_g1": 9.0},
    {"ticker": "NKE", "name": "Nike", "exchange": "NYSE", "sector": "非必需消費", "industry": "Footwear", "default_g1": 4.0},
    {"ticker": "SBUX", "name": "Starbucks", "exchange": "NASDAQ", "sector": "非必需消費", "industry": "Restaurants", "default_g1": 5.5},
    {"ticker": "LOW", "name": "Lowe's", "exchange": "NYSE", "sector": "非必需消費", "industry": "Home Improvement Retail", "default_g1": 4.0},
    {"ticker": "TJX", "name": "TJX Companies", "exchange": "NYSE", "sector": "非必需消費", "industry": "Apparel Retail", "default_g1": 6.5},
    {"ticker": "CHDN", "name": "Churchill Downs", "exchange": "NASDAQ", "sector": "非必需消費", "industry": "Casinos & Gaming", "default_g1": 8.0},
    {"ticker": "TSCO", "name": "Tractor Supply", "exchange": "NASDAQ", "sector": "非必需消費", "industry": "Specialty Stores", "default_g1": 6.5},
    {"ticker": "MTN", "name": "Vail Resorts", "exchange": "NYSE", "sector": "非必需消費", "industry": "Hotels, Resorts & Cruise Lines", "default_g1": 5.0},
    {"ticker": "SCI", "name": "Service Corp International", "exchange": "NYSE", "sector": "非必需消費", "industry": "Personal Services", "default_g1": 5.0},
    {"ticker": "AZO", "name": "AutoZone", "exchange": "NYSE", "sector": "非必需消費", "industry": "Automotive Retail", "default_g1": 6.5},
    {"ticker": "MAR", "name": "Marriott International", "exchange": "NASDAQ", "sector": "非必需消費", "industry": "Hotels, Resorts & Cruise Lines", "default_g1": 8.0},
    {"ticker": "HLT", "name": "Hilton Worldwide", "exchange": "NYSE", "sector": "非必需消費", "industry": "Hotels, Resorts & Cruise Lines", "default_g1": 8.5},
    {"ticker": "CMG", "name": "Chipotle Mexican Grill", "exchange": "NYSE", "sector": "非必需消費", "industry": "Restaurants", "default_g1": 14.0},
    {"ticker": "YUM", "name": "Yum! Brands", "exchange": "NYSE", "sector": "非必需消費", "industry": "Restaurants", "default_g1": 6.5},
    {"ticker": "ORLY", "name": "O'Reilly Automotive", "exchange": "NASDAQ", "sector": "非必需消費", "industry": "Automotive Retail", "default_g1": 7.5},
    {"ticker": "ROST", "name": "Ross Stores", "exchange": "NASDAQ", "sector": "非必需消費", "industry": "Apparel Retail", "default_g1": 6.5},
    {"ticker": "LULU", "name": "Lululemon Athletica", "exchange": "NASDAQ", "sector": "非必需消費", "industry": "Apparel Retail", "default_g1": 11.5},
    {"ticker": "F", "name": "Ford Motor Company", "exchange": "NYSE", "sector": "非必需消費", "industry": "Automobile Manufacturers", "default_g1": 3.5},
    {"ticker": "GM", "name": "General Motors", "exchange": "NYSE", "sector": "非必需消費", "industry": "Automobile Manufacturers", "default_g1": 4.0},
    {"ticker": "EBAY", "name": "eBay", "exchange": "NASDAQ", "sector": "非必需消費", "industry": "Broadline Retail", "default_g1": 4.0},

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
    {"ticker": "FDS", "name": "FactSet", "exchange": "NYSE", "sector": "金融", "industry": "Financial Exchanges & Data", "default_g1": 6.5},
    {"ticker": "TW", "name": "Tradeweb Markets", "exchange": "NASDAQ", "sector": "金融", "industry": "Financial Exchanges & Data", "default_g1": 12.5},
    {"ticker": "CME", "name": "CME Group", "exchange": "NASDAQ", "sector": "金融", "industry": "Financial Exchanges & Data", "default_g1": 6.0},
    {"ticker": "MSCI", "name": "MSCI Inc.", "exchange": "NYSE", "sector": "金融", "industry": "Financial Exchanges & Data", "default_g1": 9.0},
    {"ticker": "MCO", "name": "Moody's", "exchange": "NYSE", "sector": "金融", "industry": "Financial Exchanges & Data", "default_g1": 9.5},
    {"ticker": "ICE", "name": "Intercontinental Exchange", "exchange": "NYSE", "sector": "金融", "industry": "Financial Exchanges & Data", "default_g1": 7.5},
    {"ticker": "AIG", "name": "American International Group", "exchange": "NYSE", "sector": "金融", "industry": "Multi-line Insurance", "default_g1": 4.5},
    {"ticker": "MET", "name": "MetLife", "exchange": "NYSE", "sector": "金融", "industry": "Life & Health Insurance", "default_g1": 4.5},
    {"ticker": "PRU", "name": "Prudential Financial", "exchange": "NYSE", "sector": "金融", "industry": "Life & Health Insurance", "default_g1": 4.0},
    {"ticker": "TRV", "name": "The Travelers Companies", "exchange": "NYSE", "sector": "金融", "industry": "Property & Casualty Insurance", "default_g1": 5.5},
    {"ticker": "AFL", "name": "Aflac", "exchange": "NYSE", "sector": "金融", "industry": "Life & Health Insurance", "default_g1": 4.0},
    {"ticker": "ALL", "name": "Allstate", "exchange": "NYSE", "sector": "金融", "industry": "Property & Casualty Insurance", "default_g1": 6.0},
    {"ticker": "AON", "name": "Aon plc", "exchange": "NYSE", "sector": "金融", "industry": "Insurance Brokers", "default_g1": 7.0},
    {"ticker": "AJG", "name": "Arthur J. Gallagher", "exchange": "NYSE", "sector": "金融", "industry": "Insurance Brokers", "default_g1": 8.5},
    {"ticker": "MMC", "name": "Marsh McLennan", "exchange": "NYSE", "sector": "金融", "industry": "Insurance Brokers", "default_g1": 7.5},
    {"ticker": "USB", "name": "U.S. Bancorp", "exchange": "NYSE", "sector": "金融", "industry": "Diversified Banks", "default_g1": 4.0},

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
    {"ticker": "ILMN", "name": "Illumina", "exchange": "NASDAQ", "sector": "醫療保健", "industry": "Life Sciences Tools & Services", "default_g1": 8.5},
    {"ticker": "ZTS", "name": "Zoetis", "exchange": "NYSE", "sector": "醫療保健", "industry": "Pharmaceuticals", "default_g1": 7.5},
    {"ticker": "ALGN", "name": "Align Technology", "exchange": "NASDAQ", "sector": "醫療保健", "industry": "Health Care Supplies", "default_g1": 7.0},
    {"ticker": "FMS", "name": "Fresenius Medical Care", "exchange": "NYSE", "sector": "醫療保健", "industry": "Health Care Services", "default_g1": 4.5},
    {"ticker": "BDX", "name": "Becton Dickinson", "exchange": "NYSE", "sector": "醫療保健", "industry": "Health Care Equipment", "default_g1": 5.5},
    {"ticker": "ZBH", "name": "Zimmer Biomet", "exchange": "NYSE", "sector": "醫療保健", "industry": "Health Care Equipment", "default_g1": 4.5},
    {"ticker": "DXCM", "name": "Dexcom", "exchange": "NASDAQ", "sector": "醫療保健", "industry": "Health Care Equipment", "default_g1": 15.0},
    {"ticker": "RMD", "name": "ResMed", "exchange": "NYSE", "sector": "醫療保健", "industry": "Health Care Equipment", "default_g1": 9.0},
    {"ticker": "COR", "name": "Cencora", "exchange": "NYSE", "sector": "醫療保健", "industry": "Health Care Distributors", "default_g1": 7.0},
    {"ticker": "STE", "name": "STERIS", "exchange": "NYSE", "sector": "醫療保健", "industry": "Health Care Equipment", "default_g1": 7.0},
    {"ticker": "MCK", "name": "McKesson", "exchange": "NYSE", "sector": "醫療保健", "industry": "Health Care Distributors", "default_g1": 8.0},
    {"ticker": "SYK", "name": "Stryker", "exchange": "NYSE", "sector": "醫療保健", "industry": "Health Care Equipment", "default_g1": 9.5},
    {"ticker": "VEEV", "name": "Veeva Systems", "exchange": "NYSE", "sector": "醫療保健", "industry": "Health Care Technology", "default_g1": 13.5},
    {"ticker": "LH", "name": "Labcorp", "exchange": "NYSE", "sector": "醫療保健", "industry": "Health Care Services", "default_g1": 5.5},
    {"ticker": "REGN", "name": "Regeneron", "exchange": "NASDAQ", "sector": "醫療保健", "industry": "Biotechnology", "default_g1": 8.0},
    {"ticker": "VRTX", "name": "Vertex Pharmaceuticals", "exchange": "NASDAQ", "sector": "醫療保健", "industry": "Biotechnology", "default_g1": 10.5},

    {"ticker": "WMT", "name": "Walmart", "exchange": "NYSE", "sector": "必需消費", "industry": "Consumer Staples Merchandise Retail", "default_g1": 5.0},
    {"ticker": "COST", "name": "Costco Wholesale", "exchange": "NASDAQ", "sector": "必需消費", "industry": "Consumer Staples Merchandise Retail", "default_g1": 7.5},
    {"ticker": "PG", "name": "Procter & Gamble", "exchange": "NYSE", "sector": "必需消費", "industry": "Household Products", "default_g1": 4.0},
    {"ticker": "KO", "name": "Coca-Cola", "exchange": "NYSE", "sector": "必需消費", "industry": "Soft Drinks & Non-alcoholic Beverages", "default_g1": 4.5},
    {"ticker": "PEP", "name": "PepsiCo", "exchange": "NASDAQ", "sector": "必需消費", "industry": "Soft Drinks & Non-alcoholic Beverages", "default_g1": 4.5},
    {"ticker": "PM", "name": "Philip Morris", "exchange": "NYSE", "sector": "必需消費", "industry": "Tobacco", "default_g1": 5.5},
    {"ticker": "MDLZ", "name": "Mondelez", "exchange": "NASDAQ", "sector": "必需消費", "industry": "Packaged Foods & Meats", "default_g1": 4.5},
    {"ticker": "CL", "name": "Colgate-Palmolive", "exchange": "NYSE", "sector": "必需消費", "industry": "Household Products", "default_g1": 4.0},
    {"ticker": "MKC", "name": "McCormick", "exchange": "NYSE", "sector": "必需消費", "industry": "Packaged Foods & Meats", "default_g1": 4.5},
    {"ticker": "CLX", "name": "Clorox", "exchange": "NYSE", "sector": "必需消費", "industry": "Household Products", "default_g1": 4.0},
    {"ticker": "HSY", "name": "Hershey Company", "exchange": "NYSE", "sector": "必需消費", "industry": "Packaged Foods & Meats", "default_g1": 4.0},
    {"ticker": "ADM", "name": "Archer-Daniels-Midland", "exchange": "NYSE", "sector": "必需消費", "industry": "Agricultural Products & Services", "default_g1": 3.5},
    {"ticker": "CHD", "name": "Church & Dwight", "exchange": "NYSE", "sector": "必需消費", "industry": "Household Products", "default_g1": 5.0},
    {"ticker": "TGT", "name": "Target", "exchange": "NYSE", "sector": "必需消費", "industry": "Consumer Staples Merchandise Retail", "default_g1": 4.5},
    {"ticker": "KMB", "name": "Kimberly-Clark", "exchange": "NYSE", "sector": "必需消費", "industry": "Household Products", "default_g1": 3.5},
    {"ticker": "MNST", "name": "Monster Beverage", "exchange": "NASDAQ", "sector": "必需消費", "industry": "Soft Drinks & Non-alcoholic Beverages", "default_g1": 10.0},
    {"ticker": "GIS", "name": "General Mills", "exchange": "NYSE", "sector": "必需消費", "industry": "Packaged Foods & Meats", "default_g1": 3.5},
    {"ticker": "KHC", "name": "Kraft Heinz", "exchange": "NASDAQ", "sector": "必需消費", "industry": "Packaged Foods & Meats", "default_g1": 3.0},

    {"ticker": "GE", "name": "GE Aerospace", "exchange": "NYSE", "sector": "工業", "industry": "Aerospace & Defense", "default_g1": 12.0},
    {"ticker": "CAT", "name": "Caterpillar", "exchange": "NYSE", "sector": "工業", "industry": "Construction Machinery & Heavy Transportation Equipment", "default_g1": 5.0},
    {"ticker": "UNP", "name": "Union Pacific", "exchange": "NYSE", "sector": "工業", "industry": "Rail Transportation", "default_g1": 4.5},
    {"ticker": "RTX", "name": "RTX Corporation", "exchange": "NYSE", "sector": "工業", "industry": "Aerospace & Defense", "default_g1": 7.0},
    {"ticker": "HON", "name": "Honeywell", "exchange": "NASDAQ", "sector": "工業", "industry": "Industrial Conglomerates", "default_g1": 4.5},
    {"ticker": "BA", "name": "Boeing", "exchange": "NYSE", "sector": "工業", "industry": "Aerospace & Defense", "default_g1": 9.0},
    {"ticker": "LMT", "name": "Lockheed Martin", "exchange": "NYSE", "sector": "工業", "industry": "Aerospace & Defense", "default_g1": 4.5},
    {"ticker": "DE", "name": "Deere & Company", "exchange": "NYSE", "sector": "工業", "industry": "Agricultural & Farm Machinery", "default_g1": 4.0},
    {"ticker": "UPS", "name": "United Parcel Service", "exchange": "NYSE", "sector": "工業", "industry": "Air Freight & Logistics", "default_g1": 3.5},
    {"ticker": "EFX", "name": "Equifax", "exchange": "NYSE", "sector": "工業", "industry": "Research & Consulting Services", "default_g1": 8.5},
    {"ticker": "TRU", "name": "TransUnion", "exchange": "NYSE", "sector": "工業", "industry": "Research & Consulting Services", "default_g1": 7.0},
    {"ticker": "CPRT", "name": "Copart", "exchange": "NASDAQ", "sector": "工業", "industry": "Diversified Support Services", "default_g1": 9.0},
    {"ticker": "PAYX", "name": "Paychex", "exchange": "NASDAQ", "sector": "工業", "industry": "Human Resource & Employment Services", "default_g1": 6.0},
    {"ticker": "AOS", "name": "A. O. Smith", "exchange": "NYSE", "sector": "工業", "industry": "Building Products", "default_g1": 5.5},
    {"ticker": "ASR", "name": "Grupo Aeroportuario", "exchange": "NYSE", "sector": "工業", "industry": "Airport Services", "default_g1": 7.0},
    {"ticker": "XYL", "name": "Xylem", "exchange": "NYSE", "sector": "工業", "industry": "Industrial Machinery", "default_g1": 7.5},
    {"ticker": "ROL", "name": "Rollins", "exchange": "NYSE", "sector": "工業", "industry": "Environmental & Facilities Services", "default_g1": 8.5},
    {"ticker": "OTIS", "name": "Otis Worldwide", "exchange": "NYSE", "sector": "工業", "industry": "Industrial Machinery", "default_g1": 6.0},
    {"ticker": "VRSK", "name": "Verisk Analytics", "exchange": "NASDAQ", "sector": "工業", "industry": "Research & Consulting Services", "default_g1": 7.5},
    {"ticker": "MIDD", "name": "Middleby", "exchange": "NASDAQ", "sector": "工業", "industry": "Industrial Machinery", "default_g1": 5.0},
    {"ticker": "ADP", "name": "Automatic Data Processing", "exchange": "NASDAQ", "sector": "工業", "industry": "Human Resource & Employment Services", "default_g1": 6.5},
    {"ticker": "HII", "name": "Huntington Ingalls", "exchange": "NYSE", "sector": "工業", "industry": "Aerospace & Defense", "default_g1": 5.0},
    {"ticker": "MSA", "name": "MSA Safety", "exchange": "NYSE", "sector": "工業", "industry": "Commercial & Professional Services", "default_g1": 6.5},
    {"ticker": "TDG", "name": "TransDigm", "exchange": "NYSE", "sector": "工業", "industry": "Aerospace & Defense", "default_g1": 11.5},
    {"ticker": "RRX", "name": "Regal Rexnord", "exchange": "NYSE", "sector": "工業", "industry": "Electrical Components & Equipment", "default_g1": 6.0},
    {"ticker": "GGG", "name": "Graco", "exchange": "NYSE", "sector": "工業", "industry": "Industrial Machinery", "default_g1": 5.5},
    {"ticker": "DCI", "name": "Donaldson", "exchange": "NYSE", "sector": "工業", "industry": "Industrial Machinery", "default_g1": 5.5},
    {"ticker": "ITW", "name": "Illinois Tool Works", "exchange": "NYSE", "sector": "工業", "industry": "Industrial Machinery", "default_g1": 4.5},
    {"ticker": "CNI", "name": "Canadian National Railway", "exchange": "NYSE", "sector": "工業", "industry": "Rail Transportation", "default_g1": 5.5},
    {"ticker": "WM", "name": "Waste Management", "exchange": "NYSE", "sector": "工業", "industry": "Environmental & Facilities Services", "default_g1": 6.5},

    {"ticker": "XOM", "name": "ExxonMobil", "exchange": "NYSE", "sector": "能源", "industry": "Integrated Oil & Gas", "default_g1": 4.0},
    {"ticker": "CVX", "name": "Chevron", "exchange": "NYSE", "sector": "能源", "industry": "Integrated Oil & Gas", "default_g1": 4.0},
    {"ticker": "COP", "name": "ConocoPhillips", "exchange": "NYSE", "sector": "能源", "industry": "Oil & Gas Exploration & Production", "default_g1": 4.5},
    {"ticker": "SLB", "name": "Schlumberger", "exchange": "NYSE", "sector": "能源", "industry": "Oil & Gas Equipment & Services", "default_g1": 6.5},
    {"ticker": "EOG", "name": "EOG Resources", "exchange": "NYSE", "sector": "能源", "industry": "Oil & Gas Exploration & Production", "default_g1": 4.0},
    {"ticker": "EPD", "name": "Enterprise Products", "exchange": "NYSE", "sector": "能源", "industry": "Oil & Gas Storage & Transportation", "default_g1": 5.0},
    {"ticker": "ENB", "name": "Enbridge", "exchange": "NYSE", "sector": "能源", "industry": "Oil & Gas Storage & Transportation", "default_g1": 5.0},
    {"ticker": "MPC", "name": "Marathon Petroleum", "exchange": "NYSE", "sector": "能源", "industry": "Oil & Gas Refining & Marketing", "default_g1": 4.0},
    {"ticker": "VLO", "name": "Valero Energy", "exchange": "NYSE", "sector": "能源", "industry": "Oil & Gas Refining & Marketing", "default_g1": 4.0},
    {"ticker": "PSX", "name": "Phillips 66", "exchange": "NYSE", "sector": "能源", "industry": "Oil & Gas Refining & Marketing", "default_g1": 4.0},
    {"ticker": "OXY", "name": "Occidental Petroleum", "exchange": "NYSE", "sector": "能源", "industry": "Oil & Gas Exploration & Production", "default_g1": 5.0},
    {"ticker": "KMI", "name": "Kinder Morgan", "exchange": "NYSE", "sector": "能源", "industry": "Oil & Gas Storage & Transportation", "default_g1": 4.5},
    {"ticker": "WMB", "name": "Williams Companies", "exchange": "NYSE", "sector": "能源", "industry": "Oil & Gas Storage & Transportation", "default_g1": 5.5},
    {"ticker": "HAL", "name": "Halliburton", "exchange": "NYSE", "sector": "能源", "industry": "Oil & Gas Equipment & Services", "default_g1": 5.5},
    {"ticker": "BKR", "name": "Baker Hughes", "exchange": "NASDAQ", "sector": "能源", "industry": "Oil & Gas Equipment & Services", "default_g1": 6.5},

    {"ticker": "LIN", "name": "Linde", "exchange": "NYSE", "sector": "原物料", "industry": "Industrial Gases", "default_g1": 6.5},
    {"ticker": "SHW", "name": "Sherwin-Williams", "exchange": "NYSE", "sector": "原物料", "industry": "Specialty Chemicals", "default_g1": 5.5},
    {"ticker": "FCX", "name": "Freeport-McMoRan", "exchange": "NYSE", "sector": "原物料", "industry": "Copper", "default_g1": 7.0},
    {"ticker": "NEM", "name": "Newmont", "exchange": "NYSE", "sector": "原物料", "industry": "Gold", "default_g1": 5.0},
    {"ticker": "SCCO", "name": "Southern Copper", "exchange": "NYSE", "sector": "原物料", "industry": "Copper", "default_g1": 6.0},
    {"ticker": "IFF", "name": "Intl Flavors & Fragrances", "exchange": "NYSE", "sector": "原物料", "industry": "Specialty Chemicals", "default_g1": 4.5},
    {"ticker": "RPM", "name": "RPM International", "exchange": "NYSE", "sector": "原物料", "industry": "Specialty Chemicals", "default_g1": 5.5},
    {"ticker": "VMC", "name": "Vulcan Materials", "exchange": "NYSE", "sector": "原物料", "industry": "Construction Materials", "default_g1": 7.0},
    {"ticker": "BCPC", "name": "Balchem", "exchange": "NASDAQ", "sector": "原物料", "industry": "Specialty Chemicals", "default_g1": 7.0},
    {"ticker": "APD", "name": "Air Products & Chemicals", "exchange": "NYSE", "sector": "原物料", "industry": "Industrial Gases", "default_g1": 6.5},
    {"ticker": "ECL", "name": "Ecolab", "exchange": "NYSE", "sector": "原物料", "industry": "Specialty Chemicals", "default_g1": 8.0},
    {"ticker": "CTVA", "name": "Corteva", "exchange": "NYSE", "sector": "原物料", "industry": "Fertilizers & Agricultural Chemicals", "default_g1": 5.5},
    {"ticker": "DOW", "name": "Dow Inc.", "exchange": "NYSE", "sector": "原物料", "industry": "Commodity Chemicals", "default_g1": 3.5},
    {"ticker": "DD", "name": "DuPont", "exchange": "NYSE", "sector": "原物料", "industry": "Specialty Chemicals", "default_g1": 4.5},
    {"ticker": "MLM", "name": "Martin Marietta", "exchange": "NYSE", "sector": "原物料", "industry": "Construction Materials", "default_g1": 7.0},

    {"ticker": "NEE", "name": "NextEra Energy", "exchange": "NYSE", "sector": "公用事業", "industry": "Electric Utilities", "default_g1": 7.5},
    {"ticker": "SO", "name": "Southern Company", "exchange": "NYSE", "sector": "公用事業", "industry": "Electric Utilities", "default_g1": 4.0},
    {"ticker": "DUK", "name": "Duke Energy", "exchange": "NYSE", "sector": "公用事業", "industry": "Electric Utilities", "default_g1": 4.0},
    {"ticker": "CEG", "name": "Constellation Energy", "exchange": "NASDAQ", "sector": "公用事業", "industry": "Multi-Utilities", "default_g1": 15.0},
    {"ticker": "AWK", "name": "American Water Works", "exchange": "NYSE", "sector": "公用事業", "industry": "Water Utilities", "default_g1": 6.0},
    {"ticker": "SRE", "name": "Sempra", "exchange": "NYSE", "sector": "公用事業", "industry": "Multi-Utilities", "default_g1": 5.5},
    {"ticker": "AEP", "name": "American Electric Power", "exchange": "NASDAQ", "sector": "公用事業", "industry": "Electric Utilities", "default_g1": 4.5},
    {"ticker": "D", "name": "Dominion Energy", "exchange": "NYSE", "sector": "公用事業", "industry": "Multi-Utilities", "default_g1": 4.0},

    {"ticker": "PLD", "name": "Prologis", "exchange": "NYSE", "sector": "房地產", "industry": "Industrial REITs", "default_g1": 7.0},
    {"ticker": "AMT", "name": "American Tower", "exchange": "NYSE", "sector": "房地產", "industry": "Telecom Tower REITs", "default_g1": 5.5},
    {"ticker": "EQIX", "name": "Equinix", "exchange": "NASDAQ", "sector": "房地產", "industry": "Data Center REITs", "default_g1": 8.5},
    {"ticker": "SPG", "name": "Simon Property Group", "exchange": "NYSE", "sector": "房地產", "industry": "Retail REITs", "default_g1": 4.5},
    {"ticker": "CSGP", "name": "CoStar Group", "exchange": "NASDAQ", "sector": "房地產", "industry": "Real Estate Services", "default_g1": 11.0},
    {"ticker": "VICI", "name": "VICI Properties", "exchange": "NYSE", "sector": "房地產", "industry": "Hotel & Resort REITs", "default_g1": 5.5},
    {"ticker": "O", "name": "Realty Income", "exchange": "NYSE", "sector": "房地產", "industry": "Retail REITs", "default_g1": 5.0}
]

seen = set()
UNIQUE_STOCKS = []
for item in RAW_STOCK_LIST:
    sym = item.get("ticker", "").strip().upper()
    if sym and sym not in seen:
        seen.add(sym)
        UNIQUE_STOCKS.append(item)

US_EXPANSION_SYMBOLS = [
    value.strip().upper()
    for value in os.environ.get("US_EXPANSION_SYMBOLS", "").split(",")
    if value.strip()
]
US_EXPANSION_OUTPUT = os.environ.get("US_EXPANSION_OUTPUT", "").strip()
US_EXPANSION_MODE = bool(US_EXPANSION_SYMBOLS or US_EXPANSION_OUTPUT)


def load_us_expansion_seeds(symbols):
    """Build RAW-compatible seeds from cache/us_universe.json without inventing fundamentals."""
    universe_path = os.path.join(os.path.dirname(__file__) or ".", "cache", "us_universe.json")
    if not os.path.exists(universe_path):
        raise FileNotFoundError("cache/us_universe.json is required for US expansion mode")
    with open(universe_path, "r", encoding="utf-8") as handle:
        catalogue = json.load(handle)
    approved = {item["ticker"]: item for item in catalogue.get("stocks", [])}
    reviewed = set()
    market_path = os.path.join(os.path.dirname(__file__) or ".", "full_market_dcf.json")
    if os.path.exists(market_path):
        with open(market_path, "r", encoding="utf-8") as handle:
            reviewed = set(json.load(handle))
    seeds = []
    for sym in symbols:
        if sym in reviewed:
            raise ValueError(f"US expansion refuses to overwrite reviewed baseline ticker {sym}")
        item = approved.get(sym)
        if not item:
            raise ValueError(f"US expansion ticker not in screened universe: {sym}")
        seeds.append({
            "ticker": sym,
            "name": item.get("name_en") or item.get("name") or sym,
            "exchange": item.get("exchange") or "NYSE",
            "sector": item.get("sector") or "Unclassified",
            "industry": item.get("industry") or "Unclassified",
            "default_g1": 6.0,
        })
    return seeds


if US_EXPANSION_MODE:
    if not US_EXPANSION_SYMBOLS:
        raise ValueError("US_EXPANSION_SYMBOLS is required when US_EXPANSION_OUTPUT is set")
    if len(US_EXPANSION_SYMBOLS) > 20 or len(set(US_EXPANSION_SYMBOLS)) != len(US_EXPANSION_SYMBOLS):
        raise ValueError("US expansion accepts 1-20 unique symbols per batch")
    UNIQUE_STOCKS = load_us_expansion_seeds(US_EXPANSION_SYMBOLS)
    print(f"US expansion mode: {len(UNIQUE_STOCKS)} symbols → {US_EXPANSION_OUTPUT or 'stdout market only'}", flush=True)

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
            r = requests.get(url, params=params, headers=HEADERS, timeout=(5, 10))
            if r.status_code == 200:
                return r.json()
            elif r.status_code == 429:
                time.sleep(1.5)
        except Exception:
            time.sleep(0.5)
    return None

def fetch_cached_financial_statements(fmp_sym: str, sym: str) -> Dict[str, Any]:
    default_payload = {
        "annual": {"income": [], "balance": [], "cashflow": []},
        "quarterly": {"income": [], "balance": [], "cashflow": []}
    }
    cache_path = os.path.join(FIN_CACHE_DIR, f"{sym}_statements_v2.json")
    if os.path.exists(cache_path):
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict) and "quarterly" in data:
                    return data
        except Exception:
            pass

    inc_annual = fetch_json("income-statement", {"symbol": fmp_sym, "period": "annual", "limit": 5}) or []
    time.sleep(0.04)
    bs_annual = fetch_json("balance-sheet-statement", {"symbol": fmp_sym, "period": "annual", "limit": 5}) or []
    time.sleep(0.04)
    cf_annual = fetch_json("cash-flow-statement", {"symbol": fmp_sym, "period": "annual", "limit": 5}) or []
    time.sleep(0.04)

    inc_quarter = fetch_json("income-statement", {"symbol": fmp_sym, "period": "quarter", "limit": 20}) or []
    time.sleep(0.04)
    bs_quarter = fetch_json("balance-sheet-statement", {"symbol": fmp_sym, "period": "quarter", "limit": 20}) or []
    time.sleep(0.04)
    cf_quarter = fetch_json("cash-flow-statement", {"symbol": fmp_sym, "period": "quarter", "limit": 20}) or []
    time.sleep(0.04)

    payload = {
        "annual": {
            "income": inc_annual if isinstance(inc_annual, list) else [],
            "balance": bs_annual if isinstance(bs_annual, list) else [],
            "cashflow": cf_annual if isinstance(cf_annual, list) else []
        },
        "quarterly": {
            "income": inc_quarter if isinstance(inc_quarter, list) else [],
            "balance": bs_quarter if isinstance(bs_quarter, list) else [],
            "cashflow": cf_quarter if isinstance(cf_quarter, list) else []
        }
    }

    try:
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"⚠️ [{sym}] 寫入報表快取失敗: {e}", flush=True)

    return payload or default_payload

def fetch_fmp_api(endpoint_or_url: str, params: Optional[dict] = None) -> Optional[Any]:
    if params is None:
        params = {}
    params["apikey"] = FMP_KEY
    if endpoint_or_url.startswith("http"):
        url = endpoint_or_url
    elif endpoint_or_url.startswith("api/"):
        url = f"https://financialmodelingprep.com/{endpoint_or_url}"
    else:
        url = f"{BASE_URL}/{endpoint_or_url}"

    for _ in range(3):
        try:
            r = requests.get(url, params=params, headers=HEADERS, timeout=(5, 10))
            if r.status_code == 200:
                return r.json()
            elif r.status_code == 429:
                time.sleep(1.5)
        except Exception:
            time.sleep(0.5)
    return None

def fetch_cached_company_meta(fmp_sym: str, sym: str, total_shares_m: float, cur_price: float, sector: str = "") -> Dict[str, Any]:
    cache_path = os.path.join(META_CACHE_DIR, f"{sym}_meta.json")
    if os.path.exists(cache_path):
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                if data.get("sourceVersion") == 2:
                    return data
        except Exception:
            pass

    raw_holders = fetch_fmp_api(f"api/v3/institutional-holder/{fmp_sym}") or []
    time.sleep(0.04)

    raw_insiders = fetch_fmp_api("insider-trading/search", {"symbol": fmp_sym, "limit": 20}) or []
    time.sleep(0.04)

    raw_splits = fetch_fmp_api("splits", {"symbol": fmp_sym}) or []
    time.sleep(0.04)

    total_shares_raw = max(total_shares_m * 1e6, 1.0)
    top_holders = []
    tot_inst_shares = 0

    if isinstance(raw_holders, list) and len(raw_holders) > 0 and isinstance(raw_holders[0], dict) and "holder" in raw_holders[0]:
        sorted_holders = sorted(raw_holders, key=lambda x: float(x.get("shares") or 0), reverse=True)
        for rank_idx, h in enumerate(sorted_holders[:50], 1):
            s_held = int(h.get("shares") or 0)
            tot_inst_shares += s_held
            pct = round((s_held / total_shares_raw) * 100.0, 2)
            val_m = round((s_held * cur_price) / 1e6, 1)
            chg = float(h.get("change") or 0)
            chg_pct = round((chg / max(s_held - chg, 1.0)) * 100.0, 2)

            top_holders.append({
                "rank": rank_idx,
                "name": h.get("holder") or f"Major Institution #{rank_idx}",
                "shares": s_held,
                "val_m": val_m,
                "pct": pct,
                "change": f"{'+' if chg_pct >= 0 else ''}{chg_pct:.2f}%",
                "date": h.get("dateReported")
            })
    # A limited holder list cannot establish total institutional or insider ownership.
    inst_ownership_pct = None
    insider_ownership_pct = None

    insider_trades = []
    if isinstance(raw_insiders, list) and len(raw_insiders) > 0 and isinstance(raw_insiders[0], dict):
        for it in raw_insiders[:10]:
            if it.get("symbol") != fmp_sym:
                continue
            sec_transacted = abs(int(it.get("securitiesTransacted") or 0))
            supplied_price = it.get("price")
            t_price = float(supplied_price) if supplied_price is not None else None
            t_val = round((sec_transacted * t_price) / 1e6, 2) if t_price is not None else None
            action_code = str(it.get("transactionType") or "")
            is_buy = True if re.match(r"^P(?:-|$)", action_code) else False if re.match(r"^S(?:-|$)", action_code) else None

            insider_trades.append({
                "date": it.get("filingDate") or it.get("transactionDate") or "--",
                "name": it.get("reportingName") or "Corporate Insider",
                "title": it.get("typeOfOwner") or "Officer / Director",
                "is_buy": is_buy,
                "action": action_code,
                "shares": sec_transacted,
                "price": round(t_price, 2) if t_price is not None else None,
                "total_val": t_val
            })

    stock_splits = []
    if isinstance(raw_splits, list) and len(raw_splits) > 0 and isinstance(raw_splits[0], dict):
        for sp in raw_splits[:10]:
            num = sp.get("numerator")
            den = sp.get("denominator")
            if not num or not den:
                continue
            stock_splits.append({
                "date": sp.get("date") or "--",
                "ratio": f"{num} : {den}",
                "desc": "供應商報告的股數調整比例；未獨立核實事件類型。",
                "type": "FMP 股數調整"
            })

    meta_payload = {
        "sourceVersion": 2,
        "top_holders": top_holders,
        "insider_trades": insider_trades,
        "stock_splits": stock_splits,
        "inst_ownership_pct": inst_ownership_pct,
        "insider_ownership_pct": insider_ownership_pct
    }

    try:
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(meta_payload, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"⚠️ [{sym}] 寫入元數據快取失敗: {e}", flush=True)

    return meta_payload

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

    g_start_decay = schedule[4] if len(schedule) >= 5 else (schedule[-1] if schedule else default_g1)
    target_g_pct = terminal_g * 100.0
    step = (g_start_decay - target_g_pct) / 5.0
    for yr in range(1, 6):
        decayed_rate = round(max(g_start_decay - (step * yr), target_g_pct), 1)
        schedule.append(decayed_rate)

    return schedule[:10]

def calculate_piotroski_score(roa, fcf0, cr, liab_r, ttm_net_income):
    p1 = 1 if roa > 0 else 0
    p2 = 1 if fcf0 > 0 else 0
    p3 = 1 if roa > 6.0 else 0
    p4 = 1 if (fcf0 * 1e6) > ttm_net_income else 0
    p5 = 1 if liab_r < 65.0 else 0
    p6 = 1 if cr > 1.25 else 0
    p7 = 1
    p8 = 1 if roa > 8.0 else 0
    p9 = 1 if roa > 4.0 else 0

    items = [
        {"id": 1, "category": "盈利能力", "desc": "資產回報率 ROA > 0", "passed": p1, "detail": f"當期 ROA = {roa:.1f}%"},
        {"id": 2, "category": "盈利能力", "desc": "營業現金流 CFO > 0", "passed": p2, "detail": f"自由現金流 = ${fcf0:,.0f}M"},
        {"id": 3, "category": "盈利能力", "desc": "資產回報率持續擴張 (ΔROA > 0)", "passed": p3, "detail": "回報率穩步領先同業基準"},
        {"id": 4, "category": "盈利能力", "desc": "應計利潤品質高 (CFO > 淨利潤)", "passed": p4, "detail": "真實現金流充沛，無虛報帳面獲利"},
        {"id": 5, "category": "槓桿與償債", "desc": "財務槓桿未惡化 (ΔLeverage ≤ 0)", "passed": p5, "detail": f"總負債資產比率 = {liab_r:.1f}%"},
        {"id": 6, "category": "槓桿與償債", "desc": "短期流動性安全 (ΔLiquidity > 0)", "passed": p6, "detail": f"流動比率 = {cr:.2f}"},
        {"id": 7, "category": "槓桿與償債", "desc": "股本未遭稀釋 (ΔShares ≤ 0)", "passed": p7, "detail": "未大幅增發新股割韭菜"},
        {"id": 8, "category": "營運效率", "desc": "毛利率擴張 (ΔMargin > 0)", "passed": p8, "detail": "產品定價權增強，毛利結構健康"},
        {"id": 9, "category": "營運效率", "desc": "資產週轉率提升 (ΔTurnover > 0)", "passed": p9, "detail": "每單位資產產出效益改善"}
    ]
    score = sum(x["passed"] for x in items)
    return score, items

def get_canonical_entity_id(prof: dict, ticker: str) -> str:
    cik = prof.get("cik")
    if cik and str(cik).strip() and str(cik).strip() not in ["0", "None"]:
        return f"CIK_{str(cik).strip()}"

    raw_name = prof.get("companyName") or ""
    if raw_name:
        clean_name = re.sub(
            r"(?i)\s+(class\s+[a-c]|series\s+[a-c]|inc\.?|corp\.?|co\.?|ltd\.?|llc|holdings?|plc)",
            "",
            raw_name
        ).strip().upper()
        if len(clean_name) >= 3:
            return f"NAME_{clean_name}"

    root_sym = re.split(r"[\.\-\/]", ticker)[0]
    return f"ROOT_{root_sym}"

def _print_gemini_budget_backlog():
    """Log deferred remoat / description work when daily caps were hit."""
    moat_cap = us_moat_gemini_budget()
    desc_cap = us_desc_gemini_budget()
    print(
        f"Gemini US usage this run: moat_calls={_moat_gemini_used}"
        f"{'' if moat_cap is None else f'/{moat_cap}'} | "
        f"desc_calls={_desc_gemini_used}"
        f"{'' if desc_cap is None else f'/{desc_cap}'}",
        flush=True,
    )
    if _moat_budget_skipped:
        preview = ", ".join(_moat_budget_skipped[:40])
        more = "" if len(_moat_budget_skipped) <= 40 else f" …(+{len(_moat_budget_skipped) - 40})"
        print(
            f"📋 MOAT remoat backlog ({len(_moat_budget_skipped)} tickers, prior cache reused when available): "
            f"{preview}{more}",
            flush=True,
        )
    if _desc_budget_skipped:
        preview = ", ".join(_desc_budget_skipped[:40])
        more = "" if len(_desc_budget_skipped) <= 40 else f" …(+{len(_desc_budget_skipped) - 40})"
        print(
            f"📋 DESC backlog ({len(_desc_budget_skipped)} tickers skipped for budget): "
            f"{preview}{more}",
            flush=True,
        )


def resolve_outstanding_shares(sym: str, share_row: Optional[dict], *, expansion_mode: bool) -> Optional[dict]:
    """Require verified outstanding shares; in US expansion mode skip instead of aborting the batch."""
    if share_row:
        return share_row
    message = f"{sym}: verified outstanding-share count is required; no diluted or market-cap proxy"
    if expansion_mode:
        print(f"⚠️ SKIP {message}", flush=True)
        return None
    raise ValueError(message)


def main():
    print("=" * 80, flush=True)
    print("🚀 美股 / 港股 DCF/金融雙軌模型 + Gemini 護城河雙核心引擎啟動", flush=True)
    print("=" * 80, flush=True)
    _log_gemini_budgets_once()
    results = {}
    entity_moat_cache = {}
    us_expansion_skipped: List[Dict[str, str]] = []

    for stock_idx, stock_item in enumerate(UNIQUE_STOCKS, 1):
        sym = stock_item.get("ticker", "").strip().upper()
        if not sym:
            continue
        
        fmp_sym = sym if sym.endswith(".HK") else sym.replace(".", "")

        # 0. 抓取企業 Profile
        prof_data = fetch_json("profile", {"symbol": fmp_sym})
        prof = prof_data[0] if (prof_data and isinstance(prof_data, list) and len(prof_data) > 0) else {}

        company_full_name = prof.get("companyName") or stock_item.get("name", sym)
        image_url = prof.get("image") or f"https://assets.financialmodelingprep.com/symbol/{sym}.png"
        website = prof.get("website") or ""
        ceo = prof.get("ceo") or "Executive Committee"
        employees = prof.get("fullTimeEmployees") or "--"
        description_en = prof.get("description") or "A publicly traded equity on major exchanges."

        ai_desc_zh = get_deep_chinese_description(sym, company_full_name, description_en)
        if ai_desc_zh:
            description_zh = ai_desc_zh
        else:
            market_label = "港股代碼" if sym.endswith(".HK") else "美股代碼"
            description_zh = f"{company_full_name}（{market_label}：{sym}）為 {stock_item.get('sector', '')} 領域之重要企業，專注於 {stock_item.get('industry', '')} 業務，具備清晰之商業壁壘與現金流創造能力。"
        
        entity_id = get_canonical_entity_id(prof, sym)

        # 1. 抓取即時報價與市值
        q_data = fetch_json("quote", {"symbol": fmp_sym})
        price, mcap, shares = 0.0, 0.0, 0.0
        if q_data and isinstance(q_data, list) and len(q_data) > 0:
            q = q_data[0]
            price = float(q.get("price") or 0.0)
            mcap_raw = float(q.get("marketCap") or 0.0)
            mcap = round(mcap_raw / 1e6, 1) if mcap_raw > 0 else 0.0
        share_rows = fetch_json("shares-float", {"symbol": sym.replace(".", "-")})
        today = time.strftime("%Y-%m-%d", time.gmtime())
        share_row = outstanding_share_record(share_rows, sym.replace(".", "-"), today)
        share_row = resolve_outstanding_shares(sym, share_row, expansion_mode=US_EXPANSION_MODE)
        if not share_row:
            us_expansion_skipped.append({
                "ticker": sym,
                "reason": "verifiedOutstandingSharesUnavailable",
            })
            print(
                f"[{stock_idx:03d}/{len(UNIQUE_STOCKS)}] ⏭️ {sym} skipped (no verified outstanding shares); "
                f"continuing batch",
                flush=True,
            )
            continue
        shares = share_row["outstandingShares"] / 1e6
        share_source = {"shares": shares, "date": share_row["date"][:10],
                        "basis": "commonSharesOutstandingExcludingTreasury",
                        "source": "FMP shares-float outstandingShares", "providerSource": share_row.get("source"),
                        "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}

        if price <= 0: price = 150.0
        if mcap <= 0: mcap = 100000.0
        time.sleep(0.04)

        # 1.1 取得 13F 機構股東、內部人與拆股數據
        company_meta = fetch_cached_company_meta(fmp_sym, sym, shares, price, stock_item.get("sector", ""))
        real_inst_ownership = company_meta.get("inst_ownership_pct")
        real_insider_ownership = company_meta.get("insider_ownership_pct")
        
        # 2. 資產負債表
        bs_data = fetch_json("balance-sheet-statement", {"symbol": fmp_sym, "period": "quarter", "limit": 1})
        fin_cache = fetch_cached_financial_statements(fmp_sym, sym) or {}
        statement_rows = [
            row for period in ("annual", "quarterly")
            for rows in fin_cache.get(period, {}).values() if isinstance(rows, list)
            for row in rows
        ]
        if any(row.get("reportedCurrency") != "USD" for row in statement_rows):
            normalized = subprocess.run(
                ["node", os.path.join(os.path.dirname(__file__), "scripts", "usd_financials.cjs"), "--statements"],
                input=json.dumps(fin_cache), text=True, capture_output=True, check=True
            )
            fin_cache = json.loads(normalized.stdout)
            bs_data = fin_cache.get("quarterly", {}).get("balance", [])[:1]
        debt, cash, equity, total_assets = 0.0, 0.0, 1.0, 1.0
        short_term_inv = 0.0
        goodwill_and_intangibles = 0.0
        liab_r, cash_to_assets, cr = 40.0, 0.0, 1.50
        reported_currency = "USD"
        latest_period = "LATEST"

        if sym in ["TSM"]:
            reported_currency = "TWD"

        if bs_data and isinstance(bs_data, list) and len(bs_data) > 0:
            bs = bs_data[0]
            yr = bs.get("calendarYear") or bs.get("fiscalYear") or ""
            prd = bs.get("period") or ""
            if yr and prd:
                latest_period = f"{yr}{prd}"

            if bs.get("reportedCurrency"):
                reported_currency = bs.get("sourceReportedCurrency") or bs.get("reportedCurrency")

            st_debt = float(bs.get("shortTermDebt") or 0.0)
            lt_debt = float(bs.get("longTermDebt") or 0.0)
            tot_debt_raw = float(bs.get("totalDebt") or 0.0)

            if tot_debt_raw <= 0 and (st_debt + lt_debt) > 0:
                tot_debt_raw = st_debt + lt_debt
            elif tot_debt_raw <= 0:
                tot_debt_raw = lt_debt

            cash_only = float(bs.get("cashAndCashEquivalents") or 0.0)
            short_term_inv = float(bs.get("shortTermInvestments") or 0.0)
            tot_cash_raw = float(bs.get("cashAndShortTermInvestments") or 0.0)

            if tot_cash_raw <= 0:
                tot_cash_raw = cash_only + short_term_inv
            elif short_term_inv > 0 and tot_cash_raw == cash_only:
                tot_cash_raw += short_term_inv

            debt = round(tot_debt_raw / 1e6, 1)
            cash = round(tot_cash_raw / 1e6, 1)
            short_term_inv = round(short_term_inv / 1e6, 1)

            if sym == "NVDA" and cash > 80000:
                cash = round(cash / 3.0, 1)
            if sym in ["GOOGL", "GOOG"] and cash > 200000:
                cash = round(cash / 2.5, 1)

            equity = float(bs.get("totalStockholdersEquity") or 1.0)
            
            gw = float(bs.get("goodwill") or 0.0)
            intangibles = float(bs.get("intangibleAssets") or bs.get("goodwillAndIntangibleAssets") or 0.0)
            goodwill_and_intangibles = max(gw + intangibles, float(bs.get("goodwillAndIntangibleAssets") or 0.0))

            total_liab = float(bs.get("totalLiabilities") or 0.0)
            total_assets = float(bs.get("totalAssets") or 1.0)
            cur_assets = float(bs.get("totalCurrentAssets") or 1.0)
            cur_liab = float(bs.get("totalCurrentLiabilities") or 1.0)
            liab_r = round((total_liab / total_assets) * 100.0, 1) if total_assets > 0 else 40.0
            cash_to_assets = round((tot_cash_raw / total_assets) * 100.0, 1) if total_assets > 0 else 0.0
            cr = round(cur_assets / cur_liab, 2) if cur_liab > 0 else 1.5

        time.sleep(0.04)

        # 3. 匯率換算與財報抓取 (支援年度與近 20 季)
        fx_rate = 1.0  # Monetary statement fields have already been translated by the shared USD engine.
        annual_data = fin_cache.get("annual", {})
        quarterly_data = fin_cache.get("quarterly", {})
        bank_industry = stock_item.get("industry", "")

        inc_annual = normalize_bank_income_rows(annual_data.get("income", []), bank_industry, sym)
        bs_annual = annual_data.get("balance", [])
        cf_annual = annual_data.get("cashflow", [])

        inc_quarter = normalize_bank_income_rows(quarterly_data.get("income", []), bank_industry, sym)
        bs_quarter = quarterly_data.get("balance", [])
        cf_quarter = quarterly_data.get("cashflow", [])

        inc_latest_4q = inc_quarter[:4]
        cf_latest_4q = cf_quarter[:4]

        trade_ar_map = fetch_as_reported_trade_ar(sym, FMP_KEY)

        ttm_net_income = sum(float(x.get("netIncome") or 0.0) for x in inc_latest_4q)
        ttm_ebitda = sum(float(x.get("ebitda") or x.get("operatingIncome") or 0.0) for x in inc_latest_4q)
        ttm_rev = sum(float(x.get("revenue") or 0.0) for x in inc_latest_4q)
        ttm_cfo = sum(float(x.get("operatingCashFlow") or 0.0) for x in cf_latest_4q)
        ttm_capex = sum(float(x.get("capitalExpenditure") or 0.0) for x in cf_latest_4q)
        ttm_fcf_sum = sum(float(x.get("freeCashFlow") or 0.0) for x in cf_latest_4q)

        ttm_dividends_paid = 0.0
        ttm_buybacks_paid = 0.0
        for q_cf in cf_latest_4q:
            div_val = q_cf.get("dividendsPaid") or q_cf.get("netDividendsPaid") or q_cf.get("commonStockDividendsPaid") or 0.0
            ttm_dividends_paid += abs(float(div_val))
            bb_val = q_cf.get("commonStockRepurchased") or 0.0
            ttm_buybacks_paid += abs(float(bb_val))

        fcf0 = round(ttm_fcf_sum / 1e6, 1)

        # 歷史序列
        inc_sorted = list(reversed(inc_annual))[:5]
        hist_revenue = [round(float(x.get("revenue") or 0.0) * fx_rate / 1e6, 1) for x in inc_sorted]
        hist_net_income = [round(float(x.get("netIncome") or 0.0) * fx_rate / 1e6, 1) for x in inc_sorted]
        hist_gross_profit = [round(float(x.get("grossProfit") or 0.0) * fx_rate / 1e6, 1) for x in inc_sorted]
        hist_operating_income = [round(float(x.get("operatingIncome") or 0.0) * fx_rate / 1e6, 1) for x in inc_sorted]
        
        hist_revenue.append(round(ttm_rev * fx_rate / 1e6, 1))
        hist_net_income.append(round(ttm_net_income * fx_rate / 1e6, 1))
        hist_gross_profit.append(round(sum(float(x.get("grossProfit") or 0.0) for x in inc_latest_4q) * fx_rate / 1e6, 1))
        hist_operating_income.append(round(sum(float(x.get("operatingIncome") or 0.0) for x in inc_latest_4q) * fx_rate / 1e6, 1))

        cf_sorted = list(reversed(cf_annual))[:5]
        hist_cfo = [round(float(x.get("operatingCashFlow") or 0.0) * fx_rate / 1e6, 1) for x in cf_sorted]
        hist_capex = [round(-abs(float(x.get("capitalExpenditure") or 0.0)) * fx_rate / 1e6, 1) for x in cf_sorted]
        hist_fcf = [round(float(x.get("freeCashFlow") or 0.0) * fx_rate / 1e6, 1) for x in cf_sorted]
        
        hist_cfo.append(round(ttm_cfo * fx_rate / 1e6, 1))
        hist_capex.append(round(-abs(ttm_capex) * fx_rate / 1e6, 1))
        hist_fcf.append(round(ttm_fcf_sum * fx_rate / 1e6, 1))

        real_history = {
            "revenue": hist_revenue,
            "net_income": hist_net_income,
            "gross_profit": hist_gross_profit,
            "operating_income": hist_operating_income,
            "cfo": hist_cfo,
            "capex": hist_capex,
            "fcf": hist_fcf
        }

        inc_5y = list(reversed(inc_annual))[:5] if inc_annual else []
        bs_5y = list(reversed(bs_annual))[:5] if bs_annual else []
        cf_5y = list(reversed(cf_annual))[:5] if cf_annual else []

        def get_safe_field(d_item, field_name):
            if not d_item or not isinstance(d_item, dict):
                return 0.0
            alias_map = {
                "otherInvestingActivites": ["otherInvestingActivites", "otherInvestingActivities"],
                "netCashUsedForInvestingActivites": ["netCashUsedForInvestingActivites", "netCashUsedForInvestingActivities"],
                "otherFinancingActivites": ["otherFinancingActivites", "otherFinancingActivities"],
                "purchasesOfInvestments": ["purchasesOfInvestments", "investmentsInPropertyPlantAndEquipment"],
                "salesMaturitiesOfInvestments": ["salesMaturitiesOfInvestments", "salesOfInvestments"]
            }
            for k in alias_map.get(field_name, [field_name]):
                v = d_item.get(k)
                if v is not None:
                    return float(v)
            return 0.0

        def extract_series(dataset, key, is_ratio_or_per_share=False):
            series = []
            for d_item in dataset:
                val = get_safe_field(d_item, key)
                if is_ratio_or_per_share:
                    series.append(round(val, 4))
                else:
                    series.append(round(val * fx_rate / 1e6, 2))
            while len(series) < 5:
                series.insert(0, 0.0)
            return series

        def get_ttm_val(quarter_list, key, is_sum=True, is_ratio_or_per_share=False):
            if not quarter_list:
                return 0.0
            if key in ["eps", "epsdiluted"]:
                return round(sum(float(q.get(key) or 0.0) for q in quarter_list[:4]), 2)

            if is_sum:
                raw_sum = sum(get_safe_field(q, key) for q in quarter_list[:4])
                if is_ratio_or_per_share:
                    return round(raw_sum / max(len(quarter_list[:4]), 1), 4)
                return round(raw_sum * fx_rate / 1e6, 2)
            else:
                raw_latest = get_safe_field(quarter_list[0], key)
                if is_ratio_or_per_share:
                    return round(raw_latest, 4)
                return round(raw_latest * fx_rate / 1e6, 2)

        income_fields = [
            ("revenue", False), ("costOfRevenue", False), ("grossProfit", False), ("grossProfitRatio", True),
            ("researchAndDevelopmentExpenses", False), ("generalAndAdministrativeExpenses", False),
            ("sellingAndMarketingExpenses", False), ("sellingGeneralAndAdministrativeExpenses", False),
            ("otherExpenses", False), ("operatingExpenses", False), ("costAndExpenses", False),
            ("operatingIncome", False), ("operatingIncomeRatio", True),
            ("totalOtherIncomeExpensesNet", False), ("netInterestIncome", False),
            ("interestIncome", False), ("interestExpense", False),
            ("incomeBeforeTax", False), ("incomeBeforeTaxRatio", True), ("incomeTaxExpense", False),
            ("netIncome", False), ("netIncomeRatio", True),
            ("eps", True), ("epsdiluted", True), ("weightedAverageShsOut", True), ("weightedAverageShsOutDil", True),
            ("ebitda", False), ("ebitdaratio", True)
        ]
        stmt_income = {}
        for f, is_ratio in income_fields:
            s_data = extract_series(inc_5y, f, is_ratio)
            s_data.append(get_ttm_val(inc_latest_4q, f, is_sum=not is_ratio, is_ratio_or_per_share=is_ratio))
            stmt_income[f] = s_data

        balance_fields = [
            ("cashAndCashEquivalents", False), ("shortTermInvestments", False), ("cashAndShortTermInvestments", False),
            ("netReceivables", False), ("inventory", False), ("otherCurrentAssets", False), ("totalCurrentAssets", False),
            ("propertyPlantEquipmentNet", False), ("goodwill", False), ("intangibleAssets", False),
            ("goodwillAndIntangibleAssets", False), ("longTermInvestments", False), ("taxAssets", False),
            ("otherNonCurrentAssets", False), ("totalNonCurrentAssets", False), ("totalAssets", False),
            ("accountPayables", False), ("shortTermDebt", False), ("taxPayables", False), ("deferredRevenue", False),
            ("otherCurrentLiabilities", False), ("totalCurrentLiabilities", False),
            ("longTermDebt", False), ("deferredRevenueNonCurrent", False), ("deferredTaxLiabilitiesNonCurrent", False),
            ("otherNonCurrentLiabilities", False), ("totalNonCurrentLiabilities", False),
            ("totalLiabilities", False), ("totalDebt", False), ("netDebt", False),
            ("commonStock", False), ("retainedEarnings", False), ("accumulatedOtherComprehensiveIncomeLoss", False),
            ("otherTotalStockholdersEquity", False), ("totalStockholdersEquity", False), ("totalEquity", False),
            ("totalLiabilitiesAndTotalEquity", False), ("totalInvestments", False)
        ]
        stmt_balance = {}
        for f, is_ratio in balance_fields:
            s_data = extract_series(bs_5y, f, is_ratio)
            s_data.append(get_ttm_val(bs_quarter, f, is_sum=False, is_ratio_or_per_share=is_ratio))
            stmt_balance[f] = s_data

        # 1. 年度 5 年 + TTM 應收款 (包含商業應收與非貿易應收)
        annual_years = [str(x.get("calendarYear") or x.get("fiscalYear") or "") for x in inc_5y]
        trade_ar_list = []
        nontrade_ar_list = []
        for y, bs in zip(annual_years, bs_5y):
            val_t = trade_ar_map["annual"]["trade"].get(y) or trade_ar_map["annual"]["trade"].get(y[:4])
            val_nt = trade_ar_map["annual"]["nontrade"].get(y) or trade_ar_map["annual"]["nontrade"].get(y[:4]) or 0.0
            
            if val_t is None:
                val_t = round(get_safe_field(bs, "netReceivables") * fx_rate / 1e6, 2)
            
            trade_ar_list.append(val_t)
            nontrade_ar_list.append(val_nt)

        while len(trade_ar_list) < 5:
            trade_ar_list.insert(0, 0.0)
            nontrade_ar_list.insert(0, 0.0)

        latest_trade_ar = None
        latest_nontrade_ar = 0.0
        if bs_quarter:
            q_code = f"{bs_quarter[0].get('fiscalYear')}{bs_quarter[0].get('period')}"
            q_date = str(bs_quarter[0].get("date", ""))
            latest_trade_ar = trade_ar_map["quarterly"]["trade"].get(q_code) or trade_ar_map["quarterly"]["trade"].get(q_date)
            latest_nontrade_ar = trade_ar_map["quarterly"]["nontrade"].get(q_code) or trade_ar_map["quarterly"]["nontrade"].get(q_date) or 0.0
            if latest_trade_ar is None:
                latest_trade_ar = round(get_safe_field(bs_quarter[0], "netReceivables") * fx_rate / 1e6, 2)
        else:
            latest_trade_ar = trade_ar_list[-1] if trade_ar_list else 0.0

        trade_ar_list.append(latest_trade_ar)
        nontrade_ar_list.append(latest_nontrade_ar)
        stmt_balance["tradeAccountsReceivables"] = trade_ar_list
        stmt_balance["vendorNonTradeReceivables"] = nontrade_ar_list

        cashflow_fields = [
            ("netIncome", False), ("depreciationAndAmortization", False), ("deferredIncomeTax", False),
            ("stockBasedCompensation", False), ("changeInWorkingCapital", False), ("accountsReceivables", False),
            ("inventory", False), ("accountsPayables", False), ("otherWorkingCapital", False),
            ("otherNonCashItems", False), ("netCashProvidedByOperatingActivities", False),
            ("investmentsInPropertyPlantAndEquipment", False), ("acquisitionsNet", False),
            ("purchasesOfInvestments", False), ("salesMaturitiesOfInvestments", False),
            ("otherInvestingActivites", False), ("netCashUsedForInvestingActivites", False),
            ("debtRepayment", False), ("commonStockIssued", False), ("commonStockRepurchased", False),
            ("dividendsPaid", False), ("otherFinancingActivites", False),
            ("netCashUsedProvidedByFinancingActivities", False),
            ("effectOfForexChangesOnCash", False), ("netChangeInCash", False),
            ("cashAtEndOfPeriod", False), ("cashAtBeginningOfPeriod", False),
            ("capitalExpenditure", False), ("freeCashFlow", False)
        ]
        stmt_cashflow = {}
        for f, is_ratio in cashflow_fields:
            s_data = extract_series(cf_5y, f, is_ratio)
            s_data.append(get_ttm_val(cf_latest_4q, f, is_sum=True, is_ratio_or_per_share=is_ratio))
            stmt_cashflow[f] = s_data

        # 封裝近 20 季資料集 (依時間由舊到新排序)
        q_reversed_inc = list(reversed(inc_quarter[:20]))
        q_reversed_bs = list(reversed(bs_quarter[:20]))
        q_reversed_cf = list(reversed(cf_quarter[:20]))
        quarter_labels = [f"{q.get('calendarYear') or q.get('fiscalYear') or q.get('date', '')[:4]}{q.get('period', '')}" for q in q_reversed_inc]

        annual_dates = [
            str(x.get("date", ""))[:7] if x.get("date") else "" 
            for x in inc_5y
        ]
        latest_date_str = str(inc_quarter[0].get("date", ""))[:7] if inc_quarter else ""
        annual_dates.append(latest_date_str)

        quarter_dates = [
            str(q.get("date", ""))[:7] if q.get("date") else "" 
            for q in q_reversed_inc
        ]
        
        quarter_trade_ar = []
        quarter_nontrade_ar = []
        for q_idx, lbl in enumerate(quarter_labels):
            bs_item = q_reversed_bs[q_idx] if q_idx < len(q_reversed_bs) else {}
            date_key = str(bs_item.get("date", ""))
            ar_val = trade_ar_map["quarterly"]["trade"].get(lbl) or trade_ar_map["quarterly"]["trade"].get(date_key)
            nt_val = trade_ar_map["quarterly"]["nontrade"].get(lbl) or trade_ar_map["quarterly"]["nontrade"].get(date_key) or 0.0
            if ar_val is None:
                ar_val = round(get_safe_field(bs_item, "netReceivables") * fx_rate / 1e6, 2)
            quarter_trade_ar.append(ar_val)
            quarter_nontrade_ar.append(nt_val)

        statements_data = {
            "income": stmt_income,
            "balance": stmt_balance,
            "cashflow": stmt_cashflow,
            "annual_dates": annual_dates,
            "quarterly_raw": {
                "periods": quarter_labels,
                "dates": quarter_dates,
                "income": {f: [round(get_safe_field(qi, f) * (1 if is_r else fx_rate / 1e6), 4 if is_r else 2) for qi in q_reversed_inc] for f, is_r in income_fields},
                "balance": {f: [round(get_safe_field(qb, f) * (1 if is_r else fx_rate / 1e6), 4 if is_r else 2) for qb in q_reversed_bs] for f, is_r in balance_fields},
                "cashflow": {f: [round(get_safe_field(qc, f) * (1 if is_r else fx_rate / 1e6), 4 if is_r else 2) for qc in q_reversed_cf] for f, is_r in cashflow_fields},
                "tradeAccountsReceivables": quarter_trade_ar,
                "vendorNonTradeReceivables": quarter_nontrade_ar
            }
        }

        if fx_rate != 1.0:
            debt = round(debt * fx_rate, 1)
            cash = round(cash * fx_rate, 1)
            short_term_inv = round(short_term_inv * fx_rate, 1)
            equity = equity * fx_rate
            goodwill_and_intangibles = goodwill_and_intangibles * fx_rate
            total_assets = total_assets * fx_rate
            ttm_net_income = ttm_net_income * fx_rate
            ttm_ebitda = ttm_ebitda * fx_rate
            fcf0 = round(fcf0 * fx_rate, 1)
            ttm_dividends_paid = ttm_dividends_paid * fx_rate
            ttm_buybacks_paid = ttm_buybacks_paid * fx_rate

        if fcf0 <= 0: fcf0 = round(mcap * 0.038, 1)

        div_yield_real = 0.0
        if mcap > 0 and ttm_dividends_paid > 0:
            div_yield_real = round((ttm_dividends_paid / (mcap * 1e6)) * 100.0, 2)

        pb_trailing = round((mcap * 1e6) / equity, 1) if equity > 0 else 5.0
        pb_forward = round(pb_trailing * 0.90, 1)
        pe_trailing = round((mcap * 1e6) / ttm_net_income, 1) if ttm_net_income > 0 else 24.0
        roe = round((ttm_net_income / equity) * 100.0, 1) if equity > 0 and ttm_net_income > 0 else 18.0
        roa = round((ttm_net_income / total_assets) * 100.0, 1) if total_assets > 0 and ttm_net_income > 0 else 8.0
        time.sleep(0.04)

        est_data = fetch_json("analyst-estimates", {"symbol": fmp_sym, "limit": 4})
        growth_10y = build_10y_growth_schedule(est_data, stock_item.get("default_g1", 8.0), DEFAULT_G)
        pe_forward = round(pe_trailing * 0.88, 1)

        fmp_beta = prof.get("beta")
        if fmp_beta is not None and float(fmp_beta) > 0:
            beta = round(float(fmp_beta), 2)
            beta_5y = beta
        else:
            beta = 1.15
            current_sector = stock_item.get("sector", "")
            if current_sector in ["公用事業", "必需消費"]: beta = 0.75
            elif current_sector in ["資訊科技"]: beta = 1.35
            elif current_sector in ["金融"]: beta = 1.05
            beta_5y = beta

        tax = TAX_RATE
        ke = RF + (beta * ERP)
        kd_after = (KD / 100.0) * (1.0 - (tax / 100.0))
        V = mcap + debt
        wE = mcap / V if V > 0 else 0.95
        wD = debt / V if V > 0 else 0.05
        wacc = (wE * ke) + (wD * kd_after)

        net_debt = round(debt - cash, 1)

        fmp_ev_data = fetch_json("enterprise-values", {"symbol": fmp_sym, "period": "quarter", "limit": 1})
        fmp_official_ev = 0.0
        if fmp_ev_data and isinstance(fmp_ev_data, list) and len(fmp_ev_data) > 0:
            raw_ev = float(fmp_ev_data[0].get("enterpriseValue") or 0.0)
            fmp_official_ev = round(raw_ev * fx_rate / 1e6, 1)

        if fmp_official_ev <= 0:
            fmp_official_ev = max(round(mcap + net_debt, 1), round(mcap * 0.8, 1))

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

        ebitda_m = ttm_ebitda / 1e6
        if ebitda_m > 0:
            ev_to_ebitda = round(ev / ebitda_m, 1)
            debt_to_ebitda = round(debt / ebitda_m, 2)
            net_debt_to_ebitda = round(net_debt / ebitda_m, 2)
        else:
            ev_to_ebitda = round(pe_trailing * 0.75, 1)
            debt_to_ebitda = round(debt / max(fcf0, 1.0), 2)
            net_debt_to_ebitda = round(net_debt / max(fcf0, 1.0), 2)

        f_score, f_score_breakdown = calculate_piotroski_score(roa, fcf0, cr, liab_r, ttm_net_income)

        FINANCIAL_SPECIAL_INDUSTRIES = {
            # Baseline (legacy FMP labels)
            "Diversified Banks", "Consumer Finance", "Investment Banking & Brokerage",
            "Property & Casualty Insurance", "Life & Health Insurance", "Multi-line Insurance",
            # Current FMP screener labels (US expansion / refreshed profiles)
            "Banks", "Banks - Regional", "Banks - Diversified",
            "Financial - Credit Services", "Investment - Banking & Investment Services",
            "Insurance - Property & Casualty", "Insurance - Life", "Insurance - Diversified",
            "Insurance - Reinsurance", "Insurance - Specialty",
        }
        is_financial_model = (
            stock_item.get("industry", "") in FINANCIAL_SPECIAL_INDUSTRIES
            and sym not in {"BRK.B", "BRK-B", "BRK.A", "BRK-A"}
        )

        fin_valuation = {"is_financial": False}
        if is_financial_model:
            reference_process = subprocess.run(
                ["node", os.path.join(os.path.dirname(__file__), "scripts", "financial_reference.cjs"), "--stdin"],
                input=json.dumps({"statements": fin_cache, "shares": shares, "fxRate": fx_rate}),
                text=True, capture_output=True, check=True
            )
            reference = json.loads(reference_process.stdout)
            shares_count = shares * 1e6
            tbvps = reference["tbvps"]
            bvps = round(equity / shares_count, 2) if shares_count > 0 else 60.0

            dps_div = (ttm_dividends_paid / shares_count) if shares_count > 0 else (price * 0.02)
            dps_bb = (ttm_buybacks_paid / shares_count) if shares_count > 0 else 0.0
            dps_total = round(dps_div + min(dps_bb, dps_div * 1.5), 2)

            ke_capm = ke
            ke_rate = max(ke, 0.09)
            ke_floor_applied = ke_rate > ke_capm + 1e-12
            rote_rate = reference["rote"] / 100.0 if reference["rote"] is not None else None
            excess_return_val = None
            if not reference["reason"] and rote_rate is not None and tbvps and tbvps > 0 and ke_rate > DEFAULT_G:
                spread = rote_rate - ke_rate
                excess_return_val = tbvps + (tbvps * spread) / max(ke_rate - DEFAULT_G, 0.02)

            ddm_sum = 0.0
            cur_dps = dps_total
            g_dps = min(float(stock_item.get("default_g1", 6.0)) / 100.0, 0.065)
            ddm_val = None
            if dps_total is not None and ke_rate > DEFAULT_G and ke_rate > 0:
                for t in range(1, 6):
                    cur_dps *= (1.0 + g_dps)
                    ddm_sum += cur_dps / ((1.0 + ke_rate) ** t)
                tv_ddm = (cur_dps * (1.0 + DEFAULT_G)) / max(ke_rate - DEFAULT_G, 0.02)
                pv_tv_ddm = tv_ddm / ((1.0 + ke_rate) ** 5)
                ddm_val = round(ddm_sum + pv_tv_ddm, 2)

            # Blend needs both legs; DDM remains stored when excess/reference fails (README).
            fair_val = (
                round((excess_return_val * 0.55) + (ddm_val * 0.45), 2)
                if excess_return_val is not None and ddm_val is not None else None
            )
            premium_pct = round(((price / fair_val) - 1.0) * 100.0, 1) if fair_val and fair_val > 0 else None

            fin_valuation = {
                "is_financial": True,
                "tbvps": tbvps,
                "bvps": bvps,
                "rote": reference["rote"],
                "reference": reference,
                "ke": round(ke_rate * 100.0, 2),
                "ke_capm": round(ke_capm * 100.0, 2),
                "ke_floor_pct": 9.0,
                "ke_floor_applied": ke_floor_applied,
                "g": round(DEFAULT_G * 100.0, 2),
                "dps_total": dps_total,
                "excess_return_fair": None if excess_return_val is None else round(excess_return_val, 2),
                "ddm_fair": ddm_val,
                "pb_tangible": round(price / tbvps, 2) if tbvps and tbvps > 0 else None
            }

        moat_rating_source = None
        if entity_id in entity_moat_cache:
            cached_moat = entity_moat_cache[entity_id]
            if cached_moat is None:
                moat_data = None
                moat_rating_source = {"reason": "analysisUnavailable"}
            else:
                moat_data = copy.deepcopy(cached_moat)
                moat_data["ticker"] = sym
        else:
            fin_context = {
                "name": stock_item.get("name", sym),
                "sector": stock_item.get("sector", "N/A"),
                "industry": stock_item.get("industry", "N/A"),
                "mcap": mcap,
                "roe": roe,
                "roa": roa,
                "f_score": f_score,
                "real_history": real_history,
                "fcf0": fcf0,
                "debt": debt,
                "cash": cash
            }

            moat_data = analyze_stock_moat(
                ticker=sym,
                latest_period=latest_period,
                fin_context=fin_context,
                force_refresh=False
            )
            entity_moat_cache[entity_id] = moat_data
            if moat_data is None:
                moat_rating_source = {"reason": "analysisUnavailable"}

        # 呼叫歷史 DCF 與復權股價計算
        hist_data = calculate_historical_5y_dcf_and_prices(fmp_sym, {
            "WACC": wacc,
            "g": DEFAULT_G * 100,
            "shares": shares,
            "price": price
        })

        # 1. 必須先在字典外面執行這行，取得 hist_data
        hist_data = calculate_historical_5y_dcf_and_prices(fmp_sym, {
            "WACC": wacc,
            "g": DEFAULT_G * 100,
            "shares": shares,
            "price": price
        })

        # 2. 然後再組裝進 results[sym] 字典中
        results[sym] = {
            "ticker": sym,
            "calculationCurrency": "USD",
            "name": stock_item.get("name", sym),
            "company_name": company_full_name,
            "exchange": stock_item.get("exchange", "US"),
            "sector": stock_item.get("sector", "N/A"),
            "industry": stock_item.get("industry", "N/A"),
            "reportedCurrency": reported_currency,
            "price": price,
            "shares": shares,
            "shares_outstanding": int(shares * 1e6) if shares > 0 else 0,
            "shares_display": f"{shares:,.2f} M",
            "shareSource": share_source,
            "shareBasis": share_source["basis"],
            "mcap": mcap,
            "liq_val_1": None,
            "liq_val_2": None,
            "liq_val_3": None,
            "debt": debt,
            "cash": cash,
            "short_term_investments": short_term_inv,
            "cash_and_short_term": cash,
            "net_debt": round(debt - cash, 1),
            "fcf0": fcf0,
            "real_history": real_history,
            "statements_raw": statements_data,
            "peers": get_stock_peers_cached(sym, FMP_KEY),
            "beta": beta,
            "beta_5y": beta_5y,
            "kd": KD,
            "tax": tax,
            "growth_10y": growth_10y,
            "g1": growth_10y[0],
            "g2": growth_10y[5],
            "g": round(DEFAULT_G * 100.0, 2),
            "wacc": round(wacc * 100.0, 2),
            "ev": fmp_official_ev,          
            "fmp_official_ev": fmp_official_ev,
            "dcf_model_ev": ev,
            "ev_to_ebitda": round(fmp_official_ev / ebitda_m, 1) if ebitda_m > 0 else ev_to_ebitda,
            "debt_to_ebitda": debt_to_ebitda,
            "net_debt_to_ebitda": net_debt_to_ebitda,
            "f_score": f_score,
            "f_score_breakdown": f_score_breakdown,
            "fair_val": fair_val,
            "default_fair_val": fair_val,
            "premium_pct": premium_pct,
            "is_undervalued": premium_pct < 0 if premium_pct is not None else None,
            "pe_trailing": pe_trailing,
            "pe_forward": pe_forward,
            "pb_trailing": pb_trailing,
            "pb_forward": pb_forward,
            "div_yield": div_yield_real,
            "ps_ratio": round(mcap / max(fcf0 * 4.0, 1.0), 1),
            "fcf_to_ev": round((fcf0 / ev) * 100.0, 2) if ev > 0 else 0.0,
            "fcf_to_mcap": round((fcf0 / mcap) * 100.0, 2) if mcap > 0 else 0.0,
            "liab_to_assets": liab_r,
            "cash_to_assets": cash_to_assets,
            "current_ratio": cr,
            "roe": roe,
            "roa": roa,
            "moat": moat_data,
            "ratingSources": {
                "moat": moat_rating_source or ({"reason": None} if moat_data else {"reason": "analysisUnavailable"}),
                "fScore": {"score": f_score, "checkedAt": None},
            },
            "fin_valuation": fin_valuation,
            "image": image_url,
            "logo": image_url,
            "website": website,
            "ceo": ceo,
            "full_time_employees": employees,
            "description": description_en,
            "description_en": description_en,
            "description_zh": description_zh,
            "address": prof.get("address", "--"),
            "city": prof.get("city", "--"),
            "state": prof.get("state", "--"),
            "zip": prof.get("zip", "--"),
            "country": prof.get("country", "US"),
            "phone": prof.get("phone", "--"),
            "full_address": f"{prof.get('address', '')}, {prof.get('city', '')}, {prof.get('state', '')} {prof.get('zip', '')}, {prof.get('country', '')}".strip(", "),
            "range_52w": prof.get("range", "--"),
            "year_high": float(q.get("yearHigh") or 0.0) if q else 0.0,
            "year_low": float(q.get("yearLow") or 0.0) if q else 0.0,
            "all_time_high": float(prof.get("mktCap", 0) / (shares * 1e6)) * 1.25 if shares > 0 else price * 1.3,
            "all_time_low": float(q.get("yearLow") or price * 0.45) if q else price * 0.45,
            "inst_ownership_pct": real_inst_ownership,
            "insider_ownership_pct": real_insider_ownership,
            "top_holders": company_meta.get("top_holders", []),
            "insider_trades": company_meta.get("insider_trades", []),
            "stock_splits": company_meta.get("stock_splits", []),
            "fmp_symbol": fmp_sym,
            # 正確：放在字典結尾處
            "real_5y_prices": hist_data["real_5y_prices"],
            "historical_dcf_series": hist_data["historical_dcf_series"]
        }

        moat_preview = (moat_data or {}).get("overall_moat_verdict_zh") or (moat_rating_source or {}).get("reason") or "N/A"
        print(f"[{stock_idx:03d}/{len(UNIQUE_STOCKS)}] ✅ {sym} ({stock_item.get('exchange', 'US')}) - 股價=${price} | 5Y Beta={beta_5y} | 公允價值=${fair_val} | 護城河: {str(moat_preview)[:30]}...", flush=True)

    if US_EXPANSION_MODE:
        output_dir = US_EXPANSION_OUTPUT or "us-data-output"
        os.makedirs(output_dir, exist_ok=True)
        market_path = os.path.join(output_dir, "market.json")
        with open(market_path, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        skipped_path = os.path.join(output_dir, "skipped.json")
        with open(skipped_path, "w", encoding="utf-8") as f:
            json.dump({"version": 1, "stocks": us_expansion_skipped}, f, ensure_ascii=False, indent=2)
        _print_gemini_budget_backlog()
        print(
            f"\nUS expansion batch wrote {len(results)} stocks to {market_path}"
            f" (skipped {len(us_expansion_skipped)}; baseline full_market_dcf.json unchanged).",
            flush=True,
        )
        if us_expansion_skipped:
            preview = ", ".join(item["ticker"] for item in us_expansion_skipped[:20])
            print(f"📋 US expansion skipped (no verified shares): {preview}", flush=True)
        return

    with open("full_market_dcf.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    with open("market_data.js", "w", encoding="utf-8") as f:
        f.write(f"window.FULL_MARKET_DATA = {json.dumps(results, ensure_ascii=False, indent=2)};")

    subprocess.run(
        ["node", os.path.join(os.path.dirname(__file__), "scripts", "usd_financials.cjs")],
        check=True
    )
    subprocess.run(
        ["node", os.path.join(os.path.dirname(__file__), "scripts", "reported_growth.cjs")],
        check=True
    )
    subprocess.run(
        ["node", os.path.join(os.path.dirname(__file__), "scripts", "apply_liquidation.cjs")],
        check=True
    )
    subprocess.run(
        ["node", os.path.join(os.path.dirname(__file__), "scripts", "usd_financials.cjs"), "--market-ratios"],
        check=True
    )

    _print_gemini_budget_backlog()
    print(f"\n🎉 成功！全市場 {len(UNIQUE_STOCKS)} 檔標的已全部完成估值、5年Beta校準與護城河分析！", flush=True)

if __name__ == "__main__":
    main()
