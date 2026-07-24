import { effectiveLastMora } from "./rules.js";

export class GameState {
  constructor(config) {
    this.config = config;
    this.usedReadings = new Set();
    this.lastReading = null;
    this.lastSurface = null;
    this.lastPlayer = null;
    this.turnCount = 0;
  }

  get expectedFirstMora() {
    if (!this.lastReading) return null;
    return effectiveLastMora(this.lastReading);
  }

  markUsed(reading, surface, player) {
    this.usedReadings.add(reading);
    this.lastReading = reading;
    this.lastSurface = surface;
    this.lastPlayer = player;
    this.turnCount += 1;
  }

  reset() {
    this.usedReadings.clear();
    this.lastReading = null;
    this.lastSurface = null;
    this.lastPlayer = null;
    this.turnCount = 0;
  }

  status() {
    return {
      turnCount: this.turnCount,
      lastSurface: this.lastSurface || "",
      expectedFirstMora: this.expectedFirstMora || "",
      usedCount: this.usedReadings.size,
    };
  }
}
