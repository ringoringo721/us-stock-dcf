"""Traditional Chinese (繁體) helpers for moat ZH prose.

Uses a vendored OpenCC STCharacters map (Simplified→Traditional, Apache-2.0)
so Lite remoats can detect Simplified leakage and convert-on-retry without a
pip dependency. Never invents facts — only character-form conversion.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Iterable

_DATA = Path(__file__).resolve().parent / "data" / "opencc_st_characters.txt"


@lru_cache(maxsize=1)
def s2t_map() -> dict[str, str]:
    """Load Simplified→Traditional single-character map (first OpenCC candidate)."""
    mapping: dict[str, str] = {}
    text = _DATA.read_text(encoding="utf-8")
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) >= 2 and parts[0] != parts[1]:
            mapping[parts[0]] = parts[1]
    return mapping


def simplified_chars(text: str) -> list[str]:
    """Distinct Simplified-form characters that differ under OpenCC S2T."""
    if not isinstance(text, str) or not text:
        return []
    mapping = s2t_map()
    seen: set[str] = set()
    ordered: list[str] = []
    for char in text:
        if char in mapping and char not in seen:
            seen.add(char)
            ordered.append(char)
    return ordered


def has_simplified(text: str) -> bool:
    return bool(simplified_chars(text))


def to_traditional(text: str) -> str:
    """Convert Simplified-form characters to Traditional (OpenCC S2T, char-wise)."""
    if not isinstance(text, str) or not text:
        return text
    mapping = s2t_map()
    return "".join(mapping.get(char, char) for char in text)


def first_simplified_sample(text: str, limit: int = 8) -> str:
    chars = simplified_chars(text)
    if not chars:
        return ""
    shown = chars[:limit]
    suffix = "…" if len(chars) > limit else ""
    return "".join(shown) + suffix


ZH_SCRIPT_FIELDS = (
    "comment_zh",
    "overall_moat_verdict_zh",
    "description_zh",
)


def iter_zh_prose_fields(report: dict) -> Iterable[tuple[str, str]]:
    """Yield (field_path, text) for ZH prose fields on a moat report."""
    if not isinstance(report, dict):
        return
    description = report.get("description_zh")
    if isinstance(description, str) and description.strip():
        yield "description_zh", description
    verdict = report.get("overall_moat_verdict_zh")
    if isinstance(verdict, str) and verdict.strip():
        yield "overall_moat_verdict_zh", verdict
    for name, item in report.items():
        if not isinstance(item, dict):
            continue
        zh = item.get("comment_zh")
        if isinstance(zh, str) and zh.strip():
            yield f"{name}.comment_zh", zh


def convert_report_zh_to_traditional(report: dict) -> tuple[dict, list[str]]:
    """Return a copy of report with ZH prose converted S→T and list of converted paths."""
    from copy import deepcopy

    corrected = deepcopy(report)
    converted: list[str] = []
    description = corrected.get("description_zh")
    if isinstance(description, str) and has_simplified(description):
        corrected["description_zh"] = to_traditional(description)
        converted.append("description_zh")
    verdict = corrected.get("overall_moat_verdict_zh")
    if isinstance(verdict, str) and has_simplified(verdict):
        corrected["overall_moat_verdict_zh"] = to_traditional(verdict)
        converted.append("overall_moat_verdict_zh")
    for name, item in list(corrected.items()):
        if not isinstance(item, dict):
            continue
        zh = item.get("comment_zh")
        if isinstance(zh, str) and has_simplified(zh):
            item["comment_zh"] = to_traditional(zh)
            converted.append(f"{name}.comment_zh")
    return corrected, converted
