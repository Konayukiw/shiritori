"""しりとりBot CLI 対話ループ."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from shiritori_bot.config import GameConfig, default_config
from shiritori_bot.core.bot_word_selector import BotWordSelector, VocabPool
from shiritori_bot.core.opponent_word_validator import JmdictIndex, OpponentWordValidator
from shiritori_bot.game.session import GameState


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="ローカルしりとりBot",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--person", action="store_true", help="人名を許可")
    p.add_argument("--place", action="store_true", help="地名を許可")
    p.add_argument("--org", action="store_true", help="組織名を許可")
    p.add_argument("--proper", action="store_true", help="固有名詞(一般)を許可")
    p.add_argument("--other", action="store_true", help="その他カテゴリを許可")
    p.add_argument("--verb", action="store_true", help="動詞を許可 (Bot語彙)")
    p.add_argument(
        "--all-proper",
        action="store_true",
        help="人名/地名/組織/固有/その他をすべて許可",
    )
    p.add_argument(
        "--ignore-dakuten",
        action="store_true",
        help="濁点・半濁点の違いを無視して接続判定する",
    )
    p.add_argument(
        "--allow-alnum",
        action="store_true",
        help="アルファベット・数字を含む表記を許可",
    )
    p.add_argument(
        "--cache-dir",
        type=Path,
        default=None,
        help="SQLite キャッシュディレクトリ",
    )
    p.add_argument(
        "--bot-first",
        action="store_true",
        help="Bot から開始 (ランダムな語で始める)",
    )
    return p.parse_args(argv)


def config_from_args(args: argparse.Namespace) -> GameConfig:
    cfg = default_config()
    if args.all_proper:
        cfg.allow_person = True
        cfg.allow_place = True
        cfg.allow_organization = True
        cfg.allow_proper = True
        cfg.allow_other = True
    else:
        cfg.allow_person = args.person
        cfg.allow_place = args.place
        cfg.allow_organization = args.org
        cfg.allow_proper = args.proper
        cfg.allow_other = args.other
    cfg.allow_verb = args.verb
    cfg.require_dakuten_match = not args.ignore_dakuten
    cfg.allow_alnum = args.allow_alnum
    if args.cache_dir:
        cfg.cache_dir = args.cache_dir
    return cfg


def print_banner(cfg: GameConfig) -> None:
    print("=" * 50)
    print("  しりとり Bot")
    print("=" * 50)
    print("設定:")
    print(f"  人名: {'許可' if cfg.allow_person else '禁止'}")
    print(f"  地名: {'許可' if cfg.allow_place else '禁止'}")
    print(f"  組織: {'許可' if cfg.allow_organization else '禁止'}")
    print(f"  固有名詞(一般): {'許可' if cfg.allow_proper else '禁止'}")
    print(f"  その他: {'許可' if cfg.allow_other else '禁止'}")
    print(f"  動詞: {'許可' if cfg.allow_verb else '禁止'}")
    print(f"  濁点一致: {'要求' if cfg.require_dakuten_match else '無視'}")
    print(f"  英数字: {'許可' if cfg.allow_alnum else '禁止'}")
    print()
    print("コマンド: quit / exit で終了, help でヘルプ")
    print("-" * 50)


def print_help() -> None:
    print(
        """
使い方:
  ひらがな・カタカナ・漢字の単語を入力してください。
  直前の語の実効末尾モーラから始まる語をつなぎます。

ルール:
  - 「ん」で終わる語を出すと負け
  - 1モーラ語 (あ, きゃ など) は使用不可
  - 既出の読みは使用不可
  - 辞書にない語は「その単語は知りません」

コマンド:
  quit, exit, q  … 終了
  help, ?        … このヘルプ
  status         … 現在の状態
  restart        … 対局をリセット
""".strip()
    )


def run_game(cfg: GameConfig, *, bot_first: bool = False) -> int:
    try:
        jmdict = JmdictIndex(cfg.jmdict_db_path)
        pool = VocabPool(cfg.vocab_db_path)
    except FileNotFoundError as e:
        print(str(e), file=sys.stderr)
        print(
            "\n初回セットアップを実行してください:\n"
            "  python -m shiritori_bot.data_prep.setup_all",
            file=sys.stderr,
        )
        return 1

    validator = OpponentWordValidator(jmdict, cfg)
    selector = BotWordSelector(pool, cfg)
    state = GameState(config=cfg)

    print_banner(cfg)

    try:
        if bot_first:
            start = selector.select("し", set())
            if start is None:
                print("Bot: しりとり（しりとり）")
                state.mark_used("しりとり", "しりとり", "bot")
            else:
                print(f"Bot: {start.surface}（{start.reading}）")
                state.mark_used(start.reading, start.surface, "bot")
            print(f"  → 次は『{state.expected_first_mora}』から")

        while True:
            prompt = "あなたの単語"
            if state.expected_first_mora:
                prompt += f" [{state.expected_first_mora}…]"
            try:
                user_input = input(f"{prompt}: ").strip()
            except (EOFError, KeyboardInterrupt):
                print("\n終了します。")
                break

            if not user_input:
                continue

            cmd = user_input.lower()
            if cmd in ("quit", "exit", "q"):
                print("終了します。")
                break
            if cmd in ("help", "?"):
                print_help()
                continue
            if cmd == "status":
                print(f"  手数: {state.turn_count}")
                print(f"  直前: {state.last_surface}（{state.last_reading}）")
                print(f"  次のモーラ: {state.expected_first_mora}")
                print(f"  使用済み: {len(state.used_readings)} 語")
                continue
            if cmd == "restart":
                state.reset()
                print("対局をリセットしました。好きな語から始めてください。")
                continue

            result = validator.validate(
                user_input,
                expected_last_mora=state.expected_first_mora,
                used_readings=state.used_readings,
            )
            if not result.ok:
                print(f"  × {result.reason}")
                continue

            if result.lost:
                print(f"  {result.surface}（{result.reading}）")
                print(f"  {result.reason}")
                print(f"今回の対戦は {state.turn_count} ターンで終了しました。")
                break

            state.mark_used(result.reading, result.surface, "user")
            print(f"  ○ {result.surface}（{result.reading}）")

            bot_word = selector.select(result.effective_last_mora or "", state.used_readings)
            if bot_word is None:
                print("参りました、私の負けです。")
                print(f"今回の対戦は {state.turn_count} ターンで終了しました。")
                break

            print(f"ボット: {bot_word.surface}（{bot_word.reading}）")
            state.mark_used(bot_word.reading, bot_word.surface, "bot")
            print(f"  → 次は『{state.expected_first_mora}』から")

    finally:
        jmdict.close()
        pool.close()

    return 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    cfg = config_from_args(args)
    return run_game(cfg, bot_first=args.bot_first)


if __name__ == "__main__":
    raise SystemExit(main())
