from __future__ import annotations

import random
import sqlite3
from dataclasses import dataclass
from pathlib import Path

from bot.config import GameConfig
from bot.utils.kana_utils import strip_dakuten
from bot.utils.rules import effective_last_mora, mora_matches


@dataclass
class BotWord:
    surface: str
    reading: str
    category: str
    effective_last_mora: str | None = None

    def __post_init__(self) -> None:
        if self.effective_last_mora is None:
            self.effective_last_mora = effective_last_mora(self.reading)


class VocabPool:
    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        if not self.db_path.exists():
            raise FileNotFoundError(
                f"語彙プール DB が見つかりません: {self.db_path}\n"
                "先に `python -m bot.data_prep.build_vocab_pool` を実行してください。"
            )
        self._conn = sqlite3.connect(f"file:{self.db_path.as_posix()}?mode=ro", uri=True, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        if not self._has_zipf():
            raise FileNotFoundError(
                f"語彙プール DB が古い形式です (頻度情報なし): {self.db_path}\n"
                "語彙レベル機能には頻度情報が必要です。再構築してください:\n"
                "  python -m bot.data_prep.build_vocab_pool --download"
            )

    def _has_zipf(self) -> bool:
        try:
            row = self._conn.execute(
                "SELECT value FROM meta WHERE key = 'has_zipf'"
            ).fetchone()
        except sqlite3.Error:
            return False
        return bool(row and row["value"] == "1")

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> "VocabPool":
        return self

    def __exit__(self, *args) -> None:
        self.close()

    def find_candidates(
        self,
        first_mora: str,
        *,
        allowed_categories: list[str],
        used_readings: set[str],
        require_dakuten_match: bool = True,
        min_zipf: float | None = None,
        limit: int | None = None,
    ) -> list[BotWord]:
        if not first_mora:
            return []

        keys = {first_mora}
        if not require_dakuten_match:
            stripped = strip_dakuten(first_mora)
            keys.add(stripped)
            keys.update(_dakuten_variants(stripped))

        placeholders = ",".join("?" for _ in keys)
        cat_ph = ",".join("?" for _ in allowed_categories)
        if not allowed_categories:
            return []

        sql = f"""
            SELECT surface, reading, category, first_mora FROM vocab
            WHERE first_mora IN ({placeholders})
              AND category IN ({cat_ph})
        """
        params: list = [*keys, *allowed_categories]
        if min_zipf is not None:
            sql += " AND zipf >= ?"
            params.append(min_zipf)
        if limit is not None:
            sql += " LIMIT ?"
            params.append(max(limit * 5, limit))

        rows = self._conn.execute(sql, params).fetchall()

        results: list[BotWord] = []
        seen: set[str] = set()
        for row in rows:
            reading = row["reading"]
            if reading in used_readings or reading in seen:
                continue
            if not mora_matches(
                first_mora,
                reading,
                require_dakuten_match=require_dakuten_match,
            ):
                continue
            last = effective_last_mora(reading)
            if last == "ん":
                continue
            seen.add(reading)
            results.append(
                BotWord(
                    surface=row["surface"],
                    reading=reading,
                    category=row["category"],
                    effective_last_mora=last,
                )
            )
            if limit is not None and len(results) >= limit:
                break
        return results


def _dakuten_variants(base: str) -> set[str]:
    single = {
        "か": ["が"],
        "き": ["ぎ"],
        "く": ["ぐ"],
        "け": ["げ"],
        "こ": ["ご"],
        "さ": ["ざ"],
        "し": ["じ"],
        "す": ["ず"],
        "せ": ["ぜ"],
        "そ": ["ぞ"],
        "た": ["だ"],
        "ち": ["ぢ"],
        "つ": ["づ"],
        "て": ["で"],
        "と": ["ど"],
        "は": ["ば", "ぱ"],
        "ひ": ["び", "ぴ"],
        "ふ": ["ぶ", "ぷ"],
        "へ": ["べ", "ぺ"],
        "ほ": ["ぼ", "ぽ"],
        "う": ["ゔ"],
    }
    out: set[str] = set()
    if len(base) == 1 and base in single:
        out.update(single[base])
    elif len(base) == 2:
        head, tail = base[0], base[1]
        for v in single.get(head, []):
            out.add(v + tail)
    return out


class BotWordSelector:
    def __init__(self, pool: VocabPool, config: GameConfig):
        self.pool = pool
        self.config = config

    def _allowed_categories(self) -> list[str]:
        cats = ["general"]
        c = self.config
        if c.allow_verb:
            cats.append("verb")
        if c.allow_person:
            cats.append("person")
        if c.allow_place:
            cats.append("place")
        if c.allow_organization:
            cats.append("organization")
        if c.allow_proper:
            cats.append("proper")
        if c.allow_other:
            cats.append("other")
        return cats

    def select(
        self,
        required_first_mora: str,
        used_readings: set[str],
        *,
        rng: random.Random | None = None,
    ) -> BotWord | None:
        candidates = self.pool.find_candidates(
            required_first_mora,
            allowed_categories=self._allowed_categories(),
            used_readings=used_readings,
            require_dakuten_match=self.config.require_dakuten_match,
            min_zipf=self.config.min_vocab_zipf,
        )
        if not candidates:
            return None
        # GitHub:
        #   randomIndex = Math.floor(Math.random() * arr.length)
        #   randomWord = arr[randomIndex]
        r = rng or random.Random()
        return r.choice(candidates)
