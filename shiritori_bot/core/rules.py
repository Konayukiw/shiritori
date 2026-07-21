from __future__ import annotations

from shiritori_bot.core.kana_utils import (
    contains_obsolete_kana,
    is_kana_only_reading,
    strip_dakuten,
)

SUTEGANA = set("ぁぃぅぇぉっゃゅょゎゕゖ")


def effective_last_mora(reading: str) -> str | None:
    if not reading:
        return None

    i = len(reading) - 1
    while i >= 0 and reading[i] == "ー":
        i -= 1
    if i < 0:
        return None 

    if reading[i] in SUTEGANA:
        if i - 1 >= 0:
            return reading[i - 1 : i + 1]
        return reading[i] 
    return reading[i]


def effective_first_mora(reading: str) -> str | None:
    if not reading:
        return None
    if len(reading) >= 2 and reading[1] in SUTEGANA:
        return reading[0:2]
    return reading[0]


def mora_count(reading: str) -> int:
    if not reading:
        return 0
    count = 0
    i = 0
    n = len(reading)
    while i < n:
        if reading[i] == "ー":
            count += 1
            i += 1
        elif i + 1 < n and reading[i + 1] in SUTEGANA:
            count += 1
            i += 2
        else:
            count += 1
            i += 1
    return count


def is_one_mora_word(reading: str) -> bool:
    if not reading:
        return True
    if len(reading) == 1:
        return True
    if len(reading) == 2 and reading[1] in SUTEGANA and reading[0] not in SUTEGANA:
        return True
    return mora_count(reading) <= 1 and "ー" not in reading


def ends_with_n(reading: str) -> bool:
    mora = effective_last_mora(reading)
    return mora == "ん"


def mora_matches(
    expected: str,
    actual_prefix: str,
    *,
    require_dakuten_match: bool = True,
) -> bool:
    if not expected or not actual_prefix:
        return False

    if require_dakuten_match:
        return actual_prefix.startswith(expected)

    exp = strip_dakuten(expected)
    act = strip_dakuten(actual_prefix)
    return act.startswith(exp)


def check_default_bans(
    reading: str,
    *,
    ban_one_mora: bool = True,
    ban_obsolete_kana: bool = True,
    ban_n_ending: bool = True,
    allow_alnum: bool = False,
) -> str | None:
    if not reading:
        return "空の読みです"

    if not is_kana_only_reading(reading, allow_alnum=allow_alnum):
        return "読みに使用できない文字が含まれています"

    if ban_obsolete_kana and contains_obsolete_kana(reading):
        return "現代仮名遣いにない文字が含まれています"

    if ban_one_mora and is_one_mora_word(reading):
        return "1モーラの単語は使えません"

    if ban_n_ending and ends_with_n(reading):
        return "『ん』で終わる単語は使えません"

    return None
