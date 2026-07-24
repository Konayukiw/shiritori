"""モック SQLite による対局フローの統合テスト."""

from __future__ import annotations

import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bot.config import GameConfig
from bot.core.bot_word_selector import BotWordSelector, VocabPool
from bot.core.opponent_word_validator import JmdictIndex, OpponentWordValidator
from bot.core.rules import effective_first_mora, effective_last_mora
from bot.game.session import GameState


def _build_mock_dbs(tmpdir: Path) -> tuple[Path, Path]:
    jmdict = tmpdir / "jmdict.sqlite3"
    vocab = tmpdir / "vocab_pool.sqlite3"

    conn = sqlite3.connect(jmdict)
    conn.executescript(
        """
        CREATE TABLE entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            surface TEXT NOT NULL,
            reading TEXT NOT NULL,
            source TEXT NOT NULL
        );
        """
    )
    entries = [
        ("桜", "さくら", "jmdict"),
        ("さくら", "さくら", "jmdict"),
        ("ラジオ", "らじお", "jmdict"),
        ("らじお", "らじお", "jmdict"),
        ("おにぎり", "おにぎり", "jmdict"),
        ("りす", "りす", "jmdict"),
        ("すし", "すし", "jmdict"),
        ("しまうま", "しまうま", "jmdict"),
        ("みかん", "みかん", "jmdict"),
        ("ん", "ん", "jmdict"),
        ("東京", "とうきょう", "jmnedict"),
    ]
    conn.executemany(
        "INSERT INTO entries(surface, reading, source) VALUES (?,?,?)", entries
    )
    conn.commit()
    conn.close()

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
    words = [
        ("ラジオ", "らじお", "general"),
        ("りす", "りす", "general"),
        ("すし", "すし", "general"),
        ("しまうま", "しまうま", "general"),
        ("おにぎり", "おにぎり", "general"),
        ("ねこ", "ねこ", "general"),
        ("こども", "こども", "general"),
    ]
    rows = []
    for s, r, c in words:
        rows.append((s, r, effective_first_mora(r), c))
    conn.executemany(
        "INSERT INTO vocab(surface, reading, first_mora, category) VALUES (?,?,?,?)",
        rows,
    )
    conn.commit()
    conn.close()
    return jmdict, vocab


def test_full_turn():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        jmdict_path, vocab_path = _build_mock_dbs(tmp)
        cfg = GameConfig(cache_dir=tmp)
        # paths via properties use cache_dir names - override by using indexes directly
        index = JmdictIndex(jmdict_path)
        pool = VocabPool(vocab_path)
        validator = OpponentWordValidator(index, cfg)
        selector = BotWordSelector(pool, cfg)
        state = GameState(config=cfg)

        # ユーザー: さくら
        result = validator.validate(
            "さくら",
            expected_last_mora=None,
            used_readings=state.used_readings,
        )
        assert result.ok, result.reason
        assert result.reading == "さくら"
        assert result.effective_last_mora == "ら"
        state.mark_used(result.reading, result.surface, "user")

        # Bot: ら… で始まる語
        bot = selector.select(result.effective_last_mora, state.used_readings)
        assert bot is not None
        assert bot.reading.startswith("ら")
        state.mark_used(bot.reading, bot.surface, "bot")

        # 既出のさくらは拒否
        again = validator.validate(
            "さくら",
            expected_last_mora=state.expected_first_mora,
            used_readings=state.used_readings,
        )
        assert not again.ok
        assert "既に" in again.reason

        # ん終わりは負け
        # 先に expected を合わせるため state を操作
        state.last_reading = "うみ"
        lost = validator.validate(
            "みかん",
            expected_last_mora="み",
            used_readings=state.used_readings,
        )
        assert lost.ok and lost.lost

        # 未知語（かなのみ・辞書に無い語）
        unk = validator.validate(
            "あいうえおかきくけこざぶとんぽよ",
            expected_last_mora=None,
            used_readings=set(),
        )
        assert not unk.ok
        assert "知りません" in unk.reason

        # 接続不一致
        bad = validator.validate(
            "すし",
            expected_last_mora="ら",
            used_readings=set(),
        )
        assert not bad.ok

        index.close()
        pool.close()
        # Windows で TemporaryDirectory 削除時にロックが残らないよう明示 GC
        del index, pool, validator, selector


def test_effective_last_on_bot_word():
    w = "しゃしん"
    assert effective_last_mora(w) == "ん"
    w2 = "りょこう"
    assert effective_last_mora(w2) == "う"


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
