from __future__ import annotations

import argparse
import gzip
import sys
import tempfile
import zipfile
from pathlib import Path

from bot.config import DEFAULT_CACHE_DIR, DEFAULT_RAW_DIR, FREQ_DATA_NAME
from bot.data_prep.build_vocab_pool import _find_lex_csvs, iter_vocab_rows

FREQ_FORMAT_HEADER = "# shiritori-wordfreq-1"

DEFAULT_MIN_ZIPF = 2.0


def _resolve_sudachi_sources(arg: Path | None) -> list[Path]:
    if arg is None:
        found = _find_lex_csvs(DEFAULT_RAW_DIR, small_only=True)
        if not found:
            raise FileNotFoundError(
                "SudachiDict の CSV が見つかりません。\n"
                "  python -m bot.data_prep.download\n"
                "または --sudachi で small_lex.csv / small_lex.zip を指定してください。"
            )
        return found

    if arg.is_dir():
        found = _find_lex_csvs(arg, small_only=True)
        if not found:
            raise FileNotFoundError(f"{arg} に SudachiDict の CSV がありません")
        return found

    if arg.suffix == ".zip":
        out_dir = Path(tempfile.mkdtemp(prefix="shiritori-freq-"))
        with zipfile.ZipFile(arg, "r") as zf:
            members = [n for n in zf.namelist() if n.lower().endswith(".csv")]
            if not members:
                raise FileNotFoundError(f"{arg.name} に CSV がありません")
            for name in members:
                zf.extract(name, out_dir)
            return [out_dir / Path(name).name for name in members]

    if not arg.exists():
        raise FileNotFoundError(arg)
    return [arg]


def build_freq_data(
    csv_paths: list[Path],
    out_path: Path,
    *,
    min_zipf: float = DEFAULT_MIN_ZIPF,
    log=print,
) -> int:
    floor_z10 = round(min_zipf * 10)
    best: dict[str, int] = {}
    total = 0

    for item in iter_vocab_rows(csv_paths, log=log):
        if item is None:
            continue
        total += 1
        z10 = round(item.zipf * 10)
        if z10 < floor_z10:
            continue
        if z10 > best.get(item.surface, 0):
            best[item.surface] = z10

    out_path.parent.mkdir(parents=True, exist_ok=True)
    entries = sorted(best.items(), key=lambda kv: (-kv[1], kv[0]))
    with gzip.open(out_path, "wt", encoding="utf-8", compresslevel=9, newline="\n") as f:
        f.write(f"{FREQ_FORMAT_HEADER}\n")
        for word, z10 in entries:
            f.write(f"{word}\t{z10}\n")

    log(f"書き出し: {out_path} ({len(entries)} 語 / 対象 {total} 語)")
    return len(entries)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Bot語彙レベル用の wordfreq 頻度データ (Web) を生成する"
    )
    parser.add_argument(
        "--sudachi",
        type=Path,
        default=None,
        help="SudachiDict の CSV / zip / ディレクトリ (既定: data/raw/sudachi)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_CACHE_DIR / FREQ_DATA_NAME,
        help=f"出力先 (既定: {DEFAULT_CACHE_DIR / FREQ_DATA_NAME})",
    )
    parser.add_argument(
        "--min-zipf",
        type=float,
        default=DEFAULT_MIN_ZIPF,
        help="この zipf 値未満の語をファイルから除外する",
    )
    args = parser.parse_args(argv)

    try:
        csvs = _resolve_sudachi_sources(args.sudachi)
    except FileNotFoundError as e:
        print(str(e), file=sys.stderr)
        return 1

    build_freq_data(csvs, args.out, min_zipf=args.min_zipf)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
