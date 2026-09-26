from __future__ import annotations

import functools

import jaconv

try:
    from wordfreq import freq_to_zipf, get_frequency_dict
except ImportError as e:
    raise ImportError(
        "単語の頻度計算には wordfreq が必要です:\n  pip install -r requirements.txt"
    ) from e


@functools.lru_cache(maxsize=1)
def _ja_freq_dict() -> dict[str, float]:
    return get_frequency_dict("ja")


@functools.lru_cache(maxsize=262144)
def _best_form_zipf(word: str) -> float:
    freqs = _ja_freq_dict()
    z = 0.0
    for form in {word, jaconv.hira2kata(word), jaconv.kata2hira(word)}:
        f = freqs.get(form)
        if f:
            zz = freq_to_zipf(f)
            if zz > z:
                z = zz
    return round(z, 2)


def compute_zipf(surface: str, reading: str) -> float:
    z = _best_form_zipf(surface)
    if z > 0:
        return z
    return _best_form_zipf(reading)
