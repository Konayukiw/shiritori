from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = PACKAGE_ROOT.parent

DEFAULT_DATA_DIR = PROJECT_ROOT / "data"
DEFAULT_RAW_DIR = DEFAULT_DATA_DIR / "raw"
DEFAULT_CACHE_DIR = DEFAULT_DATA_DIR / "cache"

JMDICT_DB_NAME = "jmdict.sqlite3"
VOCAB_DB_NAME = "vocab_pool.sqlite3"
FREQ_DATA_NAME = "wordfreq-ja.tsv.gz"

VOCAB_LEVELS: dict[str, tuple[str, float | None]] = {
    "easy": ("やさしめ", 3.5),
    "standard": ("標準", 3.0),
    "hard": ("難しめ", 2.0),
    "unlimited": ("制限なし（ガチ勢向け）", None),
}
DEFAULT_VOCAB_LEVEL = "standard"


def resolve_vocab_level(value: str | None) -> str:
    return value if value in VOCAB_LEVELS else DEFAULT_VOCAB_LEVEL


def vocab_level_min_zipf(value: str | None) -> float | None:
    return VOCAB_LEVELS[resolve_vocab_level(value)][1]


@dataclass
class GameConfig:
    allow_person: bool = False
    allow_place: bool = False
    allow_organization: bool = False
    allow_proper: bool = False
    allow_other: bool = False
    allow_verb: bool = False
    require_dakuten_match: bool = True
    allow_alnum: bool = False
    ban_one_mora: bool = True
    ban_obsolete_kana: bool = True
    ban_n_ending: bool = True
    vocab_level: str = DEFAULT_VOCAB_LEVEL
    min_zipf_override: float | None = None

    data_dir: Path = field(default_factory=lambda: DEFAULT_DATA_DIR)
    cache_dir: Path = field(default_factory=lambda: DEFAULT_CACHE_DIR)

    @property
    def jmdict_db_path(self) -> Path:
        return self.cache_dir / JMDICT_DB_NAME

    @property
    def vocab_db_path(self) -> Path:
        return self.cache_dir / VOCAB_DB_NAME

    @property
    def min_vocab_zipf(self) -> float | None:
        if self.min_zipf_override is not None:
            return self.min_zipf_override
        return vocab_level_min_zipf(self.vocab_level)

    def is_category_allowed(self, category: str) -> bool:
        mapping = {
            "general": True,
            "verb": self.allow_verb,
            "person": self.allow_person,
            "place": self.allow_place,
            "organization": self.allow_organization,
            "proper": self.allow_proper,
            "other": self.allow_other,
        }
        return mapping.get(category, self.allow_other)


def default_config() -> GameConfig:
    return GameConfig()
