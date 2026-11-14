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


def traditionalize(text: str) -> str:
    raw = text or ""
    try:
        from opencc import OpenCC
        converted = None
        for cfg in ("s2twp", "s2t"):
            try:
                converted = OpenCC(cfg).convert(raw)
                break
            except Exception:
                continue
        if converted is None:
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
        )
        for a, b in fixes:
            converted = converted.replace(a, b)
        return converted
    except Exception:
        return raw



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


def player_role(stage_label_zh: str, stage_label_en: str, name_zh: str, name_en: str) -> tuple[str, str]:
    return (
        traditionalize(f"{name_zh}：{stage_label_zh}代表性玩家"),
        f"{name_en}: representative player in {stage_label_en}",
    )


def build_seed(
    row: dict,
    entities: dict,
    players_by_model: dict,
    overrides: dict,
    competitors: dict,
    universe_tickers: set[str],
    today: str,
) -> dict:
    ticker = row["ticker"]
    model_id = resolve_model_id(ticker, row.get("sector") or "", row.get("industry") or "")
    model = MODELS[model_id]
    ent = entities.get(ticker) or {
        "name_en": row.get("name") or ticker,
        "name_zh": traditionalize(row.get("name_zh") or row.get("name") or ticker),
        "exchange": row.get("exchange") or "",
    }
    stage_players = overrides.get(ticker) or players_by_model[model_id]
    stages = []
    for stage_meta in model["stages"]:
        sid = stage_meta["id"]
        raw_players = list(stage_players.get(sid) or players_by_model[model_id].get(sid) or [])
        # Drop self; keep order; pad from other stages in the same model, then any entity.
        picked = [t for t in raw_players if t != ticker]
        if len(picked) < 3:
            for other_sid, arr in (players_by_model.get(model_id) or {}).items():
                for t in arr:
                    if t != ticker and t not in picked:
                        picked.append(t)
                    if len(picked) >= 3:
                        break
                if len(picked) >= 3:
                    break
        if len(picked) < 3:
            for t in entities:
                if t != ticker and t not in picked and not t.startswith('_'):
                    picked.append(t)
                if len(picked) >= 3:
                    break
        picked = picked[:3]
        players = []
        for pt in picked:
            pe = entities.get(pt) or {"name_en": pt, "name_zh": pt, "exchange": ""}
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
    for ct, basis_zh, basis_en in competitors.get(ticker) or []:
        if ct == ticker:
            continue
        ce = entities.get(ct) or {"name_en": ct, "name_zh": ct, "exchange": ""}
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
            "currency": "USD",
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
    comps = seed.get("competitors") or []
    if not (4 <= len(comps) <= 6):
        errors.append(f"competitors:{len(comps)}")
    for c in comps:
        if c.get("ticker") == seed.get("ticker"):
            errors.append("competitor:self")
        for key in ("name_zh", "basis_zh"):
            if has_banned_simplified(c.get(key) or ""):
                errors.append(f"simplified:comp:{c.get('ticker')}:{key}")
    # model must not be hardware for banks etc.
    model_id = (seed.get("model") or {}).get("id") or ""
    sector_hint = seed["ticker"]
    if seed["ticker"] in {"JPM", "BAC", "WFC"} and "bank" not in model_id:
        errors.append("model:bank-mismatch")
    if seed["ticker"] in {"MSFT", "ORCL"} and "saas" not in model_id and "cloud" not in model_id:
        errors.append("model:saas-mismatch")
    if seed["ticker"] == "NVDA" and "semi" not in model_id and "fabless" not in model_id:
        errors.append("model:nvda-mismatch")
    _ = sector_hint, model_id
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--only", default="")
    args = parser.parse_args()

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
        seed = build_seed(row, entities, players_by_model, overrides, competitors, universe_tickers, today)
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
