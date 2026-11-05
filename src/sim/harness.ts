/**
 * Shared wiring harness: connects a mock signal source through the
 * normalizer into the coach state machine, drives the pacer, and records a
 * deterministic timeline. Used by the headless simulation CLI (src/sim/run.ts),
 * the `dev` script, and the simulation tests.
 *
 * Everything runs on a virtual clock advanced in fixed steps — no real
 * waiting — so a full session finishes instantly.
 */

import { FROZEN_DEFAULT_SETTINGS, type PartialSettings, type Settings, patchSettings } from "../config.js";
import { MockSource, type MockScenario } from "../signal/mockSource.js";
import { Normalizer } from "../signal/normalizer.js";
import type { Clock } from "../signal/SignalSource.js";
import { type CoachEvent, CoachStateMachine } from "../coach/stateMachine.js";
import { type PacePhase, Pacer } from "../coach/pacer.js";

export class SimClock implements Clock {
  time = 0;
  now(): number {
    return this.time;
  }
  advance(ms: number): void {
    this.time += ms;
  }
}

export interface TimelineRow {
  t: number;
  state: string;
  userRate?: number;
  pacerRate: number;
  phase: PacePhase;
  pacerCycles: number;
}

export type NoticeEvent = Extract<CoachEvent, { type: "notice" }>;
export type EndedEvent = Extract<CoachEvent, { type: "session_ended" }>;

export interface SimHarness {
  readonly clock: SimClock;
  readonly settings: Settings;
  readonly rows: TimelineRow[];
  readonly events: CoachEvent[];
  readonly notices: NoticeEvent[];
  /** First `session_ended` event, once it has fired. */
  ended: EndedEvent | undefined;
  /** Process simulated time in fixed 1-second steps. */
  runFor(ms: number): void;
  runMinutes(n: number): void;
}

export interface HarnessOptions {
  scenario: MockScenario;
  seed?: number;
  settings?: PartialSettings;
  minutes?: 3 | 5 | 10;
}

/** Build a fully wired coach pipeline over simulated time. */
export function createHarness(opts: HarnessOptions): SimHarness {
  let settings: Settings = { ...FROZEN_DEFAULT_SETTINGS };
  if (opts.settings) settings = patchSettings(FROZEN_DEFAULT_SETTINGS, opts.settings);
  if (opts.minutes !== undefined) {
    settings = patchSettings(settings, { session: { defaultMinutes: opts.minutes } });
  }

  const clock = new SimClock();
  const source = new MockSource(opts.scenario, clock, settings.mock, opts.seed ?? 42);
  const normalizer = new Normalizer(settings.signal);
  const coach = new CoachStateMachine({ clock, settings });
  const pacer = new Pacer(settings.pacer, settings.pacer.initialRate);

  const rows: TimelineRow[] = [];
  const events: CoachEvent[] = [];
  const notices: NoticeEvent[] = [];
  let lastEndedEvent: EndedEvent | undefined;

  coach.onEvent((e) => {
    events.push(e);
    if (e.type === "notice") notices.push(e);
    if (e.type === "session_ended") lastEndedEvent = e;
    if (e.type === "pacer_rate_changed") {
      pacer.setRate(e.rate);
      source.setPacerRate(e.rate);
    }
  });

  // Real wiring: mock -> normalizer -> coach. Also captures the rate the
  // coach actually received this step (held values included, expired none).
  let gotSampleThisStep = false;
  let presentedRate: number | undefined;
  source.onSample((rawSample) => {
    gotSampleThisStep = true;
    const norm = normalizer.accept(rawSample);
    coach.onSample(norm);
    presentedRate = norm.breathingRate;
  });

  source.start();
  coach.start();

  const stepMs = settings.mock.secondsPerSample * 1000;

  const runFor = (ms: number): void => {
    const end = clock.now() + ms;
    while (clock.now() < end) {
      clock.advance(stepMs);
      const t = clock.now();
      gotSampleThisStep = false;
      presentedRate = undefined;
      source.tick(t);
      if (!gotSampleThisStep) {
        // Silent period (e.g. dropout): let the normalizer emit hold/lost.
        const fromTick = normalizer.tick(t);
        if (fromTick) {
          coach.onSample(fromTick);
          presentedRate = fromTick.breathingRate;
        }
      }
      const snap = pacer.advance(t);
      rows.push({
        t,
        state: coach.state,
        ...(presentedRate !== undefined
          ? { userRate: round2(presentedRate) }
          : {}),
        pacerRate: snap.rate,
        phase: snap.phase,
        pacerCycles: snap.cyclesCompleted,
      });
    }
  };

  return {
    clock,
    settings,
    rows,
    events,
    notices,
    get ended() {
      return lastEndedEvent;
    },
    runFor,
    runMinutes(minutes) {
      runFor(minutes * 60_000);
    },
  };
}

/** Approximate seconds spent in each state, from the 1 Hz rows. */
export function stateSpans(harness: SimHarness): Record<string, number> {
  const spans: Record<string, number> = {};
  for (const row of harness.rows) {
    spans[row.state] = (spans[row.state] ?? 0) + harness.settings.mock.secondsPerSample;
  }
  return spans;
}

export function statesInOrder(harness: SimHarness): string[] {
  const out: string[] = [];
  for (const row of harness.rows) {
    if (out[out.length - 1] !== row.state) out.push(row.state);
  }
  return out;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
