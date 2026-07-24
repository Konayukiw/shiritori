from __future__ import annotations

import json
import re
import sqlite3
import threading
import urllib.request
import zipfile
import csv
from pathlib import Path

from flask import Flask, jsonify, render_template, request

from bot.config import GameConfig, default_config
from bot.core.bot_word_selector import BotWordSelector, VocabPool
from bot.core.kana_utils import (
    contains_obsolete_kana,
    is_allowed_surface,
    is_kana_only_reading,
    normalize_reading,
    to_hiragana,
)
from bot.core.opponent_word_validator import JmdictIndex, OpponentWordValidator
from bot.core.rules import (
    effective_first_mora,
    effective_last_mora,
    ends_with_n,
    is_one_mora_word,
)
from bot.game.session import GameState

_USER_DATA_DIR = Path.home() / ".shiritori-bot"
_USER_CACHE_DIR = _USER_DATA_DIR / "data" / "cache"
_USER_RAW_DIR = _USER_DATA_DIR / "data" / "raw"

JMDICT_DB_NAME = "jmdict.sqlite3"
VOCAB_DB_NAME = "vocab_pool.sqlite3"

SUDACHI_RAW_BASE = "http://sudachi.s3-website-ap-northeast-1.amazonaws.com/sudachidict-raw"
SUDACHI_RELEASE = "20260428"
SUDACHI_FILES = ("small_lex.zip",)

JMDICT_API = "https://api.github.com/repos/scriptin/jmdict-simplified/releases/latest"

_JMDICT_SCHEMA = """
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

_VOCAB_SCHEMA = """
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
            if reading:
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


def _build_jmdict_index(jmdict_json: Path, jmnedict_json: Path | None, out_db: Path, log_func) -> None:
    out_db.parent.mkdir(parents=True, exist_ok=True)
    if out_db.exists():
        out_db.unlink()
    conn = sqlite3.connect(out_db)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=OFF")
    conn.executescript(_JMDICT_SCHEMA)
    total = 0
    batch: list[tuple[str, str, str]] = []
    BATCH_SIZE = 5000

    def flush():
        nonlocal total, batch
        if not batch:
            return
        conn.executemany(
            "INSERT INTO entries(surface, reading, source) VALUES (?, ?, ?)", batch
        )
        total += len(batch)
        batch = []

    log_func("語彙を読み込み中... (1/3)")
    with open(jmdict_json, encoding="utf-8") as f:
        data = json.load(f)
    words = data.get("words") or []
    for pair in _iter_word_pairs(words, "jmdict"):
        batch.append(pair)
        if len(batch) >= BATCH_SIZE:
            flush()
    flush()

    if jmnedict_json and jmnedict_json.exists():
        log_func("語彙を読み込み中... (2/3)")
        with open(jmnedict_json, encoding="utf-8") as f:
            data = json.load(f)
        words = data.get("words") or []
        for pair in _iter_word_pairs(words, "jmnedict"):
            batch.append(pair)
            if len(batch) >= BATCH_SIZE:
                flush()
        flush()

    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
        ("entry_count", str(total)),
    )
    conn.commit()
    conn.close()
    log_func(f"  → {out_db.name} 完了 ({total} 行)")


def _classify_pos(pos1: str, pos2: str, pos3: str) -> str | None:
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


def _build_vocab_pool(csv_paths: list[Path], out_db: Path, log_func) -> None:
    out_db.parent.mkdir(parents=True, exist_ok=True)
    if out_db.exists():
        out_db.unlink()
    conn = sqlite3.connect(out_db)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=OFF")
    conn.executescript(_VOCAB_SCHEMA)
    seen: set[str] = set()
    batch: list[tuple[str, str, str, str]] = []
    total = 0
    skipped = 0
    BATCH_SIZE = 5000

    def flush():
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
        log_func(f"語彙を読み込み中... (3/3)")
        with open(csv_path, encoding="utf-8", errors="replace", newline="") as f:
            reader = csv.reader(f)
            for row in reader:
                if len(row) < 12:
                    skipped += 1
                    continue
                surface = (row[4] or row[0] or "").strip()
                reading_raw = (row[11] or "").strip()
                pos1 = (row[5] or "").strip()
                pos2 = (row[6] or "").strip()
                pos3 = (row[7] or "").strip()
                cform = (row[10] or "").strip() if len(row) > 10 else ""
                norm = (row[12] or "").strip() if len(row) > 12 else ""

                if not surface or not reading_raw or reading_raw == "*":
                    skipped += 1
                    continue
                if pos1 in ("動詞", "形容詞") and not cform.startswith("終止形"):
                    skipped += 1
                    continue

                category = _classify_pos(pos1, pos2, pos3)
                if category is None:
                    skipped += 1
                    continue
                if pos1 in ("動詞", "形容詞") and norm and norm != "*":
                    surface = norm
                if not is_allowed_surface(surface, allow_alnum=False):
                    skipped += 1
                    continue

                reading = to_hiragana(normalize_reading(reading_raw))
                if not reading:
                    skipped += 1
                    continue
                if not is_kana_only_reading(reading, allow_alnum=False):
                    skipped += 1
                    continue
                if contains_obsolete_kana(reading):
                    skipped += 1
                    continue
                if is_one_mora_word(reading):
                    skipped += 1
                    continue
                if ends_with_n(reading):
                    skipped += 1
                    continue
                if reading in seen:
                    skipped += 1
                    continue
                seen.add(reading)
                first = effective_first_mora(reading) or reading[0]
                batch.append((surface, reading, first, category))
                if len(batch) >= BATCH_SIZE:
                    flush()
        flush()

    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
        ("entry_count", str(total)),
    )
    conn.commit()
    conn.close()


def _download(url: str, dest: Path, log_func) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 0:
        return
    log_func(f"  ダウンロード中: {dest.name} ...")
    req = urllib.request.Request(url, headers={"User-Agent": "shiritori-bot/0.1"})
    with urllib.request.urlopen(req, timeout=600) as resp, open(dest, "wb") as f:
        total_n = int(resp.headers.get("Content-Length") or 0)
        downloaded = 0
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk:
                break
            f.write(chunk)
            downloaded += len(chunk)
            if total_n:
                pct = downloaded * 100 // total_n
                log_func(f"    {pct}% ({downloaded // 1024 // 1024} MB)")
    log_func(f"  → {dest.name} 完了")


def _unzip(zip_path: Path, out_dir: Path, log_func) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    extracted: list[Path] = []
    with zipfile.ZipFile(zip_path, "r") as zf:
        for name in zf.namelist():
            if name.endswith("/"):
                continue
            target = out_dir / Path(name).name
            if not target.exists():
                with zf.open(name) as src, open(target, "wb") as dst:
                    dst.write(src.read())
            extracted.append(target)
    return extracted


def _fetch_latest_jmdict_assets(log_func) -> dict[str, str]:
    log_func("最新の語彙を確認中…")
    req = urllib.request.Request(JMDICT_API, headers={"User-Agent": "shiritori-bot/0.1"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    assets = {a["name"]: a["browser_download_url"] for a in data.get("assets", [])}
    result: dict[str, str] = {}
    for key, pattern in (
        ("jmdict", re.compile(r"^jmdict-eng-\d.+\.json\.zip$")),
        ("jmnedict", re.compile(r"^jmnedict-all-\d.+\.json\.zip$")),
    ):
        candidates = [
            (name, url)
            for name, url in assets.items()
            if pattern.match(name) and "common" not in name and "examples" not in name
        ]
        if not candidates:
            raise RuntimeError(f"リリースに {key} の zip が見つかりません")
        candidates.sort(key=lambda x: x[0])
        result[key] = candidates[-1][1]
        log_func(f"  {key}: {candidates[-1][0]}")
    return result

app = Flask(__name__)

_game_lock = threading.Lock()

_state: dict = {
    "setup_done": False,
    "setup_log": [],
    "config": default_config(),
    "jmdict": None,
    "pool": None,
    "validator": None,
    "selector": None,
    "game": None,
}


def _log_msg(msg: str) -> None:
    _state["setup_log"].append(msg)


def _setup_worker() -> None:
    try:
        jmdict_db = _USER_CACHE_DIR / JMDICT_DB_NAME
        vocab_db = _USER_CACHE_DIR / VOCAB_DB_NAME

        if jmdict_db.exists() and vocab_db.exists():
            _log_msg("データベースは既に存在します。")
            _finish_init()
            return

        _log_msg("データをダウンロード中... (1/4)")
        urls = _fetch_latest_jmdict_assets(_log_msg)

        jmdict_zip = _USER_RAW_DIR / urls["jmdict"].rstrip("/").split("/")[-1]
        _download(urls["jmdict"], jmdict_zip, _log_msg)
        jmdict_files = _unzip(jmdict_zip, _USER_RAW_DIR / "jmdict", _log_msg)
        jmdict_json = next((p for p in jmdict_files if p.suffix == ".json"), None)
        if not jmdict_json:
            raise RuntimeError("JMdictにJSONファイルが見つかりません")

        jmnedict_zip = _USER_RAW_DIR / urls["jmnedict"].rstrip("/").split("/")[-1]
        _download(urls["jmnedict"], jmnedict_zip, _log_msg)
        jmnedict_files = _unzip(jmnedict_zip, _USER_RAW_DIR / "jmnedict", _log_msg)
        jmnedict_json = next((p for p in jmnedict_files if p.suffix == ".json"), None)

        sudachi_dir = _USER_RAW_DIR / "sudachi"
        for fname in SUDACHI_FILES:
            url = f"{SUDACHI_RAW_BASE}/{SUDACHI_RELEASE}/{fname}"
            zip_path = sudachi_dir / fname
            _download(url, zip_path, _log_msg)
            _unzip(zip_path, sudachi_dir, _log_msg)
        csv_paths = sorted(sudachi_dir.glob("*lex*"))
        if not csv_paths:
            raise RuntimeError("SudachiDictにCSVファイルが見つかりません")

        _log_msg("データをダウンロード中... (2/4)")
        _build_jmdict_index(jmdict_json, jmnedict_json, jmdict_db, _log_msg)

        _log_msg("データをダウンロード中... (3/4)")
        _build_vocab_pool(csv_paths, vocab_db, _log_msg)

        _log_msg("データをダウンロード中... (4/4)")
        _finish_init()

    except Exception as e:
        _log_msg(f"セットアップが失敗しました: {e}")
        import traceback
        _log_msg(traceback.format_exc())


def _finish_init() -> None:
    config = default_config()
    config.data_dir = _USER_DATA_DIR / "data"
    config.cache_dir = _USER_CACHE_DIR

    jmdict = JmdictIndex(_USER_CACHE_DIR / JMDICT_DB_NAME)
    pool = VocabPool(_USER_CACHE_DIR / VOCAB_DB_NAME)
    validator = OpponentWordValidator(jmdict, config)
    selector = BotWordSelector(pool, config)
    game = GameState(config=config)

    with _game_lock:
        _state["config"] = config
        _state["jmdict"] = jmdict
        _state["pool"] = pool
        _state["validator"] = validator
        _state["selector"] = selector
        _state["game"] = game
        _state["setup_done"] = True

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def api_status():
    with _game_lock:
        game = _state["game"]
    if game is None:
        return jsonify({
            "setup_done": False,
            "turn_count": 0,
            "last_surface": "",
            "expected_first_mora": "",
            "used_count": 0,
            "setup_log": _state["setup_log"],
            "game_over": False,
            "game_result": "",
        })
    return jsonify({
        "setup_done": _state["setup_done"],
        "turn_count": game.turn_count,
        "last_surface": game.last_surface or "",
        "expected_first_mora": game.expected_first_mora or "",
        "used_count": len(game.used_readings),
        "setup_log": _state["setup_log"],
        "game_over": False,
        "game_result": "",
    })


@app.route("/api/log")
def api_log():
    return jsonify({"log": _state["setup_log"]})


@app.route("/api/submit", methods=["POST"])
def api_submit():
    with _game_lock:
        validator = _state["validator"]
        selector = _state["selector"]
        game = _state["game"]
        config = _state["config"]

    if not _state["setup_done"] or game is None or validator is None or selector is None:
        return jsonify({"ok": False, "reason": "準備中です。しばらくお待ちください。"})

    data = request.get_json()
    user_input = (data.get("word") or "").strip()

    if not user_input:
        return jsonify({"ok": False, "reason": "単語を入力してください。"})

    result = validator.validate(
        user_input,
        expected_last_mora=game.expected_first_mora,
        used_readings=game.used_readings,
    )

    if not result.ok:
        return jsonify({
            "ok": False,
            "reason": result.reason,
            "user_word": user_input,
            "user_reading": "",
        })

    with _game_lock:
        game.mark_used(result.reading, result.surface, "user")
        user_turn = game.turn_count
        user_reading = result.reading

    if result.lost:
        with _game_lock:
            game_over_msg = f"今回の対戦は {game.turn_count} ターンで終了しました。"
        return jsonify({
            "ok": True,
            "user_word": result.surface,
            "user_reading": result.reading,
            "game_over": True,
            "game_result": result.reason,
            "game_over_msg": game_over_msg,
            "turn_count": user_turn,
        })

    bot_word = selector.select(
        result.effective_last_mora or "", game.used_readings
    )

    if bot_word is None:
        with _game_lock:
            game_over_msg = f"今回の対戦は {game.turn_count} ターンで終了しました。"
        return jsonify({
            "ok": True,
            "user_word": result.surface,
            "user_reading": result.reading,
            "game_over": True,
            "game_result": "参りました、私の負けです。",
            "game_over_msg": game_over_msg,
            "turn_count": user_turn,
        })

    with _game_lock:
        game.mark_used(bot_word.reading, bot_word.surface, "bot")
        final_game = game
        expected = game.expected_first_mora or ""
        turn_count = game.turn_count
        used_count = len(game.used_readings)

    return jsonify({
        "ok": True,
        "user_word": result.surface,
        "user_reading": result.reading,
        "bot_word": bot_word.surface,
        "bot_reading": bot_word.reading,
        "expected_first_mora": expected,
        "turn_count": turn_count,
        "used_count": used_count,
        "game_over": False,
        "last_surface": final_game.last_surface or "",
    })


@app.route("/api/restart", methods=["POST"])
def api_restart():
    data = request.get_json() or {}
    bot_first = data.get("bot_first", False)

    with _game_lock:
        if _state["game"] is not None:
            _state["game"].reset()
        game = _state["game"]
        selector = _state["selector"]

    events: list[dict] = []
    events.append({"sender": "システム", "message": "対局をリセットしました。好きな語から始めてください。"})

    if bot_first and game is not None and selector is not None:
        start = selector.select("し", set())
        with _game_lock:
            if start is None:
                game.mark_used("しりとり", "しりとり", "bot")
                events.append({"sender": "Bot", "message": "しりとり（しりとり）"})
                expected = game.expected_first_mora or ""
            else:
                game.mark_used(start.reading, start.surface, "bot")
                events.append({"sender": "Bot", "message": f"{start.surface}（{start.reading}）"})
                expected = game.expected_first_mora or ""
            turn = game.turn_count
            used = len(game.used_readings)
    else:
        with _game_lock:
            expected = game.expected_first_mora if game else ""
            turn = game.turn_count if game else 0
            used = len(game.used_readings) if game else 0

    return jsonify({
        "ok": True,
        "events": events,
        "expected_first_mora": expected or "",
        "turn_count": turn,
        "used_count": used,
    })


@app.route("/api/apply_settings", methods=["POST"])
def api_apply_settings():
    data = request.get_json() or {}
    cfg = default_config()
    cfg.allow_person = data.get("allow_person", False)
    cfg.allow_place = data.get("allow_place", False)
    cfg.allow_organization = data.get("allow_org", False)
    cfg.allow_proper = data.get("allow_proper", False)
    cfg.allow_other = data.get("allow_other", False)
    cfg.allow_verb = data.get("allow_verb", False)
    require_dakuten_match = not data.get("ignore_dakuten", False)
    cfg.require_dakuten_match = require_dakuten_match
    cfg.allow_alnum = data.get("allow_alnum", False)
    cfg.data_dir = _USER_DATA_DIR / "data"
    cfg.cache_dir = _USER_CACHE_DIR

    bot_first = data.get("bot_first", False)

    with _game_lock:
        _state["config"] = cfg
        if _state["game"] is not None:
            _state["game"].reset()
            _state["game"].config = cfg
        if _state["validator"] is not None:
            _state["validator"] = OpponentWordValidator(_state["jmdict"], cfg)
        if _state["selector"] is not None:
            _state["selector"] = BotWordSelector(_state["pool"], cfg)
        _state["setup_log"].clear()
        game = _state["game"]
        selector = _state["selector"]

    events: list[dict] = []
    events.append({"sender": "システム", "message": "設定を適用し、対局をリセットしました。"})

    if bot_first and game is not None and selector is not None:
        start = selector.select("し", set())
        with _game_lock:
            if start is None:
                game.mark_used("しりとり", "しりとり", "bot")
                events.append({"sender": "Bot", "message": "しりとり（しりとり）"})
                expected = game.expected_first_mora or ""
            else:
                game.mark_used(start.reading, start.surface, "bot")
                events.append({"sender": "Bot", "message": f"{start.surface}（{start.reading}）"})
                expected = game.expected_first_mora or ""
            turn = game.turn_count
            used = len(game.used_readings)
    else:
        with _game_lock:
            expected = game.expected_first_mora if game else ""
            turn = game.turn_count if game else 0
            used = len(game.used_readings) if game else 0

    return jsonify({
        "ok": True,
        "events": events,
        "expected_first_mora": expected or "",
        "turn_count": turn,
        "used_count": used,
    })


def _start_background_setup():
    t = threading.Thread(target=_setup_worker, daemon=True)
    t.start()


_start_background_setup()


def main():
    app.run(host="0.0.0.0", port=5000, debug=True, threaded=True)


if __name__ == "__main__":
    main()