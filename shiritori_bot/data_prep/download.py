from __future__ import annotations

import json
import re
import sys
import urllib.request
import zipfile
from pathlib import Path

from shiritori_bot.config import DEFAULT_RAW_DIR

SUDACHI_RAW_BASE = "http://sudachi.s3-website-ap-northeast-1.amazonaws.com/sudachidict-raw"
SUDACHI_RELEASE = "20260428"
SUDACHI_FILES = ("small_lex.zip", "core_lex.zip", "notcore_lex.zip")

JMDICT_API = "https://api.github.com/repos/scriptin/jmdict-simplified/releases/latest"


def _download(url: str, dest: Path, *, desc: str = "") -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 0:
        print(f"  既存ファイルのためスキップ: {dest.name}")
        return dest
    print(f"  ダウンロード中: {desc or url}")
    print(f"    → {dest}")
    req = urllib.request.Request(url, headers={"User-Agent": "shiritori-bot/0.1"})
    with urllib.request.urlopen(req, timeout=600) as resp, open(dest, "wb") as f:
        total = resp.headers.get("Content-Length")
        total_n = int(total) if total else None
        downloaded = 0
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk:
                break
            f.write(chunk)
            downloaded += len(chunk)
            if total_n:
                pct = downloaded * 100 // total_n
                print(f"\r    {pct:3d}% ({downloaded // 1024 // 1024} MB)", end="", flush=True)
        print()
    return dest


def _unzip(zip_path: Path, out_dir: Path) -> list[Path]:
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
            print(f"  展開: {target.name}")
    return extracted


def fetch_latest_jmdict_assets() -> dict[str, str]:
    print("JMdictの最新リリースを確認中...")
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
        print(f"  {key}: {candidates[-1][0]}")
    return result


def download_jmdict(raw_dir: Path | None = None) -> dict[str, Path]:
    raw_dir = Path(raw_dir or DEFAULT_RAW_DIR)
    raw_dir.mkdir(parents=True, exist_ok=True)
    urls = fetch_latest_jmdict_assets()
    out: dict[str, Path] = {}

    for key, url in urls.items():
        zip_name = url.rstrip("/").split("/")[-1]
        zip_path = raw_dir / zip_name
        _download(url, zip_path, desc=key)
        files = _unzip(zip_path, raw_dir / key)
        json_files = [p for p in files if p.suffix == ".json"]
        if not json_files:
            raise RuntimeError(f"{key} の JSON が見つかりません")
        out[key] = json_files[0]
    return out


def download_sudachi(raw_dir: Path | None = None) -> list[Path]:
    raw_dir = Path(raw_dir or DEFAULT_RAW_DIR)
    sudachi_dir = raw_dir / "sudachi"
    sudachi_dir.mkdir(parents=True, exist_ok=True)
    csv_paths: list[Path] = []

    for fname in SUDACHI_FILES:
        url = f"{SUDACHI_RAW_BASE}/{SUDACHI_RELEASE}/{fname}"
        zip_path = sudachi_dir / fname
        _download(url, zip_path, desc=fname)
        files = _unzip(zip_path, sudachi_dir)
        csv_paths.extend(p for p in files if p.suffix == ".csv" or "lex" in p.name)

    if not csv_paths:
        csv_paths = sorted(sudachi_dir.glob("*lex*"))
    print(f"  Sudachi ソース: {len(csv_paths)} ファイル")
    return csv_paths


def download_all(raw_dir: Path | None = None) -> None:
    raw_dir = Path(raw_dir or DEFAULT_RAW_DIR)
    print("=== JMdict / JMnedict ===")
    download_jmdict(raw_dir)
    print("=== SudachiDict ===")
    download_sudachi(raw_dir)
    print("完了.")


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    raw = Path(argv[0]) if argv else DEFAULT_RAW_DIR
    download_all(raw)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
