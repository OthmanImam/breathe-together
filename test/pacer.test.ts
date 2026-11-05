import assert from "node:assert/strict";
import { test } from "node:test";

import { FROZEN_DEFAULT_SETTINGS, patchSettings } from "../src/config.js";
import { Pacer } from "../src/coach/pacer.js";

const basePacer = FROZEN_DEFAULT_SETTINGS.pacer;

const PACER_12 = patchSettings(FROZEN_DEFAULT_SETTINGS, {
  pacer: { ...basePacer },
}).pacer;

test("pacer timing at 12 bpm with 4:6 split (5s cycles)", () => {
  const p = new Pacer(PACER_12, 12);
  const s0 = p.advance(0);
  assert.equal(s0.rate, 12);
  assert.equal(s0.phase, "inhale");
  assert.equal(s0.phaseProgress, 0);
  assert.equal(s0.cyclesCompleted, 0);
  assert.equal(s0.cycleMs, 5000);

  const s1 = p.advance(1000);
  assert.equal(s1.phase, "inhale");
  assert.ok(Math.abs(s1.phaseProgress - 0.5) < 1e-9);

  const s2 = p.advance(2000);
  assert.equal(s2.phase, "exhale"); // exactly at the inhale boundary
  assert.equal(s2.phaseProgress, 0);

  const s3 = p.advance(2500);
  assert.equal(s3.phase, "exhale"); // 2.0s inhale boundary passed
  assert.ok(Math.abs(s3.phaseProgress - 500 / 3000) < 1e-9);
});

test("pacer cycle boundaries: 12 bpm ticks each 5 seconds", () => {
  const p = new Pacer(PACER_12, 12);
  const s = p.advance(5000);
  assert.equal(s.cyclesCompleted, 1);
  assert.equal(s.phase, "inhale");
  assert.equal(s.msIntoCycle, 0);
  assert.equal(p.advance(9999).cyclesCompleted, 1);
  assert.equal(p.advance(10000).cyclesCompleted, 2);
});

test("custom inhale share: 1:1 split", () => {
  const half = patchSettings(FROZEN_DEFAULT_SETTINGS, {
    pacer: { inhaleShare: 0.5 },
  }).pacer;
  const p = new Pacer(half, 12); // 5s cycle, 2.5s each
  assert.equal(p.advance(2499).phase, "inhale");
  assert.equal(p.advance(2501).phase, "exhale");
});

test("rate change requests take effect only at the next cycle boundary", () => {
  const p = new Pacer(PACER_12, 12);
  p.advance(3000); // mid-cycle (cycle 0 runs to 5000)
  p.setRate(10);
  assert.ok(p.hasPending(), "change should be pending before boundary");

  const before = p.advance(4000);
  assert.equal(before.rate, 12); // still old timing
  assert.equal(before.pendingRate, 10);
  assert.equal(before.phase, "exhale");

  const at = p.advance(5000);
  assert.equal(at.rate, 10); // committed exactly at the boundary
  assert.equal(at.pendingRate, undefined);
  assert.ok(!p.hasPending());
  assert.equal(at.cycleMs, 6000); // 10 bpm => 6s cycles
  assert.equal(at.phase, "inhale");
  assert.equal(at.msIntoCycle, 0);
});

test("mid-cycle rate change does not distort the breath in progress", () => {
  const p = new Pacer(PACER_12, 12);
  p.advance(1000); // cycle 0
  p.setRate(10);
  // Old cycle continues on old timing until 5000ms.
  const mid = p.advance(4000);
  assert.equal(mid.rate, 12);
  // After the boundary the new 6s cycle starts: inhale is 2.4s long.
  p.advance(5000);
  const s = p.advance(7000); // 2s into the new cycle, inhale 2.4s
  assert.equal(s.phase, "inhale");
  assert.ok(Math.abs(s.phaseProgress - 2000 / 2400) < 1e-9);
});

test("rate clamping to configured bounds", () => {
  const p = new Pacer(PACER_12, 12);
  p.setRate(1000);
  const s = p.advance(5000);
  assert.equal(s.rate, basePacer.rateMax); // clamped high

  const p2 = new Pacer(PACER_12, 12);
  p2.setRate(0.1);
  assert.equal(p2.advance(5000).rate, basePacer.rateMin); // clamped low
});

test("setting the same rate is a no-op (no pending change)", () => {
  const p = new Pacer(PACER_12, 12);
  p.setRate(12);
  assert.ok(!p.hasPending());
  assert.equal(p.currentRate(), 12);
});

test("successive rate changes: only the latest pending wins", () => {
  const p = new Pacer(PACER_12, 12);
  p.setRate(10);
  p.setRate(14);
  const s = p.advance(5000);
  assert.equal(s.rate, 14);
  assert.ok(!p.hasPending());
});

test("cycles continue counting across rate changes", () => {
  const p = new Pacer(PACER_12, 12); // 5s cycles
  p.advance(5000); // 1 cycle
  p.setRate(7.5); // 8s cycles (60/7.5)
  p.advance(15000); // cycle 1 completes at 10000, cycle 2 at 18000
  // At t=15000: one more boundary crossed (at 10s).
  const s = p.advance(15000);
  assert.equal(s.cyclesCompleted, 2);
  assert.equal(s.rate, 7.5);
});
