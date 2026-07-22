# しりとり Bot

オフラインで実行可能なしりとり Bot です。Bot の語彙力は **SudachiDict** を参照します。

## 必要環境

- Python 3.10+
- 初回のみネットワークが必要（辞書ダウンロード）

## セットアップ

- 通常

[最新版しりとりBot](https://github.com/Konayukiw/shiritori/releases/latest) から `ShiritoriBot.exe` をダウンロードして実行するだけ！
初回起動時は語彙力を身につけるために数分ほどかかることがあります。

- コマンド環境 (CLI) の場合

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
| 語彙プール | [SudachiDict](https://github.com/WorksApplications/SudachiDict) の `small_lex.csv`（既定。`--all-lex` で core/notcore も可） |

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

### Bot語彙

- 既定ソースは `small_lex.csv`
- 標準カテゴリ `general` は品詞 **`名詞,普通名詞,一般`** のみ
- 表層に英数字が含まれる語は除外（形態素解析不一致フィルタの近似）
- 1モーラ / 「ん」終わり / 旧仮名 / 非かな読みは除外
- 動詞は `--verb` 時のみ。活用は**終止形のみ**

発話時の選択（`BotWordSelector`）:

1. 要求される先頭モーラで語彙プールを引く
2. 既出読みを除いた候補から **ランダムに 1 語**
3. 候補が無ければ Bot の負け

## ライセンス

- JMdict / JMnedict は [EDRDG License](http://www.edrdg.org/edrdg/licence.html) に従います
- SudachiDict は Apache-2.0（UniDic / NEologd 由来部分を含む）です

本リポジトリには辞書本体は同梱しません。上記セットアップに従えば、最新版が自動でダウンロードされます。
