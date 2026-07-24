import { stripDakuten } from "./kana.js";
import { effectiveLastMora, moraMatches } from "./rules.js";

/**
 * @typedef {{ surface: string, reading: string, category: string, effectiveLastMora?: string|null }} BotWord
 */

function dakutenVariants(base) {
  const single = {
    か: ["が"], き: ["ぎ"], く: ["ぐ"], け: ["げ"], こ: ["ご"],
    さ: ["ざ"], し: ["じ"], す: ["ず"], せ: ["ぜ"], そ: ["ぞ"],
    た: ["だ"], ち: ["ぢ"], つ: ["づ"], て: ["で"], と: ["ど"],
    は: ["ば", "ぱ"], ひ: ["び", "ぴ"], ふ: ["ぶ", "ぷ"],
    へ: ["べ", "ぺ"], ほ: ["ぼ", "ぽ"], う: ["ゔ"],
  };
  const out = new Set();
  if (base.length === 1 && single[base]) {
    for (const v of single[base]) out.add(v);
  } else if (base.length === 2) {
    const head = base[0];
    const tail = base[1];
    for (const v of single[head] || []) out.add(v + tail);
  }
  return out;
}

export class VocabPool {
  /**
   * @param {Map<string, Array<{surface:string, reading:string, category:string}>>} byFirstMora
   */
  constructor(byFirstMora) {
    this.byFirstMora = byFirstMora;
  }

  findCandidates(
    firstMora,
    { allowedCategories, usedReadings, requireDakutenMatch = true }
  ) {
    if (!firstMora || !allowedCategories.length) return [];

    const keys = new Set([firstMora]);
    if (!requireDakutenMatch) {
      const stripped = stripDakuten(firstMora);
      keys.add(stripped);
      for (const v of dakutenVariants(stripped)) keys.add(v);
    }

    const allowed = new Set(allowedCategories);
    /** @type {BotWord[]} */
    const results = [];
    const seen = new Set();

    for (const key of keys) {
      const rows = this.byFirstMora.get(key) || [];
      for (const row of rows) {
        if (!allowed.has(row.category)) continue;
        const reading = row.reading;
        if (usedReadings.has(reading) || seen.has(reading)) continue;
        if (!moraMatches(firstMora, reading, requireDakutenMatch)) continue;
        const last = effectiveLastMora(reading);
        if (last === "ん") continue;
        seen.add(reading);
        results.push({
          surface: row.surface,
          reading,
          category: row.category,
          effectiveLastMora: last,
        });
      }
    }
    return results;
  }
}

export class BotWordSelector {
  /**
   * @param {VocabPool} pool
   * @param {object} config
   */
  constructor(pool, config) {
    this.pool = pool;
    this.config = config;
  }

  allowedCategories() {
    const cats = ["general"];
    const c = this.config;
    if (c.allowVerb) cats.push("verb");
    if (c.allowPerson) cats.push("person");
    if (c.allowPlace) cats.push("place");
    if (c.allowOrganization) cats.push("organization");
    if (c.allowProper) cats.push("proper");
    if (c.allowOther) cats.push("other");
    return cats;
  }

  select(requiredFirstMora, usedReadings) {
    const candidates = this.pool.findCandidates(requiredFirstMora, {
      allowedCategories: this.allowedCategories(),
      usedReadings,
      requireDakutenMatch: this.config.requireDakutenMatch,
    });
    if (!candidates.length) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
}
