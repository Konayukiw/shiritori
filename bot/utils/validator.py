from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from bot.config import GameConfig
from bot.utils.kana_utils import (
    is_allowed_surface,
    normalize_reading,
    to_hiragana,
)
from bot.utils.rules import (
    check_default_bans,
    effective_last_mora,
    ends_with_n,
    mora_matches,
)


@dataclass
class ValidationResult:
    ok: bool
    reason: str = ""
    surface: str = ""
    reading: str = ""
    source: str = ""
    effective_last_mora: str | None = None
    lost: bool = False


class JmdictIndex:
    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        if not self.db_path.exists():
            raise FileNotFoundError(
                f"JMdict DB が見つかりません: {self.db_path}\n"
                "先に `python -m shiritori_bot.data_prep.build_jmdict_index` を実行してください。"
            )
        self._conn = sqlite3.connect(f"file:{self.db_path.as_posix()}?mode=ro", uri=True, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> "JmdictIndex":
        return self

    def __exit__(self, *args) -> None:
        self.close()

    def lookup(self, surface: str, reading_hint: str | None = None) -> Optional[tuple[str, str, str]]:
        row = self._conn.execute(
            """
            SELECT surface, reading, source FROM entries
            WHERE surface = ?
            ORDER BY CASE source WHEN 'jmdict' THEN 0 ELSE 1 END, id
            LIMIT 1
            """,
            (surface,),
        ).fetchone()
        if row:
            return row["surface"], row["reading"], row["source"]

        reading = reading_hint if reading_hint is not None else normalize_reading(surface)
        if reading and reading != surface:
            row = self._conn.execute(
                """
                SELECT surface, reading, source FROM entries
                WHERE reading = ?
                ORDER BY CASE source WHEN 'jmdict' THEN 0 ELSE 1 END, id
                LIMIT 1
                """,
                (reading,),
            ).fetchone()
            if row:
                return row["surface"], row["reading"], row["source"]

        row = self._conn.execute(
            """
            SELECT surface, reading, source FROM entries
            WHERE reading = ?
            ORDER BY CASE source WHEN 'jmdict' THEN 0 ELSE 1 END, id
            LIMIT 1
            """,
            (normalize_reading(surface),),
        ).fetchone()
        if row:
            return row["surface"], row["reading"], row["source"]

        return None


class OpponentWordValidator:
    def __init__(self, index: JmdictIndex, config: GameConfig):
        self.index = index
        self.config = config

    def validate(
        self,
        user_input: str,
        *,
        expected_last_mora: str | None,
        used_readings: set[str],
    ) -> ValidationResult:
        surface = user_input.strip()
        if not surface:
            return ValidationResult(ok=False, reason="単語を入力してください")

        if not is_allowed_surface(surface, allow_alnum=self.config.allow_alnum):
            return ValidationResult(
                ok=False,
                reason="使用できない文字が含まれています"
                + (" (ひらがな・カタカナ・漢字のみ)" if not self.config.allow_alnum else ""),
            )

        found = self.index.lookup(surface)
        if found is None:
            normalized = normalize_reading(surface)
            if normalized != surface:
                found = self.index.lookup(surface, reading_hint=normalized)
            if found is None and normalized:
                found = self.index.lookup(normalized)

        if found is None:
            return ValidationResult(ok=False, reason="その単語は知りません")

        _surf, reading, source = found
        reading = to_hiragana(reading)

        if source == "jmnedict" and not self._jmnedict_allowed():
            return ValidationResult(
                ok=False,
                reason="固有名詞・人名などは現在の設定では使えません",
                surface=_surf,
                reading=reading,
                source=source,
            )

        ban_reason = check_default_bans(
            reading,
            ban_one_mora=self.config.ban_one_mora,
            ban_obsolete_kana=self.config.ban_obsolete_kana,
            ban_n_ending=False,
            allow_alnum=self.config.allow_alnum,
        )
        if ban_reason:
            return ValidationResult(
                ok=False,
                reason=ban_reason,
                surface=_surf,
                reading=reading,
                source=source,
            )

        if reading in used_readings:
            return ValidationResult(
                ok=False,
                reason="その単語は既に使われています",
                surface=_surf,
                reading=reading,
                source=source,
            )

        if expected_last_mora is not None:
            if not mora_matches(
                expected_last_mora,
                reading,
                require_dakuten_match=self.config.require_dakuten_match,
            ):
                return ValidationResult(
                    ok=False,
                    reason=f"『{expected_last_mora}』から始まる単語を入力してください",
                    surface=_surf,
                    reading=reading,
                    source=source,
                )

        last = effective_last_mora(reading)

        if self.config.ban_n_ending and ends_with_n(reading):
            return ValidationResult(
                ok=True,
                reason="『ん』で終わったのであなたの負けです",
                surface=_surf,
                reading=reading,
                source=source,
                effective_last_mora=last,
                lost=True,
            )

        return ValidationResult(
            ok=True,
            surface=_surf,
            reading=reading,
            source=source,
            effective_last_mora=last,
        )

    def _jmnedict_allowed(self) -> bool:
        c = self.config
        return any(
            [
                c.allow_person,
                c.allow_place,
                c.allow_organization,
                c.allow_proper,
                c.allow_other,
            ]
        )
