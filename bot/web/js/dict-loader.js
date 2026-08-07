import {
  unzipSync,
  strFromU8,
  strToU8,
  zlibSync,
  unzlibSync,
} from "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js";

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
import {
  cacheGet,
  cacheSet,
  cacheKeys,
  cacheDeleteByPrefix,
  storagePersist,
  storageEstimate,
} from "./storage.js";
import { sendWebhook } from "./debug.js";
import { JmdictIndex } from "./validator.js";
import { VocabPool } from "./selector.js";

/**
 * @typedef {(msg: string) => void} LogFn
 */

const SOURCE_TO_CODE = { jmdict: 0, jmnedict: 1 };
const CODE_TO_SOURCE = ["jmdict", "jmnedict"];

const CATEGORY_TO_CODE = {
  general: 0,
  verb: 1,
  person: 2,
  place: 3,
  organization: 4,
  proper: 5,
  other: 6,
};
const CODE_TO_CATEGORY = [
  "general",
  "verb",
  "person",
  "place",
  "organization",
  "proper",
  "other",
];

const CACHE_PREFIX = "shiritori-web-v2";
const NUM_SHARDS = 16;

function shardFor(mora) {
  let h = 0;
  for (const ch of mora) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % NUM_SHARDS;
}

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
  throw lastErr || new Error("URLの取得に失敗しました");
}

async function fetchWithMeta(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "shiritori-bot-web/0.1" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const data = await res.arrayBuffer();
  return {
    data,
    url,
    etag: res.headers.get("etag"),
    lastModified: res.headers.get("last-modified"),
  };
}

async function tryFetchWithMeta(urls) {
  let lastErr = null;
  for (const url of urls) {
    try {
      return await fetchWithMeta(url);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("URLの取得に失敗しました");
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

export function buildVocabFromSudachiCsv(csvText, log = () => {}) {

  /** 
   * @type {Map<string, Array<{surface:string, reading:string, category:string}>>} 
   */

  const byFirstMora = new Map();
  const seen = new Set();
  let total = 0;
  let skipped = 0;
  let lineNo = 0;

  const lines = csvText.split(/\r?\n/);
  const totalLines = lines.length;
  log(`SudachiDictを解析中… (${totalLines.toLocaleString()} 行)`);

  for (const line of lines) {
    lineNo += 1;
    if (!line) continue;
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

async function resolveJmdictAssetUrls(log) {
  log("JMdict / JMnedictの最新バージョンを確認中…");
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
      throw new Error(`リリースに ${key} の zipファイルが見つかりません`);
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

async function loadJmdictBuffers(log, { includeJmnedict = true } = {}) {
  const local = DICT_SOURCES.local;
  const out = {
    jmdict: null,
    jmnedict: null,
    sourceTag: "local",
    sourceMeta: {},
  };

  log("JMdictからファイルを取得中…");
  try {
    const hit = await tryFetchWithMeta([local.jmdictZip]);
    log(`  取得元: ${hit.url}`);
    out.jmdict = hit.data;
    out.sourceMeta.jmdict = { url: hit.url, etag: hit.etag, lastModified: hit.lastModified };
  } catch {
    try {
      const hit = await tryFetchWithMeta([local.jmdictJson]);
      log(`  取得元: ${hit.url}`);
      out.jmdict = hit.data;
      out.sourceMeta.jmdict = { url: hit.url, etag: hit.etag, lastModified: hit.lastModified };
    } catch {
      const urls = await resolveJmdictAssetUrls(log);
      out.sourceTag = urls.tag;
      log("JMdictからファイルを取得中…");
      try {
        const hit = await fetchWithMeta(urls.jmdict);
        out.jmdict = hit.data;
        out.sourceMeta.jmdict = { url: hit.url, etag: hit.etag, lastModified: hit.lastModified };
      } catch (e) {
        throw new Error(
          `JMdictからのファイルの取得に失敗しました: ${e.message}\n`
        );
      }
    }
  }

  if (includeJmnedict) {
    log("JMnedictからファイルを取得中…");
    try {
      const hit = await tryFetchWithMeta([local.jmnedictZip]);
      log(`  取得元: ${hit.url}`);
      out.jmnedict = hit.data;
      out.sourceMeta.jmnedict = { url: hit.url, etag: hit.etag, lastModified: hit.lastModified };
    } catch {
      try {
        const hit = await tryFetchWithMeta([local.jmnedictJson]);
        log(`  取得元: ${hit.url}`);
        out.jmnedict = hit.data;
        out.sourceMeta.jmnedict = { url: hit.url, etag: hit.etag, lastModified: hit.lastModified };
      } catch (e) {
        log(`  JMnedictからのファイルの取得をスキップ: ${e.message}`);
      }
    }
  }

  return out;
}

async function loadSudachiBuffer(log) {
  const local = DICT_SOURCES.local;
  const remoteZip = `${DICT_SOURCES.sudachiBase}/${DICT_SOURCES.sudachiRelease}/${DICT_SOURCES.sudachiFile}`;

  log("SudachiDictからファイルを取得中…");
  const hit = await tryFetchWithMeta([local.sudachiZip, remoteZip, local.sudachiCsv]);
  log(`  取得元: ${hit.url}`);
  return {
    url: hit.url,
    data: hit.data,
    sourceMeta: { url: hit.url, etag: hit.etag, lastModified: hit.lastModified },
  };
}

function parseJmdictSources(sources, log) {
  let jmdictData;
  if (sources.jmdict instanceof ArrayBuffer) {
    try {
      log("zipファイルを展開中…");
      jmdictData = unzipToJson(sources.jmdict).data;
    } catch {
      jmdictData = JSON.parse(strFromU8(new Uint8Array(sources.jmdict)));
    }
  } else {
    jmdictData = sources.jmdict;
  }

  let jmnedictData = null;
  if (sources.jmnedict) {
    try {
      if (sources.jmnedict instanceof ArrayBuffer) {
        try {
          log("zipファイルを展開中…");
          jmnedictData = unzipToJson(sources.jmnedict).data;
        } catch {
          jmnedictData = JSON.parse(
            strFromU8(new Uint8Array(sources.jmnedict))
          );
        }
      } else {
        jmnedictData = sources.jmnedict;
      }
    } catch (e) {
      log(`  JMnedictの解析をスキップ: ${e.message}`);
    }
  }

  log("JMdictインデックスを構築中…");
  const maps = buildJmdictMaps(
    jmdictData.words || [],
    jmnedictData ? jmnedictData.words || [] : null
  );
  log(`  エントリ ${maps.count.toLocaleString()} 件`);
  return maps;
}

function parseSudachiSource(sudachi, log) {
  let csvText;
  if (sudachi.url.endsWith(".csv") || sudachi.url.includes("small_lex.csv")) {
    csvText = strFromU8(new Uint8Array(sudachi.data));
  } else {
    log("zipファイルを展開中…");
    csvText = unzipToText(sudachi.data, ".csv").text;
  }
  return buildVocabFromSudachiCsv(csvText, log);
}

async function computeSha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

async function checkFreshnessViaHead(log) {
  const meta = await cacheGet(`${CACHE_PREFIX}:meta`);
  if (!meta || !meta.sourceMeta) return null;

  for (const [name, info] of Object.entries(meta.sourceMeta)) {
    if (!info.url) return null;
    try {
      const res = await fetch(info.url, { method: "HEAD" });
      if (!res.ok) return null;
      const etag = res.headers.get("etag");
      const lastModified = res.headers.get("last-modified");
      if (!etag && !lastModified) return null;
      if (etag && info.etag && etag !== info.etag) {
        log(`  ${name}: eTagの変更を検知したため再取得します`);
        return null;
      }
      if (!etag && lastModified && info.lastModified && lastModified !== info.lastModified) {
        log(`  ${name}: LastModifiedの変更を検知したため再取得します`);
        return null;
      }
    } catch {
      return null;
    }
  }

  const allKeys = new Set(await cacheKeys());
  for (let i = 0; i < NUM_SHARDS; i++) {
    if (!allKeys.has(`${CACHE_PREFIX}:jmdict:s${i}`)) return null;
    if (!allKeys.has(`${CACHE_PREFIX}:vocab:s${i}`)) return null;
  }

  return meta;
}

async function findValidCache(hashes, sourceNames, log) {
  const meta = await cacheGet(`${CACHE_PREFIX}:meta`);
  if (!meta || !meta.hashes) return null;

  for (const name of sourceNames) {
    if (!meta.hashes[name] || meta.hashes[name] !== hashes[name]) {
      log(`  ${name} が最新版ではありません。キャッシュを再構築します`);
      return null;
    }
  }

  const cachedSources = meta.sources || [];
  if (
    cachedSources.length !== sourceNames.length ||
    !sourceNames.every((s) => cachedSources.includes(s))
  ) {
    log("ソース構成の変更を検出しました。キャッシュを再構築します");
    return null;
  }

  const allKeys = new Set(await cacheKeys());
  for (let i = 0; i < NUM_SHARDS; i++) {
    if (!allKeys.has(`${CACHE_PREFIX}:jmdict:s${i}`)) {
      log(`JMdictシャード s${i} が欠損しています。キャッシュを再構築します`);
      return null;
    }
    if (!allKeys.has(`${CACHE_PREFIX}:vocab:s${i}`)) {
      log(`語彙シャード s${i} が欠損しています。キャッシュを再構築します`);
      return null;
    }
  }

  return { meta };
}

async function loadFromCache(log) {
  log("キャッシュからJMdictを復元中…");

  const bySurface = new Map();
  const byReading = new Map();
  for (let i = 0; i < NUM_SHARDS; i++) {
    const raw = await cacheGet(`${CACHE_PREFIX}:jmdict:s${i}`);
    if (!raw) continue;
    const groups = JSON.parse(strFromU8(unzlibSync(raw)));
    for (const mora of Object.keys(groups)) {
      const { s: sEntries, r: rEntries } = groups[mora];
      for (const [key, reading, srcCode] of sEntries) {
        bySurface.set(key, {
          surface: key,
          reading,
          source: CODE_TO_SOURCE[srcCode],
        });
      }
      for (const [key, surface, reading, srcCode] of rEntries) {
        byReading.set(key, {
          surface,
          reading,
          source: CODE_TO_SOURCE[srcCode],
        });
      }
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  log(
    `  JMdict: ${(bySurface.size + byReading.size).toLocaleString()} 件復元`
  );

  const shardCache = new Map();
  async function loadMora(mora) {
    const si = shardFor(mora);
    if (!shardCache.has(si)) {
      const raw = await cacheGet(`${CACHE_PREFIX}:vocab:s${si}`);
      if (!raw) {
        shardCache.set(si, {});
      } else {
        const groups = JSON.parse(strFromU8(unzlibSync(raw)));
        const parsed = {};
        for (const m of Object.keys(groups)) {
          parsed[m] = groups[m].map(([reading, surface, catCode]) => ({
            surface,
            reading,
            category: CODE_TO_CATEGORY[catCode],
          }));
        }
        shardCache.set(si, parsed);
      }
    }
    return shardCache.get(si)[mora] || [];
  }

  const pool = new VocabPool(new Map(), { loadMora });
  log("  語彙プール: 遅延読み込みモード");

  return { bySurface, byReading, pool };
}

async function saveToCache(hashes, sourceNames, sourceTag, sourceMeta, jm, vocab, log) {
  const estimate = await storageEstimate();
  const available = estimate.quota - estimate.usage;
  if (available < 30 * 1024 * 1024) {
    log(`  空き容量不足 (${(available / 1024 / 1024).toFixed(0)} MB) → キャッシュをスキップします`);
    log(
      `dict-loader.js /655: saveToCacheが空き容量不足により失敗しました。 Available=${(available / 1024 / 1024).toFixed(0)}MB Quota=${(estimate.quota / 1024 / 1024).toFixed(0)}MB Usage=${(estimate.usage / 1024 / 1024).toFixed(0)}MB`,
      "warn"
    );
    return;
  }

  log("ブラウザキャッシュに保存中…");
  await cacheDeleteByPrefix(CACHE_PREFIX);
  await cacheDeleteByPrefix("shiritori-web-dict-v1");

  await cacheSet(`${CACHE_PREFIX}:meta`, {
    hashes,
    sources: sourceNames,
    sourceTag,
    sourceMeta,
    savedAt: Date.now(),
  });

  log(`  ${NUM_SHARDS} シャード x2 を書き込み中…`);

  const jmShards = Array.from({ length: NUM_SHARDS }, () => ({}));
  for (const [key, hit] of jm.bySurface) {
    const mora = effectiveFirstMora(hit.reading) || hit.reading[0] || "_";
    const si = shardFor(mora);
    if (!jmShards[si][mora]) jmShards[si][mora] = { s: [], r: [] };
    jmShards[si][mora].s.push([
      key,
      hit.reading,
      SOURCE_TO_CODE[hit.source] ?? 0,
    ]);
  }
  for (const [key, hit] of jm.byReading) {
    const mora = effectiveFirstMora(key) || key[0] || "_";
    const si = shardFor(mora);
    if (!jmShards[si][mora]) jmShards[si][mora] = { s: [], r: [] };
    jmShards[si][mora].r.push([
      key,
      hit.surface,
      hit.reading,
      SOURCE_TO_CODE[hit.source] ?? 0,
    ]);
  }
  for (let i = 0; i < NUM_SHARDS; i++) {
    const bytes = zlibSync(strToU8(JSON.stringify(jmShards[i])), { level: 6 });
    try {
      await cacheSet(`${CACHE_PREFIX}:jmdict:s${i}`, bytes);
    } catch (e) {
      log(`  jmdict:s${i} の保存に失敗しました: ${e.message}`);
      log(`dict-loader.js /709: saveToCache (s${i}) 失敗: ${e.name}: ${e.message}`, "error");
    }
    await new Promise((r) => setTimeout(r, 0));
  }

  const vocabShards = Array.from({ length: NUM_SHARDS }, () => ({}));
  for (const [mora, bucket] of vocab.byFirstMora) {
    const si = shardFor(mora);
    vocabShards[si][mora] = bucket.map((w) => [
      w.reading,
      w.surface,
      CATEGORY_TO_CODE[w.category] ?? 6,
    ]);
  }
  for (let i = 0; i < NUM_SHARDS; i++) {
    const bytes = zlibSync(strToU8(JSON.stringify(vocabShards[i])), {
      level: 6,
    });
    try {
      await cacheSet(`${CACHE_PREFIX}:vocab:s${i}`, bytes);
    } catch (e) {
      log(`  vocab:s${i} の保存に失敗しました: ${e.message}`);
      log(`dict-loader.js /731: saveToCache (s${i}) 失敗: ${e.name}: ${e.message}`, "error");
    }
    await new Promise((r) => setTimeout(r, 0));
  }
}

/**
 * @param {LogFn} log
 * @param {{ forceReload?: boolean, includeJmnedict?: boolean }} [options]
 */

export async function loadDictionaries(log = () => {}, options = {}) {
  const { forceReload = false, includeJmnedict = true } = options;

  await storagePersist();

  if (!forceReload) {
    try {
      log("キャッシュの鮮度をHEADで確認中…");
      const freshMeta = await checkFreshnessViaHead(log);
      if (freshMeta) {
        const cached = await loadFromCache(log);
        return {
          jmdict: new JmdictIndex(cached.bySurface, cached.byReading),
          pool: cached.pool,
          fromCache: true,
          sourceTag: freshMeta.sourceTag || "cache",
        };
      }
    } catch (e) {
      log(`  HEAD確認に失敗: ${e.message} → ダウンロードします`);
      log(`dict-loader.js /762: checkFreshnessViaHead 失敗: ${e.name}: ${e.message}`, "warn");
    }
  }

  log("ソースファイルを取得中…");
  const jmBuffers = await loadJmdictBuffers(log, { includeJmnedict });
  const sudachiBuffer = await loadSudachiBuffer(log);

  log("ソースファイルのハッシュを照合中…");
  const hashes = {};
  hashes.jmdict = await computeSha256Hex(jmBuffers.jmdict);
  if (jmBuffers.jmnedict) {
    hashes.jmnedict = await computeSha256Hex(jmBuffers.jmnedict);
  }
  hashes.sudachi = await computeSha256Hex(sudachiBuffer.data);
  const sourceNames = Object.keys(hashes);
  for (const [name, hex] of Object.entries(hashes)) {
    log(`  ${name}: ${hex.slice(0, 12)}…`);
  }

  if (!forceReload) {
    try {
      log("キャッシュをハッシュで確認中…");
      const valid = await findValidCache(hashes, sourceNames, log);
      if (valid) {
        const cached = await loadFromCache(log);
        return {
          jmdict: new JmdictIndex(cached.bySurface, cached.byReading),
          pool: cached.pool,
          fromCache: true,
          sourceTag: valid.meta.sourceTag || "cache",
        };
      }
    } catch (e) {
      log(`  キャッシュの確認に失敗しました: ${e.name}: ${e.message}`);
      log(`dict-loader.js /797: findValidCache 失敗: ${e.name}: ${e.message}`, "error");
    }
  }

  log("語彙を構築中…");
  const jm = parseJmdictSources(jmBuffers, log);
  const vocab = parseSudachiSource(sudachiBuffer, log);

  const sourceMeta = { ...jmBuffers.sourceMeta, sudachi: sudachiBuffer.sourceMeta };

  try {
    await saveToCache(
      hashes,
      sourceNames,
      jmBuffers.sourceTag,
      sourceMeta,
      jm,
      vocab,
      log
    );
  } catch (e) {
    log(`  キャッシュの保存に失敗しました: ${e.message}`);
    log("次回も辞書を再構築します。");
    log(`dict-loader.js /820: saveToCache 失敗: ${e.name}: ${e.message}\n${e.stack || ""}`, "error");
  }

  return {
    jmdict: new JmdictIndex(jm.bySurface, jm.byReading),
    pool: new VocabPool(vocab.byFirstMora),
    fromCache: false,
    sourceTag: jmBuffers.sourceTag,
  };
}
