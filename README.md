# しりとり Bot

オフラインで実行可能なしりとり Bot です。相手の入力を **JMdictおよびJMnedict** で存在確認し、Bot の回答語彙は **SudachiDictのCSV** から構築します。

## 必要環境

- Python 3.10+
- 初回のみネットワークが必要（辞書ダウンロード）

## セットアップ

```bash
# ライブラリ
pip install -r requirements.txt

# 辞書ダウンロード + SQLiteインデックス構築（初回のみ・時間がかかります）
python -m shiritori_bot.data_prep.setup_all
```

取得元:

| データ | ソース |
|--------|--------|
| JMdict / JMnedict | [jmdict-simplified](https://github.com/scriptin/jmdict-simplified) の JSON |
| 語彙プール | [SudachiDict](https://github.com/WorksApplications/SudachiDict) のCSV（`small_lex` / `core_lex` / `notcore_lex`） |

## 対戦の始め方

```bash
python -m shiritori_bot.main
```

### オプション

| フラグ | 意味 |
|--------|------|
| `--person` | 人名を許可 |
| `--place` | 地名を許可 |
| `--org` | 組織名を許可 |
| `--proper` | 固有名詞（一般）を許可 |
| `--other` | その他カテゴリを許可 |
| `--verb` | 動詞を許可 |
| `--all-proper` | 人名/地名/組織/固有/その他をすべて許可 |
| `--ignore-dakuten` | 濁点・半濁点の違いを無視（ほ⇔ぽ など） |
| `--allow-alnum` | 英数字を含む表記を許可 |
| `--bot-first` | Bot が先攻 |
| `--cache-dir PATH` | SQLite の場所を指定 |

例:

```bash
# 地名・人名も OK、濁点は無視
python -m shiritori_bot.main --place --person --ignore-dakuten
```

### 対局中に使えるコマンド

- `quit` / `exit` … 終了
- `help` … ヘルプ
- `status` … 手数・直前語など
- `restart` … リセット

## ルールの要点

### 単語の検証

1. 文字種チェック（ひらがな / カタカナ / 漢字、任意で英数字）
2. **JMdict** で存在確認 → なければ **JMnedict**
3. どちらにも無ければ知らない単語とみなす
4. 尻を取れているか、既出でないか、1モーラ（1文字または1文字 + 拗音 / 促音）禁止、現代仮名遣いかどうか、オプションに従っているか
5. 「ん」で終わる場合 → 即負け

Botが受け取った単語に複数読みがある場合は **最初にマッチしたエントリの読み** を採用します。

### Bot語彙のデフォルト禁止

- 1モーラ（1文字または1文字 + 拗音 / 促音）
- 「ん」で終わる語
- ゑ / ゐ など現代50音にない文字
- 特殊記号を含む読み
- 助詞・記号などしりとりに不向きな品詞
- 動詞・形容詞の非終止形（命令形・未然形など）。**終止形のみ**採用

## ライセンス

- JMdict / JMnedict は [EDRDG License](http://www.edrdg.org/edrdg/licence.html) に従います
- SudachiDict は Apache-2.0（UniDic / NEologd 由来部分を含む）です

本リポジトリには辞書本体は同梱しません。セットアップに従い、初回利用時にダウンロードしてください。
