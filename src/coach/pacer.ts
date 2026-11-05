import type { PacerSettings } from "../config.js";

export type PacePhase = "inhale" | "exhale";

export interface PacerSnapshot {
  /** Committed rate (breaths/min) currently shaping the cycle. */
  rate: number;
  /** Rate waiting to take effect at the next cycle boundary, if any. */
  pendingRate?: number;
  phase: PacePhase;
  /** 0..1 progress within the current phase. */
  phaseProgress: number;
  /** Completed cycles since the pacer started. */
  cyclesCompleted: number;
  /** Milliseconds elapsed inside the current cycle. */
  msIntoCycle: number;
  /** Full cycle length at the committed rate (ms). */
  cycleMs: number;
}

/**
 * Breathing pacer: given a rate (breaths/min) and an inhale:exhale split
 * (default 4:6), produces the current phase and progress as a pure function
 * of elapsed time.
 *
 * Rate changes are applied at the next cycle boundary so a change mid-cycle
 * never distorts an in-progress breath — the current breath finishes on the
 * old timing, the next one begins on the new timing.
 *
 * Pure with respect to time: no internal timers; `advance(tMs)` derives
 * everything from the current t. Time source is injected/stamped by callers,
 * which is what lets simulations run at any speed.
 */
export class Pacer {
  private readonly cfg: PacerSettings;
  private rate: number; // committed rate
  private cycleStart: number; // start of the current cycle (last crossed boundary)
  private cycles: number; // completed boundary crossings
  private nextRate: number | undefined; // pending until the next boundary

  constructor(cfg: PacerSettings, initialRate: number) {
    this.cfg = cfg;
    this.rate = clampRate(initialRate, cfg);
    this.cycleStart = 0;
    this.cycles = 0;
  }

  /** Request a rate change; it takes effect at the next cycle boundary. */
  setRate(breathsPerMin: number, _atMs = 0): this {
    void _atMs;
    const r = clampRate(breathsPerMin, this.cfg);
    if (r !== this.rate) this.nextRate = r;
    return this;
  }

  /** True while a requested change has not yet taken effect. */
  hasPending(): boolean {
    return this.nextRate !== undefined;
  }

  /** Derive the pacer state at time t (ms). Monotonic t expected. */
  advance(t: number): PacerSnapshot {
    let cycleMs = cycleLengthAt(this.rate);
    let elapsed = Math.max(0, t - this.cycleStart);

    while (elapsed >= cycleMs) {
      // Cross the boundary.
      this.cycleStart += cycleMs;
      this.cycles += 1;
      elapsed -= cycleMs;
      if (this.nextRate !== undefined) {
        // Commit exactly at the boundary; no mid-breath distortion.
        this.rate = this.nextRate;
        this.nextRate = undefined;
      }
      cycleMs = cycleLengthAt(this.rate);
    }

    const inhaleMs = cycleMs * this.cfg.inhaleShare;
    let phase: PacePhase;
    let msIntoPhase: number;
    if (elapsed < inhaleMs) {
      phase = "inhale";
      msIntoPhase = elapsed;
    } else {
      phase = "exhale";
      msIntoPhase = elapsed - inhaleMs;
    }
    const phaseLenMs = phase === "inhale" ? inhaleMs : cycleMs - inhaleMs;

    return {
      rate: this.rate,
      ...(this.nextRate !== undefined ? { pendingRate: this.nextRate } : {}),
      phase,
      phaseProgress: Math.min(1, Math.max(0, msIntoPhase / Math.max(1, phaseLenMs))),
      cyclesCompleted: this.cycles,
      msIntoCycle: Math.round(elapsed),
      cycleMs: Math.round(cycleMs),
    };
  }

  /** Committed rate without advancing time. */
  currentRate(): number {
    return this.rate;
  }
}

function clampRate(rate: number, cfg: PacerSettings): number {
  const clamped = Math.min(cfg.rateMax, Math.max(cfg.rateMin, rate));
  return Math.round(clamped * 100) / 100;
}

function cycleLengthAt(rateBpm: number): number {
  return (60 / rateBpm) * 1000;
}
