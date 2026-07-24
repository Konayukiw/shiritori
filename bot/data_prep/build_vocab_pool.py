from __future__ import annotations

import csv
import sqlite3
import sys
from pathlib import Path

from bot.config import DEFAULT_CACHE_DIR, DEFAULT_RAW_DIR, VOCAB_DB_NAME
from bot.utils.kana_utils import (
    contains_obsolete_kana,
    is_allowed_surface,
    is_kana_only_reading,
    normalize_reading,
    to_hiragana,
)
from bot.utils.rules import (
    effective_first_mora,
    ends_with_n,
    is_one_mora_word,
)
from bot.data_prep.download import download_sudachi

COL_SURFACE_TRIE = 0
COL_SURFACE = 4
COL_POS1 = 5
COL_POS2 = 6
COL_POS3 = 7
COL_POS4 = 8
COL_CTYPE = 9
COL_CFORM = 10
COL_READING = 11
COL_NORM = 12

CONJUGATING_POS = frozenset({"動詞", "形容詞"})

PREFERRED_LEX_ORDER = ("small_lex.csv", "core_lex.csv", "notcore_lex.csv")

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vocab (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    surface TEXT NOT NULL,
    reading TEXT NOT NULL,
    first_mora TEXT NOT NULL,
    category TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vocab_first_mora ON vocab(first_mora);
CREATE INDEX IF NOT EXISTS idx_vocab_reading ON vocab(reading);
CREATE INDEX IF NOT EXISTS idx_vocab_category ON vocab(category);
"""


def classify_pos(pos1: str, pos2: str, pos3: str, pos4: str = "") -> str | None:
    if pos1 == "名詞":
        if pos2 == "固有名詞":
            if pos3 == "人名":
                return "person"
            if pos3 == "地名":
                return "place"
            if pos3 in ("組織", "組織名"):
                return "organization"
            if pos3 in ("一般", "*"):
                return "proper"
            return "other"
        if pos2 == "普通名詞" and pos3 == "一般":
            return "general"
        return None

    if pos1 == "動詞":
        return "verb"

    return None


def _find_lex_csvs(raw_dir: Path, *, small_only: bool = True) -> list[Path]:
    sudachi = raw_dir / "sudachi"
    search_dirs = [sudachi, raw_dir]
    found: dict[str, Path] = {}

    for d in search_dirs:
        if not d.is_dir():
            continue
        for name in PREFERRED_LEX_ORDER:
            p = d / name
            if p.exists() and name not in found:
                found[name] = p
        for p in sorted(d.glob("*lex*.csv")):
            if p.name not in found:
                found[p.name] = p

    if small_only:
        if "small_lex.csv" in found:
            return [found["small_lex.csv"]]
        return list(found.values())[:1] if found else []

    ordered: list[Path] = []
    for name in PREFERRED_LEX_ORDER:
        if name in found:
            ordered.append(found[name])
    for name, p in found.items():
        if p not in ordered:
            ordered.append(p)
    return ordered


def _is_dictionary_form(pos1: str, cform: str) -> bool:
    if pos1 not in CONJUGATING_POS:
        return True
    return cform.startswith("終止形")


def _parse_row(row: list[str]) -> tuple[str, str, str] | None:
    if len(row) < 12:
        return None

    surface = (row[COL_SURFACE] or row[COL_SURFACE_TRIE] or "").strip()
    reading_raw = (row[COL_READING] or "").strip()
    pos1 = (row[COL_POS1] or "").strip()
    pos2 = (row[COL_POS2] or "").strip()
    pos3 = (row[COL_POS3] or "").strip()
    pos4 = (row[COL_POS4] or "").strip() if len(row) > COL_POS4 else ""
    cform = (row[COL_CFORM] or "").strip() if len(row) > COL_CFORM else ""
    norm = (row[COL_NORM] or "").strip() if len(row) > COL_NORM else ""

    if not surface or not reading_raw or reading_raw == "*":
        return None

    if not _is_dictionary_form(pos1, cform):
        return None

    category = classify_pos(pos1, pos2, pos3, pos4)
    if category is None:
        return None

    if pos1 in CONJUGATING_POS and norm and norm != "*":
        surface = norm

    if not is_allowed_surface(surface, allow_alnum=False):
        return None

    reading = to_hiragana(normalize_reading(reading_raw))
    if not reading:
        return None

    if not is_kana_only_reading(reading, allow_alnum=False):
        return None
    if contains_obsolete_kana(reading):
        return None
    if is_one_mora_word(reading):
        return None
    if ends_with_n(reading):
        return None

    first = effective_first_mora(reading)
    if not first:
        return None

    return surface, reading, category


def build_pool(csv_paths: list[Path], out_db: Path) -> int:
    out_db.parent.mkdir(parents=True, exist_ok=True)
    if out_db.exists():
        out_db.unlink()

    conn = sqlite3.connect(out_db)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=OFF")
    conn.executescript(SCHEMA)

    seen: set[str] = set()
    batch: list[tuple[str, str, str, str]] = []
    total = 0
    skipped = 0
    BATCH_SIZE = 5000

    def flush() -> None:
        nonlocal total, batch
        if not batch:
            return
        conn.executemany(
            "INSERT INTO vocab(surface, reading, first_mora, category) VALUES (?, ?, ?, ?)",
            batch,
        )
        total += len(batch)
        batch = []

    for csv_path in csv_paths:
        print(f"読み込み: {csv_path.name}")
        with open(csv_path, encoding="utf-8", errors="replace", newline="") as f:
            reader = csv.reader(f)
            for row in reader:
                parsed = _parse_row(row)
                if parsed is None:
                    skipped += 1
                    continue
                surface, reading, category = parsed
                if reading in seen:
                    skipped += 1
                    continue
                seen.add(reading)
                first = effective_first_mora(reading) or reading[0]
                batch.append((surface, reading, first, category))
                if len(batch) >= BATCH_SIZE:
                    flush()
                    print(
                        f"\r  登録 {total + len(batch)} / skip {skipped}",
                        end="",
                        flush=True,
                    )
        flush()
        print(f"\r  {csv_path.name}: 累計 {total} 語 (skip {skipped})")

    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
        ("entry_count", str(total)),
    )
    for row in conn.execute(
        "SELECT category, COUNT(*) FROM vocab GROUP BY category ORDER BY category"
    ):
        print(f"  category {row[0]}: {row[1]}")
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
            (f"count_{row[0]}", str(row[1])),
        )

    conn.commit()
    conn.close()
    print(f"書き出し: {out_db} ({total} 語)")
    return total


def main(argv: list[str] | None = None) -> int:
    argv = list(argv if argv is not None else sys.argv[1:])
    raw_dir = DEFAULT_RAW_DIR
    cache_dir = DEFAULT_CACHE_DIR
    auto_download = "--download" in argv
    all_lex = "--all-lex" in argv
    argv = [a for a in argv if a not in ("--download", "--all-lex")]

    if auto_download:
        download_sudachi(raw_dir)

    csvs = _find_lex_csvs(raw_dir, small_only=not all_lex)
    if not csvs:
        print(
            "SudachiDict CSV が見つかりません。\n"
            "  python -m shiritori_bot.data_prep.download\n"
            "  または: python -m shiritori_bot.data_prep.build_vocab_pool --download",
            file=sys.stderr,
        )
        return 1

    print(f"対象 CSV: {[p.name for p in csvs]}")
    if not all_lex:
        print("  (small_lex のみ。全 lex を使用する場合は --all-lex)")
    out = cache_dir / VOCAB_DB_NAME
    build_pool(csvs, out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
