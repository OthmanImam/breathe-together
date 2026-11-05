import type { MockSettings } from "../config.js";
import {
  type Clock,
  type RawSample,
  type SampleListener,
  type SignalSource,
} from "./SignalSource.js";

export type MockScenario =
  | "calm"
  | "agitated_then_settling"
  | "ignores_pacer"
  | "dropout"
  | "bad_light";

/** Seedable PRNG (mulberry32) — identical seeds give identical streams. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal deviate via Box-Muller, given a uniform generator. */
export function gaussian(uniform: () => number): number {
  let u1 = uniform();
  while (u1 <= 0) u1 = uniform();
  const u2 = uniform();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

const SCENARIO_BASE_RATE: Record<MockScenario, number> = {
  calm: 12,
  agitated_then_settling: 20,
  ignores_pacer: 23,
  dropout: 12,
  bad_light: 12,
};

/**
 * Deterministic mock source with an injected clock and a seeded RNG.
 * Emits ~1 Hz of simulated time (configurable) with realistic first-order
 * lag: the "true" rate drifts toward the pacer rate (where the scenario says
 * the person actually responds to pacing) by `followStrength` per sample.
 *
 * Scenarios:
 *  - calm: stable ~12 bpm with small noise.
 *  - agitated_then_settling: starts ~20 bpm and follows the pacer slowly
 *    (before any pacer rate exists it drifts toward the base 12 bpm default).
 *  - ignores_pacer: stays roughly constant regardless of the pacer.
 *  - dropout: normal, then signal lost for ~20 s (nothing emitted), then
 *    returns.
 *  - bad_light: status `poor_light` with low confidence for a stretch, then
 *    recovers.
 *
 * Realistic lag note: camera-derived breathing rate updates slowly with the
 * real SDK as well (docs/SDK_NOTES.md); the mock mimics that via the lag term
 * plus per-sample noise.
 */
export class MockSource implements SignalSource {
  private readonly scenario: MockScenario;
  private readonly clock: Clock;
  private readonly cfg: MockSettings;
  private readonly uniform: () => number;
  private readonly listeners: SampleListener[] = [];
  private readonly followsPacer: boolean;

  private t0 = 0;
  private started = false;
  private running = false;
  private nextIndex = 0;
  private trueRate: number;
  private pacerTarget: number | undefined;

  constructor(scenario: MockScenario, clock: Clock, cfg: MockSettings, seed: number) {
    this.scenario = scenario;
    this.clock = clock;
    this.cfg = cfg;
    this.uniform = mulberry32(seed);
    this.trueRate = SCENARIO_BASE_RATE[scenario];
    // ignores_pacer deliberately does not track setPacerRate.
    this.followsPacer = scenario !== "ignores_pacer";
  }

  start(): void {
    this.t0 = this.clock.now();
    this.trueRate = SCENARIO_BASE_RATE[this.scenario];
    this.pacerTarget = undefined;
    this.nextIndex = 0;
    this.started = true;
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  onSample(cb: SampleListener): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  setPacerRate(breathsPerMin: number): void {
    if (this.followsPacer) this.pacerTarget = breathsPerMin;
  }

  /**
   * Advance simulated time deterministically: emits (or skips, during a
   * dropout) every sample scheduled at or before tMs. Samples land on a grid
   * of t0 + n*stepMs with n >= 1 (no artificial sample at exactly t0). Safe
   * to call with arbitrary, increasing t values.
   */
  tick(tMs: number): void {
    if (!this.started || !this.running) return;
    const stepMs = this.cfg.secondsPerSample * 1000;
    while (this.t0 + (this.nextIndex + 1) * stepMs <= tMs) {
      this.nextIndex += 1;
      const sampleT = this.t0 + this.nextIndex * stepMs;
      const elapsedS = this.nextIndex * this.cfg.secondsPerSample;

      if (this.scenario === "dropout" && this.inDropoutSilence(elapsedS)) {
        continue; // signal lost: nothing emitted, rate frozen
      }

      this.updateTrueRate();
      this.emit(this.observeAt(elapsedS, sampleT));
    }
  }

  private updateTrueRate(): void {
    const calmBase = SCENARIO_BASE_RATE["calm"];
    const target =
      this.scenario === "ignores_pacer"
        ? SCENARIO_BASE_RATE[this.scenario]
        : (this.pacerTarget ?? calmBase); // pre-match: drift toward the gentle default
    this.trueRate += this.cfg.followStrength * (target - this.trueRate);
  }

  private inDropoutSilence(elapsedS: number): boolean {
    return (
      elapsedS >= this.cfg.dropoutAfter &&
      elapsedS < this.cfg.dropoutAfter + this.cfg.dropoutFor
    );
  }

  private observeAt(elapsedS: number, t: number): RawSample {
    const noisy = this.trueRate + gaussian(this.uniform) * this.cfg.breathingNoise;
    const rate = Math.round(noisy * 1000) / 1000;

    let confidence = 1;
    let status: RawSample["status"] = "ok";
    if (this.scenario === "bad_light" && elapsedS < this.cfg.badLightFor) {
      confidence = this.cfg.badLightConfidence;
      status = "poor_light";
    }

    return { t, breathingRate: rate, confidence, status };
  }

  private emit(sample: RawSample): void {
    for (const cb of this.listeners) cb(sample);
  }
}

export const MOCK_SCENARIOS: readonly MockScenario[] = [
  "calm",
  "agitated_then_settling",
  "ignores_pacer",
  "dropout",
  "bad_light",
];
