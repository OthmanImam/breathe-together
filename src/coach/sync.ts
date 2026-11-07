/**
 * Pair alignment metric (see docs/PAIR_DESIGN.md §3c).
 *
 * Alignment describes ONLY rate similarity + guide-following — never
 * relationships, feelings, or anything about the pair but their numbers.
 *
 * Data reality check: the reported breathing rate is a 30 s trailing
 * average (docs/SDK_NOTES.md), so alignment is a slow metric by
 * construction: an EMA with a time constant at least as long as the
 * reporting window, plus a hysteresis band so the display never flickers.
 *
 * PeerLink seam: this module consumes abstract per-participant inputs only
 * (rate/status/confidence + shared pacer rate). No sockets, no rooms — a
 * future relay topology can feed it identical data.
 */

import type { PairSettings } from "../config.js";
import type { SignalStatus } from "../signal/SignalSource.js";

export interface AlignmentInput {
  /** Latest reported breathing rate (bpm), if the source produced one. */
  rate?: number;
  status: SignalStatus;
  confidence: number;
}

export interface AlignmentState {
  /**
   * Smoothed alignment 0..1, or undefined when no trustworthy value exists
   * (before the first fresh update, or after the stale window).
   */
  value: number | undefined;
  /** True while either participant is unobservable (value is held, not decaying). */
  stale: boolean;
  /** True when no value is shown at all (waiting for signal). */
  waiting: boolean;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

export class AlignmentTracker {
  private readonly cfg: PairSettings;
  private ema = 0;
  private displayed = 0;
  private lastSampleT: number | undefined;
  private frozenSince: number | undefined;
  private everFresh = false;

  constructor(cfg: PairSettings) {
    this.cfg = cfg;
  }

  /**
   * Advance by one tick. `a`/`b` are each participant's latest sample,
   * `sharedPacerRate` the coordinated pacer rate (bpm).
   */
  update(a: AlignmentInput, b: AlignmentInput, sharedPacerRate: number, nowMs: number): AlignmentState {
    const fresh =
      a.status === "ok" &&
      b.status === "ok" &&
      a.confidence >= this.cfg.freezeConfidence &&
      b.confidence >= this.cfg.freezeConfidence &&
      a.rate !== undefined &&
      b.rate !== undefined;

    if (fresh) {
      const rateAgreement = clamp01(
        1 - Math.abs((a.rate as number) - (b.rate as number)) / this.cfg.maxRateGapBpm,
      );
      const guideA = clamp01(1 - Math.abs((a.rate as number) - sharedPacerRate) / this.cfg.maxGuideGapBpm);
      const guideB = clamp01(1 - Math.abs((b.rate as number) - sharedPacerRate) / this.cfg.maxGuideGapBpm);
      const raw =
        this.cfg.wRateAgreement * rateAgreement +
        this.cfg.wGuideFollowing * Math.min(guideA, guideB);

      if (!this.everFresh) {
        this.ema = raw;
        this.displayed = raw;
        this.everFresh = true;
      } else {
        const dt = this.lastSampleT !== undefined ? Math.max(0, nowMs - this.lastSampleT) : 0;
        const tauMs = Math.max(this.cfg.emaTauSeconds, 1) * 1000;
        const alpha = 1 - Math.exp(-dt / tauMs);
        this.ema += alpha * (raw - this.ema);
        if (Math.abs(this.ema - this.displayed) >= this.cfg.hysteresisBand) {
          this.displayed = this.ema;
        }
      }
      this.frozenSince = undefined;
      this.lastSampleT = nowMs;
      return { value: this.displayed, stale: false, waiting: false };
    }

    // FREEZE: hold the last value while either side is unobservable.
    if (this.frozenSince === undefined) this.frozenSince = nowMs;
    this.lastSampleT = nowMs;
    if (!this.everFresh || nowMs - this.frozenSince > this.cfg.staleResetSeconds * 1000) {
      return { value: undefined, stale: true, waiting: true };
    }
    return { value: this.displayed, stale: true, waiting: false };
  }

  /** Reset all state (new session / peer change). */
  reset(): void {
    this.ema = 0;
    this.displayed = 0;
    this.lastSampleT = undefined;
    this.frozenSince = undefined;
    this.everFresh = false;
  }
}
