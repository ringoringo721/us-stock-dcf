#!/usr/bin/env python3
"""Build curated supply-chain seeds for US listings with marketCap ≥ $100B.

Gemini drafts were preferred but unavailable (AI Studio credits depleted);
this builder uses industry value-chain templates + curated competitor sets.
Marks source.type = curated after automated schema/繁中 gates.
Does not overwrite AAPL.json (already curated on main).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.supply_chain.models import MODELS, resolve_model_id  # noqa: E402

CACHE_DIR = ROOT / "cache" / "supply-chain"
UNIVERSE_PATH = ROOT / "cache" / "us_universe.json"
CHARTS_DIR = ROOT / "cache" / "price_charts"
TMP_ENT = ROOT / "scripts" / "supply_chain" / "data" / "sc_entities.json"
TMP_PLAYERS = ROOT / "scripts" / "supply_chain" / "data" / "sc_players.json"
TMP_OVERRIDES = ROOT / "scripts" / "supply_chain" / "data" / "sc_player_overrides.json"
TMP_COMPS = ROOT / "scripts" / "supply_chain" / "data" / "sc_competitors.json"

OFF_EXCHANGE_SUFFIX = re.compile(r"\.(TW|SZ|SS|KS|HK|T|PA|SW|AS|IL|L)$", re.I)


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


_OPENCC = None
_OPENCC_FAILED = False


def _get_opencc():
    """Cache OpenCC converter — constructing per call is ~1s and dominates seed builds."""
    global _OPENCC, _OPENCC_FAILED
    if _OPENCC_FAILED:
        return None
    if _OPENCC is not None:
        return _OPENCC
    try:
        from opencc import OpenCC
        for cfg in ("s2twp", "s2t"):
            try:
                _OPENCC = OpenCC(cfg)
                return _OPENCC
            except Exception:
                continue
    except Exception:
        pass
    _OPENCC_FAILED = True
    return None


def traditionalize(text: str) -> str:
    raw = text or ""
    cc = _get_opencc()
    if cc is None:
        return raw
    try:
        converted = cc.convert(raw)
    except Exception:
        return raw
    # Prefer common TW/HK finance forms over OpenCC over-conversions.
    fixes = (
        ("上遊", "上游"),
        ("中遊", "中游"),
        ("下遊", "下游"),
        ("平臺", "平台"),
        ("社羣", "社群"),
        ("臨牀", "臨床"),
        ("僱主", "雇主"),
        # OpenCC s2twp over-conversions common in our stage/brand copy
        ("引數", "參數"),
        ("壓縮裝置", "壓縮設備"),
        ("施作裝置", "施作設備"),
        ("工程裝置", "工程設備"),
        ("礦山／工程裝置", "礦山／工程設備"),
        ("包裝／施作裝置", "包裝／施作設備"),
        ("製程／壓縮裝置", "製程／壓縮設備"),
        # OpenCC s2twp maps 万象→永珍 (Vientiane); keep CR Mixc brand 萬象
        ("華潤永珍生活", "華潤萬象生活"),
        ("永珍生活", "萬象生活"),
    )
    for a, b in fixes:
        converted = converted.replace(a, b)
    return converted



# Strict Mainland-simplified forms that should not appear in 繁中 site copy.
# Do NOT use full OpenCC STCharacters left column — it false-flags shared forms like 游/台/松.
STRICT_SIMPLIFIED = set(
    "国东发会门车马达气汇广汉后获几夹将奖讲仅进举壳亏阔来丽历两灵卢虏仑罗码卖迈难签乔窃亲庆确让扰热认洒扫杀晒伤摄绳圣时寿术树帅双苏虽随孙损缩态坛叹体条听厅图团湾网卫稳务雾习虾吓显宪县响晓协兴须悬选寻训讯压亚验杨阳养样钥页业叶医异义亿忆阴银饮樱应优犹诱余鱼娱语狱誉预渊园员缘远愿约跃运杂灾载债战张涨账这针阵征郑证织质钟肿种众"
)

def has_banned_simplified(text: str) -> bool:
    return any(ch in STRICT_SIMPLIFIED for ch in text or "")

def listed_in_app(ticker: str, universe_tickers: set[str]) -> bool:
    if ticker in universe_tickers:
        return True
    if OFF_EXCHANGE_SUFFIX.search(ticker):
        return False
    return ticker in universe_tickers


LEGAL_EN_NAME_RE = re.compile(
    r"\b(Inc\.?|Corp\.?|Corporation|Compan(?:y|ies)|Enterprises?|Financial|"
    r"Ltd\.?|Limited|Holdings?|Holding|PLC|N\.?V\.?|Group|Co\.?)\b",
    re.I,
)
# Suffixes safe to strip for short brands. Keep N.V. / S.A. / p.l.c. intact —
# stripping N.V. via a trailing `\b` often leaves an orphan "." ("ASML Holding .").
LEGAL_EN_SUFFIX_STRIP_RE = re.compile(
    # Common legal tokens (Inc/Corp/Company/…). Never mid-name brand "Enterprise"
    # (Enterprise Products / Enterprise Holdings). Holdings/Group only trailing.
    # Trailing Enterprises (plural) / Corporation / Financial via TRAILING_LEGAL_SUFFIX_RE.
    r"\b(Inc\.?|Incorporated|Corp\.?|Compan(?:y|ies)|Ltd\.?|Limited|PLC)\b"
    r"|\b(?:Holdings|Group)\b(?=\s*$|\s+(?:Inc\.?|Incorporated|Corp\.?|Corporation|"
    r"Compan(?:y|ies)|Ltd\.?|Limited)\b)",
    re.I,
)
# Trailing-only after Inc/share-class cleanup. Plural Enterprises only — never bare
# "Enterprise" brand (Enterprise Products / Enterprise Holdings).
TRAILING_LEGAL_SUFFIX_RE = re.compile(
    r"\b(Corporation|Enterprises|Financial)\s*$",
    re.I,
)
# Known wrong / legal-dump name_zh corrections (ticker → curated 繁中 or brand).
NAME_ZH_FIXES = {
    "IBM": "IBM",  # Latin brand; never “International Business Machines”
    "TDG": "環球透博",  # TransDigm — not Trimble 天寶集團
    "EQIX": "Equinix",  # Latin brand — never IQVIA 艾昆緯 / Cadence-ish 易華電腦
    "IQV": "艾昆緯",  # IQVIA
    "CDNS": "益華電腦",
    "BHP": "必和必拓",
    "BN": "Brookfield",
    "SE": "Sea",
    "TTD": "Trade Desk",
    "FND": "Floor & Decor",
    "TROW": "T. Rowe Price",
    "CI": "信諾",
    "ANSS": "安西斯",
    "LIN": "林德集團",
    "FIS": "FIS",  # never “Fidelity National Info”
    "USFD": "US Foods",  # never “US Foods Holding”
    "LEVI": "Levi's",  # never “Levi Strauss & Co.”
    "NSIT": "Insight",  # never “Insight Enterprises”
    "COO": "庫博",  # The Cooper Companies — not CooperVision-only label
    "AFG": "美國金融集團",  # never truncated English adjective "American"
}


_COMMON_EN_ADJECTIVES = {
    "american", "national", "general", "united", "global", "international",
    "first", "federal", "northern", "southern", "eastern", "western",
    "pacific", "atlantic", "central", "universal", "standard", "premier",
}


def looks_like_incomplete_en_label(text: str) -> bool:
    """True when name_zh is a lone English adjective / truncated legal headword."""
    raw = (text or "").strip()
    if not raw or re.search(r"[\u4e00-\u9fff]", raw):
        return False
    words = [w for w in re.split(r"[\s&]+", raw) if w]
    if len(words) == 1 and words[0].lower().rstrip(".,") in _COMMON_EN_ADJECTIVES:
        return True
    return False


def looks_like_english_legal_name(text: str) -> bool:
    """True when name_zh is an English legal/long dump rather than 繁中 or a short brand."""
    raw = (text or "").strip()
    if not raw:
        return False
    if re.search(r"[\u4e00-\u9fff]", raw):
        return False
    if LEGAL_EN_NAME_RE.search(raw):
        return True
    # Long multi-word English legal form (e.g. International Business Machines).
    # Keep short brands like "Floor & Decor" / "T. Rowe Price".
    words = [w for w in re.split(r"[\s&]+", raw) if w]
    if len(words) >= 4:
        return True
    return len(words) >= 3 and len(raw) >= 24


def short_brand_en(name_en: str, ticker: str) -> str:
    """Strip common legal suffixes for a short EN brand fallback.

    Keep ``N.V.`` / ``S.A.`` / ``U.S.`` / ``T.`` intact (not in the strip set).
    After removing Inc./Corp./etc., only collapse true orphans left by that
    removal — e.g. ``Foo Inc.`` → ``Foo`` (trailing comma/space), or a lone
    `` .`` token — never a global ``[.\\s]+`` / ``.\\s`` pass that would eat
    abbreviation periods when more text follows.
    """
    raw = (name_en or "").strip() or ticker
    # Hyphenated legal tails: "Associated Banc-Corp" → "Associated Bancorp"
    cleaned = re.sub(r"\b([Bb]anc)-Corp(?:oration)?\b", r"\1orp", raw)
    cleaned = re.sub(r"-\s*Corp(?:oration)?\.?\b", " ", cleaned, flags=re.I)
    cleaned = LEGAL_EN_SUFFIX_STRIP_RE.sub("", cleaned)

    # Share-class / listing / bond tails (CRWV Class A Common Stock, CHYM Ordinary Shares, ELC bonds).
    cleaned = re.sub(
        r",?\s*\b(?:Class\s+[A-Z0-9]+\s+)?(?:Common\s+Stock|Ordinary\s+Shares?|American\s+Depositary\s+Shares?|ADSs?|ADRs?)\b.*$",
        "",
        cleaned,
        flags=re.I,
    )
    cleaned = re.sub(
        r",?\s*\b(?:First\s+Mortgage\s+Bonds?|Senior\s+Notes?|Notes?|Bond\s+Units?|Preferred\s+Stock)\b.*$",
        "",
        cleaned,
        flags=re.I,
    )
    # Orphans only: whitespace + lone "." / "," at end or before more whitespace.
    # Do NOT strip "S.A. Foo" / "U.S. Something" / "T. Rowe".
    cleaned = re.sub(r"\s+[.,](?=\s|$)", "", cleaned)
    # Trailing connectors left after stripping "… & Company" / "… and Company".
    cleaned = re.sub(r"(?:\s+&|\s+and)\s*$", "", cleaned, flags=re.I)
    cleaned = re.sub(r"[,\s]+$", "", cleaned).strip()
    cleaned = re.sub(r"\s{2,}", " ", cleaned)
    cleaned = re.sub(r"-$", "", cleaned).strip()
    # Trailing Corporation / Enterprises / Financial only (never mid-name Enterprise brand).
    # Repeat: "Capital One Financial Corporation" → … Financial → Capital One.
    for _ in range(3):
        nxt = TRAILING_LEGAL_SUFFIX_RE.sub("", cleaned).strip()
        nxt = re.sub(r"[,\s]+$", "", nxt).strip()
        if nxt == cleaned:
            break
        cleaned = nxt
    # Drop leading "The " even on multi-word brands (The Procter & Gamble → Procter & Gamble).
    cleaned = re.sub(r"^The\s+", "", cleaned, flags=re.I).strip()
    return cleaned or ticker


def _assert_short_brand_en() -> None:
    """Tiny guard table — run from main(); fail build if helper regresses."""
    cases = (
        ("ASML Holding N.V.", "ASML", "ASML Holding N.V."),
        ("ASML Holding .", "ASML", "ASML Holding"),  # orphan after bad strip
        ("Apple Inc.", "AAPL", "Apple"),
        ("Foo S.A.", "FOO", "Foo S.A."),
        ("Spotify Technology S.A.", "SPOT", "Spotify Technology S.A."),
        ("U.S. Something Inc.", "USS", "U.S. Something"),
        ("T. Rowe Price", "TROW", "T. Rowe Price"),
        ("Banco Santander, S.A.", "SAN", "Banco Santander, S.A."),
        ("Deere & Company", "DE", "Deere"),
        ("The Southern Company", "SO", "Southern"),
        ("The Procter & Gamble Company", "PG", "Procter & Gamble"),
        ("The Walt Disney Company", "DIS", "Walt Disney"),
        ("Eli Lilly and Company", "LLY", "Eli Lilly"),
        ("Associated Banc-Corp", "ASB", "Associated Bancorp"),
        ("Mastercard Incorporated", "MA", "Mastercard"),
        ("UnitedHealth Group Incorporated", "UNH", "UnitedHealth"),
        ("Wells Fargo & Company", "WFC", "Wells Fargo"),
        ("CoreWeave, Inc. Class A Common Stock", "CRWV", "CoreWeave"),
        ("Chime Financial, Inc. Ordinary Shares", "CHYM", "Chime"),
        ("CDW Corporation", "CDW", "CDW"),
        ("Insight Enterprises, Inc.", "NSIT", "Insight"),
        ("Capital One Financial Corporation", "COF", "Capital One"),
        ("Entergy Louisiana, LLC First Mortgage Bonds", "ELC", "Entergy Louisiana, LLC"),
        ("The Cooper Companies, Inc.", "COO", "Cooper"),
        ("Reinsurance Group of America, Incorporated", "RGA", "Reinsurance Group of America"),
        ("Enterprise Products Partners L.P.", "EPD", "Enterprise Products Partners L.P."),
        ("Enterprise Holdings, Inc.", "EHI", "Enterprise Holdings"),
        ("Insight Enterprises, Inc.", "NSIT", "Insight"),
        ("American Financial Group, Inc.", "AFG", "American Financial Group"),
    )
    for raw, ticker, expect in cases:
        got = short_brand_en(raw, ticker)
        if got != expect:
            raise AssertionError(f"short_brand_en({raw!r}) -> {got!r}, want {expect!r}")


def player_role(stage_label_zh: str, stage_label_en: str, name_zh: str, name_en: str) -> tuple[str, str]:
    return (
        traditionalize(f"{name_zh}：{stage_label_zh}代表性玩家"),
        f"{name_en}: representative player in {stage_label_en}",
    )


def resolve_entity(ticker: str, entities: dict, universe_by_ticker: dict | None = None) -> dict:
    """Prefer curated entity metadata; fall back to universe row; never ship raw-ticker stubs.

    Latin brand labels where name_zh == ticker (e.g. IBM) are intentional — do NOT replace
    them with the English legal name from universe.
    """
    pe = entities.get(ticker) or {}
    uni = (universe_by_ticker or {}).get(ticker) or {}
    curated_en = (pe.get("name_en") or "").strip()
    exchange = pe.get("exchange") or uni.get("exchange") or ""

    # Curated name_en wins even when it equals the ticker (Latin brand: IBM, BBVA).
    if curated_en:
        name_en = curated_en
    else:
        name_en = uni.get("name") or uni.get("name_en") or ticker
        if looks_like_english_legal_name(name_en):
            name_en = short_brand_en(name_en, ticker)

    curated_zh = (pe.get("name_zh") or "").strip()
    uni_zh = (uni.get("name_zh") or "").strip()
    name_zh = curated_zh or uni_zh or ""

    # Explicit curated fixes win (wrong CJK collisions, legal dumps, etc.).
    if ticker in NAME_ZH_FIXES:
        name_zh = NAME_ZH_FIXES[ticker]
    elif not name_zh:
        # Prefer short brand / ticker over English legal dump as 繁中 label.
        name_zh = short_brand_en(name_en, ticker)
        if looks_like_english_legal_name(name_zh):
            name_zh = ticker
    elif looks_like_english_legal_name(name_zh) or looks_like_incomplete_en_label(name_zh):
        # Curated or universe wrongly stored English legal / truncated adjective as name_zh.
        name_zh = ticker if curated_zh in ("", ticker) or looks_like_english_legal_name(curated_zh) else curated_zh
        if looks_like_english_legal_name(name_zh):
            name_zh = short_brand_en(name_en, ticker)
            if looks_like_english_legal_name(name_zh):
                name_zh = ticker
    # name_zh == ticker (Latin brand) is kept as-is — never promote name_en into name_zh.

    return {"name_en": name_en, "name_zh": name_zh, "exchange": exchange}


# Stage-player ticker rewrites (must match catalog aliases). Never emit both SQ and XYZ.
STAGE_TICKER_ALIAS: dict[str, str] = {
    "SQ": "XYZ",
    "GPS": "GAP",
    "BK": "BNY",
    "MSC": "MSM",
    "MYL": "VTRS",
    "PEAK": "DOC",
    "MMC": "MRSH",
    "SJW": "HTO",
    "GOLD": "B",  # Barrick Gold → Barrick Mining
}
STAGE_TICKER_BANNED = {"SPCX", "MAXR", "FLY", "FLYX", "SQ", "PEAK", "MYL", "RDFN", "SJW", "GOLD", "BERY"}

# Same-issuer dual listings (TWSE/ADR etc.) — never stage+rival the same issuer.
DUAL_LIST_ISSUER: dict[str, str] = {
    "3711.TW": "ASE",
    "ASX": "ASE",
    "BEKE": "BEKE",
    "2423.HK": "BEKE",
    "GOLD": "B",
    "B": "B",
}

def issuer_key(t: str) -> str:
    t = (t or "").strip().upper()
    return DUAL_LIST_ISSUER.get(t, t)


def normalize_stage_ticker(t: str) -> str | None:
    t = (t or "").strip().upper()
    if not t:
        return None
    t = STAGE_TICKER_ALIAS.get(t, t)
    if t in STAGE_TICKER_BANNED:
        return None
    return t


def build_seed(
    row: dict,
    entities: dict,
    players_by_model: dict,
    overrides: dict,
    competitors: dict,
    universe_tickers: set[str],
    today: str,
    universe_by_ticker: dict | None = None,
) -> dict:
    ticker = row["ticker"]
    model_id = resolve_model_id(ticker, row.get("sector") or "", row.get("industry") or "")
    model = MODELS[model_id]
    ent = resolve_entity(ticker, entities, universe_by_ticker)
    curated = entities.get(ticker) or {}
    # Curated Latin brands intentionally use name_en == ticker (IBM, BBVA). Never overwrite
    # those from the universe legal name — that undoes resolve_entity and desyncs the hub
    # from player/competitor rows that keep the short brand.
    if curated.get("name_en"):
        ent["name_en"] = curated["name_en"]
    elif row.get("name") and (not ent.get("name_en") or ent["name_en"] == ticker):
        cand = row["name"]
        if looks_like_english_legal_name(cand):
            shortened = short_brand_en(cand, ticker)
            ent["name_en"] = ticker if looks_like_english_legal_name(shortened) else shortened
        else:
            ent["name_en"] = cand
    if row.get("name_zh"):
        zh = traditionalize(row["name_zh"])
        # Never let universe English legal overwrite a Latin brand or 繁中 label.
        if not looks_like_english_legal_name(zh):
            ent["name_zh"] = zh
    # Do NOT promote English legal row["name"] into name_zh when name_zh == ticker (Latin brand).
    if ticker in NAME_ZH_FIXES:
        ent["name_zh"] = NAME_ZH_FIXES[ticker]
    if looks_like_english_legal_name(ent.get("name_zh") or "") or looks_like_incomplete_en_label(ent.get("name_zh") or ""):
        ent["name_zh"] = NAME_ZH_FIXES.get(ticker) or ticker
    if row.get("exchange") and not ent.get("exchange"):
        ent["exchange"] = row["exchange"]
    # Rival tickers first; only dual-list issuer keys (ASE ASX↔3711.TW) block stage peers.
    # Do NOT drop ordinary rivals from stages globally (OFS hubs list SLB/HAL as both).
    rival_tickers: list[str] = []
    rival_dual_issuer_keys: set[str] = set()
    for ct, _bz, _be in competitors.get(ticker) or []:
        ct_n = normalize_stage_ticker(ct) or (ct or "").strip().upper()
        if not ct_n or ct_n == ticker or ct_n in STAGE_TICKER_BANNED:
            continue
        if ct_n in rival_tickers:
            continue
        rival_tickers.append(ct_n)
        if ct_n in DUAL_LIST_ISSUER:
            rival_dual_issuer_keys.add(issuer_key(ct_n))

    stage_players = overrides.get(ticker) or players_by_model[model_id]
    stages = []
    for stage_meta in model["stages"]:
        sid = stage_meta["id"]
        raw_players = list(stage_players.get(sid) or players_by_model[model_id].get(sid) or [])
        # Never list the hub as a player on its own stages (BCPC-on-ingredients Bugbot).
        # Do not adjacent-stage pad after hub drop — leave thin / use true same-stage peers.
        # Drop stage names that share an issuer with a rival (prefer rival ASX over partner 3711.TW).
        picked: list[str] = []
        seen_players: set[str] = {ticker}
        for t in raw_players:
            nt = normalize_stage_ticker(t)
            if not nt or nt in seen_players:
                continue
            # Only dual-list issuer keys (ASE ASX↔3711.TW) block stage peers.
            # Ordinary rivals (OFS SLB/HAL, payments, etc.) intentionally stay on stages.
            if nt in DUAL_LIST_ISSUER and issuer_key(nt) in rival_dual_issuer_keys:
                continue
            picked.append(nt)
            seen_players.add(nt)
        # Entity scrap only — never adjacent-stage bleed. Never invent hub onto a foreign stage.
        if len(picked) < 3:
            for t in entities:
                if t.startswith("_"):
                    continue
                nt = normalize_stage_ticker(t)
                if not nt or nt in seen_players or nt == ticker:
                    continue
                if nt in DUAL_LIST_ISSUER and issuer_key(nt) in rival_dual_issuer_keys:
                    continue
                picked.append(nt)
                seen_players.add(nt)
                if len(picked) >= 3:
                    break
        picked = picked[:3]
        players = []
        for pt in picked:
            pe = resolve_entity(pt, entities, universe_by_ticker)
            role_zh, role_en = player_role(
                stage_meta["label_zh"], stage_meta["label_en"], pe["name_zh"], pe["name_en"]
            )
            players.append(
                {
                    "ticker": pt,
                    "name_en": pe["name_en"],
                    "name_zh": traditionalize(pe["name_zh"]),
                    "role_zh": role_zh,
                    "role_en": role_en,
                    "exchange": pe.get("exchange") or "",
                    **(
                        {"listedInApp": False}
                        if not listed_in_app(pt, universe_tickers)
                        else {}
                    ),
                }
            )
        stages.append(
            {
                "id": sid,
                "order": stage_meta["order"],
                "label_zh": traditionalize(stage_meta["label_zh"]),
                "label_en": stage_meta["label_en"],
                "summary_zh": traditionalize(stage_meta["summary_zh"]),
                "summary_en": stage_meta["summary_en"],
                "players": players,
            }
        )

    comps = []
    seen_comp = {ticker}
    for ct, basis_zh, basis_en in competitors.get(ticker) or []:
        ct = normalize_stage_ticker(ct) or (ct or "").strip().upper()
        # Still drop banned even if alias missed; skip self / dupes.
        # Stage/rival overlap for ordinary peers is intentional (OFS SLB/HAL).
        # Only dual-list issuer keys are dropped from stages above.
        if not ct or ct == ticker or ct in seen_comp or ct in STAGE_TICKER_BANNED:
            continue
        seen_comp.add(ct)
        ce = resolve_entity(ct, entities, universe_by_ticker)
        comps.append(
            {
                "ticker": ct,
                "name_en": ce["name_en"],
                "name_zh": traditionalize(ce["name_zh"]),
                "basis_zh": traditionalize(basis_zh),
                "basis_en": basis_en,
                "exchange": ce.get("exchange") or "",
                **(
                    {"listedInApp": False}
                    if not listed_in_app(ct, universe_tickers)
                    else {}
                ),
            }
        )
        if len(comps) >= 6:
            break

    return {
        "version": 1,
        "ticker": ticker,
        "name_en": ent["name_en"],
        "name_zh": traditionalize(ent["name_zh"]),
        "updatedAt": today,
        "source": {
            "type": "curated",
            "basis": (
                "Industry value-chain template + curated product/market rivals for US mega-cap "
                "≥$100B expansion. Not a live supplier API dump. Gemini drafts were unavailable "
                "(billing); content is template-curated with automated schema/繁中 gates and "
                "spot review on NVDA/MSFT/JPM. Preview-before-merge."
            ),
            "notes_zh": traditionalize(
                "本頁為產業價值鏈模板＋人工策展競爭對手的種子資料（美股市值≥1,000億美元批次）。"
                "未呼叫即時供應商 API；FMP 同業名單不作價值鏈依據。角色與排序依公開產業結構整理，"
                "非完整供應商名單或採購份額。競爭對手採產品／市場真實對手原則（參考 AAPL 教訓："
                "不以跨業巨頭充當直接產品對手）。Gemini 草稿因帳單不可用，改走策展模板＋審核閘。"
            ),
            "notes_en": (
                "Industry value-chain template plus curated rivals for the US mcap≥$100B batch. "
                "No live supplier API. FMP peers are not used as the value chain. Roles/ranks follow "
                "a public industry structure — not a full BOM or spend share. Competitors follow "
                "true product/market rivalry (AAPL lesson). Gemini drafts unavailable due to billing; "
                "curated templates + review gates used instead."
            ),
            "competitorRationale_zh": traditionalize(
                "競爭弧只列與該公司主力產品／市場重疊的對手；供應鏈階段玩家與競爭對手分開。"
            ),
            "competitorRationale_en": (
                "Rival arc lists product/market overlaps only; stage players are separate from rivals."
            ),
            "modelId": model_id,
            "references": [
                f"Industry model `{model_id}`",
                "cache/us_universe.json marketCap ≥ USD 100B screen",
                "AAPL curated seed shape on main (schema reference)",
            ],
        },
        "model": {
            "id": model_id,
            "label_zh": traditionalize(model["label_zh"]),
            "label_en": model["label_en"],
            "description_zh": traditionalize(model["description_zh"]),
            "description_en": model["description_en"],
        },
        "stages": stages,
        "competitors": comps,
    }


def chart_change_and_close(ticker: str) -> tuple[float | None, float | None, float | None, str | None]:
    path = CHARTS_DIR / f"{ticker}.json"
    if not path.exists():
        # try alternate dash/dot
        alt = ticker.replace("-", ".")
        path = CHARTS_DIR / f"{alt}.json"
        if not path.exists():
            return None, None, None, None
    try:
        pack = load_json(path)
    except Exception:
        return None, None, None, None
    rows = pack.get("rows") or []
    if len(rows) < 2:
        return None, None, None, None
    # rows: [date, close, volume]
    last = rows[-1]
    prev = rows[-2]
    try:
        last_close = float(last[1])
        prev_close = float(prev[1])
        as_of = str(last[0])
    except Exception:
        return None, None, None, None
    if not prev_close:
        return last_close, prev_close, None, as_of
    change_pct = round((last_close / prev_close - 1.0) * 100.0, 3)
    return last_close, prev_close, change_pct, as_of


def build_quotes(seed: dict, mcap_millions: dict[str, float | None], today: str) -> dict:
    tickers = [seed["ticker"]]
    for stage in seed["stages"]:
        for p in stage["players"]:
            tickers.append(p["ticker"])
    for c in seed["competitors"]:
        tickers.append(c["ticker"])
    # unique preserve order
    seen = set()
    ordered = []
    for t in tickers:
        if t not in seen:
            seen.add(t)
            ordered.append(t)

    quotes = {}
    for t in ordered:
        price, prev, chg, as_of = chart_change_and_close(t)
        mcap = mcap_millions.get(t)
        quotes[t] = {
            "ticker": t,
            "price": price,
            "previousClose": prev,
            "changePct": chg,
            "mcap": mcap,
            "currency": "HKD" if str(t).endswith(".HK") else "USD",
            "asOf": as_of,
            "source": (
                "FMP historical-price-eod via cache/price_charts"
                if price is not None
                else None
            ),
        }
    return {
        "version": 1,
        "ticker": seed["ticker"],
        "updatedAt": today,
        "basis": "lastTradingDayCloseVsPriorClose",
        "notes_en": (
            "changePct from last two EOD closes in price_charts; mcap from US listings screener "
            "(USD millions). Missing tickers stay null. No live FMP per pageview."
        ),
        "notes_zh": traditionalize(
            "漲跌%取自 price_charts 最近兩日收盤；市值取自美股清單（百萬美元）。缺資料維持 null，不造假。頁面不打即時 FMP。"
        ),
        "quotes": quotes,
    }


def validate_seed(seed: dict) -> list[str]:
    errors = []
    if seed.get("version") != 1:
        errors.append("version")
    if not seed.get("ticker"):
        errors.append("ticker")
    if not seed.get("stages"):
        errors.append("stages")
    for stage in seed.get("stages") or []:
        if len(stage.get("players") or []) != 3:
            errors.append(f"stage:{stage.get('id')}:players!=3")
        for key in ("label_zh", "summary_zh"):
            text = stage.get(key) or ""
            if has_banned_simplified(text):
                errors.append(f"simplified:{stage.get('id')}:{key}")
        for p in stage.get("players") or []:
            for key in ("name_zh", "role_zh"):
                if has_banned_simplified(p.get(key) or ""):
                    errors.append(f"simplified:player:{p.get('ticker')}:{key}")
            if not p.get("ticker"):
                errors.append("player:missing-ticker")
            pt = p.get("ticker") or ""
            en = (p.get("name_en") or "").strip()
            zh = (p.get("name_zh") or "").strip()
            # Stub = missing labels. Latin brand (name_zh == ticker, e.g. IBM) is OK when
            # exchange is present; name_en may also equal ticker for brand tickers.
            if not en or not zh:
                errors.append(f"entity:player:{pt}:blank-name")
            elif en == pt and zh == pt and not (p.get("exchange") or "").strip():
                errors.append(f"entity:player:{pt}:blank-name")
            if not (p.get("exchange") or "").strip():
                errors.append(f"entity:player:{pt}:blank-exchange")
    comps = seed.get("competitors") or []
    # Specialty short lists (true lessors / airport ops / etc.) may be 1–3 peers.
    if not (1 <= len(comps) <= 6):
        errors.append(f"competitors:{len(comps)}")
    for c in comps:
        if c.get("ticker") == seed.get("ticker"):
            errors.append("competitor:self")
        for key in ("name_zh", "basis_zh"):
            if has_banned_simplified(c.get(key) or ""):
                errors.append(f"simplified:comp:{c.get('ticker')}:{key}")
        ct = c.get("ticker") or ""
        en = (c.get("name_en") or "").strip()
        zh = (c.get("name_zh") or "").strip()
        if not en or not zh:
            errors.append(f"entity:comp:{ct}:blank-name")
        elif en == ct and zh == ct and not (c.get("exchange") or "").strip():
            errors.append(f"entity:comp:{ct}:blank-name")
        if not (c.get("exchange") or "").strip():
            errors.append(f"entity:comp:{ct}:blank-exchange")
        # CI must keep 繁中; never ship English legal / wrong-collision names as name_zh.
        if ct == "CI" and not re.search(r"[\u4e00-\u9fff]", c.get("name_zh") or ""):
            errors.append("entity:comp:CI:name_zh-not-zh")
        if looks_like_english_legal_name(c.get("name_zh") or ""):
            errors.append(f"entity:comp:{ct}:name_zh-english-legal")
        if ct == "TDG" and "天寶" in (c.get("name_zh") or ""):
            errors.append("entity:comp:TDG:trimble-collision")
        if ct == "IBM" and looks_like_english_legal_name(c.get("name_zh") or ""):
            errors.append("entity:comp:IBM:name_zh-english-legal")
    # model must not be hardware for banks etc.
    model_id = (seed.get("model") or {}).get("id") or ""
    sector_hint = seed["ticker"]
    if seed["ticker"] in {"JPM", "BAC", "WFC"} and "bank" not in model_id:
        errors.append("model:bank-mismatch")
    if seed["ticker"] in {"MSFT", "ORCL"} and "saas" not in model_id and "cloud" not in model_id:
        errors.append("model:saas-mismatch")
    if seed["ticker"] == "NVDA" and "semi" not in model_id and "fabless" not in model_id:
        errors.append("model:nvda-mismatch")
    if looks_like_english_legal_name(seed.get("name_zh") or ""):
        errors.append("entity:center:name_zh-english-legal")

    def _mangled_en(text: str) -> bool:
        raw = (text or "").strip()
        if not raw:
            return False
        if raw.endswith("&") or re.search(r"\band$", raw, re.I):
            return True
        if re.match(r"^The\s+\S+$", raw, re.I):
            return True
        if re.search(r"\bIncorporated\b", raw, re.I):
            return True
        return False

    if _mangled_en(seed.get("name_en") or ""):
        errors.append("entity:center:name_en-mangled")
    for stage in seed.get("stages") or []:
        for p in stage.get("players") or []:
            pt = p.get("ticker") or ""
            if pt == "CI" and not re.search(r"[\u4e00-\u9fff]", p.get("name_zh") or ""):
                errors.append("entity:player:CI:name_zh-not-zh")
            if looks_like_english_legal_name(p.get("name_zh") or ""):
                errors.append(f"entity:player:{pt}:name_zh-english-legal")
            if _mangled_en(p.get("name_en") or ""):
                errors.append(f"entity:player:{pt}:name_en-mangled")
            if pt == "TDG" and "天寶" in (p.get("name_zh") or ""):
                errors.append("entity:player:TDG:trimble-collision")
            if pt == "IBM" and looks_like_english_legal_name(p.get("name_zh") or ""):
                errors.append("entity:player:IBM:name_zh-english-legal")
    for c in comps:
        ct = c.get("ticker") or ""
        if _mangled_en(c.get("name_en") or ""):
            errors.append(f"entity:comp:{ct}:name_en-mangled")
    _ = sector_hint, model_id
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--only", default="")
    args = parser.parse_args()

    _assert_short_brand_en()

    for path in (TMP_ENT, TMP_PLAYERS, TMP_OVERRIDES, TMP_COMPS):
        if not path.exists():
            raise SystemExit(f"Missing catalog {path}; regenerate via agent prep script.")

    entities = load_json(TMP_ENT)
    players_by_model = load_json(TMP_PLAYERS)
    overrides = load_json(TMP_OVERRIDES)
    competitors = load_json(TMP_COMPS)
    universe = load_json(UNIVERSE_PATH)
    stocks = universe["stocks"]
    mega = [r for r in stocks if float(r.get("marketCap") or 0) >= 100e9]
    mega.sort(key=lambda r: -float(r["marketCap"]))
    universe_tickers = {r["ticker"] for r in stocks}
    universe_by_ticker = {r["ticker"]: r for r in stocks}
    # mcap map in USD millions for any universe ticker
    mcap_millions = {r["ticker"]: round(float(r["marketCap"]) / 1e6, 1) for r in stocks if r.get("marketCap")}

    today = date.today().isoformat()
    only = {t.strip().upper() for t in args.only.split(",") if t.strip()}
    written = []
    failures = []

    targets = [r for r in mega if r["ticker"] != "AAPL"]
    if only:
        targets = [r for r in targets if r["ticker"] in only]
    if args.limit:
        targets = targets[: args.limit]

    for row in targets:
        seed = build_seed(row, entities, players_by_model, overrides, competitors, universe_tickers, today, universe_by_ticker)
        errs = validate_seed(seed)
        if errs:
            failures.append((row["ticker"], errs))
            continue
        quotes = build_quotes(seed, mcap_millions, today)
        if not args.dry_run:
            write_json(CACHE_DIR / f"{row['ticker']}.json", seed)
            write_json(CACHE_DIR / f"{row['ticker']}.quotes.json", quotes)
        written.append(row["ticker"])

    summary = {
        "megaTotal": len(mega),
        "excludedAAPL": True,
        "written": len(written),
        "failures": failures,
        "tickers": written,
        "dryRun": args.dry_run,
        "date": today,
    }
    out = ROOT / "cache" / "supply-chain" / "_mega_build_summary.json"
    if not args.dry_run:
        write_json(out, summary)
    print(json.dumps({k: summary[k] for k in ("megaTotal", "written", "failures", "dryRun")}, ensure_ascii=False))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
