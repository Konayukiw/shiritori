from __future__ import annotations

import json
import re
import sqlite3
import sys
import tempfile
import threading
import urllib.request
import zipfile
from pathlib import Path

import flet as ft

from shiritori_bot.config import GameConfig, default_config
from shiritori_bot.core.bot_word_selector import BotWordSelector, VocabPool
from shiritori_bot.core.kana_utils import (
    contains_obsolete_kana,
    is_allowed_surface,
    is_kana_only_reading,
    normalize_reading,
    to_hiragana,
)
from shiritori_bot.core.opponent_word_validator import JmdictIndex, OpponentWordValidator
from shiritori_bot.core.rules import (
    check_default_bans,
    effective_first_mora,
    effective_last_mora,
    ends_with_n,
    is_one_mora_word,
    mora_matches,
)
from shiritori_bot.game.session import GameState

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


def _build_jmdict_index(jmdict_json: Path, jmnedict_json: Path | None, out_db: Path, log) -> None:
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

    log("語彙を読み込み中... (1/3)")
    with open(jmdict_json, encoding="utf-8") as f:
        data = json.load(f)
    words = data.get("words") or []
    for pair in _iter_word_pairs(words, "jmdict"):
        batch.append(pair)
        if len(batch) >= BATCH_SIZE:
            flush()
    flush()

    if jmnedict_json and jmnedict_json.exists():
        log("語彙を読み込み中... (2/3)")
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
    log(f"  → {out_db.name} 完了 ({total} 行)")

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


def _build_vocab_pool(csv_paths: list[Path], out_db: Path, log) -> None:
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
        log(f"語彙を読み込み中... (3/3)")
        import csv

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


def _download(url: str, dest: Path, log) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 0:
        return
    log(f"  ダウンロード中: {dest.name}")
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
                log(f"    {pct}% ({downloaded // 1024 // 1024} MB)")
    log(f"  → {dest.name} 完了")


def _unzip(zip_path: Path, out_dir: Path, log) -> list[Path]:
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


def _fetch_latest_jmdict_assets(log) -> dict[str, str]:
    log("最新の語彙を確認中…")
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
        log(f"  {key}: {candidates[-1][0]}")
    return result


class ShiritoriApp:
    def __init__(self, page: ft.Page) -> None:
        self.page = page
        self.page.title = "しりとり Bot"
        self.page.theme_mode = ft.ThemeMode.LIGHT
        self.page.window.width = 1300
        self.page.window.height = 860
        self.page.window.min_width = 520
        self.page.window.min_height = 600
        self.page.padding = 10
        self.page.scroll = ft.ScrollMode.HIDDEN

        self.jmdict: JmdictIndex | None = None
        self.pool: VocabPool | None = None
        self.validator: OpponentWordValidator | None = None
        self.selector: BotWordSelector | None = None
        self.state: GameState | None = None
        self.config: GameConfig = default_config()

        self._setup_done = False

        self._build_ui()
        self._start_setup()


    def _build_ui(self) -> None:
        self.cb_person = ft.Checkbox(label="人名を許可", value=False)
        self.cb_place = ft.Checkbox(label="地名を許可", value=False)
        self.cb_org = ft.Checkbox(label="組織名を許可", value=False)
        self.cb_proper = ft.Checkbox(label="固有名詞(一般)を許可", value=False)
        self.cb_other = ft.Checkbox(label="その他カテゴリを許可", value=False)
        self.cb_verb = ft.Checkbox(label="動詞を許可", value=False)
        self.cb_ignore_dakuten = ft.Checkbox(
            label="濁点・半濁点の違いを無視", value=False
        )
        self.cb_allow_alnum = ft.Checkbox(label="英数字を許可", value=False)
        self.cb_bot_first = ft.Checkbox(label="Bot から開始", value=False)

        settings_col = ft.Column(
            [
                ft.Text("設定", weight=ft.FontWeight.BOLD, size=16),
                self.cb_person,
                self.cb_place,
                self.cb_org,
                self.cb_proper,
                self.cb_other,
                self.cb_verb,
                self.cb_ignore_dakuten,
                self.cb_allow_alnum,
                self.cb_bot_first,
                ft.ElevatedButton(
                    "設定を適用して再開",
                    on_click=self._on_apply_settings,
                    icon=ft.Icons.REFRESH,
                ),
            ],
            spacing=2,
            scroll=ft.ScrollMode.AUTO,
        )

        self.log_area = ft.ListView(spacing=4, auto_scroll=True)

        self.status_text = ft.Text("準備中…", size=14)

        self.word_input = ft.TextField(
            hint_text="単語を入力…",
            on_submit=self._on_submit,
            expand=True,
            disabled=True,
            autofocus=True,
        )
        self.submit_btn = ft.ElevatedButton("送信", on_click=self._on_submit, disabled=True)
        self.restart_btn = ft.ElevatedButton(
            "リセット", on_click=self._on_restart, icon=ft.Icons.RESTART_ALT
        )
        input_row = ft.Row([self.word_input, self.submit_btn, self.restart_btn], spacing=8)

        self.page.add(
            ft.Row(
                [
                    ft.Container(
                        content=settings_col,
                        width=220,
                        padding=8,
                        border=ft.Border.all(1, ft.Colors.GREY_300),
                        border_radius=8,
                    ),
                    ft.Container(
                        content=ft.Column(
                            [
                                ft.Container(
                                    content=self.log_area,
                                    height=700,
                                    border=ft.Border.all(1, ft.Colors.GREY_300),
                                    border_radius=8,
                                    padding=8,
                                ),
                                self.status_text,
                                input_row,
                            ],
                            spacing=8,
                            expand=False,
                        ),
                        expand=True,
                    ),
                ],
                expand=True,
                spacing=8,
                vertical_alignment=ft.CrossAxisAlignment.START,
            )
        )


    def _start_setup(self) -> None:
        self._log("システム", "初回セットアップを開始します…")
        self._log("システム", f"データ保存先: {_USER_DATA_DIR}")
        self.page.update()

        t = threading.Thread(target=self._setup_worker, daemon=True)
        t.start()

    def _setup_worker(self) -> None:
        try:
            jmdict_db = _USER_CACHE_DIR / JMDICT_DB_NAME
            vocab_db = _USER_CACHE_DIR / VOCAB_DB_NAME

            if jmdict_db.exists() and vocab_db.exists():
                self._log("システム", "データベースは既に存在します。")
                self._finish_setup()
                return

            self._log("システム", "データをダウンロード中... (1/4)")
            urls = _fetch_latest_jmdict_assets(lambda msg: self._log("システム", msg))

            jmdict_zip = _USER_RAW_DIR / urls["jmdict"].rstrip("/").split("/")[-1]
            _download(urls["jmdict"], jmdict_zip, lambda msg: self._log("システム", msg))
            jmdict_files = _unzip(jmdict_zip, _USER_RAW_DIR / "jmdict", lambda msg: self._log("システム", msg))
            jmdict_json = next((p for p in jmdict_files if p.suffix == ".json"), None)
            if not jmdict_json:
                raise RuntimeError("JMdictにJSONファイルが見つかりません")

            jmnedict_zip = _USER_RAW_DIR / urls["jmnedict"].rstrip("/").split("/")[-1]
            _download(urls["jmnedict"], jmnedict_zip, lambda msg: self._log("システム", msg))
            jmnedict_files = _unzip(jmnedict_zip, _USER_RAW_DIR / "jmnedict", lambda msg: self._log("システム", msg))
            jmnedict_json = next((p for p in jmnedict_files if p.suffix == ".json"), None)

            sudachi_dir = _USER_RAW_DIR / "sudachi"
            for fname in SUDACHI_FILES:
                url = f"{SUDACHI_RAW_BASE}/{SUDACHI_RELEASE}/{fname}"
                zip_path = sudachi_dir / fname
                _download(url, zip_path, lambda msg: self._log("システム", msg))
                _unzip(zip_path, sudachi_dir, lambda msg: self._log("システム", msg))
            csv_paths = sorted(sudachi_dir.glob("*lex*"))
            if not csv_paths:
                raise RuntimeError("SudachiDictにCSVファイルが見つかりません")

            self._log("システム", "データをダウンロード中... (2/4)")
            _build_jmdict_index(jmdict_json, jmnedict_json, jmdict_db, lambda msg: self._log("システム", msg))

            self._log("システム", "データをダウンロード中... (3/4)")
            _build_vocab_pool(csv_paths, vocab_db, lambda msg: self._log("システム", msg))

            self._log("システム", "データをダウンロード中... (4/4)")
            self._finish_setup()

        except Exception as e:
            self._log("エラー", f"セットアップが失敗しました: {e}")
            import traceback

            self._log("エラー", traceback.format_exc())

    def _finish_setup(self) -> None:
        try:
            self.config = default_config()
            self.config.data_dir = _USER_DATA_DIR / "data"
            self.config.cache_dir = _USER_CACHE_DIR

            self._init_game_objects()

            self.word_input.disabled = False
            self.submit_btn.disabled = False
            self._setup_done = True

            self._log("システム", "しりとり Bot へようこそ！")
            self._log("システム", "好きな単語を入力して遊んでください。")
            self._update_status()
            self.page.update()
            # Worker thread: schedule async focus on the page event loop.
            self.page.run_task(self._refocus_input)
        except Exception as e:
            self._log("エラー", f"ゲーム初期化に失敗しました: {e}")

    def _init_game_objects(self) -> None:
        jmdict_db = _USER_CACHE_DIR / JMDICT_DB_NAME
        vocab_db = _USER_CACHE_DIR / VOCAB_DB_NAME

        self.jmdict = JmdictIndex(jmdict_db)
        self.pool = VocabPool(vocab_db)
        self.validator = OpponentWordValidator(self.jmdict, self.config)
        self.selector = BotWordSelector(self.pool, self.config)
        self.state = GameState(config=self.config)

    async def _refocus_input(self) -> None:
        """Keep the word input focused so the next word can be typed immediately.

        Flet 0.86+ exposes focus() as an async method that must be awaited;
        calling it without await creates a no-op coroutine.
        """
        if not self._setup_done or self.word_input.disabled:
            return
        try:
            await self.word_input.focus()
        except Exception:
            pass

    async def _on_apply_settings(self, e: ft.ControlEvent) -> None:
        if not self._setup_done:
            return
        cfg = default_config()
        cfg.allow_person = self.cb_person.value
        cfg.allow_place = self.cb_place.value
        cfg.allow_organization = self.cb_org.value
        cfg.allow_proper = self.cb_proper.value
        cfg.allow_other = self.cb_other.value
        cfg.allow_verb = self.cb_verb.value
        cfg.require_dakuten_match = not self.cb_ignore_dakuten.value
        cfg.allow_alnum = self.cb_allow_alnum.value
        self.config = cfg

        if self.state is not None:
            self.state.reset()
        if self.validator is not None:
            self.validator = OpponentWordValidator(self.jmdict, self.config)
        if self.selector is not None:
            self.selector = BotWordSelector(self.pool, self.config)
        if self.state is not None:
            self.state.config = self.config

        self.word_input.disabled = False
        self.submit_btn.disabled = False
        self.word_input.value = ""
        self.log_area.controls.clear()
        self._log("システム", "設定を適用し、対局をリセットしました。")
        if self.cb_bot_first.value:
            self._bot_turn_first()
        self._update_status()
        self.page.update()
        await self._refocus_input()

    async def _on_submit(self, e: ft.ControlEvent) -> None:
        if not self._setup_done or self.state is None or self.validator is None or self.selector is None:
            return
        if self.word_input.disabled:
            return

        user_input = (self.word_input.value or "").strip()
        self.word_input.value = ""

        if not user_input:
            self.page.update()
            await self._refocus_input()
            return

        result = self.validator.validate(
            user_input,
            expected_last_mora=self.state.expected_first_mora,
            used_readings=self.state.used_readings,
        )
        if not result.ok:
            self._log("あなた", f"{user_input} → × {result.reason}")
            self._update_status()
            self.page.update()
            await self._refocus_input()
            return

        self.state.mark_used(result.reading, result.surface, "user")
        self._log("あなた", f"{result.surface}（{result.reading}）")

        if result.lost:
            self._log("結果", result.reason)
            self._log("結果", f"今回の対戦は {self.state.turn_count} ターンで終了しました。")
            self.word_input.disabled = True
            self.submit_btn.disabled = True
            self._update_status()
            self.page.update()
            return

        bot_word = self.selector.select(
            result.effective_last_mora or "", self.state.used_readings
        )
        if bot_word is None:
            self._log("Bot", "参りました、私の負けです。")
            self._log("結果", f"今回の対戦は {self.state.turn_count} ターンで終了しました。")
            self.word_input.disabled = True
            self.submit_btn.disabled = True
            self._update_status()
            self.page.update()
            return

        self.state.mark_used(bot_word.reading, bot_word.surface, "bot")
        self._log("Bot", f"{bot_word.surface}（{bot_word.reading}）")
        self._log("システム", f"→ 次は『{self.state.expected_first_mora}』から")
        self._update_status()
        self.page.update()
        await self._refocus_input()

    async def _on_restart(self, e: ft.ControlEvent) -> None:
        if not self._setup_done:
            return
        if self.state is not None:
            self.state.reset()
        self.log_area.controls.clear()
        self.word_input.disabled = False
        self.submit_btn.disabled = False
        self.word_input.value = ""
        self._log("システム", "対局をリセットしました。好きな語から始めてください。")
        if self.cb_bot_first.value:
            self._bot_turn_first()
        self._update_status()
        self.page.update()
        await self._refocus_input()


    def _bot_turn_first(self) -> None:
        if self.selector is None or self.state is None:
            return
        start = self.selector.select("し", set())
        if start is None:
            self.state.mark_used("しりとり", "しりとり", "bot")
            self._log("Bot", "しりとり（しりとり）")
        else:
            self.state.mark_used(start.reading, start.surface, "bot")
            self._log("Bot", f"{start.surface}（{start.reading}）")
        self._log("システム", f"→ 次は『{self.state.expected_first_mora}』から")

    def _log(self, sender: str, message: str) -> None:
        color_map = {
            "あなた": ft.Colors.BLUE_700,
            "Bot": ft.Colors.GREEN_700,
            "システム": ft.Colors.GREY_700,
            "結果": ft.Colors.RED_700,
            "エラー": ft.Colors.RED_900,
        }
        color = color_map.get(sender, ft.Colors.BLACK)
        self.log_area.controls.append(
            ft.Text(f"[{sender}] {message}", color=color, size=14)
        )
        # Setup runs on a worker thread; keep the log area live.
        try:
            self.page.update()
        except Exception:
            pass

    def _update_status(self) -> None:
        if self.state is None:
            self.status_text.value = "準備中…"
            return
        parts = [f"ターン: {self.state.turn_count}"]
        if self.state.last_surface:
            parts.append(f"直前: {self.state.last_surface}")
        if self.state.expected_first_mora:
            parts.append(f"次: 『{self.state.expected_first_mora}』")
        parts.append(f"使用済み: {len(self.state.used_readings)} 語")
        self.status_text.value = " | ".join(parts)


def main(page: ft.Page) -> None:
    ShiritoriApp(page)


if __name__ == "__main__":
    ft.app(target=main)