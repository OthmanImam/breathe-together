/**
 * Signal-layer contract.
 *
 * In Phase 1 the only implementation is the mock source. In Phase 2 the real
 * SmartSpectra source implements the same interface (see docs/SDK_NOTES.md for
 * how SDK events map onto these types).
 */

/** Monotonic clock, ms. Injection point: all time-dependent code takes one of these. */
export interface Clock {
  now(): number;
}

/**
 * Observation statuses, aligned with SmartSpectra ValidationCode values
 * (see docs/SDK_NOTES.md §7 for the exact mapping table).
 */
export type SignalStatus =
  | "starting"
  | "ok"
  | "no_face"
  | "poor_light"
  | "off_center"
  | "lost";

export interface NormalizedSample {
  /** Sample timestamp, ms (monotonic within a session). */
  t: number;
  /** Smoothed breathing rate, breaths/minute. Optional: may be absent while degraded. */
  breathingRate?: number;
  /** Smoothed pulse, bpm (optional, not used by the coach in Phase 1). */
  pulse?: number;
  /** 0..1, data confidence. */
  confidence: number;
  status: SignalStatus;
}

/** What a source emits before normalization. */
export interface RawSample {
  t: number;
  breathingRate?: number;
  pulse?: number;
  confidence: number;
  status: SignalStatus;
}

export type SampleListener = (s: NormalizedSample) => void;

export interface SignalSource {
  start(): void;
  stop(): void;
  /** Subscribe to normalized samples; returns an unsubscribe function. */
  onSample(cb: SampleListener): () => void;
  /**
   * Optional: tell the source what pace the coach is showing, so follow-type
   * mocks (and, later, feedback-aware adapters) can react.
   */
  setPacerRate?(breathsPerMin: number): void;

  // Real-time drivers call tick(now) to pump time forward; the mock uses the
  // same entry point inside simulations where an external loop advances the
  // injected clock deterministically. Not part of the SignalSource contract
  // for the real SDK source.
  tick?(tMs: number): void;
}

export type { RawSample as RawSignalSample };
