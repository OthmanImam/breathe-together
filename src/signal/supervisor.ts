/**
 * Supervised signal source: wraps a source factory and keeps it alive.
 *
 * Failure model (per the robustness plan):
 * - If the inner source produces no sample for `silenceMs`, it is assumed to
 *   have crashed or stalled. It is stopped and recreated (which for the SDK
 *   source means respawning the child process) after a backoff gap.
 * - After `maxRestarts`, supervision gives up and the wrapper degrades to
 *   GUIDE-ONLY: it emits nothing further, so the coach holds its steady pace
 *   (the normalizer reports `lost`, the coach keeps the pacer running), and
 *   `onDegraded` fires once so the UI can say so plainly.
 *
 * The wrapper never freezes the pipeline: tick() always returns promptly and
 * forwards pacer-facing calls to whatever inner source currently exists.
 */

import type {
  Clock,
  NormalizedSample,
  SampleListener,
  SignalSource,
} from "./SignalSource.js";

export interface SupervisorConfig {
  /** No sample for this long (ms) counts as a source failure. */
  silenceMs: number;
  /** Maximum restarts before degrading. */
  maxRestarts: number;
  /** Minimum gap between restart attempts (ms). */
  backoffMs: number;
}

export type SourceCreateFn = () => SignalSource;

export class SupervisedSource implements SignalSource {
  /** Fired once when supervision degrades to guide-only. */
  onDegraded: (() => void) | undefined;

  private readonly create: SourceCreateFn;
  private readonly cfg: SupervisorConfig;
  private readonly clock: Clock;

  private inner: SignalSource | undefined;
  private readonly listeners: SampleListener[] = [];
  private running = false;
  private degraded = false;
  private restarts = 0;
  private lastSampleT = 0;
  private lastRestartT = Number.NEGATIVE_INFINITY;
  private startedT = 0;

  constructor(create: SourceCreateFn, cfg: SupervisorConfig, clock: Clock) {
    this.create = create;
    this.cfg = cfg;
    this.clock = clock;
  }

  get isDegraded(): boolean {
    return this.degraded;
  }
  get restartCount(): number {
    return this.restarts;
  }

  start(): void {
    this.running = true;
    this.startedT = this.clock.now();
    this.lastSampleT = this.startedT;
    this.spawn();
  }

  stop(): void {
    this.running = false;
    this.inner?.stop();
    this.inner = undefined;
  }

  onSample(cb: SampleListener): () => void {
    // Spawned inner sources fan out to `listeners` (see spawn()); late
    // subscribers automatically receive future samples.
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  setPacerRate(breathsPerMin: number): void {
    this.inner?.setPacerRate?.(breathsPerMin);
  }

  /** Forward a camera frame to the inner source when it consumes frames. */
  pushFrame(timestampUs: number, pixels: Uint8Array): void {
    const sink = this.inner as
      | { pushFrame?: (us: number, px: Uint8Array) => void }
      | undefined;
    sink?.pushFrame?.(timestampUs, pixels);
  }

  tick(tMs: number): void {
    if (!this.running || this.degraded) return;
    this.inner?.tick?.(tMs);
    const silentFor = tMs - Math.max(this.lastSampleT, this.startedT);
    const enoughTimeSinceStart = tMs - this.startedT > this.cfg.silenceMs;
    if (enoughTimeSinceStart && silentFor > this.cfg.silenceMs) {
      this.maybeRestart(tMs);
    }
  }

  // ---- internals ---------------------------------------------------------

  private spawn(): void {
    this.inner = this.create();
    this.inner.onSample((s) => this.fanout(s));
    this.inner.start();
    this.lastRestartT = this.clock.now();
  }

  private maybeRestart(nowMs: number): void {
    if (this.restarts >= this.cfg.maxRestarts) {
      this.degrade();
      return;
    }
    if (nowMs - this.lastRestartT < this.cfg.backoffMs) return; // backing off
    this.restarts += 1;
    this.inner?.stop();
    this.inner = undefined;
    this.spawn();
    this.lastSampleT = this.clock.now();
  }

  private degrade(): void {
    this.degraded = true;
    this.inner?.stop();
    this.inner = undefined;
    this.onDegraded?.();
  }

  private fanout(s: NormalizedSample): void {
    this.lastSampleT = this.clock.now();
    for (const cb of this.listeners) cb(s);
  }
}
