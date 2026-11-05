import type { Settings } from "../config.js";
import { type SummaryData, buildSummaryLines } from "./summary.js";
import { isStatusValid } from "../signal/normalizer.js";
import type { Clock, NormalizedSample } from "../signal/SignalSource.js";

export type CoachState =
  | "calibrate"
  | "match"
  | "lead"
  | "hold"
  | "cooldown"
  | "ended";

export type PacerChangeReason =
  | "calibrated"
  | "calibration_fallback"
  | "lead_step_down"
  | "hold_ease_up";

export type NoticeKind =
  | "calibration_fallback"
  | "lead_step_down"
  | "hold"
  | "unavailable"
  | "resume"
  | "cooldown";

export type CoachEvent =
  | { type: "state_changed"; t: number; from: CoachState | "start"; to: CoachState }
  | {
      type: "pacer_rate_changed";
      t: number;
      rate: number;
      reason: PacerChangeReason;
    }
  | { type: "notice"; t: number; kind: NoticeKind; message: string }
  | { type: "session_ended"; t: number; summary: SummaryData; lines: string[] };

/**
 * Gentle, fixed copy for the human-facing notices. Wording lives here (not
 * scattered across logic) and stays observation-only by project rule.
 */
export const NOTICES = {
  calibration_fallback:
    "Starting at a gentle, steady pace. For a closer fit, set up in even light with your face centered in view.",
  lead_step_down: "Letting the pace ease a touch slower, with you.",
  hold: "Taking it slowly with you.",
  unavailable: "No clear view for the moment — keeping a steady pace while we wait.",
  resume: "Clear view again.",
  cooldown: "Easing toward a gentle close for the last stretch.",
} as const;

export class CoachStateMachine {
  private readonly clock: Clock;
  private readonly settings: Settings;

  private listeners: ((e: CoachEvent) => void)[] = [];

  // -- session bookkeeping ---------------------------------------------
  private t0 = Number.NEGATIVE_INFINITY;
  private sessionMs = 0;
  private cooldownStartT = Number.POSITIVE_INFINITY;
  private started = false;
  private ended = false;

  // -- phase state ------------------------------------------------------
  private _state: CoachState = "calibrate";
  private stateEntryT = Number.NEGATIVE_INFINITY;
  private _pacerRate: number;
  private matchRate: number | undefined;
  private finalPacerRate: number;

  // -- calibration ------------------------------------------------------
  private calibSamples: number[] = [];

  // -- rolling counters -------------------------------------------------
  private prevSampleT = Number.NEGATIVE_INFINITY;
  private leadWindowConf = 0;
  private leadWindowWithin = 0;
  private holdWindowConf = 0;
  private holdWindowWithin = 0;
  private holdUnproductiveWindows = 0;
  private divergeStreakMs = 0;

  // -- availability -----------------------------------------------------
  private sawAnySample = false;
  private lastConfidentT: number | undefined;
  private unavailableActive = false;
  private unavailableMs = 0;
  private followedMs = 0;
  private divergedMs = 0;
  private firstObservedRate: number | undefined;
  private lastObservedRate: number | undefined;

  constructor(deps: { clock: Clock; settings: Settings }) {
    this.clock = deps.clock;
    this.settings = deps.settings;
    this._pacerRate = deps.settings.calibrate.fallbackRate; // provisional until calibration
    this.finalPacerRate = this._pacerRate;
  }

  get state(): CoachState {
    return this._state;
  }
  get pacerRate(): number {
    return this._pacerRate;
  }

  onEvent(cb: (e: CoachEvent) => void): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Begin the session. `nowMs` defaults to the injected clock. */
  start(nowMs?: number): void {
    if (this.started) return;
    const now = nowMs ?? this.clock.now();
    this.started = true;
    this.t0 = now;
    this.prevSampleT = now;
    const { session } = this.settings;
    this.sessionMs = session.defaultMinutes * 60_000;
    this.cooldownStartT = now + this.sessionMs - this.settings.cooldown.seconds * 1000;
    this._state = "calibrate";
    this.stateEntryT = now;
    this.emit({ type: "state_changed", t: now, from: "start", to: "calibrate" });
  }

  /** Feed one normalized sample from the signal layer. */
  onSample(s: NormalizedSample): void {
    if (!this.started || this.ended) return;
    if (s.t < this.prevSampleT) return; // monotonic guard
    const now = s.t;
    const dt = Math.min(10_000, now - this.prevSampleT);
    this.prevSampleT = now;
    this.sawAnySample = true;

    const cfg = this.settings;
    const conf = isStatusValid(s.status) && s.confidence >= cfg.signal.confidenceGate;
    if (conf && typeof s.breathingRate === "number") {
      this.handleConfidentSample(now, dt, s.breathingRate);
    } else {
      this.handleUnconfidentSample(now, dt);
    }

    this.processPhaseLogic(now);
    if (this.ended) return;
    this.maybeEnterCooldown(now);
  }

  // ---- internals -------------------------------------------------------

  private handleConfidentSample(now: number, dt: number, rate: number): void {
    this.lastConfidentT = now;
    if (this.unavailableActive) {
      this.unavailableActive = false;
      this.notice("resume", now);
    }
    this.lastObservedRate = rate;
    if (this.firstObservedRate === undefined) this.firstObservedRate = rate;
    if (this._state === "calibrate") this.calibSamples.push(rate);

    if (this._state !== "calibrate") {
      if (Math.abs(rate - this._pacerRate) <= this.settings.lead.followTolerance) {
        this.followedMs += dt;
      } else {
        this.divergedMs += dt;
      }
    }

    // Divergence streak drives Lead/Match -> Hold ("they stopped following").
    if (this._state === "match" || this._state === "lead") {
      if (Math.abs(rate - this._pacerRate) > this.settings.lead.followTolerance) {
        this.divergeStreakMs += dt;
        if (this.divergeStreakMs >= this.settings.lead.divergeSeconds * 1000) {
          this.divergeStreakMs = 0;
          this.enterHold(now);
          return;
        }
      } else {
        this.divergeStreakMs = 0;
      }
    }

    // Rolling window counters for Lead/Hold evaluations.
    if (this._state === "lead") {
      this.leadWindowConf += 1;
      if (Math.abs(rate - this._pacerRate) <= this.settings.lead.followTolerance) {
        this.leadWindowWithin += 1;
      }
    } else if (this._state === "hold") {
      this.holdWindowConf += 1;
      if (Math.abs(rate - this._pacerRate) <= this.settings.lead.followTolerance) {
        this.holdWindowWithin += 1;
      }
    }
  }

  private handleUnconfidentSample(now: number, dt: number): void {
    this.unavailableMs += dt;
    this.divergeStreakMs = 0;
    if (!this.unavailableActive) {
      const sinceGood = now - (this.lastConfidentT ?? this.t0);
      if (this.sawAnySample && sinceGood >= this.settings.session.unavailableNoticeSeconds * 1000) {
        this.unavailableActive = true;
        this.notice("unavailable", now);
      }
    }
  }

  private processPhaseLogic(now: number): void {
    const cfg = this.settings;
    switch (this._state) {
      case "calibrate": {
        if (now - this.stateEntryT >= cfg.calibrate.seconds * 1000) {
          if (this.calibSamples.length >= cfg.calibrate.minConfidentSamples) {
            this.finishCalibration(median(this.calibSamples), "calibrated", now);
          } else {
            this.finishCalibration(
              cfg.calibrate.fallbackRate,
              "calibration_fallback",
              now,
            );
            this.notice("calibration_fallback", now);
          }
        }
        break;
      }
      case "match": {
        if (now - this.stateEntryT >= cfg.match.seconds * 1000) {
          this.enterState("lead", now);
        }
        break;
      }
      case "lead": {
        if (now - this.stateEntryT >= cfg.lead.windowSeconds * 1000) {
          const frac =
            this.leadWindowConf >= 5
              ? this.leadWindowWithin / this.leadWindowConf
              : -1;
          this.leadWindowConf = 0;
          this.leadWindowWithin = 0;
          this.stateEntryT = now; // window anchor for the next evaluation
          if (frac >= 0 && frac >= cfg.lead.followFraction) {
            // They are following: nudge the pace down, but never past the floor.
            const next = Math.max(
              cfg.lead.targetFloor,
              this._pacerRate - cfg.lead.stepDown,
            );
            if (next < this._pacerRate - 1e-9) {
              this.setPacerRate(next, "lead_step_down", now);
              this.notice("lead_step_down", now);
            }
          } else if (frac >= 0) {
            const tHold = now;
            this.enterHold(tHold);
          }
        }
        break;
      }
      case "hold": {
        if (now - this.stateEntryT >= cfg.hold.easeWindowSeconds * 1000) {
          const frac =
            this.holdWindowConf >= 5
              ? this.holdWindowWithin / this.holdWindowConf
              : -1;
          this.holdWindowConf = 0;
          this.holdWindowWithin = 0;
          this.stateEntryT = now;
          if (frac >= 0 && frac >= cfg.lead.followFraction) {
            // A full window of good following: return to Lead (hysteresis).
            this.enterState("lead", now);
          } else if (frac >= 0) {
            // Ease back up slightly after repeated unproductive windows, but
            // never past the ceiling, and only with enough confident data.
            this.holdUnproductiveWindows += 1;
            if (this.holdUnproductiveWindows >= 2) {
              this.holdUnproductiveWindows = 0;
              const next = Math.min(
                cfg.hold.ceiling,
                this._pacerRate + cfg.hold.easeUpStep,
              );
              if (next > this._pacerRate + 1e-9) {
                this.setPacerRate(next, "hold_ease_up", now);
              }
            }
          }
        }
        break;
      }
      case "cooldown": {
        if (now - this.stateEntryT >= cfg.cooldown.seconds * 1000) {
          this.endSession(now);
        }
        break;
      }
      default:
        break;
    }
  }

  private finishCalibration(
    rate: number,
    reason: "calibrated" | "calibration_fallback",
    now: number,
  ): void {
    const clamped = Math.min(
      this.settings.calibrate.clampMax,
      Math.max(this.settings.calibrate.clampMin, rate),
    );
    this.matchRate = clamped;
    this.setPacerRate(clamped, reason, now);
    this.enterState("match", now);
  }

  private enterHold(now: number): void {
    this.holdUnproductiveWindows = 0;
    this.holdWindowConf = 0;
    this.holdWindowWithin = 0;
    this.divergeStreakMs = 0;
    this.enterState("hold", now);
    this.notice("hold", now);
  }

  private maybeEnterCooldown(now: number): void {
    if (this._state === "cooldown" || this.ended) return;
    if (now >= this.cooldownStartT) {
      this.enterState("cooldown", now);
      this.notice("cooldown", now);
      // Design choice: the close keeps the current pace instead of forcing a
      // final rate jump — a wind-down that reshapes the pace for someone who
      // never followed it would feel scripted. Phase 2's UI tapering can use
      // cooldown.windDownRate if wanted.
      return;
    }
  }

  private enterState(to: CoachState, now: number): void {
    const from = this._state;
    this._state = to;
    this.stateEntryT = now;
    this.leadWindowConf = 0;
    this.leadWindowWithin = 0;
    this.emit({ type: "state_changed", t: now, from, to });
  }

  private setPacerRate(rate: number, reason: PacerChangeReason, now: number): void {
    this._pacerRate = rate;
    this.finalPacerRate = rate;
    this.emit({ type: "pacer_rate_changed", t: now, rate, reason });
  }

  private notice(kind: NoticeKind, now: number): void {
    const message = NOTICES[kind];
    this.emit({ type: "notice", t: now, kind, message });
  }

  private endSession(now: number): void {
    this.ended = true;
    this.enterState("ended", now);
    const summary: SummaryData = {
      ...(this.matchRate !== undefined ? { startRate: this.matchRate } : {}),
      ...(this.firstObservedRate !== undefined ? { firstRate: this.firstObservedRate } : {}),
      ...(this.lastObservedRate !== undefined ? { endRate: this.lastObservedRate } : {}),
      minutesFollowed: this.followedMs / 60_000,
      minutesDiverged: this.divergedMs / 60_000,
      minutesUnavailable: this.unavailableMs / 60_000,
      minutesTotal: Math.min(this.sessionMs, now - this.t0) / 60_000,
      finalPacerRate: this.finalPacerRate,
    };
    this.emit({ type: "session_ended", t: now, summary, lines: buildSummaryLines(summary) });
  }

  private emit(e: CoachEvent): void {
    for (const cb of this.listeners) cb(e);
  }
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}
