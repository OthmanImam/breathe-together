/**
 * One participant's live session: a SignalSource -> normalizer -> coach ->
 * pacer chain on an injected clock, shaped exactly like the Phase 1
 * simulation harness but emitting protocol-domain events instead of
 * recording timeline rows.
 *
 * The clock is injected by the caller: real time in production (a periodic
 * driver calls `tick(now)` at ~10 Hz), virtual time in tests/simulations —
 * the same code paths run either way.
 *
 * Lifecycle:
 * - `startSession()` builds a FRESH chain (source, normalizer, coach, pacer).
 *   Nothing samples — and nothing opens hardware — until it is called, and
 *   repeated sessions ("do it again") start from clean internal state
 *   because nothing is carried over.
 * - `stopSession()` ends a session early (user stop / consent revoked). The
 *   coach does not summarize sessions it did not run through cooldown, so
 *   the emitted `session_ended` carries `natural: false` and no summary.
 * - a natural session end stops the source too (Step 6's SDK source treats
 *   stop as "release the camera").
 *
 * Sequence guarantees (tested):
 * - samples reach the coach only via the normalizer;
 * - when the source is silent (dropout / starved frames), the normalizer's
 *   hold/lost values still reach the coach once per tick;
 * - `pacer_update` is emitted on every tick while a session runs, so clients
 *   can safely interpolate between any two consecutive updates.
 */

import {
  patchSettings,
  type SessionMinutes,
  type Settings,
} from "../config.js";
import type { Clock, NormalizedSample, SignalSource } from "../signal/SignalSource.js";
import { Normalizer } from "../signal/normalizer.js";
import {
  CoachStateMachine,
  type CoachEvent,
  type CoachState,
  type NoticeKind,
} from "../coach/stateMachine.js";
import { type PacerSnapshot, Pacer } from "../coach/pacer.js";
import type { SummaryData } from "../coach/summary.js";
import type { SourceKind } from "./rooms.js";

/**
 * Silence tick cadence for the normalizer hold/lost path: matches the mock
 * sample interval (1 s). Real sources that emit faster simply reset this
 * timer with every sample.
 */
const SILENCE_TICK_MS = 1000;

export interface ParticipantSampleEvent {
  type: "sample";
  sample: NormalizedSample;
}

export interface ParticipantPacerEvent {
  type: "pacer_update";
  t: number;
  snap: PacerSnapshot;
}

export interface ParticipantStateEvent {
  type: "state_changed";
  t: number;
  from: CoachState | "start";
  to: CoachState;
}

export interface ParticipantNoticeEvent {
  type: "notice";
  t: number;
  kind: NoticeKind;
  text: string;
}

export interface ParticipantEndedEvent {
  type: "session_ended";
  t: number;
  /** True when the session ran to its natural end (summary available). */
  natural: boolean;
  /** Populated for natural ends only; the coach does not summarize early stops. */
  summary?: SummaryData;
  lines: string[];
}

export type ParticipantPipelineEvent =
  | ParticipantSampleEvent
  | ParticipantPacerEvent
  | ParticipantStateEvent
  | ParticipantNoticeEvent
  | ParticipantEndedEvent;

export interface StartedSource {
  kind: SourceKind;
  note?: string;
}

export interface ParticipantPipelineDeps {
  clock: Clock;
  /** Per-participant settings copy; pipeline never mutates the shared defaults. */
  settings: Settings;
  /**
   * Builds the signal source for a session. Takes a per-session settings
   * copy so scenario-driven mocks (and, later, the SDK child process) always
   * see coherent configuration.
   */
  createSource: (
    spec: { kind: SourceKind; scenario?: string },
    sessionSettings: Settings,
  ) => { source: SignalSource; kind: SourceKind; note?: string };
}

export class ParticipantPipeline {
  private readonly clock: Clock;
  private readonly baseSettings: Settings;
  private readonly createSource: ParticipantPipelineDeps["createSource"];

  private readonly listeners: ((e: ParticipantPipelineEvent) => void)[] = [];

  private source: SignalSource | undefined;
  private normalizer: Normalizer | undefined;
  private coach: CoachStateMachine | undefined;
  private pacer: Pacer | undefined;
  private sessionSettings: Settings | undefined;

  private active = false;

  constructor(deps: ParticipantPipelineDeps) {
    this.clock = deps.clock;
    this.baseSettings = deps.settings;
    this.createSource = deps.createSource;
  }

  /** Subscribe to domain events; returns an unsubscribe function. */
  onEvent(cb: (e: ParticipantPipelineEvent) => void): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  get isSessionActive(): boolean {
    return this.active;
  }

  /** True while the lightweight preview chain (source + normalizer) is running. */
  get isPreviewActive(): boolean {
    return this.previewActive;
  }

  /**
   * Preview: run only source -> normalizer and forward samples, with no
   * coach or pacer. The Setup screen uses this for framing guidance; nothing
   * here is recorded or summarized.
   */
  startPreview(spec: { kind: SourceKind; scenario?: string } = { kind: "mock" }): StartedSource {
    if (this.previewActive) return this.startedSource ?? { kind: "mock" };
    if (this.active) this.stopSession();
    this.previewSettings = patchSettings(this.baseSettings, {});
    const built = this.createSource(spec, this.previewSettings);
    this.previewSource = built.source;
    this.previewNormalizer = new Normalizer(this.previewSettings.signal);
    this.previewSource.onSample((raw) => {
      const norm = this.previewNormalizer!.accept(raw);
      this.emit({ type: "sample", sample: norm });
    });
    this.previewSource.start();
    this.previewActive = true;
    this.startedSource = { kind: built.kind, ...(built.note ? { note: built.note } : {}) };
    return this.startedSource;
  }

  stopPreview(): void {
    if (!this.previewActive) return;
    this.previewActive = false;
    this.previewSource?.stop();
    this.previewSource = undefined;
    this.previewNormalizer = undefined;
  }

  private previewActive = false;
  private previewSource: SignalSource | undefined;
  private previewNormalizer: Normalizer | undefined;
  private previewSettings: Settings | undefined;

  get state(): CoachState {
    return this.coach?.state ?? "calibrate";
  }

  get pacerRate(): number {
    return this.pacer?.currentRate() ?? this.baseSettings.pacer.initialRate;
  }

  /** Begin a session; returns which source actually started (with any fallback note). */
  startSession(
    durationMin: SessionMinutes,
    spec: { kind: SourceKind; scenario?: string } = { kind: "mock" },
  ): StartedSource {
    if (this.active) return this.startedSource ?? { kind: "mock" };
    if (this.previewActive) this.stopPreview();
    // Fresh settings per session; only the requested duration changes.
    this.sessionSettings = patchSettings(this.baseSettings, {
      session: { defaultMinutes: durationMin },
    });
    const built = this.createSource(spec, this.sessionSettings);
    this.source = built.source;
    this.normalizer = new Normalizer(this.sessionSettings.signal);
    this.coach = new CoachStateMachine({ clock: this.clock, settings: this.sessionSettings });
    this.pacer = new Pacer(
      this.sessionSettings.pacer,
      this.sessionSettings.pacer.initialRate,
    );

    this.coach.onEvent((e) => this.onCoachEvent(e));
    this.source.onSample((raw) => {
      this.sampleSeenThisTick = true;
      const norm = this.normalizer!.accept(raw);
      this.emit({ type: "sample", sample: norm });
      this.coach!.onSample(norm);
    });

    this.source.start();
    this.coach.start();
    this.active = true;
    this.lastSignalActivityT = this.clock.now();
    this.startedSource = { kind: built.kind, ...(built.note ? { note: built.note } : {}) };
    return this.startedSource;
  }

  private startedSource: StartedSource | undefined;
  /** Last time a source sample (or a silence tick) reached the normalizer. */
  private lastSignalActivityT = 0;

  /** End the session early (user stop or consent revoked). */
  stopSession(): void {
    if (!this.active) return;
    this.active = false;
    this.source?.stop();
    this.emit({ type: "session_ended", t: this.clock.now(), natural: false, lines: [] });
  }

  /** `nowMs` must be monotonic. Drives source tick, normalizer holds, pacer. */
  tick(nowMs: number): void {
    if (this.previewActive && !this.active) {
      this.previewSource?.tick?.(nowMs);
      return;
    }
    if (!this.active) return;
    this.sampleSeenThisTick = false;
    this.source?.tick?.(nowMs);
    if (this.sampleSeenThisTick) {
      this.lastSignalActivityT = nowMs;
    } else if (nowMs - this.lastSignalActivityT >= SILENCE_TICK_MS) {
      // Genuine silence (dropout / starved frames): advance the normalizer's
      // hold-then-lost logic at sample cadence. Ticking it at the pacer push
      // rate instead would emit confidence-0 held samples 10x/sec and make
      // the coach count almost everything as unavailable.
      const held = this.normalizer?.tick(nowMs);
      if (held) {
        this.emit({ type: "sample", sample: held });
        this.coach!.onSample(held);
      }
      this.lastSignalActivityT = nowMs;
    }
    const snap = this.pacer!.advance(nowMs);
    this.emit({ type: "pacer_update", t: nowMs, snap });
  }

  /** Final teardown: stops the source (releases camera-facing resources). */
  destroy(): void {
    if (this.previewActive) this.stopPreview();
    if (this.active) this.stopSession();
    this.source?.stop();
    this.active = false;
    this.listeners.length = 0;
  }

  // ---- internals ---------------------------------------------------------

  private sampleSeenThisTick = false;

  private onCoachEvent(e: CoachEvent): void {
    if (e.type === "pacer_rate_changed") {
      this.pacer?.setRate(e.rate, e.t);
      this.source?.setPacerRate?.(e.rate);
    }
    if (e.type === "state_changed") {
      this.emit({ type: "state_changed", t: e.t, from: e.from, to: e.to });
    } else if (e.type === "notice") {
      this.emit({ type: "notice", t: e.t, kind: e.kind, text: e.message });
    } else if (e.type === "session_ended") {
      this.active = false;
      this.source?.stop();
      this.emit({
        type: "session_ended",
        t: e.t,
        natural: true,
        summary: e.summary,
        lines: e.lines,
      });
    }
  }

  private emit(e: ParticipantPipelineEvent): void {
    for (const cb of this.listeners) cb(e);
  }
}
