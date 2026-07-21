from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

from shiritori_bot.config import DEFAULT_CACHE_DIR, DEFAULT_RAW_DIR, JMDICT_DB_NAME
from shiritori_bot.core.kana_utils import normalize_reading, to_hiragana
from shiritori_bot.data_prep.download import download_jmdict


SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    surface TEXT NOT NULL,
    reading TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('jmdict', 'jmnedict'))
);

CREATE INDEX IF NOT EXISTS idx_entries_surface ON entries(surface);
CREATE INDEX IF NOT EXISTS idx_entries_reading ON entries(reading);
CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source);
"""


def _find_json(raw_dir: Path, key: str) -> Path | None:
    d = raw_dir / key
    if d.is_dir():
        files = sorted(d.glob("*.json"))
        if files:
            return files[0]
    files = sorted(raw_dir.glob(f"*{key}*.json"))
    if files:
        return files[0]
    if key == "jmdict":
        files = sorted(raw_dir.glob("jmdict*.json"))
        files = [f for f in files if "jmnedict" not in f.name]
        if files:
            return files[0]
    return None


def _iter_word_pairs(words: list[dict], source: str):
    for word in words:
        kanji_list = word.get("kanji") or []
        kana_list = word.get("kana") or []
        if not kana_list:
            continue

        for kana in kana_list:
            ktext = (kana.get("text") or "").strip()
            if not ktext:
                continue
            reading = to_hiragana(normalize_reading(ktext))
            if not reading:
                continue
            yield ktext, reading, source

        for kj in kanji_list:
            stext = (kj.get("text") or "").strip()
            if not stext:
                continue
            chosen = None
            for kana in kana_list:
                applies = kana.get("appliesToKanji") or ["*"]
                if "*" in applies or stext in applies:
                    chosen = kana.get("text") or ""
                    break
            if not chosen and kana_list:
                chosen = kana_list[0].get("text") or ""
            if not chosen:
                continue
            reading = to_hiragana(normalize_reading(chosen))
            if reading:
                yield stext, reading, source


def build_index(
    jmdict_json: Path,
    jmnedict_json: Path | None,
    out_db: Path,
    *,
    include_jmnedict: bool = True,
) -> int:
    out_db.parent.mkdir(parents=True, exist_ok=True)
    if out_db.exists():
        out_db.unlink()

    conn = sqlite3.connect(out_db)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=OFF")
    conn.executescript(SCHEMA)

    total = 0
    batch: list[tuple[str, str, str]] = []
    BATCH_SIZE = 5000

    def flush() -> None:
        nonlocal total, batch
        if not batch:
            return
        conn.executemany(
            "INSERT INTO entries(surface, reading, source) VALUES (?, ?, ?)",
            batch,
        )
        total += len(batch)
        batch = []

    print(f"JMdict 読み込み: {jmdict_json}")
    with open(jmdict_json, encoding="utf-8") as f:
        data = json.load(f)
    words = data.get("words") or []
    print(f"  エントリ数: {len(words)}")
    for pair in _iter_word_pairs(words, "jmdict"):
        batch.append(pair)
        if len(batch) >= BATCH_SIZE:
            flush()
            print(f"\r  登録中... {total + len(batch)}", end="", flush=True)
    flush()
    print(f"\r  JMdict 完了: {total} 行")

    if include_jmnedict and jmnedict_json and jmnedict_json.exists():
        print(f"JMnedict 読み込み: {jmnedict_json}")
        with open(jmnedict_json, encoding="utf-8") as f:
            data = json.load(f)
        words = data.get("words") or []
        print(f"  エントリ数: {len(words)}")
        before = total
        for pair in _iter_word_pairs(words, "jmnedict"):
            batch.append(pair)
            if len(batch) >= BATCH_SIZE:
                flush()
                print(f"\r  登録中... {total + len(batch)}", end="", flush=True)
        flush()
        print(f"\r  JMnedict 完了: +{total - before} 行 (合計 {total})")

    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
        ("entry_count", str(total)),
    )
    conn.commit()
    conn.close()
    print(f"書き出し: {out_db} ({total} 行)")
    return total


def main(argv: list[str] | None = None) -> int:
    argv = list(argv if argv is not None else sys.argv[1:])
    raw_dir = DEFAULT_RAW_DIR
    cache_dir = DEFAULT_CACHE_DIR
    auto_download = "--download" in argv
    argv = [a for a in argv if a != "--download"]

    if auto_download:
        download_jmdict(raw_dir)

    jmdict = _find_json(raw_dir, "jmdict")
    jmnedict = _find_json(raw_dir, "jmnedict")

    if jmdict is None:
        print(
            "JMdict JSON が見つかりません。\n"
            "  python -m shiritori_bot.data_prep.download\n"
            "  または: python -m shiritori_bot.data_prep.build_jmdict_index --download",
            file=sys.stderr,
        )
        return 1

    out = cache_dir / JMDICT_DB_NAME
    build_index(jmdict, jmnedict, out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
