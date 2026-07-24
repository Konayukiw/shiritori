"""rules / kana_utils のユニットテスト."""

from __future__ import annotations

import sys
from pathlib import Path

# プロジェクトルートを path に追加
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bot.core.kana_utils import (
    contains_obsolete_kana,
    is_allowed_surface,
    normalize_reading,
    strip_dakuten,
    to_hiragana,
)
from bot.core.rules import (
    check_default_bans,
    effective_first_mora,
    effective_last_mora,
    ends_with_n,
    is_one_mora_word,
    mora_count,
    mora_matches,
)


def test_effective_last_mora_basic():
    assert effective_last_mora("さくら") == "ら"
    assert effective_last_mora("ねこ") == "こ"
    assert effective_last_mora("あ") == "あ"


def test_effective_last_mora_chouonpu():
    # 読みはひらがな正規化済み前提
    assert effective_last_mora("こーひー") == "ひ"
    assert effective_last_mora("しゃー") == "しゃ"
    assert effective_last_mora("あーー") == "あ"
    assert effective_last_mora("ー") is None
    assert effective_last_mora("ーー") is None


def test_effective_last_mora_youon():
    assert effective_last_mora("きゃく") == "く"
    assert effective_last_mora("かっきゃ") == "きゃ"
    assert effective_last_mora("りょ") == "りょ"
    assert effective_last_mora("がっこう") == "う"


def test_effective_last_mora_sokuon():
    # 促音終わり (異常だが仕様どおり直前とペア)
    assert effective_last_mora("あっ") == "あっ"


def test_effective_first_mora():
    assert effective_first_mora("さくら") == "さ"
    assert effective_first_mora("きゃく") == "きゃ"
    assert effective_first_mora("あ") == "あ"


def test_mora_count():
    assert mora_count("さくら") == 3
    assert mora_count("きゃく") == 2
    assert mora_count("こーひー") == 4  # こ ー ひ ー
    assert mora_count("あっ") == 1


def test_is_one_mora_word():
    assert is_one_mora_word("あ")
    assert is_one_mora_word("きゃ")
    assert is_one_mora_word("りょ")
    assert not is_one_mora_word("あい")
    assert not is_one_mora_word("さくら")
    assert not is_one_mora_word("きゃく")


def test_ends_with_n():
    assert ends_with_n("かん")
    assert ends_with_n("みかん")
    assert not ends_with_n("さくら")
    # 長音符を挟むケース
    assert ends_with_n("かんー") is True or effective_last_mora("かんー") == "ん"


def test_mora_matches_dakuten():
    assert mora_matches("か", "かき", require_dakuten_match=True)
    assert not mora_matches("か", "がき", require_dakuten_match=True)
    assert mora_matches("か", "がき", require_dakuten_match=False)
    assert mora_matches("きょ", "きょう", require_dakuten_match=True)
    assert mora_matches("しゃ", "しゃしん", require_dakuten_match=True)


def test_strip_dakuten():
    assert strip_dakuten("がぎぐげご") == "かきくけこ"
    assert strip_dakuten("ぱぴぷぺぽ") == "はひふへほ"


def test_obsolete_kana():
    assert contains_obsolete_kana("うゐ")
    assert contains_obsolete_kana("ゑ")
    assert not contains_obsolete_kana("あいうえお")


def test_normalize_reading():
    assert normalize_reading("サクラ") == "さくら"
    assert normalize_reading("コーヒー") == "こーひー"


def test_is_allowed_surface():
    assert is_allowed_surface("さくら")
    assert is_allowed_surface("猫")
    assert is_allowed_surface("コンピューター")
    assert not is_allowed_surface("hello", allow_alnum=False)
    assert is_allowed_surface("hello", allow_alnum=True)
    assert not is_allowed_surface("猫！")
    assert not is_allowed_surface("🌸")


def test_check_default_bans():
    assert check_default_bans("あ") is not None  # 1モーラ
    assert check_default_bans("きゃ") is not None
    assert check_default_bans("かん") is not None  # ん終わり
    assert check_default_bans("さくら") is None
    assert check_default_bans("ゑびす") is not None


def test_classify_and_bot_startswith():
    """Bot 候補は startswith(effective_last_mora) で十分."""
    last = effective_last_mora("がっこう")
    assert last == "う"
    assert "うさぎ".startswith(last)
    last2 = effective_last_mora("りょこう")
    assert last2 == "う"
    last3 = effective_last_mora("しゃー")
    assert last3 == "しゃ"
    assert "しゃしん".startswith(last3)


if __name__ == "__main__":
    import traceback

    tests = [v for k, v in list(globals().items()) if k.startswith("test_")]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  OK  {t.__name__}")
        except Exception:
            failed += 1
            print(f"  FAIL {t.__name__}")
            traceback.print_exc()
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    raise SystemExit(1 if failed else 0)
