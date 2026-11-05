import assert from "node:assert/strict";
import { test } from "node:test";

import { FROZEN_DEFAULT_SETTINGS, patchSettings } from "../src/config.js";
import {
  Normalizer,
  isPlausible,
  maxAllowedJump,
  nextEma,
} from "../src/signal/normalizer.js";
import type { RawSample } from "../src/signal/SignalSource.js";

function makeNormalizer(overrides?: Partial<typeof FROZEN_DEFAULT_SETTINGS.signal>) {
  return new Normalizer(
    patchSettings(FROZEN_DEFAULT_SETTINGS, {
      signal: { ...overrides },
    }).signal,
  );
}

function raw(t: number, rate: number, confidence = 1, status: RawSample["status"] = "ok"): RawSample {
  return { t, breathingRate: rate, confidence, status };
}

test("nextEma: first value seeds, then smooths", () => {
  assert.equal(nextEma(undefined, 10, 0.5), 10);
  assert.equal(nextEma(10, 20, 0.5), 15);
  assert.equal(nextEma(15, 20, 0.25), 16.25);
});

test("isPlausible and maxAllowedJump helpers", () => {
  assert.equal(isPlausible(12, 4, 40), true);
  assert.equal(isPlausible(55, 4, 40), false);
  assert.equal(maxAllowedJump(1000, 6), 6);
  assert.equal(maxAllowedJump(5000, 6), 30);
});

test("normalizer: EMA smoothing of breathing rate", () => {
  const n = makeNormalizer({ breathingEmaAlpha: 0.5 });
  const s0 = n.accept(raw(0, 10));
  assert.equal(s0.breathingRate, 10);
  assert.equal(s0.status, "ok");

  const s1 = n.accept(raw(1000, 12));
  assert.equal(s1.breathingRate, 11);

  const s2 = n.accept(raw(2000, 14));
  assert.equal(s2.breathingRate, 12.5);
});

test("normalizer: implausible breathing rates are rejected (bounds)", () => {
  const n = makeNormalizer({ breathingEmaAlpha: 0.5 });
  n.accept(raw(0, 10));
  n.accept(raw(1000, 14)); // ema 12

  const bogus = n.accept(raw(2000, 55)); // outside 4..40
  assert.equal(bogus.breathingRate, 12); // held value survives
  assert.equal(bogus.status, "ok");

  const low = n.accept(raw(3000, 2)); // below 4
  assert.equal(low.breathingRate, 12);
});

test("normalizer: sudden spikes are rejected per second of gap", () => {
  const n = makeNormalizer({ breathingEmaAlpha: 0.5, maxJumpPerSecondBreathing: 6 });
  n.accept(raw(0, 10));
  n.accept(raw(1000, 14)); // jump 4 in 1s — allowed; ema 12

  const spiked = n.accept(raw(2000, 19)); // jump 7 in 1s > 6
  assert.equal(spiked.breathingRate, 12);

  const gentle = n.accept(raw(3000, 16)); // jump 4 in 1s — allowed
  assert.equal(gentle.breathingRate, 14);

  // A jump that would be a spike in 1s is fine across 5s.
  const lagged = n.accept(raw(8000, 30)); // jump 16 over 5s gap, cap 30
  assert.equal(lagged.breathingRate, 22);
});

test("normalizer: confidence gate holds the last good value, then reports lost", () => {
  const n = makeNormalizer({ breathingEmaAlpha: 0.5, holdSeconds: 5 });
  n.accept(raw(0, 10));
  n.accept(raw(1000, 12)); // ema 11, lastGood 1000

  const holding = n.accept(raw(2000, 12, 0.2)); // low confidence
  assert.equal(holding.breathingRate, 11);
  assert.equal(holding.confidence, 0.2);

  const stillHolding = n.accept(raw(6000, 12, 0.2)); // 5.0s since last good (<= 5s)
  assert.equal(stillHolding.breathingRate, 11);

  const expired = n.accept(raw(7000, 12, 0.2)); // 6.0s — hold window is over
  assert.equal(expired.status, "lost");
  assert.equal(expired.breathingRate, undefined);
});

test("normalizer: hold-then-lost via tick() when the source goes silent", () => {
  const n = makeNormalizer({ breathingEmaAlpha: 0.5, holdSeconds: 5 });
  n.accept(raw(0, 12));

  const t1 = n.tick(2000);
  assert.ok(t1 !== null);
  assert.equal(t1.breathingRate, 12);
  assert.equal(t1.confidence, 0);

  assert.equal(n.tick(2000), null); // same time as before -> nothing new

  const t5 = n.tick(5001); // just past the 5s hold from t=0
  assert.ok(t5 !== null);
  assert.equal(t5.status, "lost");
  assert.equal(t5.breathingRate, undefined);
});

test("normalizer: long gap resets smoothing (no stale spike check)", () => {
  const n = makeNormalizer({ breathingEmaAlpha: 0.5, gapResetSeconds: 30 });
  n.accept(raw(0, 10));
  n.accept(raw(1000, 20));

  // 40s gap: everything resets; next value seeds a new average.
  const fresh = n.accept(raw(41000, 14));
  assert.equal(fresh.breathingRate, 14);
  assert.equal(fresh.status, "ok");
});

test("normalizer: non-ok statuses pass through and drop the value", () => {
  const n = makeNormalizer({ breathingEmaAlpha: 0.5 });
  n.accept(raw(0, 10));

  const noFace = n.accept(raw(1000, 12, 1, "no_face"));
  assert.equal(noFace.status, "no_face");
  assert.equal(noFace.breathingRate, 10); // held, not updated

  const backOk = n.accept(raw(2000, 12, 1, "ok"));
  assert.equal(backOk.status, "ok");
  assert.equal(backOk.breathingRate, 11);
});

test("normalizer: implausible values with default bounds", () => {
  const n = makeNormalizer();
  assert.equal(n.accept(raw(0, 3.9)).breathingRate, undefined);
  assert.equal(n.accept(raw(1000, 3.99, 1, "ok")).breathingRate, undefined);
});
