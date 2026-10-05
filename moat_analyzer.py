"""
moat_analyzer.py
職責：負責呼叫 Gemini API 分析股票的巴菲特 10 大護城河（M1 至 M10），
      每項給予 0-10 分與 200 字內深入點評，並依最新財報季進行本地快取。
"""

import os
import json
import time
from typing import Dict, Any, Optional
from google import genai
from google.genai import types
from pydantic import BaseModel, Field

# 初始化 Gemini Client
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
client = genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None

CACHE_DIR = "cache/moat"
os.makedirs(CACHE_DIR, exist_ok=True)

class MoatDimension(BaseModel):
    score: int = Field(..., ge=0, le=10, description="0到10整數打分")
    comment: str = Field(..., description="200字以內深度評語，包含量化指標、核心優勢或結構性劣勢")

class StockMoatReport(BaseModel):
    ticker: str
    period: str = Field(..., description="財報基準季，例如 2024Q3")
    m1_brand_pricing: MoatDimension = Field(..., description="M1 品牌定價權 (無形資產)")
    m2_patents_regulatory: MoatDimension = Field(..., description="M2 專利與法規/特許准入壁壘")
    m3_high_switching_costs: MoatDimension = Field(..., description="M3 客戶轉換成本")
    m4_network_effects: MoatDimension = Field(..., description="M4 雙向/單向網絡效應")
    m5_cost_advantage_scale: MoatDimension = Field(..., description="M5 規模經濟與單位成本優勢")
    m6_unique_geography_assets: MoatDimension = Field(..., description="M6 獨佔性地理區位或核心自然資源/戰略資產")
    m7_operational_efficiency: MoatDimension = Field(..., description="M7 營運效率與獨特文化")
    m8_capital_allocation: MoatDimension = Field(..., description="M8 管理層資本配置能力 (ROIC vs WACC, 股票回購/配息/再投資)")
    m9_customer_retention: MoatDimension = Field(..., description="M9 顧客黏著度、續約率與淨留存率")
    m10_durability: MoatDimension = Field(..., description="M10 商業模式抗破壞性創新能力與長期耐久性")
    overall_moat_verdict: str = Field(..., description="200字以內的巴菲特護城河綜合評斷與核心競爭壁壘總結")

def get_or_analyze_moat(
    ticker: str,
    latest_period: str,
    financial_context: Dict[str, Any],
    force_refresh: bool = False
) -> Dict[str, Any]:
    """
    依據 ticker 與財報季度檢查快取。
    若快取不存在或強制更新，則調用 Gemini API 進行評分與短評。
    """
    safe_period = str(latest_period).replace("/", "_").strip() if latest_period else "LATEST"
    cache_file = os.path.join(CACHE_DIR, f"{ticker}_{safe_period}.json")

    # 1. 命中季度快取：直接讀取，完全不消耗 API Token
    if not force_refresh and os.path.exists(cache_file):
        try:
            with open(cache_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"[{ticker}] 快取讀取異常，將重新調用 API: {e}")

    # 2. 缺少 API Key 的降級處理
    if not client:
        print(f"[{ticker}] 未偵測到 GEMINI_API_KEY，返回預設資料。")
        return _fallback_moat(ticker, safe_period)

    # 3. 構建 Prompt（限制每項 200 字以內）
    prompt = f"""
    請針對美股上市公司 【{ticker}】 進行巴菲特 10 大經濟護城河（M1 至 M10）深度評估與評分。
    當前分析基準季度：{safe_period}

    【公司基本面與財務參考數據】
    - 所屬產業 (Sector/Industry): {financial_context.get('industry', 'N/A')}
    - 近 3 年毛利率 (Gross Margin) 表現: {financial_context.get('gross_margin_trend', 'N/A')}
    - ROIC / ROE 表現: {financial_context.get('roic_roe', 'N/A')}
    - 皮氏 F-Score (9分制): {financial_context.get('f_score', 'N/A')} / 9
    - 自由現金流 (FCF) 現狀: {financial_context.get('fcf_trend', 'N/A')}
    - 營收或業務核心描述: {financial_context.get('business_summary', '全球領導地位或具備特定競爭力之企業')}

    【評估規則與要求】
    1. 評分標準：0 到 10 分整數（0-3分：極弱或無護城河；4-6分：中等壁壘；7-8分：堅固護城河；9-10分：全球罕見定價權或壟斷級壁壘）。
    2. 點評要求：每條護城河的 comment 以及 overall_moat_verdict 必須深入透徹，字數控制在 **200 字以內**。必須點出具體商業模式邏輯、競爭對手差異或財務數字佐證。
    3. 嚴格輸出符合指定 JSON Schema 的結構。
    """

    # 4. 指數退避重試（避免 200 檔快速呼叫觸發 Rate Limit）
    max_retries = 3
    for attempt in range(max_retries):
        try:
            response = client.models.generate_content(
                model="gemini-2.5-flash",
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=StockMoatReport,
                    temperature=0.2, # 保持穩定且理性的客觀評分
                ),
            )
            data = json.loads(response.text)

            # 寫入季度本地快取
            with open(cache_file, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)

            return data

        except Exception as err:
            wait_time = (2 ** attempt) * 3
            print(f"[{ticker}] Gemini API 請求失敗 (第 {attempt+1} 次): {err}. 等待 {wait_time} 秒後重試...")
            time.sleep(wait_time)

    # 重試耗盡後降級返回
    return _fallback_moat(ticker, safe_period)

def _fallback_moat(ticker: str, period: str) -> Dict[str, Any]:
    default_item = {"score": 5, "comment": "待分析：API 額度暫時受限或缺少即時數據，維持中性預設。"}
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
        "overall_moat_verdict": "暫未取得 Gemini 深度護城河分析結果。"
    }
