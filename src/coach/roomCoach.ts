/**
 * RoomCoach — pair coordinator (see docs/PAIR_DESIGN.md §3d).
 *
 * Owns ONE shared Pacer for the room. Each participant keeps their own full
 * solo `CoachStateMachine` (via ParticipantPipeline); their pacer proposal
 * is their coach's rate. The shared rate is the MAX of the counted
 * proposals — the gentler (slower-to-descend) proposal wins — subject to
 * the solo step size, floor and ceiling. A shared Lead step therefore
 * requires both coaches to propose it, with no solo logic forked.
 *
 * Calibration handling: a participant still calibrating is excluded from
 * the max until they finish, or until `maxCalibrateWaitSeconds` elapses
 * (then the fallback rate counts for them) — a late joiner can never speed
 * the shared pacer up to the fallback immediately.
 *
 * PeerLink seam: feeds are the small `RoomCoachFeed` interface (proposal,
 * state, latest sample, activity). A future relay topology can drive this
 * coordinator with identical inputs and no coach changes.
 */

import type { Clock, SignalStatus } from "../signal/SignalSource.js";
import type { Settings } from "../config.js";
import { Pacer, type PacerSnapshot } from "./pacer.js";
import { AlignmentTracker, type AlignmentState } from "./sync.js";
import type { CoachState } from "./stateMachine.js";
import type { ParticipantPipelineEvent } from "../server/sessionPipeline.js";

export type RoomPhase = CoachState;

export interface RoomCoachFeed {
  /** The participant coach's current pacer proposal (their solo pacer rate). */
  proposalRate(): number;
  /** The participant coach's state. */
  coachState(): CoachState;
  /** The participant coach's session ended naturally. */
  sessionEnded(): boolean;
  /** Subscribe to pipeline events to observe samples (alive feed). */
  onEvent(cb: (e: ParticipantPipelineEvent) => void): () => void;
}

export interface RoomCoachEvent {
  type: "alignment_update";
  t: number;
  state: AlignmentState;
}

export interface RoomSnapshot {
  t: number;
  sharedRate: number;
  snap: PacerSnapshot;
  phase: RoomPhase;
  alignment: AlignmentState;
}

/** Distance order for "least advanced" room phase derivation. */
const PHASE_ORDER: Record<RoomPhase, number> = {
  calibrate: 0,
  match: 1,
  lead: 2,
  hold: 3,
  cooldown: 4,
  ended: 5,
};

export class RoomCoach {
  private readonly settings: Settings;
  private readonly feeds: Array<RoomCoachFeed & { active: boolean }>;
  private readonly sharedPacer: Pacer;
  private readonly tracker: AlignmentTracker;
  private readonly listeners: ((e: RoomCoachEvent) => void)[] = [];
  private readonly latest: Array<
    | { breathingRate?: number; status: SignalStatus; confidence: number }
    | undefined
  > = [undefined, undefined];
  private readonly startT: number;
  private alignment: AlignmentState = { value: undefined, stale: true, waiting: true };

  constructor(deps: {
    clock: Clock;
    settings: Settings;
    feeds: [RoomCoachFeed, RoomCoachFeed];
  }) {
    this.settings = deps.settings;
    this.sharedPacer = new Pacer(deps.settings.pacer, deps.settings.pacer.initialRate);
    this.tracker = new AlignmentTracker(deps.settings.pair);
    this.startT = deps.clock.now();
    this.feeds = deps.feeds.map((f) => {
      const feed = f as RoomCoachFeed & { active: boolean };
      feed.active = true;
      f.onEvent((e) => {
        if (e.type !== "sample") return;
        const idx = this.feeds.indexOf(feed);
        if (idx >= 0) this.latest[idx] = e.sample;
      });
      return feed;
    });
  }

  onEvent(cb: (e: RoomCoachEvent) => void): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** The one shared pacer (pipelines render its snapshots). */
  get pacer(): Pacer {
    return this.sharedPacer;
  }

  /** A participant left or disconnected: drop their proposal from the max. */
  removeFeed(feed: RoomCoachFeed): void {
    const f = this.feeds.find((x) => x === feed);
    if (f) f.active = false;
  }

  /** Current room phase: least advanced of the active participants. */
  phase(): RoomPhase {
    const states = this.feeds
      .filter((f) => f.active)
      .map((f) => f.coachState());
    if (states.length === 0) return "ended";
    if (states.every((s) => s === "ended")) return "ended";
    if (states.every((s) => s === "cooldown" || s === "ended")) return "cooldown";
    let worst = states[0] as RoomPhase;
    for (const s of states) {
      if (PHASE_ORDER[s] < PHASE_ORDER[worst]) worst = s;
    }
    return worst;
  }

  /** Advance one tick: proposals -> shared pacer -> alignment. */
  tick(nowMs: number): RoomSnapshot {
    this.sharedRateAt(nowMs);
    const snap = this.sharedPacer.advance(nowMs);
    const sharedRate = this.sharedPacer.currentRate();
    const [a, b] = this.latest;
    const activeA = this.feeds[0]?.active ? a : undefined;
    const activeB = this.feeds[1]?.active ? b : undefined;
    this.alignment = this.tracker.update(
      toAlignmentInput(activeA),
      toAlignmentInput(activeB),
      sharedRate,
      nowMs,
    );
    if (!this.alignment.stale && this.alignment.value !== undefined) {
      this.freshHistory.push({ t: nowMs, value: this.alignment.value });
    }
    for (const cb of this.listeners) {
      cb({ type: "alignment_update", t: nowMs, state: this.alignment });
    }
    return {
      t: nowMs,
      sharedRate,
      snap,
      phase: this.phase(),
      alignment: this.alignment,
    };
  }

  private readonly freshHistory: Array<{ t: number; value: number }> = [];

  /** Mean alignment over fresh (non-stale) time — the summary input. */
  pairSummaryStats(): { meanAlignment: number | undefined; freshSeconds: number } {
    if (this.freshHistory.length === 0) {
      return { meanAlignment: undefined, freshSeconds: 0 };
    }
    const mean =
      this.freshHistory.reduce((sum, h) => sum + h.value, 0) /
      this.freshHistory.length;
    const spanMs =
      this.freshHistory[this.freshHistory.length - 1]!.t - this.freshHistory[0]!.t;
    return { meanAlignment: mean, freshSeconds: Math.round(spanMs / 1000) };
  }

  /** Latest alignment (for summaries / room state). */
  get currentAlignment(): AlignmentState {
    return this.alignment;
  }

  // ---- internals ---------------------------------------------------------

  private sharedRateAt(nowMs: number): void {
    const { pair, calibrate, hold, pacer } = this.settings;
    let shared = this.settings.pacer.initialRate;
    let counted = false;
    for (const feed of this.feeds) {
      if (!feed.active) continue;
      const state = feed.coachState();
      const calibrated = state !== "calibrate";
      const waitedLongEnough =
        nowMs - this.startT >= pair.maxCalibrateWaitSeconds * 1000;
      if (!calibrated && !waitedLongEnough) continue; // excluded entirely
      const proposal = calibrated
        ? feed.proposalRate()
        : calibrate.fallbackRate;
      if (!counted || proposal > shared) {
        shared = proposal;
        counted = true;
      }
    }
    // Ceiling from Hold rules; floor handled by coach proposals already,
    // pacer clamps to its own min/max as well. (Rate changes commit at the
    // next cycle boundary inside Pacer, as in solo mode.)
    shared = Math.min(shared, hold.ceiling);
    shared = Math.max(pacer.rateMin, shared);
    this.sharedPacer.setRate(shared);
  }
}

/** Wrap a ParticipantPipeline as a coordinator feed (PeerLink seam). */
export function pipelineFeed(pipeline: {
  coachProposal: number;
  state: import("./stateMachine.js").CoachState;
  isSessionActive: boolean;
  onEvent(cb: (e: ParticipantPipelineEvent) => void): () => void;
}): RoomCoachFeed {
  return {
    proposalRate: () => pipeline.coachProposal,
    coachState: () => pipeline.state,
    sessionEnded: () => !pipeline.isSessionActive,
    onEvent: (cb) => pipeline.onEvent(cb),
  };
}

function toAlignmentInput(
  sample: { breathingRate?: number; status: SignalStatus; confidence: number } | undefined,
): { rate?: number; status: SignalStatus; confidence: number } {
  if (!sample) return { status: "starting", confidence: 0 };
  return {
    ...(sample.breathingRate !== undefined ? { rate: sample.breathingRate } : {}),
    status: sample.status,
    confidence: sample.confidence,
  };
}
