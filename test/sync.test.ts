import test from "node:test";
import assert from "node:assert/strict";
import { AlignmentTracker } from "../src/coach/sync.js";
import { FROZEN_DEFAULT_SETTINGS } from "../src/config.js";
import type { AlignmentInput, AlignmentState } from "../src/coach/sync.js";

const cfg = FROZEN_DEFAULT_SETTINGS.pair;

function input(rate: number, status: AlignmentInput["status"] = "ok", confidence = 1): AlignmentInput {
  return { rate, status, confidence };
}

test("identical rates at the pacer: alignment rises to the top", () => {
  const t = new AlignmentTracker(cfg);
  let state: AlignmentState = { value: undefined, stale: true, waiting: true };
  for (let ms = 0; ms <= 240_000; ms += 1000) {
    state = t.update(input(10), input(10), 10, ms);
  }
  assert.equal(state.waiting, false);
  assert.equal(state.stale, false);
  assert.ok(state.value !== undefined && state.value > 0.95, `value=${state.value}`);
});

test("a large rate gap scores near zero, and the min rule binds", () => {
  const t = new AlignmentTracker(cfg);
  let state: AlignmentState = { value: undefined, stale: true, waiting: true };
  for (let ms = 0; ms <= 240_000; ms += 1000) {
    // A follows the pacer (10); B sits 6 bpm away at 16.
    state = t.update(input(10), input(16), 10, ms);
  }
  assert.ok(state.value !== undefined && state.value < 0.35, `value=${state.value}`);
});

test("hysteresis suppresses flicker: small raw changes don't move the display", () => {
  const t = new AlignmentTracker(cfg);
  // Settle at a stable gap.
  let state: AlignmentState = { value: undefined, stale: true, waiting: true };
  for (let ms = 0; ms <= 120_000; ms += 1000) {
    state = t.update(input(10), input(12), 10, ms);
  }
  const settled = state.value!;
  // Tiny wobble around the same raw score: display must hold steady.
  for (let ms = 121_000; ms <= 180_000; ms += 1000) {
    state = t.update(input(10), input(12 + Math.sin(ms / 5000) * 0.2), 10, ms);
    assert.ok(
      Math.abs((state.value ?? 0) - settled) < cfg.hysteresisBand,
      "display within the band",
    );
  }
});

test("freeze: one participant lost holds the value, then waiting after the stale window", () => {
  const t = new AlignmentTracker(cfg);
  let state: AlignmentState = { value: undefined, stale: true, waiting: true };
  for (let ms = 0; ms <= 120_000; ms += 1000) {
    state = t.update(input(10), input(11), 10, ms);
  }
  const held = state.value!;
  assert.ok(held > 0.5);
  // B lost: value freezes (same number, stale flag).
  for (let ms = 121_000; ms <= 130_000; ms += 1000) {
    state = t.update(input(10), input(11, "lost", 0), 10, ms);
    assert.equal(state.stale, true);
    assert.equal(state.waiting, false);
    assert.equal(state.value, held, "frozen value, no decay");
  }
  // Past the stale window: neutral waiting, no number.
  state = t.update(input(10), input(11, "lost", 0), 10, 200_000);
  assert.equal(state.stale, true);
  assert.equal(state.waiting, true);
  assert.equal(state.value, undefined);
});

test("low confidence freezes without a status change", () => {
  const t = new AlignmentTracker({ ...cfg });
  let state: AlignmentState = { value: undefined, stale: true, waiting: true };
  for (let ms = 0; ms <= 120_000; ms += 1000) {
    state = t.update(input(10), input(11), 10, ms);
  }
  const held = state.value!;
  state = t.update(input(10), input(11, "poor_light", 0.15), 10, 121_000);
  assert.equal(state.stale, true);
  assert.equal(state.value, held);
});

test("recovery after a freeze resumes rising from the held value", () => {
  const t = new AlignmentTracker(cfg);
  let state: AlignmentState = { value: undefined, stale: true, waiting: true };
  for (let ms = 0; ms <= 120_000; ms += 1000) {
    state = t.update(input(10), input(14), 10, ms);
  }
  const before = state.value!;
  // B recovers and converges to A: alignment must be able to rise again.
  for (let ms = 121_000; ms <= 300_000; ms += 1000) {
    state = t.update(input(10), input(10), 10, ms);
  }
  assert.ok((state.value ?? 0) > before + 0.1, "rises after recovery");
  assert.equal(state.stale, false);
});

test("never fresh: waiting from the start, never a fabricated zero", () => {
  const t = new AlignmentTracker(cfg);
  const state = t.update(input(10, "starting", 0.2), input(11, "starting", 0.2), 12, 0);
  assert.equal(state.waiting, true);
  assert.equal(state.value, undefined);
});
