import test from "node:test";
import assert from "node:assert/strict";
import { SupervisedSource } from "../src/signal/supervisor.js";
import type { Clock, NormalizedSample, SignalSource } from "../src/signal/SignalSource.js";
import { SimClock } from "../src/sim/harness.js";

class FlakySource implements SignalSource {
  static instances: FlakySource[] = [];
  samplesEmitted = 0;
  started = 0;
  stopped = 0;
  private cb: ((s: NormalizedSample) => void) | undefined;
  constructor(clock: Clock, private readonly dieAfterSamples: number) {
    void clock;
    FlakySource.instances.push(this);
  }
  start(): void {
    this.started++;
  }
  stop(): void {
    this.stopped++;
  }
  onSample(cb: (s: NormalizedSample) => void): () => void {
    this.cb = cb;
    return () => undefined;
  }
  tick(tMs: number): void {
    if (this.samplesEmitted < this.dieAfterSamples) {
      this.samplesEmitted++;
      this.cb?.({
        t: tMs,
        breathingRate: 12,
        confidence: 1,
        status: "ok",
      });
    }
  }
}

function makeSupervisor(
  clock: SimClock,
  dieAfter = 3,
  cfg = { silenceMs: 5_000, maxRestarts: 2, backoffMs: 1_000 },
): SupervisedSource {
  return new SupervisedSource(
    () => new FlakySource(clock, dieAfter),
    cfg,
    clock,
  );
}

test("healthy source passes samples through untouched", () => {
  FlakySource.instances = [];
  const clock = new SimClock();
  const sup = makeSupervisor(clock, 1_000);
  const got: NormalizedSample[] = [];
  sup.onSample((s) => got.push(s));
  sup.start();
  for (let t = 0; t <= 10_000; t += 1_000) {
    clock.time = t;
    sup.tick(t);
  }
  assert.equal(got.length, 11);
  assert.equal(sup.restartCount, 0);
  assert.equal(sup.isDegraded, false);
});

test("silent source is restarted with backoff, then degrades to guide-only", () => {
  FlakySource.instances = [];
  const clock = new SimClock();
  const sup = makeSupervisor(clock, 2); // each incarnation dies after 2 samples
  const degraded: boolean[] = [];
  sup.onDegraded = () => degraded.push(true);
  const got: NormalizedSample[] = [];
  sup.onSample((s) => got.push(s));
  sup.start();

  // Drive 60 virtual seconds at 1 Hz ticks.
  for (let t = 0; t <= 60_000; t += 1_000) {
    clock.time = t;
    sup.tick(t);
  }

  assert.ok(sup.restartCount >= 2, `restarts attempted (${sup.restartCount})`);
  assert.equal(sup.isDegraded, true, "degraded after max restarts");
  assert.deepEqual(degraded, [true], "onDegraded fired exactly once");
  // Each incarnation delivered its 2 samples before dying: 1 + 2 restarts*(2) = 6
  assert.equal(got.length, 6);
  // After degradation the wrapper emits nothing more, even if ticked.
  for (let t = 61_000; t <= 70_000; t += 1_000) {
    clock.time = t;
    sup.tick(t);
  }
  assert.equal(got.length, 6, "guide-only: silent after degradation");
  assert.equal(sup.restartCount, 2, "no further restarts after degradation");
});

test("backoff: restarts are not attempted more often than backoffMs", () => {
  FlakySource.instances = [];
  const clock = new SimClock();
  const sup = makeSupervisor(clock, 0, { silenceMs: 1_000, maxRestarts: 5, backoffMs: 10_000 });
  sup.start();
  for (let t = 0; t <= 20_000; t += 500) {
    clock.time = t;
    sup.tick(t);
  }
  assert.ok(sup.restartCount <= 2, `backoff respected (${sup.restartCount} in 20s)`);
  assert.equal(sup.isDegraded, false);
});

test("stop() releases the inner source and halts supervision", () => {
  FlakySource.instances = [];
  const clock = new SimClock();
  const sup = makeSupervisor(clock, 0);
  sup.start();
  sup.stop();
  for (let t = 0; t <= 60_000; t += 1_000) {
    clock.time = t;
    sup.tick(t);
  }
  assert.equal(sup.restartCount, 0);
  assert.equal(sup.isDegraded, false);
  assert.ok(FlakySource.instances.every((i) => i.stopped >= 1));
});
