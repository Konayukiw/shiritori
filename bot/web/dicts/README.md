# Original dictionary files (for the static web client)

The web client loads **original** SudachiDict / JMdict / JMnedict artifacts
here — not the SQLite `vocab_pool` / `jmdict` caches used by CLI and desktop.

## Expected files (any subset works; zip preferred)

| File | Source |
|------|--------|
| `small_lex.zip` or `small_lex.csv` | [SudachiDict raw](http://sudachi.s3-website-ap-northeast-1.amazonaws.com/sudachidict-raw/) (`small_lex`) |
| `jmdict-eng.json.zip` or `jmdict-eng.json` | [jmdict-simplified](https://github.com/scriptin/jmdict-simplified/releases) `jmdict-eng-*.json.zip` |
| `jmnedict-all.json.zip` or `jmnedict-all.json` | same release `jmnedict-all-*.json.zip` |

## Local development

```bash
# Download originals into data/raw (CLI/desktop path)
python -m bot.data_prep.download

# Serve bot/web and mirror originals into this directory
python -m bot.web.main
```

## GitHub Pages

The workflow `.github/workflows/pages.yml` downloads these originals into
`dicts/` at deploy time so the browser can fetch them same-origin (no CORS issues).

Do **not** commit the large dictionary binaries to git.
