/**
 * Headless pair simulation CLI.
 *
 * Wires two mock signal sources through two solo coaches into one RoomCoach
 * (shared pacer + alignment) on a virtual clock, then prints a per-second
 * timeline plus a skew summary:
 *
 *   npm run simulate:pair -- --a agitated_then_settling --b calm --minutes 3 --seed 7
 *
 * The skew metric: two virtual clients interpolate the same shared pacer
 * snapshot stream with different arrival times; the maximum phase-time
 * disagreement between them is the measured phase-lock skew for the report.
 */

import {
  FROZEN_DEFAULT_SETTINGS,
  patchSettings,
  type Settings,
} from "../config.js";
import { MockSource, MOCK_SCENARIOS, type MockScenario } from "../signal/mockSource.js";
import { Normalizer } from "../signal/normalizer.js";
import { CoachStateMachine } from "../coach/stateMachine.js";
import { Pacer } from "../coach/pacer.js";
import { RoomCoach, type RoomPhase } from "../coach/roomCoach.js";
import type { NormalizedSample } from "../signal/SignalSource.js";
import { SimClock } from "./harness.js";

interface Args {
  a: MockScenario;
  b: MockScenario;
  minutes: number;
  seed: number;
}

function parseArgs(argv: string[]): Args | null {
  let a: MockScenario | undefined;
  let b: MockScenario | undefined;
  let minutes = 3;
  let seed = 42;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--a") a = argv[++i] as MockScenario;
    else if (arg === "--b") b = argv[++i] as MockScenario;
    else if (arg === "--minutes") minutes = Number(argv[++i]);
    else if (arg === "--seed") seed = Number(argv[++i]);
  }
  if (a === undefined || b === undefined) return null;
  if (!MOCK_SCENARIOS.includes(a) || !MOCK_SCENARIOS.includes(b)) return null;
  if (![3, 5, 10].includes(minutes)) return null;
  return { a, b, minutes, seed };
}

type SampleListener = (s: NormalizedSample) => void;

/**
 * One simulated participant: mock -> normalizer -> coach (solo logic).
 * The shared pacer (RoomCoach's) is what gets rendered; the participant's
 * own pacer only tracks proposals.
 */
class SimParticipant {
  readonly source: MockSource;
  readonly normalizer: Normalizer;
  readonly coach: CoachStateMachine;
  readonly pacer: Pacer;
  private readonly sampleListeners: SampleListener[] = [];
  lastRate: number | undefined;

  constructor(
    scenario: MockScenario,
    clock: SimClock,
    settings: Settings,
    seed: number,
  ) {
    this.source = new MockSource(scenario, clock, settings.mock, seed);
    this.normalizer = new Normalizer(settings.signal);
    this.coach = new CoachStateMachine({ clock, settings });
    this.pacer = new Pacer(settings.pacer, settings.pacer.initialRate);
    this.coach.onEvent((e) => {
      if (e.type === "pacer_rate_changed") {
        this.pacer.setRate(e.rate);
        this.source.setPacerRate(e.rate);
      }
    });
    this.source.onSample((raw) => {
      const norm = this.normalizer.accept(raw);
      this.coach.onSample(norm);
      this.forward(norm);
    });
  }

  onSample(cb: SampleListener): () => void {
    this.sampleListeners.push(cb);
    return () => {
      const i = this.sampleListeners.indexOf(cb);
      if (i >= 0) this.sampleListeners.splice(i, 1);
    };
  }

  private forward(s: NormalizedSample): void {
    this.lastRate = s.breathingRate;
    for (const cb of this.sampleListeners) cb(s);
  }

  start(): void {
    this.source.start();
    this.coach.start();
  }

  tick(t: number): void {
    this.source.tick(t);
    const held = this.normalizer.tick(t);
    if (held) {
      this.coach.onSample(held);
      this.forward(held);
    }
    this.coach.tick(t);
  }

  get proposal(): number {
    return this.coach.pacerRate;
  }
  get state(): RoomPhase {
    return this.coach.state;
  }
  get active(): boolean {
    return this.coach.state !== "ended";
  }
}

export interface PairSimResult {
  rows: Array<{
    t: number;
    stateA: string;
    stateB: string;
    rateA?: number;
    rateB?: number;
    sharedRate: number;
    alignment?: number;
    stale: boolean;
    waiting: boolean;
  }>;
  /** Max phase-time skew (ms) between two interpolating clients 100 ms apart. */
  maxSkewMs: number;
  alignmentStart?: number;
  alignmentEnd?: number;
  sharedStart: number;
  sharedEnd: number;
}

export function runPairSimulation(args: Args): PairSimResult {
  const settings = patchSettings(FROZEN_DEFAULT_SETTINGS, {
    session: { defaultMinutes: args.minutes as 3 | 5 | 10 },
  });
  const clock = new SimClock();
  const pa = new SimParticipant(args.a, clock, settings, args.seed);
  const pb = new SimParticipant(args.b, clock, settings, args.seed * 7 + 1);

  // Coordinator feeds (PeerLink seam: proposals, states, samples only).
  const toFeed = (p: SimParticipant) => ({
    proposalRate: () => p.proposal,
    coachState: () => p.state,
    sessionEnded: () => !p.active,
    onEvent: (cb: (e: { type: "sample"; sample: NormalizedSample }) => void) =>
      p.onSample((s) => cb({ type: "sample", sample: s })),
  });

  const coach = new RoomCoach({
    clock,
    settings,
    feeds: [toFeed(pa), toFeed(pb)],
  });

  pa.start();
  pb.start();

  const rows: PairSimResult["rows"] = [];
  let sharedStart = 0;
  let alignmentStart: number | undefined;
  let maxSkewMs = 0;
  let lastSnap: ReturnType<typeof snapshotAt> | undefined;

  const durationMs = args.minutes * 60_000;
  for (let t = 0; t <= durationMs; t += 100) {
    clock.advance(t - clock.time);
    pa.tick(t);
    pb.tick(t);
    const snapNow = coach.tick(t);
    if (sharedStart === 0 && snapNow.sharedRate > 0) sharedStart = snapNow.sharedRate;
    if (alignmentStart === undefined && snapNow.alignment.value !== undefined) {
      alignmentStart = snapNow.alignment.value;
    }
    // Phase-lock skew: two clients interpolate the same snapshot stream.
    const s = snapshotAt(t);
    if (lastSnap) {
      const skew = skewBetween(lastSnap, s, settings.pacer.inhaleShare);
      if (skew > maxSkewMs) maxSkewMs = skew;
    }
    lastSnap = s;
    if (t % 1000 === 0) {
      rows.push({
        t,
        stateA: pa.state,
        stateB: pb.state,
        ...(pa.lastRate !== undefined ? { rateA: Math.round(pa.lastRate * 10) / 10 } : {}),
        ...(pb.lastRate !== undefined ? { rateB: Math.round(pb.lastRate * 10) / 10 } : {}),
        sharedRate: Math.round(snapNow.sharedRate * 100) / 100,
        ...(snapNow.alignment.value !== undefined
          ? { alignment: Math.round(snapNow.alignment.value * 100) / 100 }
          : {}),
        stale: snapNow.alignment.stale,
        waiting: snapNow.alignment.waiting,
      });
    }
  }

  const sharedEnd = coach.pacer.currentRate();
  const alignmentEnd = coach.currentAlignment.value;
  return {
    rows,
    maxSkewMs: Math.round(maxSkewMs),
    ...(alignmentStart !== undefined ? { alignmentStart } : {}),
    ...(alignmentEnd !== undefined ? { alignmentEnd } : {}),
    sharedStart,
    sharedEnd,
  };

  function snapshotAt(t: number) {
    const snap = coach.pacer.advance(t);
    return { rate: snap.rate, phase: snap.phase, phaseProgress: snap.phaseProgress, t };
  }
}

/**
 * Phase-time disagreement (ms) between two clients rendering the same
 * snapshot stream 100 ms (one push interval) apart. Compared in absolute
 * cycle position (wrap-aware), so a phase flip isn't mistaken for skew.
 * Phase progress is linear in time within an interval, so the measured
 * value is the actual rendering offset, not an assumption.
 */
function skewBetween(
  a: { rate: number; phase: "inhale" | "exhale"; phaseProgress: number; t: number },
  b: { rate: number; phase: "inhale" | "exhale"; phaseProgress: number; t: number },
  inhaleShare: number,
): number {
  const cycleMs = (60 / a.rate) * 1000;
  const inhaleMs = cycleMs * inhaleShare;
  const pos = (s: typeof a): number =>
    s.phase === "inhale"
      ? s.phaseProgress * inhaleMs
      : inhaleMs + s.phaseProgress * (cycleMs - inhaleMs);
  const d = Math.abs(pos(a) - pos(b));
  return Math.min(d, cycleMs - d);
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  if (!args) {
    console.error(
      "usage: simulate:pair --a <scenario> --b <scenario> [--minutes 3|5|10] [--seed N]",
    );
    console.error(`scenarios: ${MOCK_SCENARIOS.join(", ")}`);
    process.exit(2);
  }
  const res = runPairSimulation(args);
  console.log(`# pair simulation a=${args.a} b=${args.b} minutes=${args.minutes} seed=${args.seed}`);
  for (const r of res.rows) {
    const mm = String(Math.floor(r.t / 60000)).padStart(2, "0");
    const ss = String(Math.floor((r.t % 60000) / 1000)).padStart(2, "0");
    console.log(
      `${mm}:${ss}  A:${r.stateA}(${r.rateA ?? "--"}) B:${r.stateB}(${r.rateB ?? "--"}) shared=${r.sharedRate} ` +
        `align=${r.alignment !== undefined ? r.alignment : "—"}${r.stale ? " (stale)" : ""}${r.waiting ? " (waiting)" : ""}`,
    );
  }
  console.log(`# max phase-lock skew (clients 100 ms apart): ${res.maxSkewMs} ms`);
  console.log(
    `# shared pacer ${res.sharedStart} -> ${res.sharedEnd} bpm; alignment ` +
      `${res.alignmentStart ?? "—"} -> ${res.alignmentEnd ?? "—"}`,
  );
}

const invokedAsMain =
  typeof process !== "undefined" &&
  typeof process.argv?.[1] === "string" &&
  process.argv[1].replaceAll("\\", "/").endsWith("src/sim/runPair.ts");
if (invokedAsMain) {
  main();
}
