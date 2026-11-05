import type { SignalSettings } from "../config.js";
import type { NormalizedSample, RawSample, SignalStatus } from "./SignalSource.js";

/**
 * Pure, side-effect-free helpers (exported for tests and reuse).
 */

/** One EMA step. The first value seeds the average. */
export function nextEma(
  prev: number | undefined,
  value: number,
  alpha: number,
): number {
  return prev === undefined ? value : prev + alpha * (value - prev);
}

export function isPlausible(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

/** Largest per-step change tolerated for a gap of dtMs at a per-second cap. */
export function maxAllowedJump(dtMs: number, maxPerSecond: number): number {
  return maxPerSecond * (dtMs / 1000);
}

export function isStatusValid(status: SignalStatus): boolean {
  return status === "ok" || status === "starting";
}

interface ChannelState {
  algo: {
    min: number;
    max: number;
    maxJumpPerSecond: number;
    alpha: number;
  };
  ema: number | undefined;
  lastGoodT: number; // ms timestamp of the last trusted update
  sawData: boolean;
}

/**
 * Stateful normalizer: exponential smoothing, plausibility + spike rejection,
 * confidence gating with hold-then-lost behavior.
 *
 * Determinism: no wall clock is read anywhere — time comes only from sample
 * timestamps (`accept`) or explicit ticks (`tick`), so an external loop can
 * drive it at any speed. Phase 1 runs accelerated simulations this way; a
 * later real-time adapter simply stamps samples from a monotonic clock.
 *
 * Per-channel logic (breathing rate and pulse are independent):
 *  - trusted sample: status is `ok`/`starting` AND confidence >= gate AND the
 *    value is plausible AND the jump vs. the smoothed value is within the
 *    per-second cap for the elapsed gap. Only then does the EMA move.
 *  - otherwise the last good value is repeated ("held") for up to
 *    `holdSeconds`, after which the channel stops carrying a value and the
 *    sample is reported `lost` until fresh trusted data arrives.
 *  - a gap longer than `gapResetSeconds` starts smoothing over (fresh EMA).
 */
export class Normalizer {
  private readonly cfg: SignalSettings;
  private readonly rate: ChannelState;
  private readonly pulse: ChannelState;
  private lastT = Number.NEGATIVE_INFINITY;
  private lastOutput: NormalizedSample | undefined;

  constructor(cfg: SignalSettings) {
    this.cfg = cfg;
    this.rate = {
      algo: {
        min: cfg.breathingMin,
        max: cfg.breathingMax,
        maxJumpPerSecond: cfg.maxJumpPerSecondBreathing,
        alpha: cfg.breathingEmaAlpha,
      },
      ema: undefined,
      lastGoodT: Number.NEGATIVE_INFINITY,
      sawData: false,
    };
    this.pulse = {
      algo: {
        min: cfg.pulseMin,
        max: cfg.pulseMax,
        maxJumpPerSecond: cfg.maxJumpPerSecondPulse,
        alpha: cfg.pulseEmaAlpha,
      },
      ema: undefined,
      lastGoodT: Number.NEGATIVE_INFINITY,
      sawData: false,
    };
  }

  accept(raw: RawSample): NormalizedSample {
    const t = raw.t;
    if (t < this.lastT) {
      return this.lastOutput ?? { t, confidence: 0, status: "starting" };
    }
    this.lastT = t;
    const out = this.materialize(t, raw);
    this.lastOutput = out;
    return out;
  }

  /**
   * Time-only progress with no new raw data (e.g. a silent dropout):
   * advances the hold window and emits hold/lost transitions.
   * Returns null when nothing is due (same time, or no data ever seen).
   */
  tick(tMs: number): NormalizedSample | null {
    if (tMs <= this.lastT) return null;
    if (!this.rate.sawData && !this.pulse.sawData) return null;
    this.lastT = tMs;
    // Synthetic "ok-but-no-data" raw drives the generic hold/expire path.
    const out = this.materialize(tMs, { t: tMs, confidence: 0, status: "ok" });
    this.lastOutput = out;
    return out;
  }

  /** Smoothed value currently held, for summaries and previews. */
  peekRate(): number | undefined {
    return this.rate.ema;
  }

  // -- internals ------------------------------------------------------------

  private materialize(t: number, raw: RawSample): NormalizedSample {
    this.maybeChannelGapReset(this.rate, t);
    this.maybeChannelGapReset(this.pulse, t);

    const trusted =
      isStatusValid(raw.status) && raw.confidence >= this.cfg.confidenceGate;

    if (raw.breathingRate !== undefined) this.rate.sawData = true;
    if (raw.pulse !== undefined) this.pulse.sawData = true;

    const rateOut =
      raw.breathingRate !== undefined
        ? this.updateChannel(this.rate, t, raw.breathingRate, trusted)
        : this.heldValue(this.rate, t);
    const pulseOut =
      raw.pulse !== undefined
        ? this.updateChannel(this.pulse, t, raw.pulse, trusted)
        : this.heldValue(this.pulse, t);

    const anyData = this.rate.sawData || this.pulse.sawData;
    const rateLost = anyData && this.isChannelLost(this.rate, t);
    const pulseLost = anyData && this.isChannelLost(this.pulse, t);

    let status: SignalStatus;
    if (rateLost && pulseLost) {
      // Everything saw data at some point but nothing is currently presentable.
      status = "lost";
    } else if (!isStatusValid(raw.status) && rateOut === undefined && pulseOut === undefined) {
      status = raw.status;
    } else if (!trusted && rateOut === undefined && pulseOut === undefined) {
      status = raw.status;
    } else {
      status = raw.status;
    }

    const confidence =
      status === "lost" ? Math.min(raw.confidence, 0.1) : raw.confidence;

    return {
      t,
      ...(rateOut !== undefined ? { breathingRate: rateOut } : {}),
      ...(pulseOut !== undefined ? { pulse: pulseOut } : {}),
      confidence,
      status,
    };
  }

  private maybeChannelGapReset(ch: ChannelState, t: number): void {
    if (
      ch.ema !== undefined &&
      Number.isFinite(ch.lastGoodT) &&
      t - ch.lastGoodT > this.cfg.gapResetSeconds * 1000
    ) {
      // Start smoothing over after a long gap.
      ch.ema = undefined;
      ch.lastGoodT = Number.NEGATIVE_INFINITY;
    }
  }

  private updateChannel(
    ch: ChannelState,
    t: number,
    value: number,
    trusted: boolean,
  ): number | undefined {
    const withinHold = this.channelHolding(ch, t);
    if (!trusted || !isPlausible(value, ch.algo.min, ch.algo.max)) {
      return withinHold ? ch.ema : undefined;
    }
    if (ch.ema !== undefined && Number.isFinite(ch.lastGoodT)) {
      const dtMs = Math.max(1, t - ch.lastGoodT);
      const jump = Math.abs(value - ch.ema);
      if (jump > maxAllowedJump(dtMs, ch.algo.maxJumpPerSecond)) {
        return withinHold ? ch.ema : undefined; // spike rejected
      }
    }
    const next = nextEma(ch.ema, value, ch.algo.alpha);
    ch.ema = next;
    ch.lastGoodT = t;
    return next;
  }

  /** Outgoing value when this sample carried no candidate for the channel. */
  private heldValue(ch: ChannelState, t: number): number | undefined {
    return this.channelHolding(ch, t) ? ch.ema : undefined;
  }

  /** True when the channel has a smoothed value still within its hold window. */
  private channelHolding(ch: ChannelState, t: number): boolean {
    return (
      ch.ema !== undefined &&
      Number.isFinite(ch.lastGoodT) &&
      t - ch.lastGoodT <= this.cfg.holdSeconds * 1000
    );
  }

  private isChannelLost(ch: ChannelState, t: number): boolean {
    if (ch.ema === undefined || ch.lastGoodT === Number.NEGATIVE_INFINITY) {
      return true;
    }
    return t - ch.lastGoodT > this.cfg.holdSeconds * 1000;
  }
}
