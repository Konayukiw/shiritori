/**
 * Load original SudachiDict / JMdict / JMnedict files in the browser.
 *
 * Does NOT use pre-built vocab_pool.sqlite3 / jmdict.sqlite3.
 * Sources (in priority order):
 *   1. Same-origin ./dicts/ (GitHub Pages deploy or local server)
 *   2. Official remote URLs (when CORS allows)
 */

import { unzipSync, strFromU8 } from "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js";

import { DICT_SOURCES } from "./config.js";
import {
  containsObsoleteKana,
  isAllowedSurface,
  isKanaOnlyReading,
  normalizeReading,
  toHiragana,
} from "./kana.js";
import {
  effectiveFirstMora,
  endsWithN,
  isOneMoraWord,
} from "./rules.js";
import { cacheGet, cacheSet } from "./storage.js";
import { JmdictIndex } from "./validator.js";
import { VocabPool } from "./selector.js";

/**
 * @typedef {(msg: string) => void} LogFn
 */

async function fetchOk(url, { as = "arrayBuffer" } = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": "shiritori-bot-web/0.1" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (as === "json") return res.json();
  if (as === "text") return res.text();
  return res.arrayBuffer();
}

async function tryFetch(urls, options) {
  let lastErr = null;
  for (const url of urls) {
    try {
      const data = await fetchOk(url, options);
      return { url, data };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("すべての URL の取得に失敗しました");
}

function unzipFirst(arrayBuffer, { preferExt = null } = {}) {
  const files = unzipSync(new Uint8Array(arrayBuffer));
  const names = Object.keys(files).filter((n) => !n.endsWith("/"));
  if (!names.length) throw new Error("zip が空です");
  let chosen = names[0];
  if (preferExt) {
    const hit = names.find((n) => n.toLowerCase().endsWith(preferExt));
    if (hit) chosen = hit;
  }
  return { name: chosen, bytes: files[chosen] };
}

function unzipToText(arrayBuffer, preferExt) {
  const { name, bytes } = unzipFirst(arrayBuffer, { preferExt });
  return { name, text: strFromU8(bytes) };
}

function unzipToJson(arrayBuffer) {
  const { name, text } = unzipToText(arrayBuffer, ".json");
  return { name, data: JSON.parse(text) };
}

/* ---------- JMdict / JMnedict ---------- */

function* iterWordPairs(words, source) {
  for (const word of words) {
    const kanjiList = word.kanji || [];
    const kanaList = word.kana || [];
    if (!kanaList.length) continue;

    for (const kana of kanaList) {
      const ktext = (kana.text || "").trim();
      if (!ktext) continue;
      const reading = toHiragana(normalizeReading(ktext));
      if (reading) yield [ktext, reading, source];
    }

    for (const kj of kanjiList) {
      const stext = (kj.text || "").trim();
      if (!stext) continue;
      let chosen = null;
      for (const kana of kanaList) {
        const applies = kana.appliesToKanji || ["*"];
        if (applies.includes("*") || applies.includes(stext)) {
          chosen = kana.text || "";
          break;
        }
      }
      if (!chosen && kanaList.length) {
        chosen = kanaList[0].text || "";
      }
      if (!chosen) continue;
      const reading = toHiragana(normalizeReading(chosen));
      if (reading) yield [stext, reading, source];
    }
  }
}

/**
 * Prefer jmdict over jmnedict when the same surface/reading is first seen.
 * @returns {{ bySurface: Map<string, object>, byReading: Map<string, object>, count: number }}
 */
export function buildJmdictMaps(jmdictWords, jmnedictWords = null) {
  const bySurface = new Map();
  const byReading = new Map();
  let count = 0;

  function add(surface, reading, source) {
    const hit = { surface, reading, source };
    if (!bySurface.has(surface)) {
      bySurface.set(surface, hit);
    } else if (
      bySurface.get(surface).source === "jmnedict" &&
      source === "jmdict"
    ) {
      bySurface.set(surface, hit);
    }
    if (!byReading.has(reading)) {
      byReading.set(reading, hit);
    } else if (
      byReading.get(reading).source === "jmnedict" &&
      source === "jmdict"
    ) {
      byReading.set(reading, hit);
    }
    count += 1;
  }

  for (const pair of iterWordPairs(jmdictWords, "jmdict")) {
    add(pair[0], pair[1], pair[2]);
  }
  if (jmnedictWords) {
    for (const pair of iterWordPairs(jmnedictWords, "jmnedict")) {
      add(pair[0], pair[1], pair[2]);
    }
  }
  return { bySurface, byReading, count };
}

function mapsToSerializable(bySurface, byReading) {
  return {
    surfaces: Array.from(bySurface.entries()),
    readings: Array.from(byReading.entries()),
  };
}

function mapsFromSerializable(data) {
  return {
    bySurface: new Map(data.surfaces),
    byReading: new Map(data.readings),
  };
}

async function resolveJmdictAssetUrls(log) {
  log("最新の JMdict / JMnedict リリースを確認中…");
  const release = await fetchOk(DICT_SOURCES.jmdictApi, { as: "json" });
  const assets = {};
  for (const a of release.assets || []) {
    assets[a.name] = a.browser_download_url;
  }

  function pick(key, pattern) {
    const candidates = Object.entries(assets).filter(
      ([name]) =>
        pattern.test(name) &&
        !name.includes("common") &&
        !name.includes("examples")
    );
    if (!candidates.length) {
      throw new Error(`リリースに ${key} の zip が見つかりません`);
    }
    candidates.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const [name, url] = candidates[candidates.length - 1];
    log(`  ${key}: ${name}`);
    return url;
  }

  return {
    jmdict: pick("jmdict", /^jmdict-eng-\d.+\.json\.zip$/),
    jmnedict: pick("jmnedict", /^jmnedict-all-\d.+\.json\.zip$/),
    tag: release.tag_name || release.name || "unknown",
  };
}

/* ---------- SudachiDict ---------- */

function classifyPos(pos1, pos2, pos3) {
  if (pos1 === "名詞") {
    if (pos2 === "固有名詞") {
      if (pos3 === "人名") return "person";
      if (pos3 === "地名") return "place";
      if (pos3 === "組織" || pos3 === "組織名") return "organization";
      if (pos3 === "一般" || pos3 === "*") return "proper";
      return "other";
    }
    if (pos2 === "普通名詞" && pos3 === "一般") return "general";
    return null;
  }
  if (pos1 === "動詞") return "verb";
  return null;
}

/** Parse SudachiDict CSV text into first_mora → entries map. */
export function buildVocabFromSudachiCsv(csvText, log = () => {}) {
  /** @type {Map<string, Array<{surface:string, reading:string, category:string}>>} */
  const byFirstMora = new Map();
  const seen = new Set();
  let total = 0;
  let skipped = 0;
  let lineNo = 0;

  // Handle both \n and \r\n; Sudachi CSV has no header.
  const lines = csvText.split(/\r?\n/);
  const totalLines = lines.length;
  log(`SudachiDict を解析中… (${totalLines.toLocaleString()} 行)`);

  for (const line of lines) {
    lineNo += 1;
    if (!line) continue;
    // Simple CSV split — Sudachi lex fields do not contain unescaped commas in practice for these columns.
    const row = parseCsvLine(line);
    if (row.length < 12) {
      skipped += 1;
      continue;
    }

    let surface = (row[4] || row[0] || "").trim();
    const readingRaw = (row[11] || "").trim();
    const pos1 = (row[5] || "").trim();
    const pos2 = (row[6] || "").trim();
    const pos3 = (row[7] || "").trim();
    const cform = (row[10] || "").trim();
    const norm = (row[12] || "").trim();

    if (!surface || !readingRaw || readingRaw === "*") {
      skipped += 1;
      continue;
    }
    if ((pos1 === "動詞" || pos1 === "形容詞") && !cform.startsWith("終止形")) {
      skipped += 1;
      continue;
    }

    const category = classifyPos(pos1, pos2, pos3);
    if (category == null) {
      skipped += 1;
      continue;
    }
    if ((pos1 === "動詞" || pos1 === "形容詞") && norm && norm !== "*") {
      surface = norm;
    }
    if (!isAllowedSurface(surface, false)) {
      skipped += 1;
      continue;
    }

    const reading = toHiragana(normalizeReading(readingRaw));
    if (!reading) {
      skipped += 1;
      continue;
    }
    if (!isKanaOnlyReading(reading, false)) {
      skipped += 1;
      continue;
    }
    if (containsObsoleteKana(reading)) {
      skipped += 1;
      continue;
    }
    if (isOneMoraWord(reading)) {
      skipped += 1;
      continue;
    }
    if (endsWithN(reading)) {
      skipped += 1;
      continue;
    }
    if (seen.has(reading)) {
      skipped += 1;
      continue;
    }
    seen.add(reading);

    const first = effectiveFirstMora(reading) || reading[0];
    let bucket = byFirstMora.get(first);
    if (!bucket) {
      bucket = [];
      byFirstMora.set(first, bucket);
    }
    bucket.push({ surface, reading, category });
    total += 1;

    if (lineNo % 200000 === 0) {
      log(`  SudachiDict ${Math.floor((lineNo / totalLines) * 100)}% …`);
    }
  }

  log(`  → 語彙 ${total.toLocaleString()} 語 (スキップ ${skipped.toLocaleString()})`);
  return { byFirstMora, total };
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function vocabToSerializable(byFirstMora) {
  return Array.from(byFirstMora.entries());
}

function vocabFromSerializable(entries) {
  return new Map(entries);
}

/* ---------- High-level load ---------- */

async function loadSudachiOriginal(log) {
  const local = DICT_SOURCES.local;
  const remoteZip = `${DICT_SOURCES.sudachiBase}/${DICT_SOURCES.sudachiRelease}/${DICT_SOURCES.sudachiFile}`;

  // Prefer zip (smaller transfer). CSV is a local fallback only.
  try {
    log("SudachiDict (small_lex) を取得中…");
    const { url, data } = await tryFetch(
      [local.sudachiZip, remoteZip, local.sudachiCsv],
      { as: "arrayBuffer" }
    );
    log(`  取得元: ${url}`);
    let csvText;
    if (url.endsWith(".csv") || url.includes("small_lex.csv")) {
      csvText = strFromU8(new Uint8Array(data));
    } else {
      log("  zip を展開中…");
      csvText = unzipToText(data, ".csv").text;
    }
    return buildVocabFromSudachiCsv(csvText, log);
  } catch (e) {
    throw new Error(
      `SudachiDict の取得に失敗しました: ${e.message}\n` +
        "GitHub Pages では ./dicts/small_lex.zip を配置するか、Actions デプロイを利用してください。"
    );
  }
}

async function loadJmdictOriginal(log, { includeJmnedict = true } = {}) {
  const local = DICT_SOURCES.local;

  let jmdictData = null;
  let jmnedictData = null;
  let sourceTag = "local";

  // Local originals first (zip preferred over raw JSON).
  try {
    log("JMdict を取得中…");
    try {
      const { url, data } = await tryFetch([local.jmdictZip], { as: "arrayBuffer" });
      log(`  取得元: ${url}`);
      log("  zip を展開中…");
      jmdictData = unzipToJson(data).data;
    } catch {
      const { url, data } = await tryFetch([local.jmdictJson], { as: "arrayBuffer" });
      log(`  取得元: ${url}`);
      jmdictData = JSON.parse(strFromU8(new Uint8Array(data)));
    }
  } catch {
    // Remote: resolve latest release asset URLs (API has CORS; asset download often does not).
    // Still attempt — some environments / mirrors may allow it.
    const urls = await resolveJmdictAssetUrls(log);
    sourceTag = urls.tag;
    log("JMdict (リモート) を取得中…");
    try {
      const buf = await fetchOk(urls.jmdict, { as: "arrayBuffer" });
      log("  zip を展開中…");
      jmdictData = unzipToJson(buf).data;
    } catch (e) {
      throw new Error(
        `JMdict の取得に失敗しました: ${e.message}\n` +
          "GitHub Pages では ./dicts/jmdict-eng.json.zip を配置するか、Actions デプロイを利用してください。"
      );
    }
    if (includeJmnedict) {
      log("JMnedict (リモート) を取得中…");
      try {
        const buf = await fetchOk(urls.jmnedict, { as: "arrayBuffer" });
        log("  zip を展開中…");
        jmnedictData = unzipToJson(buf).data;
      } catch (e) {
        log(`  JMnedict スキップ: ${e.message}`);
      }
    }
  }

  if (jmdictData && includeJmnedict && !jmnedictData) {
    try {
      log("JMnedict を取得中…");
      try {
        const { url, data } = await tryFetch([local.jmnedictZip], {
          as: "arrayBuffer",
        });
        log(`  取得元: ${url}`);
        log("  zip を展開中…");
        jmnedictData = unzipToJson(data).data;
      } catch {
        const { url, data } = await tryFetch([local.jmnedictJson], {
          as: "arrayBuffer",
        });
        log(`  取得元: ${url}`);
        jmnedictData = JSON.parse(strFromU8(new Uint8Array(data)));
      }
    } catch (e) {
      log(`  JMnedict スキップ: ${e.message}`);
    }
  }

  log("JMdict インデックスを構築中…");
  const maps = buildJmdictMaps(
    jmdictData.words || [],
    jmnedictData ? jmnedictData.words || [] : null
  );
  log(`  → エントリ ${maps.count.toLocaleString()} 件`);
  return { ...maps, sourceTag };
}

/**
 * Load dictionaries from original files (with IndexedDB cache of derived indexes).
 * @param {LogFn} log
 * @param {{ forceReload?: boolean, includeJmnedict?: boolean }} [options]
 */
export async function loadDictionaries(log = () => {}, options = {}) {
  const { forceReload = false, includeJmnedict = true } = options;
  const cacheKey = `${DICT_SOURCES.cacheVersion}:full:${includeJmnedict ? "with-names" : "no-names"}`;

  if (!forceReload) {
    log("キャッシュを確認中…");
    const cached = await cacheGet(cacheKey);
    if (cached && cached.jmdict && cached.vocab) {
      log("キャッシュから語彙を復元しました。");
      const jm = mapsFromSerializable(cached.jmdict);
      const byFirstMora = vocabFromSerializable(cached.vocab);
      return {
        jmdict: new JmdictIndex(jm.bySurface, jm.byReading),
        pool: new VocabPool(byFirstMora),
        fromCache: true,
        sourceTag: cached.sourceTag || "cache",
      };
    }
  }

  log("原本辞書ファイルを読み込みます (SudachiDict / JMdict / JMnedict)…");

  const jm = await loadJmdictOriginal(log, { includeJmnedict });
  const vocab = await loadSudachiOriginal(log);

  // Persist compact derived indexes (still built from originals each cold start if cache cleared).
  log("ブラウザキャッシュに保存中…");
  await cacheSet(cacheKey, {
    sourceTag: jm.sourceTag,
    jmdict: mapsToSerializable(jm.bySurface, jm.byReading),
    vocab: vocabToSerializable(vocab.byFirstMora),
    savedAt: Date.now(),
  });

  return {
    jmdict: new JmdictIndex(jm.bySurface, jm.byReading),
    pool: new VocabPool(vocab.byFirstMora),
    fromCache: false,
    sourceTag: jm.sourceTag,
  };
}
