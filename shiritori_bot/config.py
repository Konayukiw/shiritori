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


@dataclass
class GameConfig:
    """対局オプション.

    Attributes:
        allow_person: 人名を許可するか
        allow_place: 地名を許可するか
        allow_organization: 組織名を許可するか
        allow_proper: 固有名詞・一般を許可するか
        allow_other: その他カテゴリを許可するか
        allow_verb: 動詞を許可するか
        require_dakuten_match: 濁点・半濁点の一致を要求するか
            False の場合、か/が や は/ぱ などを同一視する
        allow_alnum: アルファベット・数字を含む表記を許可するか
        ban_one_mora: 1モーラ語を禁止するか
        ban_obsolete_kana: ゑ/ゐ など現代50音にない文字を禁止するか
        ban_n_ending: 「ん」で終わる語を禁止するか
    """

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

    data_dir: Path = field(default_factory=lambda: DEFAULT_DATA_DIR)
    cache_dir: Path = field(default_factory=lambda: DEFAULT_CACHE_DIR)

    @property
    def jmdict_db_path(self) -> Path:
        return self.cache_dir / JMDICT_DB_NAME

    @property
    def vocab_db_path(self) -> Path:
        return self.cache_dir / VOCAB_DB_NAME

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
