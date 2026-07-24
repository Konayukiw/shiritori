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
  },
  cacheVersion: "shiritori-web-dict-v1",
};
