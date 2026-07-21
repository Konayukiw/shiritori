"""Sudachi 品詞分類のテスト"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shiritori_bot.data_prep.build_vocab_pool import classify_pos, _parse_row


def test_classify_person():
    assert classify_pos("名詞", "固有名詞", "人名", "名") == "person"
    assert classify_pos("名詞", "固有名詞", "人名", "姓") == "person"


def test_classify_place():
    assert classify_pos("名詞", "固有名詞", "地名", "一般") == "place"


def test_classify_org():
    assert classify_pos("名詞", "固有名詞", "組織", "*") == "organization"


def test_classify_proper():
    assert classify_pos("名詞", "固有名詞", "一般", "*") == "proper"


def test_classify_general():
    # GitHub: 名詞,普通名詞,一般 のみ general
    assert classify_pos("名詞", "普通名詞", "一般", "*") == "general"
    assert classify_pos("動詞", "一般", "*", "*") == "verb"
    # サ変可能などは general に入れない
    assert classify_pos("名詞", "普通名詞", "サ変可能", "*") is None
    assert classify_pos("名詞", "数詞", "*", "*") is None


def test_classify_skip():
    assert classify_pos("助詞", "格助詞", "一般", "*") is None
    assert classify_pos("補助記号", "句点", "*", "*") is None
    assert classify_pos("形容詞", "一般", "*", "*") is None
    assert classify_pos("副詞", "*", "*", "*") is None


def _make_row(
    surface,
    reading,
    pos1="名詞",
    pos2="普通名詞",
    pos3="一般",
    *,
    c_type="*",
    c_form="*",
    norm=None,
):
    # surface, left, right, cost, surface2, pos1-4, cType, cForm, reading, norm, ...
    row = ["*"] * 18
    row[0] = surface
    row[4] = surface
    row[5] = pos1
    row[6] = pos2
    row[7] = pos3
    row[8] = "*"
    row[9] = c_type
    row[10] = c_form
    row[11] = reading
    row[12] = surface if norm is None else norm
    return row


def test_parse_row_filters():
    # 正常
    r = _parse_row(_make_row("桜", "サクラ"))
    assert r is not None
    surface, reading, cat = r
    assert surface == "桜"
    assert reading == "さくら"
    assert cat == "general"

    # ん終わり → 除外
    assert _parse_row(_make_row("本", "ホン")) is None

    # 1モーラ → 除外
    assert _parse_row(_make_row("木", "キ")) is None

    # 英数字表層 → 除外 (GitHub の形態素不一致に相当)
    assert _parse_row(_make_row("1000th", "サウザンス")) is None
    assert _parse_row(_make_row("CYBER", "サイバー")) is None

    # 人名
    r = _parse_row(_make_row("太郎", "タロウ", "名詞", "固有名詞", "人名"))
    assert r is not None
    assert r[2] == "person"


def test_parse_row_verb_dictionary_form_only():
    # 終止形は採用。surface は norm を優先
    r = _parse_row(
        _make_row(
            "司る",
            "ツカサドル",
            "動詞",
            "一般",
            "*",
            c_type="五段-ラ行",
            c_form="終止形-一般",
            norm="司る",
        )
    )
    assert r is not None
    assert r[0] == "司る"
    assert r[1] == "つかさどる"
    assert r[2] == "verb"

    # 終止形-撥音便も採用
    r = _parse_row(
        _make_row(
            "死ぬ",
            "シヌ",
            "動詞",
            "一般",
            "*",
            c_type="五段-ナ行",
            c_form="終止形-撥音便",
            norm="死ぬ",
        )
    )
    # ぬ終わりは「ん」ではないので通る想定（ends_with_n は「ん」のみ）
    assert r is not None
    assert r[1] == "しぬ"

    # 命令形・未然形・意志推量形は除外
    for c_form in ("命令形", "未然形-一般", "意志推量形", "連用形-一般"):
        assert (
            _parse_row(
                _make_row(
                    "つかさどろ",
                    "ツカサドロ",
                    "動詞",
                    "一般",
                    "*",
                    c_type="五段-ラ行",
                    c_form=c_form,
                    norm="司る",
                )
            )
            is None
        ), c_form


def test_parse_row_adjective_excluded():
    # GitHub しりとり辞書は名詞のみ。形容詞はプールに入れない
    assert (
        _parse_row(
            _make_row(
                "美しい",
                "ウツクシイ",
                "形容詞",
                "一般",
                "*",
                c_type="形容詞",
                c_form="終止形-一般",
                norm="美しい",
            )
        )
        is None
    )


def test_parse_row_noun_unaffected_by_cform():
    # 名詞は cForm=* のまま通る
    r = _parse_row(_make_row("さくら", "サクラ", c_form="*"))
    assert r is not None


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
