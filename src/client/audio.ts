/**
 * Synthesized breathing tones (WebAudio, no audio assets, nothing to license).
 *
 * Design constraints:
 * - No autoplay: the AudioContext is created/resumed only from a user
 *   gesture (the Begin button). `ensureStarted()` is the only entry point.
 * - Sessions usable with the screen off or eyes closed: tones keep their
 *   schedule from pacer updates and are never paused by visibility changes.
 * - Gentle by construction: sine oscillators with smooth gain envelopes and
 *   slow pitch sweeps (inhale rises, exhale falls), low peak gain.
 * - Pure helpers below are exported for node tests; the context/scheduling
 *   code is browser-only and guarded so importing this module in node is safe.
 */

export type TonePhase = "inhale" | "exhale";

/** Full cycle length in ms at a given rate (breaths per minute). */
export function cycleMsForRate(rateBpm: number): number {
  return (60 / Math.max(1, rateBpm)) * 1000;
}

/** Length of one phase (inhale or exhale) at a given rate. */
export function phaseDurationMs(
  rateBpm: number,
  phase: TonePhase,
  inhaleShare: number,
): number {
  const cycle = cycleMsForRate(rateBpm);
  return phase === "inhale" ? cycle * inhaleShare : cycle * (1 - inhaleShare);
}

/** Pitch endpoints (Hz) for a phase sweep: inhale rises, exhale falls. */
export function sweepForPhase(phase: TonePhase): { fromHz: number; toHz: number } {
  return phase === "inhale" ? { fromHz: 196, toHz: 294 } : { fromHz: 294, toHz: 196 };
}

/** Peak gain for a volume setting (0..1). Kept low: this sits under the orb. */
export function peakGainForVolume(volume: number): number {
  const v = Math.min(1, Math.max(0, volume));
  return 0.02 + 0.13 * v;
}

export class BreathingAudio {
  private ctx: AudioContext | undefined;
  private master: GainNode | undefined;
  private volume = 0.3;
  private lastPhase: TonePhase | undefined;
  private activeOsc: OscillatorNode | undefined;

  /** Create/resume the context. Call from a user gesture only. */
  ensureStarted(): void {
    if (typeof AudioContext === "undefined") return;
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 1;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
  }

  /** Context clock (seconds); 0 when not started. */
  currentTime(): number {
    return this.ctx?.currentTime ?? 0;
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
  }

  /**
   * Feed one pacer update; starts a tone at each phase change. `nowSec` is
   * the context clock's `currentTime` scale — pass `ctx.currentTime` at the
   * call site so tests can pass synthetic times.
   */
  onPacer(
    phase: TonePhase,
    rateBpm: number,
    inhaleShare: number,
    nowSec: number,
  ): void {
    if (!this.ctx || !this.master) return;
    if (phase === this.lastPhase) return;
    this.lastPhase = phase;
    this.startTone(phase, rateBpm, inhaleShare, nowSec);
  }

  /** Stop any sounding tone immediately (session end, stop, disconnect). */
  stop(): void {
    this.lastPhase = undefined;
    this.stopOsc();
  }

  private startTone(
    phase: TonePhase,
    rateBpm: number,
    inhaleShare: number,
    nowSec: number,
  ): void {
    if (!this.ctx || !this.master) return;
    this.stopOsc();
    const durSec = phaseDurationMs(rateBpm, phase, inhaleShare) / 1000;
    if (!(durSec > 0.2)) return; // degenerate rate; skip rather than buzz
    const { fromHz, toHz } = sweepForPhase(phase);
    const peak = peakGainForVolume(this.volume);

    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(fromHz, nowSec);
    osc.frequency.exponentialRampToValueAtTime(toHz, nowSec + durSec);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, nowSec);
    gain.gain.linearRampToValueAtTime(peak, nowSec + durSec * 0.25);
    gain.gain.setValueAtTime(peak, nowSec + durSec * 0.7);
    gain.gain.linearRampToValueAtTime(0, nowSec + durSec);

    osc.connect(gain);
    gain.connect(this.master);
    osc.start(nowSec);
    osc.stop(nowSec + durSec + 0.05);
    this.activeOsc = osc;
  }

  private stopOsc(): void {
    try {
      this.activeOsc?.stop();
    } catch {
      // Already stopped/finished — fine.
    }
    this.activeOsc = undefined;
  }
}
