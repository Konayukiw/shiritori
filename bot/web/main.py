from __future__ import annotations

import argparse
import functools
import http.server
import os
import shutil
import socketserver
import sys
from pathlib import Path

from bot.config import DEFAULT_RAW_DIR

WEB_ROOT = Path(__file__).resolve().parent
DICTS_DIR = WEB_ROOT / "dicts"


def _find_first(patterns: list[Path]) -> Path | None:
    for p in patterns:
        if p.is_file() and p.stat().st_size > 0:
            return p
    return None


def ensure_dict_links(raw_dir: Path | None = None) -> None:
    """Make original dictionary files available at ``bot/web/dicts/``.

    Prefers already-present files in ``dicts/``. Otherwise copies (or on
    Windows, falls back to copy) from ``data/raw`` so the browser can load
    the *original* SudachiDict / JMdict / JMnedict artifacts — not the
    SQLite vocab pool used by CLI/desktop.
    """
    raw_dir = Path(raw_dir or DEFAULT_RAW_DIR)
    DICTS_DIR.mkdir(parents=True, exist_ok=True)

    mapping: list[tuple[str, list[Path]]] = [
        (
            "small_lex.zip",
            [raw_dir / "sudachi" / "small_lex.zip"],
        ),
        (
            "small_lex.csv",
            [raw_dir / "sudachi" / "small_lex.csv"],
        ),
        (
            "jmdict-eng.json.zip",
            sorted(raw_dir.glob("jmdict-eng-*.json.zip")),
        ),
        (
            "jmdict-eng.json",
            sorted((raw_dir / "jmdict").glob("jmdict-eng-*.json"))
            + sorted(raw_dir.glob("jmdict-eng-*.json")),
        ),
        (
            "jmnedict-all.json.zip",
            sorted(raw_dir.glob("jmnedict-all-*.json.zip")),
        ),
        (
            "jmnedict-all.json",
            sorted((raw_dir / "jmnedict").glob("jmnedict-all-*.json"))
            + sorted(raw_dir.glob("jmnedict-all-*.json")),
        ),
    ]

    for dest_name, candidates in mapping:
        dest = DICTS_DIR / dest_name
        if dest.exists() and dest.stat().st_size > 0:
            continue
        src = _find_first(list(candidates))
        if src is None:
            continue
        try:
            if dest.exists() or dest.is_symlink():
                dest.unlink()
            try:
                os.link(src, dest)
                print(f"  link  {dest_name} <- {src}")
            except OSError:
                try:
                    dest.symlink_to(src)
                    print(f"  symlink {dest_name} <- {src}")
                except OSError:
                    shutil.copy2(src, dest)
                    print(f"  copy  {dest_name} <- {src}")
        except OSError as e:
            print(f"  skip  {dest_name}: {e}", file=sys.stderr)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, directory: str | None = None, **kwargs):
        super().__init__(*args, directory=directory, **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="しりとりBot Web")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument(
        "--raw-dir",
        type=Path,
        default=None,
        help="Original dict files (/data/raw)",
    )
    parser.add_argument(
        "--skip-dicts",
        action="store_true",
        help="Do not mirror data/raw into bot/web/dicts/",
    )
    args = parser.parse_args(argv)

    if not args.skip_dicts:
        print("語彙を bot/web/dicts/ にアップロード中...")
        ensure_dict_links(args.raw_dir)
        present = sorted(p.name for p in DICTS_DIR.iterdir() if p.is_file() and p.name != ".gitkeep")
        if present:
            print("  利用可能:", ", ".join(present))
        else:
            print(
                "  警告: dicts/ が空です。"
                " 先に `python -m bot.data_prep.download` を実行するか、"
                "原本 zip/csv/json を bot/web/dicts/ に置いてください。",
                file=sys.stderr,
            )

    handler = functools.partial(QuietHandler, directory=str(WEB_ROOT))
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer((args.host, args.port), handler) as httpd:
        url = f"http://{args.host}:{args.port}/"
        print(f"Serving {WEB_ROOT}")
        print(f"Open {url}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
