"""Shared Buffett-v3 / Lite moat standard for US and HK.

Locked 2026-10-24:
- One assessment policy family for both markets
- Model: gemini-2.5-flash-lite
- Each M1–M10 comment_zh: 100–150 Traditional Chinese characters (字)
- comment_en: translation of the Chinese (length not the gate)
"""

from __future__ import annotations

import os
import re
from typing import Iterable, Mapping, MutableMapping, Optional

# Unified policy id (replaces us-buffett-moat-v3 and grounded/researched-v4–v6 for new remoats).
BUFFETT_MOAT_ASSESSMENT_POLICY = "buffett-moat-v3"
BUFFETT_MOAT_MODEL = "gemini-2.5-flash-lite"

# Hard acceptance band for Traditional Chinese dimension comments (Unicode code points after strip).
MIN_COMMENT_ZH_CHARS = 100
MAX_COMMENT_ZH_CHARS = 150

# Retry floor/ceiling slightly soft so 98–99 / 151–152 near-misses still get a useful correction message
# while the prompt still targets the locked 100–150 band.
RETRY_MIN_COMMENT_ZH_CHARS = 100
RETRY_MAX_COMMENT_ZH_CHARS = 150

DIMENSION_KEYS = (
    "m1_brand_pricing",
    "m2_patents_regulatory",
    "m3_high_switching_costs",
    "m4_network_effects",
    "m5_cost_advantage_scale",
    "m6_unique_geography_assets",
    "m7_operational_efficiency",
    "m8_capital_allocation",
    "m9_customer_retention",
    "m10_durability",
)

_CJK_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]")


def moat_model() -> str:
    return (os.environ.get("MOAT_MODEL") or os.environ.get("US_MOAT_MODEL") or BUFFETT_MOAT_MODEL).strip() or BUFFETT_MOAT_MODEL


def zh_char_count(text: str) -> int:
    """Primary length gate: stripped Unicode code-point count (繁中字 including punctuation)."""
    return len((text or "").strip())


def zh_cjk_count(text: str) -> int:
    """Secondary diagnostic: Han ideograph count only."""
    return len(_CJK_RE.findall(text or ""))


def zh_length_ok(text: str, minimum: int = MIN_COMMENT_ZH_CHARS, maximum: int = MAX_COMMENT_ZH_CHARS) -> bool:
    count = zh_char_count(text)
    return minimum <= count <= maximum


def validate_dimension_zh_lengths(
    report: Mapping,
    dimensions: Iterable[str] = DIMENSION_KEYS,
    *,
    minimum: int = RETRY_MIN_COMMENT_ZH_CHARS,
    maximum: int = RETRY_MAX_COMMENT_ZH_CHARS,
) -> None:
    """Raise ValueError if any M1–M10 comment_zh is outside the locked band.

    English is required to be present but is not length-gated (translation of ZH).
    """
    for name in dimensions:
        item = report.get(name) if isinstance(report, Mapping) else None
        if not isinstance(item, Mapping):
            raise ValueError(f"{name}: missing moat dimension for length check")
        zh = item.get("comment_zh")
        en = item.get("comment_en")
        if not isinstance(zh, str) or not zh.strip():
            raise ValueError(f"{name}.comment_zh: missing Traditional Chinese comment")
        if not isinstance(en, str) or not en.strip():
            raise ValueError(f"{name}.comment_en: missing English translation of the Chinese comment")
        count = zh_char_count(zh)
        if count < minimum or count > maximum:
            raise ValueError(
                f"{name}.comment_zh: length {count} outside locked {minimum}–{maximum} 繁中字 band "
                f"(English is a translation only; do not use EN word count as the gate; "
                f"rewrite Chinese to {minimum}–{maximum} characters then translate)"
            )


def dimension_zh_counts(report: Mapping, dimensions: Iterable[str] = DIMENSION_KEYS) -> dict:
    rows = {}
    for name in dimensions:
        item = report.get(name) if isinstance(report, Mapping) else None
        zh = (item or {}).get("comment_zh") if isinstance(item, Mapping) else None
        en = (item or {}).get("comment_en") if isinstance(item, Mapping) else None
        rows[name] = {
            "zh_chars": zh_char_count(zh) if isinstance(zh, str) else None,
            "zh_cjk": zh_cjk_count(zh) if isinstance(zh, str) else None,
            "en_present": bool(isinstance(en, str) and en.strip()),
            "en_words": len(en.split()) if isinstance(en, str) and en.strip() else 0,
            "score": item.get("score") if isinstance(item, Mapping) else None,
            "zh_ok": zh_length_ok(zh) if isinstance(zh, str) else False,
        }
    return rows


def report_zh_pass(report: Mapping, dimensions: Iterable[str] = DIMENSION_KEYS) -> bool:
    counts = dimension_zh_counts(report, dimensions)
    return all(row["zh_ok"] and row["en_present"] for row in counts.values())


def zh_primary_prompt_rules() -> str:
    return (
        f"PRIMARY LENGTH GATE (locked): each dimension comment_zh MUST be {MIN_COMMENT_ZH_CHARS}–"
        f"{MAX_COMMENT_ZH_CHARS} Traditional Chinese characters (字, Unicode code points after trim). "
        "Write the Chinese analysis first. comment_en MUST be a faithful English translation of that "
        "Chinese comment — do not invent a separate English-first essay; EN length is NOT the acceptance gate. "
        "Do not change scores when translating. Avoid empty padding and the old short ~40–80 字 blurb style, "
        f"and do not exceed {MAX_COMMENT_ZH_CHARS} 字."
    )


def stamp_policy(record: MutableMapping, *, model: Optional[str] = None) -> MutableMapping:
    record["assessmentPolicy"] = BUFFETT_MOAT_ASSESSMENT_POLICY
    if model is not None:
        record["model"] = model
    return record
