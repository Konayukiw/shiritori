"""かな変換・文字種チェック."""

from __future__ import annotations

import re
import unicodedata

import jaconv

MODERN_HIRAGANA = set(
    "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん"
    "がぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽ"
    "ぁぃぅぇぉっゃゅょゎゕゖー"
)

OBSOLETE_KANA = set("ゐゑゐ゙ゑ゙ヰヱゐ゚ゑ゚")

KATAKANA_RANGE = re.compile(r"[\u30A0-\u30FF]")
HIRAGANA_RANGE = re.compile(r"[\u3040-\u309F]")
ALNUM_RANGE = re.compile(r"[A-Za-z0-9Ａ-Ｚａ-ｚ０-９]")

ALLOWED_KANA_MARKS = set("ー・")


def to_hiragana(text: str) -> str:
    return jaconv.kata2hira(text)


def to_katakana(text: str) -> str:
    return jaconv.hira2kata(text)


def normalize_reading(text: str) -> str:
    text = unicodedata.normalize("NFKC", text.strip())
    return to_hiragana(text)


def is_hiragana_char(ch: str) -> bool:
    return "\u3040" <= ch <= "\u309F" or ch == "ー"


def is_katakana_char(ch: str) -> bool:
    return "\u30A0" <= ch <= "\u30FF"


def is_kana_char(ch: str) -> bool:
    return is_hiragana_char(ch) or is_katakana_char(ch)


def is_alnum_char(ch: str) -> bool:
    return bool(ALNUM_RANGE.fullmatch(ch)) or ch.isascii() and ch.isalnum()


def contains_obsolete_kana(text: str) -> bool:
    for ch in text:
        if ch in OBSOLETE_KANA:
            return True
        if is_hiragana_char(ch) and ch not in MODERN_HIRAGANA and ch not in "゛゜゙゚":
            if "\u3041" <= ch <= "\u3096" and ch not in MODERN_HIRAGANA:
                return True
    return False


def is_allowed_surface(text: str, *, allow_alnum: bool = False) -> bool:
    if not text:
        return False
    text = unicodedata.normalize("NFKC", text)
    for ch in text:
        if ch.isspace():
            return False
        if is_kana_char(ch) or ch in ALLOWED_KANA_MARKS:
            continue
        if _is_cjk(ch):
            continue
        if allow_alnum and is_alnum_char(ch):
            continue
        return False
    return True


def is_kana_only_reading(text: str, *, allow_alnum: bool = False) -> bool:
    if not text:
        return False
    for ch in text:
        if ch in MODERN_HIRAGANA or ch == "ー":
            continue
        if ch in OBSOLETE_KANA:
            return False
        if allow_alnum and is_alnum_char(ch):
            continue
        if not is_hiragana_char(ch):
            return False
        if ch not in MODERN_HIRAGANA:
            return False
    return True


def _is_cjk(ch: str) -> bool:
    code = ord(ch)
    return (
        0x4E00 <= code <= 0x9FFF  # CJK Unified
        or 0x3400 <= code <= 0x4DBF  # Extension A
        or 0xF900 <= code <= 0xFAFF  # Compatibility
        or 0x20000 <= code <= 0x2FA1F  # Extension B-F etc.
        or 0x3005 <= code <= 0x3007  # 々 〇 〆 など
        or ch in "々〆ヵヶ"
    )


_DAKUTEN_STRIP = str.maketrans(
    {
        "が": "か",
        "ぎ": "き",
        "ぐ": "く",
        "げ": "け",
        "ご": "こ",
        "ざ": "さ",
        "じ": "し",
        "ず": "す",
        "ぜ": "せ",
        "ぞ": "そ",
        "だ": "た",
        "ぢ": "ち",
        "づ": "つ",
        "で": "て",
        "ど": "と",
        "ば": "は",
        "び": "ひ",
        "ぶ": "ふ",
        "べ": "へ",
        "ぼ": "ほ",
        "ぱ": "は",
        "ぴ": "ひ",
        "ぷ": "ふ",
        "ぺ": "へ",
        "ぽ": "ほ",
        "ゔ": "う",
    }
)


def strip_dakuten(text: str) -> str:
    return text.translate(_DAKUTEN_STRIP)
