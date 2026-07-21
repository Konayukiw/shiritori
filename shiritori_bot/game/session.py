from __future__ import annotations

from dataclasses import dataclass, field

from shiritori_bot.config import GameConfig
from shiritori_bot.core.rules import effective_last_mora


@dataclass
class GameState:
    config: GameConfig
    used_readings: set[str] = field(default_factory=set)
    last_reading: str | None = None
    last_surface: str | None = None
    last_player: str | None = None
    turn_count: int = 0

    @property
    def expected_first_mora(self) -> str | None:
        if not self.last_reading:
            return None
        return effective_last_mora(self.last_reading)

    def mark_used(self, reading: str, surface: str, player: str) -> None:
        self.used_readings.add(reading)
        self.last_reading = reading
        self.last_surface = surface
        self.last_player = player
        self.turn_count += 1

    def reset(self) -> None:
        self.used_readings.clear()
        self.last_reading = None
        self.last_surface = None
        self.last_player = None
        self.turn_count = 0
