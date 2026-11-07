import test from "node:test";
import assert from "node:assert/strict";
import { RoomManager, DEFAULT_SOURCE_FACTORY } from "../src/server/rooms.js";
import { SimClock } from "../src/sim/harness.js";
import { FROZEN_DEFAULT_SETTINGS, patchSettings, type Settings } from "../src/config.js";
import type { NormalizedSample, SignalSource } from "../src/signal/SignalSource.js";
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

test("guide-only session runs on timers and ends honestly", () => {
  const clock = new SimClock();
  const mgr = new RoomManager({ clock });
  const { roomId, participantId } = mgr.join();
  const participant = mgr.getRoom(roomId)!.getParticipant(participantId)!;
  const events = collect(participant);

  // Consent still required, even without a camera.
  assert.equal(participant.startGuideOnlySession(3).ok, false);
  participant.setConsent(true);
  assert.equal(participant.startGuideOnlySession(3).ok, true);

  runUntilInactive(mgr, clock, () => participant.pipeline.isSessionActive);

  const ended = events.find(
    (e): e is Extract<ParticipantPipelineEvent, { type: "session_ended" }> =>
      e.type === "session_ended",
  )!;
  assert.equal(ended.natural, true);
  assert.ok(ended.lines.some((l) => l.includes("without sensing")));
  // Pacer ran the whole time despite zero samples.
  assert.ok(
    events.some((e): e is Extract<ParticipantPipelineEvent, { type: "pacer_update" }> => e.type === "pacer_update"),
  );
  assert.equal(
    events.filter((e) => e.type === "sample").length,
    0,
    "guide-only never fabricates a sample",
  );
});

test("flaky sdk source: supervised restarts, then degrades with pacer still running", () => {
  const clock = new SimClock();
  // A source that dies after 2 samples, every incarnation.
  const flakyFactory: (
    spec: { kind: string; scenario?: never },
    ctx: { clock: SimClock; settings: Settings; seed: number },
  ) => { source: SignalSource; kind: "sdk"; note?: string } = (_spec, ctx) => {
    const listeners: ((s: NormalizedSample) => void)[] = [];
    let emitted = 0;
    const source: SignalSource = {
      start: () => undefined,
      stop: () => undefined,
      onSample: (cb) => {
        listeners.push(cb);
        return () => undefined;
      },
      tick: (t: number) => {
        if (emitted < 2) {
          emitted++;
          for (const cb of listeners) {
            cb({ t, breathingRate: 12, confidence: 1, status: "ok" });
          }
        }
      },
      setPacerRate: () => undefined,
    };
    void ctx;
    return { source, kind: "sdk" };
  };
  const mgr = new RoomManager({
    clock,
    settings: patchSettings(FROZEN_DEFAULT_SETTINGS, {
      server: {
        supervisorSilenceMs: 2_000,
        supervisorMaxRestarts: 1,
        supervisorBackoffMs: 500,
      },
    }),
    sourceFactory: flakyFactory as never,
  });
  const { roomId, participantId } = mgr.join();
  const participant = mgr.getRoom(roomId)!.getParticipant(participantId)!;
  participant.wantedSource = "sdk";
  participant.setConsent(true);
  const events = collect(participant);
  participant.startSession(3);

  for (let t = 0; t <= 60_000; t += 100) {
    clock.advance(100);
    mgr.tickAll(clock.now());
  }

  assert.ok(
    events.some((e) => e.type === "source_degraded"),
    "degradation surfaced to the pipeline",
  );
  // Pacer kept flowing after the source died (guide-only degradation).
  const degradedIdx = events.findIndex((e) => e.type === "source_degraded");
  assert.ok(
    events
      .slice(degradedIdx)
      .some((e): e is Extract<ParticipantPipelineEvent, { type: "pacer_update" }> => e.type === "pacer_update"),
    "pacer continues after degradation (session never freezes)",
  );
  participant.stopSession();
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

test("source factory: sdk kind builds the real SDK source; mock kind builds the mock", () => {  const built = DEFAULT_SOURCE_FACTORY(
    { kind: "sdk" },
    { clock: new SimClock(), settings: FROZEN_DEFAULT_SETTINGS, seed: 7 },
  );
  assert.equal(built.kind, "sdk");
  assert.equal(built.note, undefined);
  assert.equal(typeof built.source.start, "function");
  const mock = DEFAULT_SOURCE_FACTORY(
    { kind: "mock", scenario: "calm" },
    { clock: new SimClock(), settings: FROZEN_DEFAULT_SETTINGS, seed: 7 },
  );
  assert.equal(mock.kind, "mock");
  assert.equal(mock.note, undefined);
});

test("pair rooms: create, move with consent preserved, host designation, full room", () => {
  const clock = new SimClock();
  const mgr = new RoomManager({ clock });

  // Host starts in a solo auto-room, consents, then creates a pair room.
  const hostJoin = mgr.join();
  const host = mgr.getRoom(hostJoin.roomId)!.getParticipant(hostJoin.participantId)!;
  host.setConsent(true);
  const pair = mgr.createPairRoom();
  assert.equal(pair.isPair, true);
  assert.match(pair.code, /^[A-Z0-9]{6}$/);
  const moved = mgr.moveParticipant(hostJoin.roomId, hostJoin.participantId, pair, "Host");
  assert.equal(moved.ok, true);
  if (!moved.ok) throw new Error("move failed");
  const hostInPair = pair.getParticipant(moved.participantId)!;
  assert.equal(hostInPair.consentGranted, true, "consent preserved across the move");
  assert.equal(hostInPair.label, "Host");
  assert.equal(pair.hostId, hostJoin.participantId, "creator is host");
  assert.equal(mgr.getRoom(hostJoin.roomId), undefined, "empty solo room vanished");

  // Joiner moves in; room fills at 2.
  const guestJoin = mgr.join();
  const guest = mgr.getRoom(guestJoin.roomId)!.getParticipant(guestJoin.participantId)!;
  guest.setConsent(true);
  const moved2 = mgr.moveParticipant(guestJoin.roomId, guestJoin.participantId, pair, "Guest");
  assert.equal(moved2.ok, true);
  if (!moved2.ok) throw new Error("move2 failed");
  assert.notEqual(moved2.participantId, guestJoin.participantId, "colliding id gets a fresh one");
  assert.equal(pair.participants().size, 2);
  assert.equal(pair.getParticipant(moved2.participantId)!.label, "Guest");

  // A third participant cannot be moved in.
  const third = mgr.join();
  const moved3 = mgr.moveParticipant(third.roomId, third.participantId, pair, "Third");
  assert.equal(moved3.ok, false);
  if (!moved3.ok) assert.equal(moved3.error, "That room is full.");
});

test("pair rooms expire when unused (never started)", () => {
  const clock = new SimClock();
  const mgr = new RoomManager({ clock });
  const pair = mgr.createPairRoom();
  mgr.join({ wantedRoomId: pair.id }); // someone sits in it, unstarted
  const expiryMs = mgr.internal.settings.pair.codeExpiryMinutes * 60_000;
  clock.advance(expiryMs + 1);
  mgr.tickAll(clock.now());
  assert.equal(mgr.getRoom(pair.id), undefined, "expired room swept");
});

test("started pair rooms do not expire", () => {
  const clock = new SimClock();
  const mgr = new RoomManager({ clock });
  const pair = mgr.createPairRoom();
  mgr.join({ wantedRoomId: pair.id });
  pair.sessionStarted = true;
  const expiryMs = mgr.internal.settings.pair.codeExpiryMinutes * 60_000;
  clock.advance(expiryMs + 1);
  mgr.tickAll(clock.now());
  assert.ok(mgr.getRoom(pair.id), "started rooms survive past the code expiry");
});
