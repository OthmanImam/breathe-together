import test from "node:test";
import assert from "node:assert/strict";
import {
  cycleMsForRate,
  phaseDurationMs,
  sweepForPhase,
  peakGainForVolume,
  BreathingAudio,
} from "./audio.js";

test("cycle and phase durations follow the rate and 4:6 split", () => {
  assert.equal(cycleMsForRate(12), 5000);
  assert.equal(phaseDurationMs(12, "inhale", 0.4), 2000);
  assert.equal(phaseDurationMs(12, "exhale", 0.4), 3000);
  assert.equal(phaseDurationMs(10, "inhale", 0.4), 2400);
});

test("inhale sweep rises, exhale falls, both in a gentle mid register", () => {
  const inhale = sweepForPhase("inhale");
  assert.ok(inhale.toHz > inhale.fromHz);
  const exhale = sweepForPhase("exhale");
  assert.ok(exhale.toHz < exhale.fromHz);
  for (const f of [inhale.fromHz, inhale.toHz]) {
    assert.ok(f >= 150 && f <= 400, `gentle register (${f} Hz)`);
  }
});

test("peak gain stays low and monotone in volume, clamped to 0..1", () => {
  assert.ok(peakGainForVolume(0) < peakGainForVolume(0.5));
  assert.ok(peakGainForVolume(0.5) < peakGainForVolume(1));
  assert.ok(peakGainForVolume(1) <= 0.2, "never loud");
  assert.equal(peakGainForVolume(-1), peakGainForVolume(0));
  assert.equal(peakGainForVolume(99), peakGainForVolume(1));
});

test("BreathingAudio is a safe no-op without a browser AudioContext", () => {
  const audio = new BreathingAudio();
  // Node has no AudioContext: ensureStarted must not throw, onPacer is inert.
  assert.doesNotThrow(() => audio.ensureStarted());
  assert.doesNotThrow(() => audio.onPacer("inhale", 12, 0.4, 0));
  assert.doesNotThrow(() => audio.stop());
  audio.setVolume(0.5);
});
