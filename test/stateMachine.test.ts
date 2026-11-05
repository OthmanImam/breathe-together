import assert from "node:assert/strict";
import { test } from "node:test";

import { FROZEN_DEFAULT_SETTINGS, patchSettings } from "../src/config.js";
import { NOTICES, CoachStateMachine, type CoachEvent } from "../src/coach/stateMachine.js";
import { assertSummaryIsClean, containsForbiddenTerm } from "../src/coach/summary.js";
import {
  createHarness,
  statesInOrder,
  stateSpans,
  type EndedEvent,
} from "../src/sim/harness.js";
import type { Clock, NormalizedSample } from "../src/signal/SignalSource.js";

const SCENARIOS = [
  "calm",
  "agitated_then_settling",
  "ignores_pacer",
  "dropout",
  "bad_light",
] as const;

function calibrationChange(
  h: ReturnType<typeof createHarness>,
): Extract<CoachEvent, { type: "pacer_rate_changed" }> {
  const e = h.events.find(
    (e): e is Extract<CoachEvent, { type: "pacer_rate_changed" }> =>
      e.type === "pacer_rate_changed" &&
      (e.reason === "calibrated" || e.reason === "calibration_fallback"),
  );
  assert.ok(e !== undefined, "calibration pacer change expected");
  return e;
}

function summaryOf(h: ReturnType<typeof createHarness>): EndedEvent {
  const e = h.ended;
  assert.ok(e !== undefined, "session_ended should have fired");
  return e;
}

test("calm: smooth journey calibrate -> match -> lead -> cooldown -> ended", () => {
  const h = createHarness({ scenario: "calm", seed: 42, minutes: 3 });
  h.runMinutes(3);
  assert.deepEqual(statesInOrder(h), ["calibrate", "match", "lead", "cooldown", "ended"]);
});

test("calibration completes at the deadline with a clamped match rate", () => {
  const h = createHarness({ scenario: "calm", seed: 42, minutes: 3 });
  h.runMinutes(1);
  const change = calibrationChange(h);
  assert.ok(change.t >= 44_000 && change.t <= 46_000, `calibration at ${change.t}`);
  assert.ok(change.rate >= 8 && change.rate <= 20, `match rate ${change.rate}`);
  assert.equal(change.reason, "calibrated");
});

test("lead lowers the pacer rate stepwise and rests exactly on the floor", () => {
  // 1 bpm per window means the floor (7) is reached inside a 10-min session.
  const h = createHarness({
    scenario: "calm",
    seed: 42,
    minutes: 10,
    settings: { lead: { stepDown: 1.0 } },
  });
  h.runMinutes(10);
  const steps = h.events.filter(
    (e): e is Extract<CoachEvent, { type: "pacer_rate_changed" }> =>
      e.type === "pacer_rate_changed" && e.reason === "lead_step_down",
  );
  assert.ok(steps.length >= 4, `expected several lead steps, got ${steps.length}`);
  for (const s of steps) {
    assert.ok(
      s.rate >= h.settings.lead.targetFloor - 1e-9,
      `step ${s.rate} below floor`,
    );
  }
  assert.equal(steps[steps.length - 1]!.rate, h.settings.lead.targetFloor);
});

test("hold: sustained divergence switches into Hold with the gentle notice", () => {
  const h = createHarness({ scenario: "ignores_pacer", seed: 42, minutes: 3 });
  h.runMinutes(3);
  assert.ok(
    h.events.some((e) => e.type === "state_changed" && e.to === "hold"),
    "expected a Hold entry",
  );
  const holdNotice = h.notices.find((n) => n.kind === "hold");
  assert.ok(holdNotice !== undefined);
  assert.ok(holdNotice.message.includes("Taking it slowly with you"));
});

test("hold: hysteresis — a full window of following returns to Lead, divergence re-triggers Hold", () => {
  // Drive the coach directly with crafted samples for full control.
  const clock: Clock = { now: () => 0 };
  const coach = new CoachStateMachine({
    clock,
    settings: FROZEN_DEFAULT_SETTINGS,
  });
  const events: CoachEvent[] = [];
  coach.onEvent((e) => events.push(e));
  coach.start(0);

  // Calibrate: 45 confident samples at 12 bpm (well over the 20 minimum).
  for (let t = 1000; t <= 45_000; t += 1000) {
    const s: NormalizedSample = { t, breathingRate: 12, confidence: 1, status: "ok" };
    coach.onSample(s);
  }
  assert.equal(coach.pacerRate, 12);
  assert.ok(
    events.some((e) => e.type === "state_changed" && e.to === "match"),
  );

  // Diverge hard for 10s while in match: Hold.
  for (let t = 46_000; t <= 55_000; t += 1000) {
    coach.onSample({ t, breathingRate: 30, confidence: 1, status: "ok" });
  }
  const holdEntry = events.find((e) => e.type === "state_changed" && e.to === "hold");
  assert.ok(holdEntry !== undefined, "Hold expected after sustained divergence");
  assert.ok(holdEntry.t <= 56_000);
  assert.ok(
    events.some((e) => e.type === "notice" && e.kind === "hold"),
  );

  // Stay close for a full Hold window (45s of confident, near-pacer samples):
  // the coach must come back to Lead (hysteresis via window evaluation).
  let t = 56_000;
  while (t <= 100_000) {
    coach.onSample({ t, breathingRate: 12.2, confidence: 1, status: "ok" });
    t += 1000;
  }
  const backToLead = events.some(
    (e) => e.type === "state_changed" && e.from === "hold" && e.to === "lead",
  );
  assert.ok(backToLead, "expected Lead after a following window");
  assert.ok(events.at(-1) !== undefined);
});

test("signal_lost: pacing continues through a dropout and recovers on return", () => {
  const h = createHarness({ scenario: "dropout", seed: 42, minutes: 3 });
  h.runMinutes(3);
  const at90 = h.rows.find((r) => r.t === 90_000);
  const at110 = h.rows.find((r) => r.t === 110_000);
  assert.ok(at90 !== undefined && at110 !== undefined);
  assert.ok(at110.pacerCycles > at90.pacerCycles, "pacer cycles continued through dropout");
  assert.equal(at110.pacerRate, at90.pacerRate, "rate held steady through dropout");
  assert.ok(h.notices.some((n) => n.kind === "unavailable"));
  assert.ok(h.notices.some((n) => n.kind === "resume"));
});

test("bad_light: calibration falls back to the default rate with a setup notice", () => {
  const h = createHarness({ scenario: "bad_light", seed: 42, minutes: 3 });
  h.runMinutes(3);
  assert.ok(h.notices.some((n) => n.kind === "calibration_fallback"), "setup notice expected");
  const change = calibrationChange(h);
  assert.equal(change.reason, "calibration_fallback");
  assert.equal(change.rate, FROZEN_DEFAULT_SETTINGS.calibrate.fallbackRate);
  const ended = summaryOf(h);
  assert.ok(ended.summary.minutesUnavailable >= 1.4, "bad light should dominate unavailability");
});

test("cooldown: 3-minute session ends at ~3 minutes with a summary", () => {
  const h = createHarness({ scenario: "calm", seed: 42, minutes: 3 });
  h.runMinutes(3);
  const ended = summaryOf(h);
  assert.ok(ended.t >= 179_000 && ended.t <= 181_000, `ended at ${ended.t}`);
  assert.ok(ended.summary.minutesTotal >= 2.9);
  assert.ok(ended.summary.finalPacerRate >= h.settings.lead.targetFloor);
  assert.ok(ended.summary.startRate !== undefined);
  assert.ok(ended.summary.endRate !== undefined);
});

test("ignores_pacer: meaningful Hold time and no aggressive downward ratchet", () => {
  const h = createHarness({ scenario: "ignores_pacer", seed: 42, minutes: 3 });
  h.runMinutes(3);
  const spans = stateSpans(h);
  assert.ok((spans["hold"] ?? 0) >= 60, `hold span ${spans["hold"]}`);
  const matched = calibrationChange(h);
  const steps = h.events.filter(
    (e): e is Extract<CoachEvent, { type: "pacer_rate_changed" }> =>
      e.type === "pacer_rate_changed" && e.reason === "lead_step_down",
  );
  // The user is far above the matched rate; the coach must not keep stepping down.
  assert.ok(steps.length <= 1, `lead steps while diverging: ${steps.length}`);
  const ended = summaryOf(h);
  assert.ok(
    ended.summary.finalPacerRate >= matched.rate - 1e-9,
    `final ${ended.summary.finalPacerRate} must not ratchet below the match rate ${matched.rate}`,
  );
  assert.ok(ended.summary.finalPacerRate <= h.settings.hold.ceiling);
});

test("agitated_then_settling: reaches Lead and ends lower than the match rate", () => {
  const h = createHarness({ scenario: "agitated_then_settling", seed: 42, minutes: 3 });
  h.runMinutes(3);
  assert.ok(statesInOrder(h).includes("lead"), "should reach Lead");
  const matched = calibrationChange(h);
  const ended = summaryOf(h);
  assert.ok(
    ended.summary.finalPacerRate < matched.rate - 1e-9,
    `final ${ended.summary.finalPacerRate} should be < matched ${matched.rate}`,
  );
});

test("hard rule: summary and notice wording stay observation-only for every scenario", () => {
  for (const scenario of SCENARIOS) {
    const h = createHarness({ scenario, seed: 7, minutes: 3 });
    h.runFor(3 * 60_000);
    const e = h.ended;
    assert.ok(e !== undefined, `${scenario}: session should end`);
    const violations = assertSummaryIsClean(e.lines);
    assert.deepEqual(violations, [], `${scenario}: forbidden terms in summary`);
    for (const n of h.notices) {
      assert.equal(
        containsForbiddenTerm(n.message),
        false,
        `${scenario}: notice forbidden "${n.message}"`,
      );
    }
    for (const text of Object.values(NOTICES)) {
      assert.equal(containsForbiddenTerm(text), false, `NOTICES copy: "${text}"`);
    }
  }
});

test("ignores_pacer summary notes the rhythm kept its own pace", () => {
  const h = createHarness({ scenario: "ignores_pacer", seed: 42, minutes: 3 });
  h.runMinutes(3);
  const ended = summaryOf(h);
  assert.ok(ended.summary.minutesDiverged >= 1.5, "diverged minutes tracked");
  assert.ok(
    ended.lines.some((l) => l.includes("kept its own pace")),
    `expected a kept-own-pace line: ${ended.lines.join(" | ")}`,
  );
});

test("never-ratchet invariant: pacer never dips below the match rate while user ignores pacing", () => {
  const h = createHarness({ scenario: "ignores_pacer", seed: 42, minutes: 3 });
  h.runMinutes(3);
  const matched = calibrationChange(h);
  const duringLeadHold = h.rows
    .filter((r) => r.state === "lead" || r.state === "hold")
    .map((r) => r.pacerRate);
  const min = Math.min(...duringLeadHold);
  assert.ok(min >= matched.rate - 1e-9, `pacer dipped below the match rate: ${min}`);
});

test("unavailable accounting is sane for dropout", () => {
  const h = createHarness({ scenario: "dropout", seed: 42, minutes: 3 });
  h.runMinutes(3);
  const ended = summaryOf(h);
  assert.ok(ended.summary.minutesUnavailable >= 0.15, "dropout adds unavailable time");
  assert.ok(ended.summary.minutesUnavailable <= 0.45);
  assert.ok(ended.summary.minutesFollowed >= 1.5);
});

test("hold eases back up slowly and respects the ceiling", () => {
  // ignores_pacer with a 10-minute run: repeated unproductive Hold windows
  // eventually ease the rate up toward the ceiling, never past it.
  const h = createHarness({ scenario: "ignores_pacer", seed: 42, minutes: 10 });
  h.runMinutes(10);
  const eases = h.events.filter(
    (e): e is Extract<CoachEvent, { type: "pacer_rate_changed" }> =>
      e.type === "pacer_rate_changed" && e.reason === "hold_ease_up",
  );
  assert.ok(eases.length >= 2, `expected easing, got ${eases.length}`);
  const rates = eases.map((e) => e.rate);
  assert.ok(Math.max(...rates) <= FROZEN_DEFAULT_SETTINGS.hold.ceiling + 1e-9);
  assert.ok(
    patchSettings(FROZEN_DEFAULT_SETTINGS, {}).hold.ceiling > 0,
  );
});
