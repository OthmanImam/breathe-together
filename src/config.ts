/**
 * ALL tunables for the whole app live in this single documented place.
 * Components accept a slice of `Settings` (already sliced by callers) — they
 * must not hard-code timing or threshold values of their own.
 *
 * Note on units: all times are milliseconds unless a name ends in `Seconds`.
 * Breathing rates are breaths/minute (bpm). Confidence is 0..1.
 */

export type SessionMinutes = 3 | 5 | 10;

export interface SignalSettings {
  /** Smoothing strength for breathing rate EMA (0..1). Lower = smoother/slower. */
  breathingEmaAlpha: number;
  /** Smoothing strength for pulse EMA (0..1). */
  pulseEmaAlpha: number;
  /** Plausibility bounds for breathing rate (bpm). Outside = rejected sample. */
  breathingMin: number;
  breathingMax: number;
  /** Plausibility bounds for pulse (bpm). */
  pulseMin: number;
  pulseMax: number;
  /** Largest breathing-rate change per second (bpm/s) accepted without calling it a spike. */
  maxJumpPerSecondBreathing: number;
  /** Largest pulse change per second (bpm/s) accepted. */
  maxJumpPerSecondPulse: number;
  /** Samples below this confidence are not trusted to carry new values. */
  confidenceGate: number;
  /** When input degrades, keep repeating the last good value this long, then report `lost`. */
  holdSeconds: number;
  /** If this much time passes with no trusted sample, start smoothing over (no spike check on the next sample). */
  gapResetSeconds: number;
}

export interface PacerSettings {
  /** Inhale share of one cycle (default 4:6 inhale:exhale => 0.4). */
  inhaleShare: number;
  /** Rate the pacer shows before the coach has calibrated anything (bpm). */
  initialRate: number;
  /** Hard clamp for any rate the pacer will accept. */
  rateMin: number;
  rateMax: number;
}

export interface CalibrationSettings {
  /** How long the calibration phase runs (seconds). */
  seconds: number;
  /** Minimum number of confident samples needed for a calibration; fewer => fallback below. */
  minConfidentSamples: number;
  /** Gentle default rate (bpm) used when calibration doesn't get enough confident samples. */
  fallbackRate: number;
  /** Calibrated rates are clamped to this window before becoming the pacer rate (bpm). */
  clampMin: number;
  clampMax: number;
}

export interface MatchSettings {
  /** How long the pacer simply mirrors the calibrated rate (seconds). */
  seconds: number;
}

export interface LeadSettings {
  /** Evaluate "are they following?" every N seconds during Lead (seconds). */
  windowSeconds: number;
  /** How much to lower the pacer rate when the user follows well (bpm). */
  stepDown: number;
  /**
   * Pacer rate floor (bpm). NOTE (internal): ~6-8 breaths/min is the range most
   * commonly used in slow-breathing relaxation exercises; 7 sits mid-range. This
   * is a wellness-exercise convention, not a sourced constant — verify against
   * citable sources before quoting it publicly.
   */
  targetFloor: number;
  /** |userRate - pacerRate| within this (bpm) counts as "following". */
  followTolerance: number;
  /** Fraction of confident samples within tolerance, per window, that counts as following. */
  followFraction: number;
  /** Continuous divergence longer than this moves Lead -> Hold (seconds). */
  divergeSeconds: number;
  /**
   * Length of the SDK's breathing-rate averaging window (seconds). The
   * reported rate is a trailing 30 s mean, so the report can lag a step
   * change in the user's actual breathing by up to this long. Coach streak
   * thresholds must exceed it, or Hold fires on the lag alone.
   */
  averagingWindowSeconds: number;
}

export interface HoldSettings {
  /** Re-evaluate whether to resume Lead or ease back up, every N seconds (seconds). */
  easeWindowSeconds: number;
  /** How much to raise the pacer rate per unproductive Hold window (bpm). */
  easeUpStep: number;
  /** Hard ceiling for any pacer rate (bpm). Never above this. */
  ceiling: number;
}

export interface CooldownSettings {
  /** Wind-down duration before the session ends (seconds). */
  seconds: number;
  /** Rate the pacer settles to during wind-down (bpm, then clamped to the floor). */
  windDownRate: number;
}

export interface SessionSettings {
  /** Default session length. Options: 3 / 5 / 10 minutes. */
  defaultMinutes: SessionMinutes;
  /** Signal counted unavailable for at least this long before a steady-pace notice (seconds). */
  unavailableNoticeSeconds: number;
}

export interface MockSettings {
  /** Simulated seconds between mock samples (1 => ~1 Hz). */
  secondsPerSample: number;
  /** Standard deviation of multiplicative noise on the mock breathing rate (bpm). */
  breathingNoise: number;
  /** First-order lag strength toward the pacer target per sample, for follow-type scenarios (0..1). */
  followStrength: number;
  /** Dropout scenario: signal disappears after this many simulated seconds. */
  dropoutAfter: number;
  /** Dropout scenario: how long the signal stays gone (seconds). */
  dropoutFor: number;
  /** bad_light scenario: poor-light stretch duration (seconds). */
  badLightFor: number;
  /** bad_light scenario: confidence during the poor-light stretch. */
  badLightConfidence: number;
}

export interface SdkSettings {
  /** Capture frame width the browser sends (px). Must match the client's downscale. */
  frameWidth: number;
  /** Capture frame height the browser sends (px). */
  frameHeight: number;
  /**
   * Daily measurement budget (minutes) for the SDK source. When the counter
   * (usage file) reaches this, the SDK source refuses to start and the guide
   * runs on its own with a clear notice. Guards the free-trial credits.
   */
  dailyCapMinutes: number;
  /** Counter file for the daily cap (JSON {date, seconds}). Git-ignored. */
  usageFile: string;
}

export interface ServerSettings {
  /** HTTP/WS port for the local server. Production default; overridable by PORT env. */
  port: number;
  /** How often the pacer state is pushed to clients (Hz). ~10 Hz keeps the orb smooth with client-side rAF interpolation, without flooding localhost. */
  pacerUpdateHz: number;
  /** Hard cap for a single inbound message (JSON text or binary frame), bytes. Anything bigger is dropped before parsing. */
  maxMessageBytes: number;
  /** Sustained control-message rate per connection (msgs/s) and burst allowance. */
  controlRatePerSec: number;
  controlBurst: number;
  /** Sustained camera-frame rate per connection (frames/s) and burst allowance. Should exceed the browser's capture throttle (15 fps) with headroom. */
  frameRatePerSec: number;
  frameBurst: number;
  /** Participant ID prefix for solo rooms (pair mode will reuse rooms with more participants). */
  soloParticipantId: string;
  /** No sample for this long (ms) counts as a source failure and triggers a supervised restart. */
  supervisorSilenceMs: number;
  /** Maximum supervised restarts before degrading to guide-only. */
  supervisorMaxRestarts: number;
  /** Minimum gap between restart attempts (ms). */
  supervisorBackoffMs: number;
}

export interface Settings {
  signal: SignalSettings;
  pacer: PacerSettings;
  calibrate: CalibrationSettings;
  match: MatchSettings;
  lead: LeadSettings;
  hold: HoldSettings;
  cooldown: CooldownSettings;
  session: SessionSettings;
  mock: MockSettings;
  sdk: SdkSettings;
  server: ServerSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  signal: {
    breathingEmaAlpha: 0.25,
    pulseEmaAlpha: 0.2,
    breathingMin: 4,
    breathingMax: 40,
    pulseMin: 30,
    pulseMax: 200,
    maxJumpPerSecondBreathing: 6,
    maxJumpPerSecondPulse: 30,
    confidenceGate: 0.5,
    holdSeconds: 5,
    gapResetSeconds: 30,
  },
  pacer: {
    inhaleShare: 0.4,
    initialRate: 12,
    rateMin: 3,
    rateMax: 40,
  },
  calibrate: {
    // 45s keeps a 3-minute default session long enough to reach Lead once (45 + 60 + 45 = 150, then 30s cooldown).
    seconds: 45,
    // ~20 of ~45 samples at 1 Hz.
    minConfidentSamples: 20,
    fallbackRate: 12,
    clampMin: 8,
    clampMax: 20,
  },
  match: {
    seconds: 60,
  },
  lead: {
    // 45s ≈ "~60s" spec value, shortened so a 3-minute default session gets at least one Lead evaluation.
    windowSeconds: 45,
    stepDown: 0.5,
    targetFloor: 7,
    followTolerance: 1.0,
    followFraction: 0.7,
    // Must exceed the 30 s reporting window: with a trailing-mean rate, a
    // user who STARTS following still shows as diverged for up to 30 s. A
    // 10 s streak (the old value) entered Hold on the lag alone — the coach
    // would feel unresponsive right when the user began to follow.
    divergeSeconds: 35,
    averagingWindowSeconds: 30,
  },
  hold: {
    easeWindowSeconds: 45,
    easeUpStep: 0.5,
    ceiling: 24,
  },
  cooldown: {
    seconds: 30,
    windDownRate: 8,
  },
  session: {
    defaultMinutes: 3,
    unavailableNoticeSeconds: 3,
  },
  mock: {
    secondsPerSample: 1,
    breathingNoise: 0.3,
    followStrength: 0.08,
    dropoutAfter: 90,
    dropoutFor: 20,
    badLightFor: 90,
    badLightConfidence: 0.15,
  },
  sdk: {
    frameWidth: 320,
    frameHeight: 240,
    dailyCapMinutes: 60,
    usageFile: ".bt-usage.json",
  },
  server: {
    port: 3000,
    // 10 Hz pacer push: the client interpolates between updates with rAF, so
    // motion stays smooth while the wire carries trivially little. (Chosen
    // over event-only updates so reconnects resync deterministically.)
    pacerUpdateHz: 10,
    // 300 KB covers a full RGBA 320x240 frame (~256 KB) plus a short JSON
    // control message with room to spare; larger inputs are dropped unread.
    maxMessageBytes: 300_000,
    controlRatePerSec: 20,
    controlBurst: 40,
    // 20/s sustained tolerates the 15 fps capture cap plus bursts.
    frameRatePerSec: 20,
    frameBurst: 30,
    soloParticipantId: "p1",
    supervisorSilenceMs: 15_000,
    supervisorMaxRestarts: 3,
    supervisorBackoffMs: 2_000,
  },
};

/** Deep-freeze helper so the shared default object can't drift at runtime. */
function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === "object") {
    for (const v of Object.values(obj as Record<string, unknown>)) {
      deepFreeze(v);
    }
    Object.freeze(obj);
  }
  return obj;
}

export const FROZEN_DEFAULT_SETTINGS = deepFreeze(DEFAULT_SETTINGS);

/** Patch type for tests and the simulator CLI. */
export type PartialSettings = {
  [K in keyof Settings]?: Partial<Settings[K]>;
};

/** Shallow-merge a patch into a settings object, returning a new object. */
export function patchSettings(base: Settings, patch: PartialSettings): Settings {
  return {
    signal: { ...base.signal, ...patch.signal },
    pacer: { ...base.pacer, ...patch.pacer },
    calibrate: { ...base.calibrate, ...patch.calibrate },
    match: { ...base.match, ...patch.match },
    lead: { ...base.lead, ...patch.lead },
    hold: { ...base.hold, ...patch.hold },
    cooldown: { ...base.cooldown, ...patch.cooldown },
    session: { ...base.session, ...patch.session },
    mock: { ...base.mock, ...patch.mock },
    sdk: { ...base.sdk, ...patch.sdk },
    server: { ...base.server, ...patch.server },
  };
}
