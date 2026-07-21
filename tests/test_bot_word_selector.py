"""BotWordSelector のランダム選択テスト (shiritori-Github 準拠)."""

from __future__ import annotations

import random
import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shiritori_bot.config import GameConfig
from shiritori_bot.core.bot_word_selector import BotWordSelector, VocabPool
from shiritori_bot.core.rules import effective_first_mora


def _build_vocab(tmpdir: Path, words: list[tuple[str, str, str]]) -> Path:
    vocab = tmpdir / "vocab_pool.sqlite3"
    conn = sqlite3.connect(vocab)
    conn.executescript(
        """
        CREATE TABLE vocab (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            surface TEXT NOT NULL,
            reading TEXT NOT NULL,
            first_mora TEXT NOT NULL,
            category TEXT NOT NULL
        );
        CREATE INDEX idx_fm ON vocab(first_mora);
        """
    )
    rows = [(s, r, effective_first_mora(r), c) for s, r, c in words]
    conn.executemany(
        "INSERT INTO vocab(surface, reading, first_mora, category) VALUES (?,?,?,?)",
        rows,
    )
    conn.commit()
    conn.close()
    return vocab


def test_selects_from_candidates_randomly():
    """候補からランダムに 1 語を返す (SystemWordSelector 相当)."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        vocab_path = _build_vocab(
            tmp,
            [
                ("桜", "さくら", "general"),
                ("魚", "さかな", "general"),
                ("砂", "すな", "general"),  # 別モーラ
            ],
        )
        pool = VocabPool(vocab_path)
        selector = BotWordSelector(pool, GameConfig(cache_dir=tmp))

        # 決定的 RNG で再現可能に
        first = selector.select("さ", set(), rng=random.Random(0))
        assert first is not None
        assert first.reading in {"さくら", "さかな"}
        assert first.reading.startswith("さ")

        # 既出を除外して次を取る
        used = {first.reading}
        second = selector.select("さ", used, rng=random.Random(1))
        assert second is not None
        assert second.reading != first.reading
        assert second.reading in {"さくら", "さかな"}

        # 両方使い切ったら None
        assert selector.select("さ", {first.reading, second.reading}) is None

        pool.close()


def test_used_readings_skip_to_next():
    """既出読みは飛ばして残候補から選ぶ."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        vocab_path = _build_vocab(
            tmp,
            [
                ("猫", "ねこ", "general"),
                ("ネズミ", "ねずみ", "general"),
            ],
        )
        pool = VocabPool(vocab_path)
        selector = BotWordSelector(pool, GameConfig(cache_dir=tmp))

        a = selector.select("ね", set(), rng=random.Random(42))
        assert a is not None
        b = selector.select("ね", {a.reading}, rng=random.Random(42))
        assert b is not None
        assert a.reading != b.reading

        all_used = {a.reading, b.reading}
        assert selector.select("ね", all_used) is None

        pool.close()


def test_no_candidates_returns_none():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        vocab_path = _build_vocab(tmp, [("猫", "ねこ", "general")])
        pool = VocabPool(vocab_path)
        selector = BotWordSelector(pool, GameConfig(cache_dir=tmp))
        assert selector.select("あ", set()) is None
        pool.close()


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
