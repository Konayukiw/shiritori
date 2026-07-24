/** Shiritori rule helpers (port of bot/utils/rules.py) */

import {
  containsObsoleteKana,
  isKanaOnlyReading,
  stripDakuten,
} from "./kana.js";

export const SUTEGANA = new Set("ぁぃぅぇぉっゃゅょゎゕゖ");

export function effectiveLastMora(reading) {
  if (!reading) return null;
  let i = reading.length - 1;
  while (i >= 0 && reading[i] === "ー") i -= 1;
  if (i < 0) return null;
  if (SUTEGANA.has(reading[i])) {
    if (i - 1 >= 0) return reading.slice(i - 1, i + 1);
    return reading[i];
  }
  return reading[i];
}

export function effectiveFirstMora(reading) {
  if (!reading) return null;
  if (reading.length >= 2 && SUTEGANA.has(reading[1])) {
    return reading.slice(0, 2);
  }
  return reading[0];
}

export function moraCount(reading) {
  if (!reading) return 0;
  let count = 0;
  let i = 0;
  const n = reading.length;
  while (i < n) {
    if (reading[i] === "ー") {
      count += 1;
      i += 1;
    } else if (i + 1 < n && SUTEGANA.has(reading[i + 1])) {
      count += 1;
      i += 2;
    } else {
      count += 1;
      i += 1;
    }
  }
  return count;
}

export function isOneMoraWord(reading) {
  if (!reading) return true;
  if (reading.length === 1) return true;
  if (
    reading.length === 2 &&
    SUTEGANA.has(reading[1]) &&
    !SUTEGANA.has(reading[0])
  ) {
    return true;
  }
  return moraCount(reading) <= 1 && !reading.includes("ー");
}

export function endsWithN(reading) {
  return effectiveLastMora(reading) === "ん";
}

export function moraMatches(expected, actualPrefix, requireDakutenMatch = true) {
  if (!expected || !actualPrefix) return false;
  if (requireDakutenMatch) {
    return actualPrefix.startsWith(expected);
  }
  return stripDakuten(actualPrefix).startsWith(stripDakuten(expected));
}

export function checkDefaultBans(
  reading,
  {
    banOneMora = true,
    banObsoleteKana = true,
    banNEnding = true,
    allowAlnum = false,
  } = {}
) {
  if (!reading) return "空の読みです";
  if (!isKanaOnlyReading(reading, allowAlnum)) {
    return "読みに使用できない文字が含まれています";
  }
  if (banObsoleteKana && containsObsoleteKana(reading)) {
    return "現代仮名遣いにない文字が含まれています";
  }
  if (banOneMora && isOneMoraWord(reading)) {
    return "1モーラの単語は使えません";
  }
  if (banNEnding && endsWithN(reading)) {
    return "『ん』で終わる単語は使えません";
  }
  return null;
}
