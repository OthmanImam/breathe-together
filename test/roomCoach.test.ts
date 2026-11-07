import test from "node:test";
import assert from "node:assert/strict";
import { RoomCoach, type RoomCoachFeed } from "../src/coach/roomCoach.js";
import { FROZEN_DEFAULT_SETTINGS } from "../src/config.js";
import type { CoachState } from "../src/coach/stateMachine.js";
import type { ParticipantPipelineEvent } from "../src/server/sessionPipeline.js";

class FakeFeed implements RoomCoachFeed {
  proposal = 12;
  state: CoachState = "lead";
  private cb: (e: ParticipantPipelineEvent) => void = () => undefined;
  proposalRate(): number {
    return this.proposal;
  }
  coachState(): CoachState {
    return this.state;
  }
  sessionEnded(): boolean {
    return false;
  }
  onEvent(cb: (e: ParticipantPipelineEvent) => void): () => void {
    this.cb = cb;
    return () => undefined;
  }
  sample(rate: number, t: number, status: "ok" | "lost" = "ok"): void {
    this.cb({
      type: "sample",
      sample: { t, breathingRate: rate, confidence: status === "ok" ? 1 : 0, status },
    });
  }
}

function setup() {
  const a = new FakeFeed();
  const b = new FakeFeed();
  let now = 0;
  const clock = { now: () => now };
  const coach = new RoomCoach({
    clock,
    settings: FROZEN_DEFAULT_SETTINGS,
    feeds: [a, b],
  });
  return { a, b, coach, setNow: (t: number) => { now = t; } };
}

test("gentler proposal wins: shared rate is the MAX", () => {
  const { a, b, coach } = setup();
  a.proposal = 9;
  b.proposal = 14;
  // Rate changes commit at the next cycle boundary (solo pacer rule).
  coach.tick(0);
  assert.equal(coach.tick(6000).sharedRate, 14);
  a.proposal = 15;
  assert.equal(coach.tick(12_000).sharedRate, 15);
});

test("a calibrating participant is excluded until calibrated", () => {
  const { a, b, coach } = setup();
  a.state = "calibrate";
  a.proposal = 12; // fallback-ish preview value
  b.state = "lead";
  b.proposal = 8;
  coach.tick(0);
  assert.equal(coach.tick(6000).sharedRate, 8, "excluded while calibrating");
  a.state = "match";
  assert.equal(coach.tick(20_000).sharedRate, 12, "counted once calibrated");
});

test("max wait includes the fallback for a still-calibrating participant", () => {
  const { a, b, coach } = setup();
  a.state = "calibrate";
  a.proposal = 12;
  b.state = "lead";
  b.proposal = 8;
  coach.tick(0);
  // maxCalibrateWaitSeconds = 90
  assert.equal(coach.tick(91_000).sharedRate, 12);
});

test("alignment tracks both samples against the shared rate", () => {
  const { a, b, coach } = setup();
  a.proposal = b.proposal = 10;
  for (let t = 0; t <= 30_000; t += 1000) {
    a.sample(10, t);
    b.sample(10, t);
    coach.tick(t);
  }
  assert.ok(coach.currentAlignment.value !== undefined);
  assert.ok(coach.currentAlignment.value! > 0.5, `alignment ${coach.currentAlignment.value}`);
});

test("phase is the least-advanced participant's state", () => {
  const { a, b, coach } = setup();
  a.state = "cooldown";
  b.state = "calibrate";
  assert.equal(coach.phase(), "calibrate");
  b.state = "match";
  a.state = "cooldown";
  assert.equal(coach.phase(), "match");
  a.state = "ended";
  b.state = "ended";
  assert.equal(coach.phase(), "ended");
});

test("peer removal leaves the solo proposal driving the shared rate", () => {
  const { a, b, coach } = setup();
  a.proposal = 9;
  b.proposal = 14;
  coach.tick(0);
  assert.equal(coach.tick(6000).sharedRate, 14);
  coach.removeFeed(b);
  assert.equal(coach.tick(12000).sharedRate, 9);
  assert.equal(coach.currentAlignment.waiting, true, "alignment waits without a peer");
});
