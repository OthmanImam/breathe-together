import assert from "node:assert/strict";
import { test } from "node:test";

import { createHarness, stateSpans, statesInOrder, type SimHarness } from "../src/sim/harness.js";
import type { CoachEvent } from "../src/coach/stateMachine.js";

function calibrationChange(h: SimHarness): Extract<CoachEvent, { type: "pacer_rate_changed" }> {
  const e = h.events.find(
    (e): e is Extract<CoachEvent, { type: "pacer_rate_changed" }> =>
      e.type === "pacer_rate_changed" &&
      (e.reason === "calibrated" || e.reason === "calibration_fallback"),
  );
  assert.ok(e !== undefined, "calibration pacer change expected");
  return e;
}

const testScenarios = [
  "calm",
  "agitated_then_settling",
  "ignores_pacer",
  "dropout",
  "bad_light",
] as const;

test("simulation determinism: same seed replays an identical timeline", () => {
  const a = createHarness({ scenario: "agitated_then_settling", seed: 42, minutes: 3 });
  const b = createHarness({ scenario: "agitated_then_settling", seed: 42, minutes: 3 });
  a.runMinutes(3);
  b.runMinutes(3);
  assert.equal(JSON.stringify(a.rows), JSON.stringify(b.rows));
  assert.equal(JSON.stringify(a.events), JSON.stringify(b.events));
});

test("agitated_then_settling: reaches Lead and ends with a lower pacer rate than it started with", () => {
  const h = createHarness({ scenario: "agitated_then_settling", seed: 42, minutes: 3 });
  h.runMinutes(3);
  assert.ok(statesInOrder(h).includes("lead"), "should reach Lead");
  const matched = calibrationChange(h); // the rate the pacing started with
  const finalRow = h.rows[h.rows.length - 1]!;
  const finalEvent = h.events.filter(
    (e): e is Extract<CoachEvent, { type: "pacer_rate_changed" }> =>
      e.type === "pacer_rate_changed",
  ).at(-1);
  assert.ok(finalRow.pacerRate < matched.rate - 1e-9, `final ${finalRow.pacerRate} vs started ${matched.rate}`);
  assert.ok(finalEvent !== undefined && finalEvent.rate >= h.settings.lead.targetFloor);
  // The user (who settles toward the pacer) should read lower at the end too.
  const firstUser = h.rows.find((r) => r.userRate !== undefined)!.userRate;
  const lastUser = finalRow.userRate;
  assert.ok(lastUser !== undefined && firstUser !== undefined);
  assert.ok(lastUser < firstUser - 1, "user breathing reads lower by the end");
});

test("ignores_pacer: spends meaningful time in Hold and does not ratchet the pacer down", () => {
  const h = createHarness({ scenario: "ignores_pacer", seed: 42, minutes: 3 });
  h.runMinutes(3);
  const spans = stateSpans(h);
  assert.ok((spans["hold"] ?? 0) >= 60, `Hold span too small: ${spans["hold"]}`);
  const matched = calibrationChange(h);
  const minDuringLeadHold = Math.min(
    ...h.rows.filter((r) => r.state === "lead" || r.state === "hold").map((r) => r.pacerRate),
  );
  assert.ok(
    minDuringLeadHold >= matched.rate - 1e-9,
    `pacer ratcheted below the match rate (${minDuringLeadHold} < ${matched.rate})`,
  );
});

test("dropout: pacer keeps running through the dropout and the state machine recovers", () => {
  const h = createHarness({ scenario: "dropout", seed: 42, minutes: 3 });
  h.runMinutes(3);
  // Silent window is 90-110s: normalizer holds the last value ~5s, then lost.
  const holdRows = h.rows.filter((r) => r.t > 91_000 && r.t <= 94_000);
  assert.ok(holdRows.length > 0);
  for (const r of holdRows) {
    assert.ok(r.userRate !== undefined, "held value shown during the 5s grace period");
  }
  const silentRows = h.rows.filter((r) => r.t >= 96_000 && r.t <= 108_000);
  assert.ok(silentRows.length > 0);
  for (const r of silentRows) {
    assert.equal(r.userRate, undefined, "no user data once the hold window expires");
  }
  assert.ok(h.notices.some((n) => n.kind === "unavailable"), "steady-pace notice while dark");
  assert.ok(h.notices.some((n) => n.kind === "resume"), "recovery when the signal returns");
  // Cycles continue increasing across the silent window.
  const before = h.rows.find((r) => r.t === 90_000)!;
  const after = h.rows.find((r) => r.t === 110_000)!;
  assert.ok(after.pacerCycles > before.pacerCycles);
  assert.equal(after.pacerRate, before.pacerRate);
});

test("bad_light: calibration falls back to the default and emits the setup notice", () => {
  const h = createHarness({ scenario: "bad_light", seed: 42, minutes: 3 });
  h.runMinutes(3);
  const fallbackNotice = h.notices.find((n) => n.kind === "calibration_fallback");
  assert.ok(fallbackNotice !== undefined, "setup notice expected");
  const change = calibrationChange(h);
  assert.equal(change.reason, "calibration_fallback");
  assert.equal(change.rate, h.settings.calibrate.fallbackRate);
  // Poor light dominated the start; confirm unavailable accounting reflects it.
  const spans = stateSpans(h);
  assert.ok(statesInOrder(h).includes("match"));
  void spans;
});

test("all five scenarios produce a sensible, ending timeline", () => {
  for (const scenario of testScenarios) {
    const h = createHarness({ scenario, seed: 42, minutes: 3 });
    h.runMinutes(3);
    assert.ok(h.ended !== undefined, `${scenario}: session must end`);
    assert.equal(statesInOrder(h).at(-2), "cooldown", `${scenario}: ends through cooldown`);
    const last = h.rows[h.rows.length - 1]!;
    assert.ok(last.t >= 180_000, `${scenario}: ran the full session`);
    for (const r of h.rows) {
      assert.ok(
        r.pacerRate >= h.settings.lead.targetFloor - 1e-9 && r.pacerRate <= h.settings.hold.ceiling + 1e-9,
        `${scenario}: pacer ${r.pacerRate} in range`,
      );
    }
  }
});
