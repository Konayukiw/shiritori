// Bot語彙レベル定義: id → { label, minZipf }
// minZipf は wordfreq (ja) の Zipf スケール。null はフィルタなし。
// Python 側 (bot/config.py) の VOCAB_LEVELS としきい値を揃えること。
export const VOCAB_LEVELS = {
  easy: { label: "やさしめ", minZipf: 3.5 },
  standard: { label: "標準", minZipf: 3.0 },
  hard: { label: "難しめ", minZipf: 2.0 },
  unlimited: { label: "制限なし（ガチ勢向け）", minZipf: null },
};

export const DEFAULT_VOCAB_LEVEL = "standard";

export function resolveVocabLevel(value) {
  return value in VOCAB_LEVELS ? value : DEFAULT_VOCAB_LEVEL;
}

export function minVocabZipf(config) {
  return VOCAB_LEVELS[resolveVocabLevel(config.vocabLevel)].minZipf;
}

export function defaultConfig() {
  return {
    allowPerson: false,
    allowPlace: false,
    allowOrganization: false,
    allowProper: false,
    allowOther: false,
    allowVerb: false,
    requireDakutenMatch: true,
    allowAlnum: false,
    banOneMora: true,
    banObsoleteKana: true,
    banNEnding: true,
    vocabLevel: DEFAULT_VOCAB_LEVEL,
  };
}

export function isCategoryAllowed(config, category) {
  switch (category) {
    case "general":
      return true;
    case "verb":
      return config.allowVerb;
    case "person":
      return config.allowPerson;
    case "place":
      return config.allowPlace;
    case "organization":
      return config.allowOrganization;
    case "proper":
      return config.allowProper;
    case "other":
      return config.allowOther;
    default:
      return config.allowOther;
  }
}

export function jmnedictAllowed(config) {
  return (
    config.allowPerson ||
    config.allowPlace ||
    config.allowOrganization ||
    config.allowProper ||
    config.allowOther
  );
}

export const DICT_SOURCES = {
  sudachiRelease: "20260428",
  sudachiFile: "small_lex.zip",
  sudachiBase:
    "http://sudachi.s3-website-ap-northeast-1.amazonaws.com/sudachidict-raw",
  jmdictApi:
    "https://api.github.com/repos/scriptin/jmdict-simplified/releases/latest",
  local: {
    sudachiZip: "./dicts/small_lex.zip",
    sudachiCsv: "./dicts/small_lex.csv",
    jmdictZip: "./dicts/jmdict-eng.json.zip",
    jmdictJson: "./dicts/jmdict-eng.json",
    jmnedictZip: "./dicts/jmnedict-all.json.zip",
    jmnedictJson: "./dicts/jmnedict-all.json",
    freqData: "./dicts/wordfreq-ja.tsv.gz",
  },
  cacheVersion: "shiritori-web-dict-v1",
};
