import {
  Unzip,
  UnzipInflate,
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
  cacheDelete,
  cacheKeys,
  cacheDeleteByPrefix,
  storagePersist,
  storageEstimate,
} from "./storage.js";
import { sendWebhook, markStage } from "./debug.js";
import { JmdictIndex } from "./validator.js";
import { VocabPool } from "./selector.js";

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

const CACHE_PREFIX = "shiritori-web-v3";
const LEGACY_PREFIXES = ["shiritori-web-v2", "shiritori-web-dict-v1"];
const NUM_SHARDS = 16;
const STREAM_CHUNK_BYTES = 1 << 20;
const SCAN_WINDOW_LIMIT = 64 << 20;
const FLUSH_THRESHOLD = 600_000;
const ZLIB_LEVEL = 1;
const JM_SHARD_LRU = 4;
const VOCAB_SHARD_LRU = 3;
const MIN_CACHE_FREE_BYTES = 60 * 1024 * 1024;

function shardFor(mora) {
  let h = 0;
  for (const ch of mora) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % NUM_SHARDS;
}

function yieldToEvents() {
  return new Promise((r) => setTimeout(r, 0));
}

async function fetchOk(url, { as = "arrayBuffer" } = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (as === "json") return res.json();
  if (as === "text") return res.text();
  return res.arrayBuffer();
}

async function fetchWithMeta(url) {
  const res = await fetch(url);
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

function isZipBytes(bytes) {
  return (
    bytes.length > 3 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
  );
}

function createWordScanner(onWord) {
  const S_ROOT = 0;
  const S_KEY = 1;
  const S_KEY_STR = 2;
  const S_COLON = 3;
  const S_VALUE = 4;
  const S_VALUE_STR = 5;
  const S_VALUE_BAL = 6;
  const S_VALUE_LIT = 7;
  const S_ARRAY = 8;
  const S_ITEM = 9;
  const S_DRAIN = 10;

  let state = S_ROOT;
  let buf = "";
  let pos = 0;
  let key = "";
  let inStr = false;
  let esc = false;
  let balDepth = 0;
  let itemStart = -1;
  let itemDepth = 0;
  let wordsClosed = false;

  function fail(msg) {
    throw new Error(`JMdict の解析に失敗しました: ${msg}`);
  }

  function compact() {
    const cut = state === S_ITEM && itemStart >= 0 ? itemStart : pos;
    if (cut > STREAM_CHUNK_BYTES) {
      buf = buf.slice(cut);
      pos -= cut;
      if (itemStart >= 0) itemStart -= cut;
    }
  }

  return {
    push(text) {
      buf += text;
      if (buf.length - pos > SCAN_WINDOW_LIMIT) {
        fail("バッファが異常に肥大化しました");
      }
      while (pos < buf.length) {
        const c = buf[pos];
        switch (state) {
          case S_ROOT:
            if (c === "{") {
              pos += 1;
              state = S_KEY;
            } else if (c === " " || c === "\n" || c === "\t" || c === "\r") {
              pos += 1;
            } else {
              fail("ルートがオブジェクトではありません");
            }
            break;

          case S_KEY:
            if (c === " " || c === "\n" || c === "\t" || c === "\r" || c === ",") {
              pos += 1;
            } else if (c === '"') {
              pos += 1;
              key = "";
              inStr = true;
              esc = false;
              state = S_KEY_STR;
            } else if (c === "}") {
              pos += 1;
              state = S_DRAIN;
            } else {
              fail(`トップレベルで不正な文字 '${c}'`);
            }
            break;

          case S_KEY_STR:
            if (esc) {
              key += c;
              esc = false;
            } else if (c === "\\") {
              esc = true;
            } else if (c === '"') {
              inStr = false;
              state = S_COLON;
            } else {
              key += c;
            }
            pos += 1;
            break;

          case S_COLON:
            if (c === " " || c === "\n" || c === "\t" || c === "\r") {
              pos += 1;
            } else if (c === ":") {
              pos += 1;
              state = S_VALUE;
            } else {
              fail(`キーの後に':'がありません ('${c}')`);
            }
            break;

          case S_VALUE:
            if (c === " " || c === "\n" || c === "\t" || c === "\r") {
              pos += 1;
            } else if (key === "words") {
              if (c === "[") {
                pos += 1;
                state = S_ARRAY;
              } else {
                fail("words が配列ではありません");
              }
            } else if (c === '"') {
              pos += 1;
              inStr = true;
              esc = false;
              state = S_VALUE_STR;
            } else if (c === "{") {
              pos += 1;
              balDepth = 1;
              inStr = false;
              esc = false;
              state = S_VALUE_BAL;
            } else if (c === "[") {
              pos += 1;
              balDepth = 1;
              inStr = false;
              esc = false;
              state = S_VALUE_BAL;
            } else if (c === "," || c === "}" || c === "]") {
              fail("空の値");
            } else {
              state = S_VALUE_LIT;
            }
            break;

          case S_VALUE_STR:
            if (esc) {
              esc = false;
            } else if (c === "\\") {
              esc = true;
            } else if (c === '"') {
              inStr = false;
              state = S_KEY;
            }
            pos += 1;
            break;

          case S_VALUE_BAL:
            if (inStr) {
              if (esc) esc = false;
              else if (c === "\\") esc = true;
              else if (c === '"') inStr = false;
            } else if (c === '"') {
              inStr = true;
            } else if (c === "{" || c === "[") {
              balDepth += 1;
            } else if (c === "}" || c === "]") {
              balDepth -= 1;
              if (balDepth === 0) {
                state = S_KEY;
              }
            }
            pos += 1;
            break;

          case S_VALUE_LIT:
            if (c === "," || c === "}" || c === " " || c === "\n" || c === "\t" || c === "\r") {
              state = S_KEY;
            } else {
              pos += 1;
            }
            break;

          case S_ARRAY:
            if (c === " " || c === "\n" || c === "\t" || c === "\r" || c === ",") {
              pos += 1;
            } else if (c === "]") {
              pos += 1;
              wordsClosed = true;
              state = S_DRAIN;
            } else if (c === "{") {
              itemStart = pos;
              itemDepth = 1;
              inStr = false;
              esc = false;
              pos += 1;
              state = S_ITEM;
            } else {
              fail(`words の要素がオブジェクトではありません ('${c}')`);
            }
            break;

          case S_ITEM:
            if (inStr) {
              if (esc) esc = false;
              else if (c === "\\") esc = true;
              else if (c === '"') inStr = false;
              pos += 1;
            } else if (c === '"') {
              inStr = true;
              pos += 1;
            } else if (c === "{" || c === "[") {
              itemDepth += 1;
              pos += 1;
            } else if (c === "}" || c === "]") {
              itemDepth -= 1;
              pos += 1;
              if (itemDepth === 0) {
                const item = buf.slice(itemStart, pos);
                onWord(JSON.parse(item));
                state = S_ARRAY;
              } else if (itemDepth < 0) {
                fail("words の要素が壊れています");
              }
            } else {
              pos += 1;
            }
            break;

          case S_DRAIN:
            pos = buf.length;
            break;
        }
      }
      compact();
    },

    end() {
      if (!wordsClosed) {
        fail('"words" 配列が見つかりませんでした');
      }
    },
  };
}

function createLineScanner(onLine) {
  let buf = "";
  return {
    push(text) {
      buf += text;
      let start = 0;
      for (;;) {
        const nl = buf.indexOf("\n", start);
        if (nl === -1) break;
        let line = buf.slice(start, nl);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        onLine(line);
        start = nl + 1;
      }
      if (start > 0) buf = buf.slice(start);
      if (buf.length > SCAN_WINDOW_LIMIT) {
        throw new Error("CSV 行バッファが異常に肥大化しました");
      }
    },
    flush() {
      const line = buf;
      buf = "";
      onLine(line);
    },
  };
}

function wordPairsOf(word, source) {
  const out = [];
  const kanjiList = word.kanji || [];
  const kanaList = word.kana || [];
  if (!kanaList.length) return out;

  for (const kana of kanaList) {
    const ktext = (kana.text || "").trim();
    if (!ktext) continue;
    const reading = toHiragana(normalizeReading(ktext));
    if (reading) out.push([ktext, reading, source]);
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
    if (reading) out.push([stext, reading, source]);
  }
  return out;
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

function createEagerJm() {
  const bySurface = new Map();
  const byReading = new Map();
  let count = 0;

  function add(surface, reading, srcCode) {
    const prev = bySurface.get(surface);
    if (!prev || (prev.src === 1 && srcCode === 0)) {
      bySurface.set(surface, { surface, reading, src: srcCode });
    }
    const prevR = byReading.get(reading);
    if (!prevR || (prevR.src === 1 && srcCode === 0)) {
      byReading.set(reading, { surface, reading, src: srcCode });
    }
    count += 1;
  }

  return { bySurface, byReading, add, get count() { return count; } };
}

function createEagerVocab() {
  const byFirstMora = new Map();
  let count = 0;

  function add(firstMora, reading, surface, catCode) {
    let bucket = byFirstMora.get(firstMora);
    if (!bucket) {
      bucket = [];
      byFirstMora.set(firstMora, bucket);
    }
    bucket.push([reading, surface, catCode]);
    count += 1;
  }

  return { byFirstMora, add, get count() { return count; } };
}

function createShardWriter({ gen, log, enabled }) {
  const jmPending = [];
  const vocabPending = [];
  for (let i = 0; i < NUM_SHARDS; i++) {
    jmPending.push({ s: new Map(), r: new Map() });
    vocabPending.push(new Map());
  }
  const eagerJm = createEagerJm();
  const eagerVocab = createEagerVocab();
  let pendingUnits = 0;
  let addedUnits = 0;
  let degraded = !enabled;
  let flushRounds = 0;
  const counts = { jmSurface: 0, jmReading: 0, vocab: 0 };

  function spillPendingToEager() {
    for (let si = 0; si < NUM_SHARDS; si++) {
      const p = jmPending[si];
      for (const [surface, pair] of p.s) {
        eagerJm.add(surface, pair[0], pair[1]);
      }
      for (const [reading, pair] of p.r) {
        eagerJm.add(pair[0], reading, pair[1]);
      }
      p.s.clear();
      p.r.clear();
      const v = vocabPending[si];
      for (const [mora, rows] of v) {
        for (const row of rows) eagerVocab.add(mora, row[0], row[1], row[2]);
      }
      v.clear();
    }
    pendingUnits = 0;
  }

  function addJm(surface, reading, srcCode) {
    if (degraded) {
      eagerJm.add(surface, reading, srcCode);
      addedUnits += 1;
      return;
    }
    const p = jmPending[shardFor(surface)];
    if (!p.s.has(surface)) {
      p.s.set(surface, [reading, srcCode]);
      pendingUnits += 1;
      addedUnits += 1;
    }
    const q = jmPending[shardFor(reading)];
    if (!q.r.has(reading)) {
      q.r.set(reading, [surface, srcCode]);
      pendingUnits += 1;
      addedUnits += 1;
    }
  }

  function addVocabRow(firstMora, reading, surface, catCode) {
    if (degraded) {
      eagerVocab.add(firstMora, reading, surface, catCode);
      addedUnits += 1;
      return;
    }
    const p = vocabPending[shardFor(firstMora)];
    let bucket = p.get(firstMora);
    if (!bucket) {
      bucket = [];
      p.set(firstMora, bucket);
    }
    bucket.push([reading, surface, catCode]);
    pendingUnits += 1;
    addedUnits += 1;
  }

  async function flushJmShard(si) {
    const p = jmPending[si];
    if (!p.s.size && !p.r.size) return;
    const key = `${CACHE_PREFIX}:jm:s${si}`;
    let sMap = new Map();
    let rMap = new Map();
    const existing = await cacheGet(key);
    if (existing) {
      try {
        const payload = JSON.parse(strFromU8(unzlibSync(existing)));
        if (payload.gen === gen) {
          if (Array.isArray(payload.s)) sMap = new Map(payload.s);
          if (Array.isArray(payload.r)) rMap = new Map(payload.r);
        }
      } catch (e) {
        sendWebhook(`dict-loader jm shard s${si} 再読に失敗: ${e && e.message}`, "warn");
      }
    }
    let insertedS = 0;
    let insertedR = 0;
    for (const [k, v] of p.s) {
      if (!sMap.has(k)) {
        sMap.set(k, v);
        insertedS += 1;
      }
    }
    for (const [k, v] of p.r) {
      if (!rMap.has(k)) {
        rMap.set(k, v);
        insertedR += 1;
      }
    }
    const payload = {
      gen,
      s: Array.from(sMap),
      r: Array.from(rMap),
    };
    await cacheSet(key, zlibSync(strToU8(JSON.stringify(payload)), { level: ZLIB_LEVEL }));
    counts.jmSurface += insertedS;
    counts.jmReading += insertedR;
    p.s.clear();
    p.r.clear();
  }

  async function flushVocabShard(si) {
    const p = vocabPending[si];
    if (!p.size) return;
    const key = `${CACHE_PREFIX}:vocab:s${si}`;
    let moraMap = new Map();
    const existing = await cacheGet(key);
    if (existing) {
      try {
        const payload = JSON.parse(strFromU8(unzlibSync(existing)));
        if (payload.gen === gen && Array.isArray(payload.mora)) {
          moraMap = new Map(payload.mora);
        }
      } catch (e) {
        sendWebhook(`シャード s${si} 再読み込みに失敗: ${e && e.message}`, "warn");
      }
    }
    let inserted = 0;
    for (const [mora, rows] of p) {
      const prev = moraMap.get(mora);
      if (prev) {
        for (const row of rows) prev.push(row);
      } else {
        moraMap.set(mora, rows);
      }
      inserted += rows.length;
    }
    const payload = { gen, mora: Array.from(moraMap) };
    await cacheSet(key, zlibSync(strToU8(JSON.stringify(payload)), { level: ZLIB_LEVEL }));
    counts.vocab += inserted;
    p.clear();
  }

  async function flushAll() {
    if (degraded) return;
    pendingUnits = 0;
    flushRounds += 1;
    log(`  シャード書き込み #${flushRounds}…`);
    for (let si = 0; si < NUM_SHARDS; si++) {
      try {
        await flushJmShard(si);
        await flushVocabShard(si);
      } catch (e) {
        degraded = true;
        spillPendingToEager();
        sendWebhook(
          `シャード書き込み失敗 (s${si}): ${e && e.name}: ${e && e.message}。RAMモードで継続`,
          "warn"
        );
        return;
      }
      await yieldToEvents();
    }
  }

  async function flushIfHeavy() {
    if (degraded || addedUnits < FLUSH_THRESHOLD) return;
    await flushAll();
  }

  async function finalize({ hashes, sourceNames, sourceTag, sourceMeta }) {
    await flushAll();
    if (degraded) {
      return { degraded: true, eagerJm, eagerVocab };
    }
    await cacheSet(`${CACHE_PREFIX}:meta`, {
      version: 3,
      gen,
      savedAt: Date.now(),
      hashes,
      sources: sourceNames,
      sourceTag,
      sourceMeta,
      counts,
    });
    for (const legacy of LEGACY_PREFIXES) {
      await cacheDeleteByPrefix(legacy);
    }
    log(
      `  キャッシュ保存完了 (索引 ${counts.jmSurface.toLocaleString()}+${counts.jmReading.toLocaleString()} 件 / 語彙 ${counts.vocab.toLocaleString()} 件)`
    );
    return { degraded: false, eagerJm: null, eagerVocab: null };
  }

  return {
    addJm,
    addVocabRow,
    flushIfHeavy,
    finalize,
    get counts() {
      return counts;
    },
    getEagerFallback() {
      return { eagerJm, eagerVocab };
    },
  };}

function createJmIdbLoader({ gen }) {
  const lru = new Map();

  async function getShard(si) {
    let shard = lru.get(si);
    if (shard) {
      lru.delete(si);
      lru.set(si, shard);
      return shard;
    }
    const raw = await cacheGet(`${CACHE_PREFIX}:jm:s${si}`);
    shard = { s: new Map(), r: new Map() };
    if (raw) {
      let payload = null;
      try {
        payload = JSON.parse(strFromU8(unzlibSync(raw)));
      } catch (e) {
        sendWebhook(`シャード s${si} の解凍に失敗: ${e && e.message}`, "warn");
      }
      if (payload && payload.gen === gen) {
        if (Array.isArray(payload.s)) shard.s = new Map(payload.s);
        if (Array.isArray(payload.r)) shard.r = new Map(payload.r);
      } else if (payload) {
        sendWebhook(`シャード s${si} の不一致 (raw=${payload.gen} gen=${gen})`, "warn");
      }
    }
    lru.set(si, shard);
    if (lru.size > JM_SHARD_LRU) {
      lru.delete(lru.keys().next().value);
    }
    return shard;
  }

  return {
    async lookupSurface(surface) {
      const shard = await getShard(shardFor(surface));
      const v = shard.s.get(surface);
      if (!v) return null;
      return { surface, reading: v[0], source: CODE_TO_SOURCE[v[1] ?? 0] };
    },
    async lookupReading(reading) {
      const shard = await getShard(shardFor(reading));
      const v = shard.r.get(reading);
      if (!v) return null;
      return { surface: v[0], reading, source: CODE_TO_SOURCE[v[1] ?? 0] };
    },
  };
}

function createEagerJmLoader(eagerJm) {
  return {
    async lookupSurface(surface) {
      const hit = eagerJm.bySurface.get(surface);
      if (!hit) return null;
      return { surface, reading: hit.reading, source: CODE_TO_SOURCE[hit.src ?? 0] };
    },
    async lookupReading(reading) {
      const hit = eagerJm.byReading.get(reading);
      if (!hit) return null;
      return { surface: hit.surface, reading, source: CODE_TO_SOURCE[hit.src ?? 0] };
    },
  };
}

function createCompositeJmLoader(primary, secondary) {
  return {
    async lookupSurface(surface) {
      return (
        (await primary.lookupSurface(surface)) ||
        (await secondary.lookupSurface(surface))
      );
    },
    async lookupReading(reading) {
      return (
        (await primary.lookupReading(reading)) ||
        (await secondary.lookupReading(reading))
      );
    },
  };
}

function createVocabIdbLoader({ gen }) {
  const lru = new Map();

  async function getShard(si) {
    let shard = lru.get(si);
    if (shard) {
      lru.delete(si);
      lru.set(si, shard);
      return shard;
    }
    const raw = await cacheGet(`${CACHE_PREFIX}:vocab:s${si}`);
    shard = { mora: new Map() };
    if (raw) {
      let payload = null;
      try {
        payload = JSON.parse(strFromU8(unzlibSync(raw)));
      } catch (e) {
        sendWebhook(`シャード s${si} の解凍に失敗: ${e && e.message}`, "warn");
      }
      if (payload && payload.gen === gen && Array.isArray(payload.mora)) {
        shard.mora = new Map(payload.mora);
      } else if (payload) {
        sendWebhook(`シャード s${si} の不一致 (raw=${payload.gen} gen=${gen})`, "warn");
      }
    }
    lru.set(si, shard);
    if (lru.size > VOCAB_SHARD_LRU) {
      lru.delete(lru.keys().next().value);
    }
    return shard;
  }

  return {
    async loadMora(mora) {
      const shard = await getShard(shardFor(mora));
      const rows = shard.mora.get(mora) || [];
      return rows.map(([reading, surface, catCode]) => ({
        surface,
        reading,
        category: CODE_TO_CATEGORY[catCode] ?? "other",
      }));
    },
  };
}

function eagerVocabToPoolMap(eagerVocab) {
  const byFirstMora = new Map();
  for (const [mora, rows] of eagerVocab.byFirstMora) {
    byFirstMora.set(
      mora,
      rows.map(([reading, surface, catCode]) => ({
        surface,
        reading,
        category: CODE_TO_CATEGORY[catCode] ?? "other",
      }))
    );
  }
  return byFirstMora;
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

async function acquireJmSource(log, kind, state) {
  const local = DICT_SOURCES.local;
  const zipUrl = kind === "jmdict" ? local.jmdictZip : local.jmnedictZip;
  const jsonUrl = kind === "jmdict" ? local.jmdictJson : local.jmnedictJson;

  log(`${kind === "jmdict" ? "JMdict" : "JMnedict"}からファイルを取得中…`);
  try {
    const hit = await tryFetchWithMeta([zipUrl]);
    log(`  取得元: ${hit.url}`);
    return { data: hit.data, meta: { url: hit.url, etag: hit.etag, lastModified: hit.lastModified } };
  } catch (e1) {
    try {
      const hit = await tryFetchWithMeta([jsonUrl]);
      log(`  取得元: ${hit.url}`);
      return { data: hit.data, meta: { url: hit.url, etag: hit.etag, lastModified: hit.lastModified } };
    } catch (e2) {
      if (kind === "jmnedict") {
        log(`  JMnedict からのファイルの取得をスキップ: ${e2.message}`);
        return null;
      }
      if (!state.urls) {
        state.urls = await resolveJmdictAssetUrls(log);
        state.tag = state.urls.tag;
      }
      try {
        const hit = await fetchWithMeta(state.urls.jmdict);
        return { data: hit.data, meta: { url: hit.url, etag: hit.etag, lastModified: hit.lastModified } };
      } catch (e3) {
        throw new Error(`JMdict からのファイルの取得に失敗しました: ${e3.message}\n`);
      }
    }
  }
}

async function loadSudachiSource(log) {
  const local = DICT_SOURCES.local;
  const remoteZip = `${DICT_SOURCES.sudachiBase}/${DICT_SOURCES.sudachiRelease}/${DICT_SOURCES.sudachiFile}`;

  log("SudachiDict からファイルを取得中…");
  const hit = await tryFetchWithMeta([local.sudachiZip, remoteZip, local.sudachiCsv]);
  log(`  取得元: ${hit.url}`);
  return {
    url: hit.url,
    data: hit.data,
    meta: { url: hit.url, etag: hit.etag, lastModified: hit.lastModified },
  };
}

async function computeSha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

async function checkFreshnessViaHead(log) {
  const meta = await cacheGet(`${CACHE_PREFIX}:meta`);
  if (!meta || !meta.sourceMeta || !meta.gen) return null;

  for (const [name, info] of Object.entries(meta.sourceMeta)) {
    if (!info || !info.url) return null;
    try {
      const res = await fetch(info.url, { method: "HEAD" });
      if (!res.ok) return null;
      const etag = res.headers.get("etag");
      const lastModified = res.headers.get("last-modified");
      if (!etag && !lastModified) return null;
      if (etag && info.etag && etag !== info.etag) {
        log(`  ${name}: eTag の変更を検知したため再取得します`);
        return null;
      }
      if (!etag && lastModified && info.lastModified && lastModified !== info.lastModified) {
        log(`  ${name}: LastModified の変更を検知したため再取得します`);
        return null;
      }
    } catch {
      return null;
    }
  }

  const allKeys = new Set(await cacheKeys());
  for (let i = 0; i < NUM_SHARDS; i++) {
    if (!allKeys.has(`${CACHE_PREFIX}:jm:s${i}`)) return null;
    if (!allKeys.has(`${CACHE_PREFIX}:vocab:s${i}`)) return null;
  }

  return meta;
}

async function tryLoadFromCache(log, { includeJmnedict }) {
  markStage("cache:head-check");
  const meta = await checkFreshnessViaHead(log);
  if (!meta) return null;

  const need = includeJmnedict
    ? ["jmdict", "jmnedict", "sudachi"]
    : ["jmdict", "sudachi"];
  if (!need.every((s) => (meta.sources || []).includes(s))) {
    log("  キャッシュのソース構成が異なるため再構築します");
    return null;
  }

  log("キャッシュ済みの語彙で開始します (遅延読み込み)");
  return {
    jmdict: new JmdictIndex(createJmIdbLoader({ gen: meta.gen })),
    pool: new VocabPool(new Map(), {
      loadMora: createVocabIdbLoader({ gen: meta.gen }).loadMora,
    }),
    fromCache: true,
    sourceTag: meta.sourceTag || "cache",
  };
}

async function streamZipMemberText(arrayBuffer, preferExt, onText, onChunk) {
  let chosenName = null;
  let finished = false;
  let failure = null;
  const dec = new TextDecoder();

  const unzip = new Unzip((file) => {
    if (file.name.endsWith("/")) return;
    const matches = !preferExt || file.name.toLowerCase().endsWith(preferExt);
    if (matches && !chosenName) {
      chosenName = file.name;
      file.ondata = (err, data, final) => {
        if (err) {
          failure = failure || err;
          return;
        }
        try {
          const text = dec.decode(data, { stream: !final });
          if (text) onText(text);
          if (final) {
            const tail = dec.decode();
            if (tail) onText(tail);
            finished = true;
          }
        } catch (e) {
          failure = failure || e;
        }
      };
    } else {
      file.ondata = () => {};
    }
    file.start();
  });
  unzip.register(UnzipInflate);

  const bytes = new Uint8Array(arrayBuffer);
  for (let pos = 0; pos < bytes.length; ) {
    if (failure) throw failure;
    const end = Math.min(pos + STREAM_CHUNK_BYTES, bytes.length);
    const final = end >= bytes.length;
    unzip.push(bytes.subarray(pos, end), final);
    pos = end;
    if (failure) throw failure;
    if (onChunk) await onChunk();
    await yieldToEvents();
  }
  if (failure) throw failure;
  if (!chosenName) {
    throw new Error(`zip に ${preferExt || "ファイル"} がありません`);
  }
  if (!finished) {
    throw new Error("zip メンバーの展開が完了しませんでした");
  }
  return chosenName;
}

async function decodeBytesToTextChunks(bytes, onText, onChunk) {
  const dec = new TextDecoder();
  for (let pos = 0; pos < bytes.length; pos += STREAM_CHUNK_BYTES) {
    const chunk = bytes.subarray(pos, Math.min(pos + STREAM_CHUNK_BYTES, bytes.length));
    const text = dec.decode(chunk, { stream: true });
    if (text) onText(text);
    if (onChunk) await onChunk();
    await yieldToEvents();
  }
  const tail = dec.decode();
  if (tail) onText(tail);
}

async function streamJmdictWordsInto(arrayBuffer, source, writer, log, label) {
  let seen = 0;
  const onWord = (word) => {
    const srcCode = SOURCE_TO_CODE[source];
    for (const pair of wordPairsOf(word, source)) {
      writer.addJm(pair[0], pair[1], srcCode);
    }
    seen += 1;
    if (seen % 200000 === 0) {
      log(`  ${label} ${seen.toLocaleString()} 語…`);
    }
  };

  const scanner = createWordScanner(onWord);
  const bytes = new Uint8Array(arrayBuffer);
  const onChunk = () => writer.flushIfHeavy();

  try {
    if (isZipBytes(bytes)) {
      await streamZipMemberText(arrayBuffer, ".json", (t) => scanner.push(t), onChunk);
      scanner.end();
      return;
    }
    await decodeBytesToTextChunks(bytes, (t) => scanner.push(t), onChunk);
    scanner.end();
  } catch (e) {
    sendWebhook(
      `dict-loader streamJmdictWordsInto(${label}) 失敗: ${e && e.name}: ${e && e.message}`,
      "error"
    );
    throw e;
  }
}

async function parseSudachiInto(sudachiData, url, writer, log) {
  const st = { seen: new Set(), total: 0, skipped: 0, lineNo: 0 };
  const onLine = (line) => {
    processSudachiLine(line, st, writer);
    if (st.lineNo % 200000 === 0) {
      log(`  SudachiDict ${st.lineNo.toLocaleString()} 行…`);
    }
  };
  const lines = createLineScanner(onLine);
  const bytes = new Uint8Array(sudachiData);
  const onChunk = () => writer.flushIfHeavy();

  log("SudachiDict を解析中…");
  const isCsvUrl =
    url.endsWith(".csv") || url.includes("small_lex.csv");

  try {
    if (isZipBytes(bytes) && !isCsvUrl) {
      await streamZipMemberText(sudachiData, ".csv", (t) => lines.push(t), onChunk);
      lines.flush();
    } else {
      await decodeBytesToTextChunks(bytes, (t) => lines.push(t), onChunk);
      lines.flush();
    }
  } catch (e) {
    sendWebhook(
      `dict-loader parseSudachiInto 失敗: ${e && e.name}: ${e && e.message}`,
      "error"
    );
    throw e;
  }

  log(`  → 語彙 ${st.total.toLocaleString()} 語 (スキップ ${st.skipped.toLocaleString()})`);
}

function processSudachiLine(line, st, writer) {
  st.lineNo += 1;
  if (!line) return;
  const row = parseCsvLine(line);
  if (row.length < 12) {
    st.skipped += 1;
    return;
  }

  let surface = (row[4] || row[0] || "").trim();
  const readingRaw = (row[11] || "").trim();
  const pos1 = (row[5] || "").trim();
  const pos2 = (row[6] || "").trim();
  const pos3 = (row[7] || "").trim();
  const cform = (row[10] || "").trim();
  const norm = (row[12] || "").trim();

  if (!surface || !readingRaw || readingRaw === "*") {
    st.skipped += 1;
    return;
  }
  if ((pos1 === "動詞" || pos1 === "形容詞") && !cform.startsWith("終止形")) {
    st.skipped += 1;
    return;
  }

  const category = classifyPos(pos1, pos2, pos3);
  if (category == null) {
    st.skipped += 1;
    return;
  }
  if ((pos1 === "動詞" || pos1 === "形容詞") && norm && norm !== "*") {
    surface = norm;
  }
  if (!isAllowedSurface(surface, false)) {
    st.skipped += 1;
    return;
  }

  const reading = toHiragana(normalizeReading(readingRaw));
  if (!reading) {
    st.skipped += 1;
    return;
  }
  if (!isKanaOnlyReading(reading, false)) {
    st.skipped += 1;
    return;
  }
  if (containsObsoleteKana(reading)) {
    st.skipped += 1;
    return;
  }
  if (isOneMoraWord(reading)) {
    st.skipped += 1;
    return;
  }
  if (endsWithN(reading)) {
    st.skipped += 1;
    return;
  }
  if (st.seen.has(reading)) {
    st.skipped += 1;
    return;
  }
  st.seen.add(reading);

  const first = effectiveFirstMora(reading) || reading[0];
  writer.addVocabRow(first, reading, surface, CATEGORY_TO_CODE[category] ?? 6);
  st.total += 1;
}

/**
 * @param {LogFn} log
 * @param {{ forceReload?: boolean, includeJmnedict?: boolean }} [options]
 */

export async function loadDictionaries(log = () => {}, options = {}) {
  const { forceReload = false, includeJmnedict = true } = options;

  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error(
      "この環境では crypto.subtle (SHA-256) を利用できません。HTTPS または localhost でページを開いてください。"
    );
  }

  await storagePersist();
  markStage("load-start");

  if (!forceReload) {
    try {
      const cached = await tryLoadFromCache(log, { includeJmnedict });
      if (cached) {
        markStage("cache:ready");
        return cached;
      }
    } catch (e) {
      log(`  キャッシュの確認に失敗: ${e.message} → 再構築します`);
      sendWebhook(
        `dict-loader tryLoadFromCache 失敗: ${e && e.name}: ${e && e.message}`,
        "warn"
      );
    }
  }

  const gen = Date.now();

  try {
    await cacheDelete(`${CACHE_PREFIX}:meta`);
  } catch {}

  const estimate = await storageEstimate();
  const available =
    estimate.quota === Infinity
      ? Infinity
      : estimate.quota - estimate.usage;
  const cacheEnabled = available >= MIN_CACHE_FREE_BYTES;
  if (!cacheEnabled) {
    log(
      `  空き容量不足 (${(available / 1024 / 1024).toFixed(0)} MB) → キャッシュなしで動作します`
    );
  }
  const writer = createShardWriter({ gen, log, enabled: cacheEnabled });

  const hashes = {};
  const sourceMeta = {};
  let sourceTag = "local";
  const jmState = { urls: null, tag: null };

  markStage("rebuild:fetch-jmdict");
  const jmdictSource = await acquireJmSource(log, "jmdict", jmState);
  if (jmState.tag) sourceTag = jmState.tag;
  sourceMeta.jmdict = jmdictSource.meta;
  hashes.jmdict = await computeSha256Hex(jmdictSource.data);

  markStage("rebuild:parse-jmdict");
  log("JMdictインデックスを構築中…");
  await streamJmdictWordsInto(jmdictSource.data, "jmdict", writer, log, "JMdict");
  log(`  エントリ ${(writer.counts.jmSurface + writer.counts.jmReading).toLocaleString()} 件`);
  jmdictSource.data = null;

  markStage("rebuild:fetch-jmnedict");
  let jmnedictData = null;
  try {
    const jmnedictSource = await acquireJmSource(log, "jmnedict", jmState);
    if (jmnedictSource) {
      jmnedictData = jmnedictSource.data;
      sourceMeta.jmnedict = jmnedictSource.meta;
      hashes.jmnedict = await computeSha256Hex(jmnedictData);
    }
  } catch (e) {
    log(`  JMnedictの取得に失敗: ${e.message}`);
    sendWebhook(`dict-loader jmnedict取得失敗: ${e && e.name}: ${e && e.message}`, "warn");
  }

  if (jmnedictData) {
    markStage("rebuild:parse-jmnedict");
    await streamJmdictWordsInto(jmnedictData, "jmnedict", writer, log, "JMnedict");
    log(`  エントリ ${(writer.counts.jmSurface + writer.counts.jmReading).toLocaleString()} 件`);
    jmnedictData = null;
  }

  markStage("rebuild:fetch-sudachi");
  const sudachi = await loadSudachiSource(log);
  sourceMeta.sudachi = sudachi.meta;
  hashes.sudachi = await computeSha256Hex(sudachi.data);

  markStage("rebuild:parse-sudachi");
  await parseSudachiInto(sudachi.data, sudachi.url, writer, log);
  sudachi.data = null;

  const sourceNames = Object.keys(hashes);
  for (const [name, hex] of Object.entries(hashes)) {
    log(`  ${name}: ${hex.slice(0, 12)}…`);
  }

  markStage("rebuild:save-cache");
  let finalizeResult = null;
  try {
    finalizeResult = await writer.finalize({
      hashes,
      sourceNames,
      sourceTag,
      sourceMeta,
    });
  } catch (e) {
    log(`  キャッシュの保存に失敗しました: ${e.message}`);
    log("次回も辞書を再構築します。");
    sendWebhook(
      `dict-loader saveToCache 失敗: ${e && e.name}: ${e && e.message}\n${(e && e.stack) || ""}`,
      "error"
    );
    finalizeResult = { degraded: true, ...writer.getEagerFallback() };
  }
  markStage("rebuild:done");

  if (finalizeResult && !finalizeResult.degraded) {
    return {
      jmdict: new JmdictIndex(createJmIdbLoader({ gen })),
      pool: new VocabPool(new Map(), {
        loadMora: createVocabIdbLoader({ gen }).loadMora,
      }),
      fromCache: false,
      sourceTag,
    };
  }

  const eager = finalizeResult
    ? finalizeResult
    : writer.getEagerFallback();
  log("  キャッシュ無効のためRAM併用モードで動作します (次回起動時に再構築)");

  const idbJmLoader = createJmIdbLoader({ gen });
  const eagerLoader = createEagerJmLoader(eager.eagerJm);
  const jmLoader = createCompositeJmLoader(eagerLoader, idbJmLoader);

  const idbVocabLoader = createVocabIdbLoader({ gen });
  const pool = new VocabPool(eagerVocabToPoolMap(eager.eagerVocab), {
    loadMora: idbVocabLoader.loadMora,
  });

  return {
    jmdict: new JmdictIndex(jmLoader),
    pool,
    fromCache: false,
    sourceTag,
  };
}
