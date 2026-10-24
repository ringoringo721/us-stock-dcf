"""Shared Buffett-v3 / Lite moat standard for US and HK.

Locked 2026-10-24 (updated):
- One assessment policy family for both markets
- Model: gemini-2.5-flash-lite
- Each M1–M10 comment_zh: about 100–300 Traditional Chinese characters (字)
- comment_en: translation of the Chinese (length not the gate)
- Same band for US and HK (mcap ≥ HKD 1B for HK remoats)
"""

from __future__ import annotations

import os
import re
from typing import Iterable, Mapping, MutableMapping, Optional

# Unified policy id (replaces us-buffett-moat-v3 and grounded/researched-v4–v6 for new remoats).
BUFFETT_MOAT_ASSESSMENT_POLICY = "buffett-moat-v3"
BUFFETT_MOAT_MODEL = "gemini-2.5-flash-lite"

# Hard acceptance band for Traditional Chinese dimension comments (Unicode code points after strip).
# User-locked target ~100–300 繁中字 (US already often lands here; HK ≥1B must match).
MIN_COMMENT_ZH_CHARS = 100
MAX_COMMENT_ZH_CHARS = 300

RETRY_MIN_COMMENT_ZH_CHARS = 100
RETRY_MAX_COMMENT_ZH_CHARS = 300
# Near the floor (e.g. 90–99): still reject, but retry feedback must say "expand by a few characters"
# so Lite does not keep regenerating ~98-char near-misses that waste the attempt budget.
NEAR_FLOOR_ZH_CHARS = 90

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


def zh_length_violation_message(
    name: str,
    count: int,
    *,
    minimum: int = RETRY_MIN_COMMENT_ZH_CHARS,
    maximum: int = RETRY_MAX_COMMENT_ZH_CHARS,
    near_floor: int = NEAR_FLOOR_ZH_CHARS,
) -> str:
    """Actionable length error for validators and Lite retry prompts."""
    band = f"{minimum}–{maximum}"
    if near_floor <= count < minimum:
        need = minimum - count
        return (
            f"{name}.comment_zh: length {count} is a NEAR-FLOOR miss "
            f"(in {near_floor}–{minimum - 1}; locked band is {band} 繁中字). "
            f"EXPAND BY A FEW CHARACTERS — add about {need} more Traditional Chinese characters "
            f"(aim ~{minimum + 10}–{minimum + 40}, stay ≤{maximum}); keep the same score and meaning; "
            f"then re-translate comment_en. Do not shorten other dimensions."
        )
    if count < near_floor:
        return (
            f"{name}.comment_zh: length {count} is TOO SHORT for locked {band} 繁中字 band "
            f"(English is a translation only; do not use EN word count as the gate). "
            f"Expand the Chinese analysis substantially to at least {minimum} characters "
            f"(prefer ~{minimum + 20}–{minimum + 80}), then translate."
        )
    if count > maximum:
        over = count - maximum
        return (
            f"{name}.comment_zh: length {count} is TOO LONG for locked {band} 繁中字 band "
            f"(over by ~{over}). Tighten the Chinese to ≤{maximum} characters "
            f"(prefer ~{minimum + 20}–{maximum - 20}), then translate; keep the same score."
        )
    return (
        f"{name}.comment_zh: length {count} outside locked {band} 繁中字 band; "
        f"rewrite Chinese to {band} characters then translate"
    )


def zh_length_retry_guidance(error_text: str) -> str:
    """Extra OUTPUT CORRECTION lines when a length / near-floor miss triggered the retry."""
    text = error_text or ""
    if "NEAR-FLOOR" in text or "near-floor" in text.lower() or "EXPAND BY A FEW" in text:
        return (
            " LENGTH RETRY (near floor): one or more comment_zh values are only a few characters "
            "short of the minimum. Expand those Chinese comments by a few characters into the "
            f"{MIN_COMMENT_ZH_CHARS}–{MAX_COMMENT_ZH_CHARS} band; do not rewrite scores; "
            "re-translate EN after expanding ZH."
        )
    if "comment_zh" in text and ("length" in text or "TOO SHORT" in text or "TOO LONG" in text):
        return (
            " LENGTH RETRY: every comment_zh must land in "
            f"{MIN_COMMENT_ZH_CHARS}–{MAX_COMMENT_ZH_CHARS} 繁中字. "
            f"Regenerate dims outside that band (including {NEAR_FLOOR_ZH_CHARS}–"
            f"{MIN_COMMENT_ZH_CHARS - 1} near-misses); expand short ones, tighten long ones; "
            "then translate."
        )
    return ""


def validate_dimension_zh_lengths(
    report: Mapping,
    dimensions: Iterable[str] = DIMENSION_KEYS,
    *,
    minimum: int = RETRY_MIN_COMMENT_ZH_CHARS,
    maximum: int = RETRY_MAX_COMMENT_ZH_CHARS,
) -> None:
    """Raise ValueError if any M1–M10 comment_zh is outside the locked band.

    Treats 90–99 (near floor) and any other out-of-band length as hard rejects with
    actionable expand/tighten guidance for Lite retries.

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
            raise ValueError(zh_length_violation_message(name, count, minimum=minimum, maximum=maximum))


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
