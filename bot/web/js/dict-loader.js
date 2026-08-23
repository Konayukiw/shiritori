import {
  Unzip,
  UnzipInflate,
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
const STREAM_CHUNK_BYTES = 1 << 20;
const SCAN_WINDOW_LIMIT = 64 << 20;

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

function isZipBytes(bytes) {
  return (
    bytes.length > 3 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
  );
}

function decodeBytesToTextChunks(bytes, onText) {
  const dec = new TextDecoder();
  for (let pos = 0; pos < bytes.length; pos += STREAM_CHUNK_BYTES) {
    const chunk = bytes.subarray(pos, Math.min(pos + STREAM_CHUNK_BYTES, bytes.length));
    const text = dec.decode(chunk, { stream: true });
    if (text) onText(text);
  }
  const tail = dec.decode();
  if (tail) onText(tail);
}

function streamZipMemberText(arrayBuffer, preferExt, onText) {
  return new Promise((resolve, reject) => {
    let chosenName = null;
    let finished = false;
    let failure = null;
    const dec = new TextDecoder();

    const unzip = new Unzip((file) => {
      if (file.name.endsWith("/")) return;
      const matches =
        !preferExt || file.name.toLowerCase().endsWith(preferExt);
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
    let pos = 0;
    const step = () => {
      if (failure) return reject(failure);
      if (pos >= bytes.length) {
        if (!chosenName) {
          return reject(new Error(`zip に ${preferExt || "ファイル"} がありません`));
        }
        if (!finished) {
          return reject(new Error("zip メンバーの展開が完了しませんでした"));
        }
        return resolve(chosenName);
      }
      const end = Math.min(pos + STREAM_CHUNK_BYTES, bytes.length);
      const final = end >= bytes.length;
      try {
        unzip.push(bytes.subarray(pos, end), final);
      } catch (e) {
        return reject(e);
      }
      pos = end;
      setTimeout(step, 0);
    };
    step();
  });
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
    throw new Error(`JMdict JSONの解析に失敗しました: ${msg}`);
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
        throw new Error("CSV行バッファが異常に肥大化しました");
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

function* iterWordPairs(words, source) {
  for (const word of words) {
    yield* wordPairsOf(word, source);
  }
}

function createJmBuilder() {
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

  return {
    bySurface,
    byReading,
    add,
    get count() {
      return count;
    },
  };
}

/**
 * @returns {{ bySurface: Map<string, object>, byReading: Map<string, object>, count: number }}
 */

export function buildJmdictMaps(jmdictWords, jmnedictWords = null) {
  const builder = createJmBuilder();
  for (const pair of iterWordPairs(jmdictWords, "jmdict")) {
    builder.add(pair[0], pair[1], pair[2]);
  }
  if (jmnedictWords) {
    for (const pair of iterWordPairs(jmnedictWords, "jmnedict")) {
      builder.add(pair[0], pair[1], pair[2]);
    }
  }
  return { bySurface: builder.bySurface, byReading: builder.byReading, count: builder.count };
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

function createVocabState() {
  
  /** 
   * @type {Map<string, Array<{surface:string, reading:string, category:string}>>}
  */

  const byFirstMora = new Map();
  const seen = new Set();
  return { byFirstMora, seen, total: 0, skipped: 0, lineNo: 0 };
}

function processSudachiLine(line, st) {
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
  let bucket = st.byFirstMora.get(first);
  if (!bucket) {
    bucket = [];
    st.byFirstMora.set(first, bucket);
  }
  bucket.push({ surface, reading, category });
  st.total += 1;
}

export function buildVocabFromSudachiCsv(csvText, log = () => {}) {
  const st = createVocabState();
  log("SudachiDictを解析中…");
  let start = 0;
  for (;;) {
    let nl = csvText.indexOf("\n", start);
    let last = false;
    if (nl === -1) {
      nl = csvText.length;
      last = true;
    }
    let line = csvText.slice(start, nl);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    processSudachiLine(line, st);
    if (st.lineNo % 200000 === 0) {
      log(`  SudachiDict ${st.lineNo.toLocaleString()} 行…`);
    }
    if (last) break;
    start = nl + 1;
  }
  log(`  → 語彙 ${st.total.toLocaleString()} 語 (スキップ ${st.skipped.toLocaleString()})`);
  return { byFirstMora: st.byFirstMora, total: st.total };
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

async function streamJmdictWordsInto(arrayBuffer, source, builder, log, label) {
  let seen = 0;
  const onWord = (word) => {
    for (const pair of wordPairsOf(word, source)) {
      builder.add(pair[0], pair[1], pair[2]);
    }
    seen += 1;
    if (seen % 200000 === 0) {
      log(`  ${label} ${seen.toLocaleString()} 語…`);
    }
  };

  const bytes = new Uint8Array(arrayBuffer);

  if (isZipBytes(bytes)) {
    try {
      const scanner = createWordScanner(onWord);
      await streamZipMemberText(arrayBuffer, ".json", (t) => scanner.push(t));
      scanner.end();
      return;
    } catch (e) {
      log(`  ${label}: ストリーム解析に失敗 (${e.message}) → 一括解析に切り替えます`);
      sendWebhook(`dict-loader streamJmdictWordsInto(${label}) ストリーム失敗: ${e.name}: ${e.message}`, "warn");
    }
    const { data } = unzipToJson(arrayBuffer);
    for (const word of data.words || []) onWord(word);
    return;
  }

  try {
    const scanner = createWordScanner(onWord);
    decodeBytesToTextChunks(bytes, (t) => scanner.push(t));
    scanner.end();
  } catch (e) {
    log(`  ${label}: ストリーム解析に失敗 (${e.message}) → 一括解析に切り替えます`);
    sendWebhook(`dict-loader streamJmdictWordsInto(${label}) raw失敗: ${e.name}: ${e.message}`, "warn");
    const data = JSON.parse(strFromU8(bytes));
    for (const word of data.words || []) onWord(word);
  }
}

async function parseJmdictSources(sources, log) {
  const builder = createJmBuilder();

  log("JMdictインデックスを構築中…");
  if (sources.jmdict) {
    await streamJmdictWordsInto(sources.jmdict, "jmdict", builder, log, "JMdict");
  }
  if (sources.jmnedict) {
    await streamJmdictWordsInto(sources.jmnedict, "jmnedict", builder, log, "JMnedict");
  }
  log(`  エントリ ${builder.count.toLocaleString()} 件`);
  return {
    bySurface: builder.bySurface,
    byReading: builder.byReading,
    count: builder.count,
  };
}

async function parseSudachiSource(sudachi, log) {
  const st = createVocabState();
  const onLine = (line) => {
    processSudachiLine(line, st);
    if (st.lineNo % 200000 === 0) {
      log(`  SudachiDict ${st.lineNo.toLocaleString()} 行…`);
    }
  };
  const lines = createLineScanner(onLine);
  const bytes = new Uint8Array(sudachi.data);

  const finish = () => {
    log(`  → 語彙 ${st.total.toLocaleString()} 語 (スキップ ${st.skipped.toLocaleString()})`);
    return { byFirstMora: st.byFirstMora, total: st.total };
  };

  log("SudachiDictを解析中…");

  const isCsvUrl =
    sudachi.url.endsWith(".csv") || sudachi.url.includes("small_lex.csv");

  if (isZipBytes(bytes) && !isCsvUrl) {
    try {
      await streamZipMemberText(sudachi.data, ".csv", (t) => lines.push(t));
      lines.flush();
      return finish();
    } catch (e) {
      log(`  SudachiDict: ストリーム解析に失敗 (${e.message}) → 一括解析に切り替えます`);
      sendWebhook(`dict-loader parseSudachiSource ストリーム失敗: ${e.name}: ${e.message}`, "warn");
    }
    const { text } = unzipToText(sudachi.data, ".csv");
    for (const line of text.split(/\r?\n/)) onLine(line);
    return finish();
  }

  try {
    decodeBytesToTextChunks(bytes, (t) => lines.push(t));
    lines.flush();
  } catch (e) {
    log(`  SudachiDict: ストリーム解析に失敗 (${e.message}) → 一括解析に切り替えます`);
    sendWebhook(`dict-loader parseSudachiSource raw失敗: ${e.name}: ${e.message}`, "warn");
    const text = strFromU8(bytes);
    for (const line of text.split(/\r?\n/)) onLine(line);
  }
  return finish();
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

function buildJmShard(jm, si) {
  const shard = {};
  for (const [key, hit] of jm.bySurface) {
    const mora = effectiveFirstMora(hit.reading) || hit.reading[0] || "_";
    if (shardFor(mora) !== si) continue;
    if (!shard[mora]) shard[mora] = { s: [], r: [] };
    shard[mora].s.push([
      key,
      hit.reading,
      SOURCE_TO_CODE[hit.source] ?? 0,
    ]);
  }
  for (const [key, hit] of jm.byReading) {
    const mora = effectiveFirstMora(key) || key[0] || "_";
    if (shardFor(mora) !== si) continue;
    if (!shard[mora]) shard[mora] = { s: [], r: [] };
    shard[mora].r.push([
      key,
      hit.surface,
      hit.reading,
      SOURCE_TO_CODE[hit.source] ?? 0,
    ]);
  }
  return shard;
}

function buildVocabShard(vocab, si) {
  const shard = {};
  for (const [mora, bucket] of vocab.byFirstMora) {
    if (shardFor(mora) !== si) continue;
    shard[mora] = bucket.map((w) => [
      w.reading,
      w.surface,
      CATEGORY_TO_CODE[w.category] ?? 6,
    ]);
  }
  return shard;
}

async function saveToCache(hashes, sourceNames, sourceTag, sourceMeta, jm, vocab, log) {
  const estimate = await storageEstimate();
  const available = estimate.quota - estimate.usage;
  if (available < 30 * 1024 * 1024) {
    log(`  空き容量不足 (${(available / 1024 / 1024).toFixed(0)} MB) → キャッシュをスキップします`);
    log(
      `dict-loader saveToCache: 空き容量不足によりスキップ。 Available=${(available / 1024 / 1024).toFixed(0)}MB Quota=${(estimate.quota / 1024 / 1024).toFixed(0)}MB Usage=${(estimate.usage / 1024 / 1024).toFixed(0)}MB`,
      "warn"
    );
    return;
  }

  log("ブラウザキャッシュに保存中…");
  await cacheDeleteByPrefix(CACHE_PREFIX);
  await cacheDeleteByPrefix("shiritori-web-dict-v1");

  log(`  ${NUM_SHARDS} シャード x2 を書き込み中…`);

  for (let si = 0; si < NUM_SHARDS; si++) {
    const bytes = zlibSync(strToU8(JSON.stringify(buildJmShard(jm, si))), {
      level: 6,
    });
    try {
      await cacheSet(`${CACHE_PREFIX}:jmdict:s${si}`, bytes);
    } catch (e) {
      log(`  jmdict:s${si} の保存に失敗しました: ${e.message}`);
      log(`dict-loader saveToCache (jmdict s${si}) 失敗: ${e.name}: ${e.message}`, "error");
    }
    await new Promise((r) => setTimeout(r, 0));
  }

  for (let si = 0; si < NUM_SHARDS; si++) {
    const bytes = zlibSync(strToU8(JSON.stringify(buildVocabShard(vocab, si))), {
      level: 6,
    });
    try {
      await cacheSet(`${CACHE_PREFIX}:vocab:s${si}`, bytes);
    } catch (e) {
      log(`  vocab:s${si} の保存に失敗しました: ${e.message}`);
      log(`dict-loader saveToCache (vocab s${si}) 失敗: ${e.name}: ${e.message}`, "error");
    }
    await new Promise((r) => setTimeout(r, 0));
  }

  await cacheSet(`${CACHE_PREFIX}:meta`, {
    hashes,
    sources: sourceNames,
    sourceTag,
    sourceMeta,
    savedAt: Date.now(),
  });
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
      log(`dict-loader checkFreshnessViaHead 失敗: ${e.name}: ${e.message}`, "warn");
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
      log(`dict-loader findValidCache 失敗: ${e.name}: ${e.message}`, "error");
    }
  }

  log("語彙を構築中…");
  const jm = await parseJmdictSources(jmBuffers, log);
  const vocab = await parseSudachiSource(sudachiBuffer, log);

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
    log(`dict-loader saveToCache 失敗: ${e.name}: ${e.message}\n${e.stack || ""}`, "error");
  }

  return {
    jmdict: new JmdictIndex(jm.bySurface, jm.byReading),
    pool: new VocabPool(vocab.byFirstMora),
    fromCache: false,
    sourceTag: jmBuffers.sourceTag,
  };
}
