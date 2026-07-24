/** Opponent word validator (port of bot/utils/validator.py) */

import {
  isAllowedSurface,
  normalizeReading,
  toHiragana,
} from "./kana.js";
import {
  checkDefaultBans,
  effectiveLastMora,
  endsWithN,
  moraMatches,
} from "./rules.js";
import { jmnedictAllowed } from "./config.js";

/**
 * @typedef {{ surface: string, reading: string, source: string }} DictHit
 */

export class JmdictIndex {
  /**
   * @param {Map<string, DictHit>} bySurface
   * @param {Map<string, DictHit>} byReading
   */
  constructor(bySurface, byReading) {
    this.bySurface = bySurface;
    this.byReading = byReading;
  }

  /**
   * @param {string} surface
   * @param {string|null} readingHint
   * @returns {DictHit|null}
   */
  lookup(surface, readingHint = null) {
    const hit = this.bySurface.get(surface);
    if (hit) return hit;

    const reading =
      readingHint != null ? readingHint : normalizeReading(surface);
    if (reading && reading !== surface) {
      const byR = this.byReading.get(reading);
      if (byR) return byR;
    }

    const byNorm = this.byReading.get(normalizeReading(surface));
    if (byNorm) return byNorm;
    return null;
  }
}

export class OpponentWordValidator {
  /**
   * @param {JmdictIndex} index
   * @param {object} config
   */
  constructor(index, config) {
    this.index = index;
    this.config = config;
  }

  validate(userInput, { expectedLastMora, usedReadings }) {
    const surface = userInput.trim();
    if (!surface) {
      return { ok: false, reason: "単語を入力してください" };
    }

    if (!isAllowedSurface(surface, this.config.allowAlnum)) {
      return {
        ok: false,
        reason:
          "使用できない文字が含まれています" +
          (this.config.allowAlnum ? "" : " (ひらがな・カタカナ・漢字のみ)"),
      };
    }

    let found = this.index.lookup(surface);
    if (!found) {
      const normalized = normalizeReading(surface);
      if (normalized !== surface) {
        found = this.index.lookup(surface, normalized);
      }
      if (!found && normalized) {
        found = this.index.lookup(normalized);
      }
    }

    if (!found) {
      return { ok: false, reason: "その単語は知りません" };
    }

    let { surface: _surf, reading, source } = found;
    reading = toHiragana(reading);

    if (source === "jmnedict" && !jmnedictAllowed(this.config)) {
      return {
        ok: false,
        reason: "固有名詞・人名などは現在の設定では使えません",
        surface: _surf,
        reading,
        source,
      };
    }

    const banReason = checkDefaultBans(reading, {
      banOneMora: this.config.banOneMora,
      banObsoleteKana: this.config.banObsoleteKana,
      banNEnding: false,
      allowAlnum: this.config.allowAlnum,
    });
    if (banReason) {
      return {
        ok: false,
        reason: banReason,
        surface: _surf,
        reading,
        source,
      };
    }

    if (usedReadings.has(reading)) {
      return {
        ok: false,
        reason: "その単語は既に使われています",
        surface: _surf,
        reading,
        source,
      };
    }

    if (expectedLastMora != null) {
      if (
        !moraMatches(expectedLastMora, reading, this.config.requireDakutenMatch)
      ) {
        return {
          ok: false,
          reason: `『${expectedLastMora}』から始まる単語を入力してください`,
          surface: _surf,
          reading,
          source,
        };
      }
    }

    const last = effectiveLastMora(reading);

    if (this.config.banNEnding && endsWithN(reading)) {
      return {
        ok: true,
        reason: "『ん』で終わったのであなたの負けです",
        surface: _surf,
        reading,
        source,
        effectiveLastMora: last,
        lost: true,
      };
    }

    return {
      ok: true,
      surface: _surf,
      reading,
      source,
      effectiveLastMora: last,
      lost: false,
    };
  }
}
