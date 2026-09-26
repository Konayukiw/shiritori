from __future__ import annotations

import sys

from bot.data_prep.build_freq_data import main as build_freq
from bot.data_prep.build_jmdict_index import main as build_jmdict
from bot.data_prep.build_vocab_pool import main as build_vocab
from bot.data_prep.download import download_all


def main(argv: list[str] | None = None) -> int:
    argv = list(argv if argv is not None else sys.argv[1:])
    skip_download = "--skip-download" in argv
    skip_freq = "--skip-freq" in argv

    if not skip_download:
        print("======== 1/4 ダウンロード ========")
        download_all()
    else:
        print("======== 1/4 ダウンロード (スキップ) ========")

    print("======== 2/4 JMdict インデックス ========")
    rc = build_jmdict([])
    if rc != 0:
        return rc

    print("======== 3/4 SudachiDict 語彙プール ========")
    rc = build_vocab([])
    if rc != 0:
        return rc

    if not skip_freq:
        print("======== 4/4 単語頻度データ (Web用) ========")
        rc = build_freq([])
        if rc != 0:
            return rc
    else:
        print("======== 4/4 単語頻度データ (スキップ) ========")

    print("\nセットアップ完了。次のコマンドで遊べます:")
    print("  python -m bot.cli.main")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
