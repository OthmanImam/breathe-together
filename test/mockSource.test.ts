import assert from "node:assert/strict";
import { test } from "node:test";

import { FROZEN_DEFAULT_SETTINGS } from "../src/config.js";
import { MockSource, mulberry32 } from "../src/signal/mockSource.js";
import type { Clock } from "../src/signal/SignalSource.js";

const cfg = FROZEN_DEFAULT_SETTINGS.mock;

/** Manual clock — deterministic stand-in for a real monotonic clock. */
class ManualClock implements Clock {
  time = 0;
  now(): number {
    return this.time;
  }
  advance(ms: number): void {
    this.time += ms;
  }
}

test("mulberry32 is deterministic for a seed and differs across seeds", () => {
  const a = mulberry32(7);
  const b = mulberry32(7);
  const c = mulberry32(8);
  const seqA = Array.from({ length: 5 }, () => a());
  const seqB = Array.from({ length: 5 }, () => b());
  const seqC = Array.from({ length: 5 }, () => c());
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
});

test("mock source: deterministic given the same seed and scenario", () => {
  const collect = (seed: number): unknown[] => {
    const clock = new ManualClock();
    const src = new MockSource("calm", clock, cfg, seed);
    const out: unknown[] = [];
    src.onSample((s) => out.push({ ...s }));
    src.start();
    for (let i = 0; i < 60; i++) {
      clock.advance(1000);
      src.tick(clock.now());
    }
    return out;
  };
  assert.deepEqual(collect(123), collect(123));
  assert.notDeepEqual(collect(123), collect(124));
});

test("mock source: samples arrive at ~1 Hz of simulated time", () => {
  const clock = new ManualClock();
  const src = new MockSource("calm", clock, cfg, 1);
  const times: number[] = [];
  src.onSample((s) => times.push(s.t));
  src.start();
  for (let i = 0; i < 65; i++) {
    clock.advance(1000);
    src.tick(clock.now());
  }
  assert.equal(times.length, 65); // 1 Hz including the very first second
  assert.equal(times[0], 1000);
  for (let i = 1; i < times.length; i++) {
    assert.equal(times[i]! - times[i - 1]!, 1000);
  }
});

test("calm scenario: stable ~12 bpm with small noise, ok status, full confidence", () => {
  const clock = new ManualClock();
  const src = new MockSource("calm", clock, cfg, 42);
  const samples: { t: number; rate?: number; conf: number; status: string }[] = [];
  src.onSample((s) =>
    samples.push({ t: s.t, rate: s.breathingRate, conf: s.confidence, status: s.status }),
  );
  src.start();
  for (let i = 0; i < 120; i++) {
    clock.advance(1000);
    src.tick(clock.now());
  }
  const all = samples;
  assert.ok(all.length >= 119);
  for (const s of all) {
    assert.equal(s.status, "ok");
    assert.equal(s.conf, 1);
    assert.ok(s.rate !== undefined && s.rate > 10.5 && s.rate < 13.5, `rate ${s.rate}`);
  }
});

test("agitated_then_settling: starts ~20 and follows the pacer when told to", () => {
  const clock = new ManualClock();
  const src = new MockSource("agitated_then_settling", clock, cfg, 42);
  const rates: number[] = [];
  src.onSample((s) => {
    if (s.breathingRate !== undefined) rates.push(s.breathingRate);
  });
  src.start();
  src.tick(1000);
  clock.advance(1000);
  src.tick(clock.now());
  src.setPacerRate(10);
  for (let i = 0; i < 120; i++) {
    clock.advance(1000);
    src.tick(clock.now());
  }
  assert.ok(rates[0] !== undefined && rates[0] > 17 && rates[0] < 23, `first ${rates[0]}`);
  const last10 = rates.slice(-10);
  const avg = last10.reduce((a, b) => a + b, 0) / last10.length;
  assert.ok(avg < 11.5, `should settle near 10, got ${avg}`);
});

test("ignores_pacer: stays roughly constant regardless of the pacer", () => {
  const clock = new ManualClock();
  const src = new MockSource("ignores_pacer", clock, cfg, 42);
  const rates: number[] = [];
  src.onSample((s) => {
    if (s.breathingRate !== undefined) rates.push(s.breathingRate);
  });
  src.start();
  src.setPacerRate(8);
  for (let i = 0; i < 180; i++) {
    clock.advance(1000);
    src.tick(clock.now());
  }
  const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
  const max = Math.max(...rates);
  const min = Math.min(...rates);
  assert.ok(avg > 21 && avg < 25, `avg ${avg}`);
  assert.ok(max - min < 4, `spread ${max - min}`);
});

test("dropout: signal disappears for the configured window, then returns", () => {
  const clock = new ManualClock();
  const src = new MockSource("dropout", clock, cfg, 42);
  const samples: { t: number }[] = [];
  src.onSample((s) => samples.push({ t: s.t }));
  src.start();
  for (let i = 0; i < 140; i++) {
    clock.advance(1000);
    src.tick(clock.now());
  }
  const silent = samples.filter((s) => s.t > 90_000 && s.t < 110_000);
  assert.equal(silent.length, 0);
  const during = samples.filter((s) => s.t >= 110_000 && s.t <= 140_000);
  assert.ok(during.length >= 30); // resumed
  const before = samples.filter((s) => s.t <= 90_000);
  assert.equal(before.length, 89); // samples at 1..89 s
});

test("bad_light: poor_light with low confidence for a stretch, then recovers", () => {
  const clock = new ManualClock();
  const src = new MockSource("bad_light", clock, cfg, 42);
  const samples: { t: number; conf: number; status: string }[] = [];
  src.onSample((s) => samples.push({ t: s.t, conf: s.confidence, status: s.status }));
  src.start();
  for (let i = 0; i < 120; i++) {
    clock.advance(1000);
    src.tick(clock.now());
  }
  const early = samples.filter((s) => s.t < 90_000);
  const late = samples.filter((s) => s.t > 90_000);
  assert.ok(early.every((s) => s.status === "poor_light" && s.conf < 0.5));
  assert.ok(late.every((s) => s.status === "ok" && s.conf === 1));
});

test("mock source: unsubscribe stops delivery", () => {
  const clock = new ManualClock();
  const src = new MockSource("calm", clock, cfg, 42);
  const got: number[] = [];
  const off = src.onSample((s) => got.push(s.t));
  src.start();
  clock.advance(1000);
  src.tick(clock.now());
  assert.equal(got.length, 1);
  off();
  clock.advance(1000);
  src.tick(clock.now());
  assert.equal(got.length, 1);
});

test("mock source: stop ends emission", () => {
  const clock = new ManualClock();
  const src = new MockSource("calm", clock, cfg, 42);
  let n = 0;
  src.onSample(() => n++);
  src.start();
  clock.advance(1000);
  src.tick(clock.now());
  src.stop();
  clock.advance(10000);
  src.tick(clock.now());
  assert.equal(n, 1);
});
