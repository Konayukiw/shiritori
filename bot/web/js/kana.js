export const MODERN_HIRAGANA = new Set(
  "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん" +
    "がぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽ" +
    "ぁぃぅぇぉっゃゅょゎゕゖー"
);

export const OBSOLETE_KANA = new Set("ゐゑゐ゙ゑ゙ヰヱゐ゚ゑ゚");
export const ALLOWED_KANA_MARKS = new Set("ー・");

const ALNUM_RE = /[A-Za-z0-9Ａ-Ｚａ-ｚ０-９]/;

const DAKUTEN_STRIP = {
  が: "か", ぎ: "き", ぐ: "く", げ: "け", ご: "こ",
  ざ: "さ", じ: "し", ず: "す", ぜ: "せ", ぞ: "そ",
  だ: "た", ぢ: "ち", づ: "つ", で: "て", ど: "と",
  ば: "は", び: "ひ", ぶ: "ふ", べ: "へ", ぼ: "ほ",
  ぱ: "は", ぴ: "ひ", ぷ: "ふ", ぺ: "へ", ぽ: "ほ",
  ゔ: "う",
};

export function toHiragana(text) {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0x30a1 && code <= 0x30f6) {
      out += String.fromCodePoint(code - 0x60);
    } else if (ch === "ヵ") {
      out += "か";
    } else if (ch === "ヶ") {
      out += "け";
    } else if (ch === "ヴ") {
      out += "ゔ";
    } else {
      out += ch;
    }
  }
  return out;
}

export function normalizeReading(text) {
  const nfkc = text.trim().normalize("NFKC");
  return toHiragana(nfkc);
}

export function isHiraganaChar(ch) {
  return (ch >= "\u3040" && ch <= "\u309f") || ch === "ー";
}

export function isKatakanaChar(ch) {
  return ch >= "\u30a0" && ch <= "\u30ff";
}

export function isKanaChar(ch) {
  return isHiraganaChar(ch) || isKatakanaChar(ch);
}

export function isAlnumChar(ch) {
  return ALNUM_RE.test(ch) || (/^[A-Za-z0-9]$/.test(ch));
}

function isCjk(ch) {
  const code = ch.codePointAt(0);
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x20000 && code <= 0x2fa1f) ||
    (code >= 0x3005 && code <= 0x3007) ||
    ch === "々" ||
    ch === "〆" ||
    ch === "ヵ" ||
    ch === "ヶ"
  );
}

export function containsObsoleteKana(text) {
  for (const ch of text) {
    if (OBSOLETE_KANA.has(ch)) return true;
    if (isHiraganaChar(ch) && !MODERN_HIRAGANA.has(ch) && ch !== "゛" && ch !== "゜" && ch !== "゙" && ch !== "゚") {
      if (ch >= "\u3041" && ch <= "\u3096" && !MODERN_HIRAGANA.has(ch)) {
        return true;
      }
    }
  }
  return false;
}

export function isAllowedSurface(text, allowAlnum = false) {
  if (!text) return false;
  const n = text.normalize("NFKC");
  for (const ch of n) {
    if (/\s/.test(ch)) return false;
    if (isKanaChar(ch) || ALLOWED_KANA_MARKS.has(ch)) continue;
    if (isCjk(ch)) continue;
    if (allowAlnum && isAlnumChar(ch)) continue;
    return false;
  }
  return true;
}

export function isKanaOnlyReading(text, allowAlnum = false) {
  if (!text) return false;
  for (const ch of text) {
    if (MODERN_HIRAGANA.has(ch) || ch === "ー") continue;
    if (OBSOLETE_KANA.has(ch)) return false;
    if (allowAlnum && isAlnumChar(ch)) continue;
    if (!isHiraganaChar(ch)) return false;
    if (!MODERN_HIRAGANA.has(ch)) return false;
  }
  return true;
}

export function stripDakuten(text) {
  let out = "";
  for (const ch of text) {
    out += DAKUTEN_STRIP[ch] || ch;
  }
  return out;
}
