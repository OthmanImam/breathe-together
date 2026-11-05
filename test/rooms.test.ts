import test from "node:test";
import assert from "node:assert/strict";
import { RoomManager, DEFAULT_SOURCE_FACTORY } from "../src/server/rooms.js";
import { SimClock } from "../src/sim/harness.js";
import { FROZEN_DEFAULT_SETTINGS } from "../src/config.js";
import type { ParticipantPipelineEvent } from "../src/server/sessionPipeline.js";

function collect(participant: {
  pipeline: { onEvent(cb: (e: ParticipantPipelineEvent) => void): () => void };
}): ParticipantPipelineEvent[] {
  const events: ParticipantPipelineEvent[] = [];
  participant.pipeline.onEvent((e) => events.push(e));
  return events;
}

function runUntilInactive(
  mgr: RoomManager,
  clock: SimClock,
  isActive: () => boolean,
  virtualMs = 3 * 60_000,
  stepMs = 100,
): void {
  for (let i = 0; i < virtualMs / stepMs; i++) {
    if (!isActive()) break;
    clock.advance(stepMs);
    mgr.tickAll(clock.now());
  }
}

function runWholeSession(
  mgr: RoomManager,
  clock: SimClock,
  participant: {
    pipeline: {
      isSessionActive: boolean;
      onEvent(cb: (e: ParticipantPipelineEvent) => void): () => void;
    };
  },
): ParticipantPipelineEvent[] {
  const events = collect(participant);
  runUntilInactive(mgr, clock, () => participant.pipeline.isSessionActive);
  return events;
}

test("solo room: full accelerated session produces the full state walk + summary", () => {
  const clock = new SimClock();
  const mgr = new RoomManager({ clock });
  const { roomId, participantId } = mgr.join();
  assert.match(roomId, /^solo-/);
  const participant = mgr.getRoom(roomId)!.getParticipant(participantId)!;

  // Consent is required before a session can start (room-level guard).
  const refused = participant.startSession(3);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /Consent/);
  participant.setConsent(true);
  const events = collect(participant);
  const started = participant.startSession(3);
  assert.equal(started.ok, true);

  runUntilInactive(mgr, clock, () => participant.pipeline.isSessionActive);

  const states = events
    .filter(
      (e): e is Extract<ParticipantPipelineEvent, { type: "state_changed" }> =>
        e.type === "state_changed",
    )
    .map((e) => e.to);
  assert.deepEqual(
    [...new Set(states)],
    ["calibrate", "match", "lead", "cooldown", "ended"],
  );

  const ended = events.find(
    (e): e is Extract<ParticipantPipelineEvent, { type: "session_ended" }> =>
      e.type === "session_ended",
  )!;
  assert.equal(ended.natural, true);
  assert.ok(ended.summary);
  assert.ok(ended.lines.length >= 4);
  assert.match(ended.lines[0]!, /observations only/);

  // Pacer updates flowed at driver cadence with valid snapshots.
  const pacerUpdates = events.filter(
    (e): e is Extract<ParticipantPipelineEvent, { type: "pacer_update" }> =>
      e.type === "pacer_update",
  );
  assert.ok(pacerUpdates.length > 1000, "pacer pushed throughout the session");
  for (const u of pacerUpdates) {
    assert.ok(u.snap.phaseProgress >= 0 && u.snap.phaseProgress <= 1);
    assert.ok(u.snap.rate > 0);
    assert.ok(u.snap.phase === "inhale" || u.snap.phase === "exhale");
  }

  // Samples flowed through the normalizer with plausible values.
  const samples = events.filter(
    (e): e is Extract<ParticipantPipelineEvent, { type: "sample" }> => e.type === "sample",
  );
  assert.ok(samples.length > 100);
  assert.ok(samples.every((s) => s.sample.confidence >= 0 && s.sample.confidence <= 1));
});

test("double-start on an active session is refused (no silent second pipeline)", () => {
  const clock = new SimClock();
  const mgr = new RoomManager({ clock });
  const { roomId, participantId } = mgr.join();
  const participant = mgr.getRoom(roomId)!.getParticipant(participantId)!;
  participant.setConsent(true);

  assert.equal(participant.startSession(3).ok, true);
  const second = participant.startSession(5);
  assert.equal(second.ok, false);
  if (!second.ok) assert.match(second.error, /already running/);
  participant.stopSession();
  assert.equal(participant.pipeline.isSessionActive, false);
});

test("early stop emits an honest non-natural end with no summary", () => {
  const clock = new SimClock();
  const mgr = new RoomManager({ clock });
  const { roomId, participantId } = mgr.join();
  const participant = mgr.getRoom(roomId)!.getParticipant(participantId)!;
  participant.setConsent(true);
  const events = collect(participant);
  participant.startSession(3);

  clock.advance(10_000);
  mgr.tickAll(clock.now());
  participant.stopSession();

  const endedEvents = events.filter(
    (e): e is Extract<ParticipantPipelineEvent, { type: "session_ended" }> =>
      e.type === "session_ended",
  );
  assert.equal(endedEvents.length, 1);
  assert.equal(endedEvents[0]!.natural, false);
  assert.equal(endedEvents[0]!.summary, undefined);
});

test("dev scenario control is permission-gated and validated", () => {
  const gated = new RoomManager({ clock: new SimClock(), allowDevControls: false });
  const j1 = gated.join();
  const p1 = gated.getRoom(j1.roomId)!.getParticipant(j1.participantId)!;
  const refused = p1.setDevScenario("calm", false);
  assert.ok(refused?.includes("development-only"));
  assert.notEqual(p1.setDevScenario("banana", true), null, "unknown scenario refused");

  const open = new RoomManager({ clock: new SimClock(), allowDevControls: true });
  const j2 = open.join();
  const p2 = open.getRoom(j2.roomId)!.getParticipant(j2.participantId)!;
  assert.equal(p2.setDevScenario("ignores_pacer", true), null);
  p2.setConsent(true);
  p2.startSession(3);
  // The ignorer diverges from the pace throughout: divergence minutes accrue.
  const events = runWholeSession(open, open.internal.clock as SimClock, p2);
  const ended = events.find(
    (e): e is Extract<ParticipantPipelineEvent, { type: "session_ended" }> =>
      e.type === "session_ended",
  )!;
  assert.ok(ended.summary, "summary exists");
  assert.ok(
    (ended.summary!.minutesDiverged ?? 0) >= 1.5,
    "ignores_pacer scenario took effect",
  );
});

test("room closes when its last participant leaves", () => {
  const mgr = new RoomManager({ clock: new SimClock() });
  const { roomId, participantId } = mgr.join();
  assert.equal(mgr.roomCount, 1);
  mgr.removeParticipant(roomId, participantId);
  assert.equal(mgr.roomCount, 0);
  assert.equal(mgr.getRoom(roomId), undefined);
});

test("second participant gets a unique id in the same room (pair-mode shape)", () => {
  const mgr = new RoomManager({ clock: new SimClock() });
  mgr.join({ wantedRoomId: "test-room-1" });
  const b = mgr.join({ wantedRoomId: "test-room-1" });
  const room = mgr.getRoom("test-room-1")!;
  assert.equal(room.participants().size, 2);
  assert.notEqual(b.participantId, "p1");
  mgr.shutdownAll();
  assert.equal(mgr.roomCount, 0);
});

test("default source factory falls back honestly for sdk requests", () => {
  const built = DEFAULT_SOURCE_FACTORY(
    { kind: "sdk" },
    { clock: new SimClock(), settings: FROZEN_DEFAULT_SETTINGS, seed: 7 },
  );
  assert.equal(built.kind, "mock");
  assert.match(built.note ?? "", /not wired up/);
  const mock = DEFAULT_SOURCE_FACTORY(
    { kind: "mock", scenario: "calm" },
    { clock: new SimClock(), settings: FROZEN_DEFAULT_SETTINGS, seed: 7 },
  );
  assert.equal(mock.kind, "mock");
  assert.equal(mock.note, undefined);
});
