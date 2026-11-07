/**
 * Rooms and participants.
 *
 * A room owns a set of participants; solo is a room of one (pair mode later
 * adds participants to the same shape without structural changes). Each
 * participant gets its own `ParticipantPipeline` — coach, pacer, normalizer
 * and one SignalSource per session — wired on the manager's injected clock.
 *
 * Source selection policy:
 * - the registry maps source kinds to factories; unknown/unavailable kinds
 *   never crash the server — they degrade to the mock WITH an honest note
 *   that travels to the client (never a silent or disguised fallback);
 * - the server never trusts client-supplied numbers as signal truth: JSON
 *   client messages carry no signal data at all, and camera frames feed
 *   only SDK-mode sources (Step 6).
 *
 * Dev-only scenario control works only while `allowDevControls` is true
 * (server passes `NODE_ENV !== "production"` AND mock mode), so production
 * servers cannot be steered into synthetic data.
 */

import {
  FROZEN_DEFAULT_SETTINGS,
  patchSettings,
  type Settings,
  type SessionMinutes,
} from "../config.js";
import type { Clock, SignalSource } from "../signal/SignalSource.js";
import { MockSource, MOCK_SCENARIOS, type MockScenario } from "../signal/mockSource.js";
import { SdkSource } from "../signal/sdkSource.js";
import { SupervisedSource } from "../signal/supervisor.js";
import type { ParticipantPipelineEvent } from "./sessionPipeline.js";
import { ParticipantPipeline } from "./sessionPipeline.js";
import { generateRoomCode } from "./protocol.js";
import { readUsageSeconds } from "../signal/sdkSource.js";

export type SourceKind = "mock" | "sdk";

export interface SourceSpec {
  kind: SourceKind;
  /** Only meaningful for the mock source (dev controls). */
  scenario?: MockScenario;
}

export interface SourceBuild {
  source: SignalSource;
  /** The kind actually built (may differ from the spec when falling back). */
  kind: SourceKind;
  /** Populated when the requested source could not be provided. */
  note?: string;
}

export type SourceFactory = (
  spec: SourceSpec,
  ctx: { clock: Clock; settings: Settings; seed: number },
) => SourceBuild;

/**
 * Default registry. The "sdk" entry exists structurally but refuses until
 * Step 6 wires the worker process; the manager degrades to the mock with a
 * note instead of ever running without a source.
 */
export const DEFAULT_SOURCE_FACTORY: SourceFactory = (spec, ctx) => {
  if (spec.kind === "sdk") {
    // Real SDK source: the child process loads the native runtime. If the
    // native package is missing, the child fails to start, the source goes
    // silent, and supervision degrades honestly — never disguised as data.
    return {
      source: new SdkSource({
        clock: ctx.clock,
        settings: ctx.settings.sdk,
        apiKey: process.env.SMARTSPECTRA_API_KEY ?? "",
      }),
      kind: "sdk",
    };
  }
  return {
    source: new MockSource(
      spec.scenario ?? "agitated_then_settling",
      ctx.clock,
      ctx.settings.mock,
      ctx.seed,
    ),
    kind: "mock",
  };
};

export interface RoomManagerOptions {
  clock: Clock;
  settings?: Settings;
  sourceFactory?: SourceFactory;
  /** Gates dev scenario selection. */
  allowDevControls?: boolean;
}

export interface RoomOptions {
  wantedRoomId?: string;
  participantId?: string;
}

const ROOM_ID_CITY = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomRoomId(counter: number): string {
  let suffix = "";
  for (let i = 0; i < 8; i++) {
    suffix += ROOM_ID_CITY[Math.floor(Math.random() * ROOM_ID_CITY.length)];
  }
  return `solo-${counter.toString(36)}-${suffix}`;
}

export type RoomEvent =
  | { kind: "participant_added"; roomId: string; participantId: string }
  | { kind: "room_expired"; roomId: string; participantId: string };

export type RoomEventListener = (e: RoomEvent) => void;

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly settings: Settings;
  private readonly clock: Clock;
  private readonly sourceFactory: SourceFactory;
  private readonly allowDevControls: boolean;
  private readonly roomListeners: RoomEventListener[] = [];
  private roomCounter = 0;

  constructor(opts: RoomManagerOptions) {
    this.clock = opts.clock;
    this.settings = patchSettings(opts.settings ?? FROZEN_DEFAULT_SETTINGS, {});
    this.sourceFactory = opts.sourceFactory ?? DEFAULT_SOURCE_FACTORY;
    this.allowDevControls = opts.allowDevControls ?? false;
  }

  /** Subscribe to room lifecycle events (add FIRST, before any join). */
  onRoomEvent(cb: RoomEventListener): () => void {
    this.roomListeners.push(cb);
    return () => {
      const i = this.roomListeners.indexOf(cb);
      if (i >= 0) this.roomListeners.splice(i, 1);
    };
  }

  /** Room events only (participant_added / room_expired). */
  onPairEvent(cb: RoomEventListener): () => void {
    return this.onRoomEvent(cb);
  }

  /* @internal */ emitRoomEvent(e: RoomEvent): void {
    for (const cb of this.roomListeners) cb(e);
  }

  /** Join (creating the room if needed). Solo default: room of one. */
  join(opts: RoomOptions = {}): { roomId: string; participantId: string } {
    const roomId =
      opts.wantedRoomId && /^[A-Za-z0-9_-]{3,64}$/.test(opts.wantedRoomId)
        ? opts.wantedRoomId
        : randomRoomId(++this.roomCounter);
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Room(roomId, this);
      this.rooms.set(roomId, room);
    }
    const participantId = room.addParticipant(opts.participantId);
    return { roomId, participantId };
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  get devControlsAllowed(): boolean {
    return this.allowDevControls;
  }

  /** Drive every participant's session forward to `nowMs` (monotonic). */
  tickAll(nowMs: number): void {
    for (const room of this.rooms.values()) room.tick(nowMs);
    this.sweepExpired(nowMs);
  }

  /** Pair rooms expire (unused, session never started) after the configured window. */
  sweepExpired(nowMs: number): void {
    const expiryMs = this.settings.pair.codeExpiryMinutes * 60_000;
    for (const [id, room] of this.rooms) {
      if (!room.isPair) continue;
      if (room.sessionStarted) continue;
      if (nowMs - room.createdAtMs > expiryMs) {
        room.shutdown();
        this.rooms.delete(id);
        for (const cb of this.roomListeners) {
          cb({ kind: "room_expired", roomId: id, participantId: "" });
        }
      }
    }
  }

  /** Create a pair room with a fresh code; the creator becomes host. */
  createPairRoom(): Room {
    const pair = this.settings.pair;
    let code = "";
    for (let attempt = 0; attempt < 20; attempt++) {
      code = generateRoomCode(pair.codeLength);
      if (![...this.rooms.values()].some((r) => r.code === code)) break;
    }
    const room = new Room(`pair-${code.toLowerCase()}`, this, { pair: true, code });
    this.rooms.set(room.id, room);
    return room;
  }

  findPairRoomByCode(code: string): Room | undefined {
    const wanted = `pair-${code.toLowerCase()}`;
    return this.rooms.get(wanted);
  }

  /**
   * Move a participant into a pair room, preserving consent/label/ready.
   * Returns the assigned id on success, or an error message. The source
   * room is cleaned up. Note: solo rooms all mint "p1"-style ids, so on
   * collision the moved participant gets a FRESH id in the target room —
   * callers must use the returned id, never the old one.
   */
  moveParticipant(
    fromRoomId: string,
    participantId: string,
    target: Room,
    label?: string,
  ): { ok: true; participantId: string } | { ok: false; error: string } {
    const from = this.rooms.get(fromRoomId);
    const source = from?.getParticipant(participantId);
    if (!from || !source) return { ok: false, error: "Not in a room." };
    if (target.participants().size >= target.maxParticipants) {
      return { ok: false, error: "That room is full." };
    }
    from.removeParticipant(participantId);
    if (from.participants().size === 0) this.rooms.delete(from.id);
    const addedId = target.addParticipant(
      target.getParticipant(participantId) ? undefined : participantId,
    );
    const moved = target.getParticipant(addedId);
    if (moved) {
      moved.setConsent(source.consentGranted);
      moved.ready = source.ready;
      moved.label = label ?? source.label;
      moved.shareRate = source.shareRate;
    }
    return { ok: true, participantId: addedId };
  }

  /** Remaining daily SDK budget in minutes (for pair quota display). */
  quotaRemainingMin(): number {
    const capSec = this.settings.sdk.dailyCapMinutes * 60;
    const usedSec = readUsageSeconds(this.settings.sdk.usageFile);
    return Math.max(0, Math.floor((capSec - usedSec) / 60));
  }

  removeParticipant(roomId: string, participantId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.removeParticipant(participantId);
    if (room.participants().size === 0) this.rooms.delete(roomId);
  }

  /** Stop every session and release every source (graceful shutdown). */
  shutdownAll(): void {
    for (const room of this.rooms.values()) room.shutdown();
    this.rooms.clear();
  }

  get internal(): {
    settings: Settings;
    clock: Clock;
    sourceFactory: SourceFactory;
    allowDevControls: boolean;
  } {
    return {
      settings: this.settings,
      clock: this.clock,
      sourceFactory: this.sourceFactory,
      allowDevControls: this.allowDevControls,
    };
  }
}

export class Room {
  readonly id: string;
  readonly isPair: boolean;
  readonly code: string;
  readonly createdAtMs: number;
  private readonly manager: RoomManager;
  private readonly byId = new Map<string, RoomParticipant>();
  private participantCounter = 0;
  /** Set when a session starts; only unstarted pair rooms expire. */
  sessionStarted = false;
  /** Host participant id (pair rooms; first participant). */
  hostId: string | undefined;

  constructor(
    id: string,
    manager: RoomManager,
    opts?: { pair?: boolean; code?: string },
  ) {
    this.id = id;
    this.manager = manager;
    this.isPair = opts?.pair ?? false;
    this.code = opts?.code ?? "";
    this.createdAtMs = manager.internal.clock.now();
  }

  get maxParticipants(): number {
    return this.isPair ? this.manager.internal.settings.pair.maxParticipants : 64;
  }

  participants(): Map<string, RoomParticipant> {
    return this.byId;
  }

  getParticipant(id: string): RoomParticipant | undefined {
    return this.byId.get(id);
  }

  /** Add (or idempotently return) a participant with its own pipeline. */
  addParticipant(wantedId?: string): string {
    let id =
      wantedId && /^[A-Za-z0-9_-]{1,64}$/.test(wantedId)
        ? wantedId
        : "";
    if (!id) {
      do {
        id = `p${++this.participantCounter}`;
      } while (this.byId.has(id));
    }
    const existing = this.byId.get(id);
    if (existing) return id;

    const ctx = this.manager.internal;
    // Per-participant settings copy; pipelines read by reference.
    const settings = patchSettings(ctx.settings, {});
    const seed = Math.floor(Math.random() * 2 ** 31);
    const pipeline = new ParticipantPipeline({
      clock: ctx.clock,
      settings,
      createSource: (spec, sessionSettings) => {
        // Only real (SDK) sources are supervised: silence is a failure there.
        // The mock's own dropout scenario is deliberate silence and must NOT
        // be "repaired" by the supervisor.
        if (spec.kind !== "sdk") {
          return ctx.sourceFactory(
            { kind: spec.kind, ...(spec.scenario !== undefined ? { scenario: spec.scenario as MockScenario } : {}) },
            { clock: ctx.clock, settings: sessionSettings, seed },
          );
        }
        const buildOnce = (): SignalSource =>
          ctx.sourceFactory({ kind: "sdk" }, { clock: ctx.clock, settings: sessionSettings, seed })
            .source;
        // SupervisedSource spawns on start(), so the factory closure must
        // build a FRESH source per attempt (a dead SDK child can't be revived).
        const supervised = new SupervisedSource(buildOnce, {
          silenceMs: ctx.settings.server.supervisorSilenceMs,
          maxRestarts: ctx.settings.server.supervisorMaxRestarts,
          backoffMs: ctx.settings.server.supervisorBackoffMs,
        }, ctx.clock);
        return { source: supervised, kind: "sdk" };
      },
    });
    const p = new RoomParticipant(id, pipeline, this);
    this.byId.set(id, p);
    if (this.isPair && !this.hostId) this.hostId = id;
    this.manager.emitRoomEvent({ kind: "participant_added", roomId: this.id, participantId: id });
    return id;
  }

  removeParticipant(id: string): void {
    const p = this.byId.get(id);
    if (!p) return;
    p.pipeline.destroy();
    this.byId.delete(id);
    if (this.hostId === id) this.hostId = undefined;
  }

  tick(nowMs: number): void {
    for (const p of this.byId.values()) p.pipeline.tick(nowMs);
  }

  shutdown(): void {
    for (const p of this.byId.values()) p.pipeline.destroy();
    this.byId.clear();
  }
}

export class RoomParticipant {
  readonly id: string;
  readonly pipeline: ParticipantPipeline;
  private readonly room: Room;
  consentGranted = false;
  /** Self-chosen display label (no accounts). Defaults to a neutral name. */
  label = "Participant";
  /** Lobby readiness (camera on, setup done). */
  ready = false;
  /** Opt-in: share my breathing rate with the other participant (off). */
  shareRate = false;
  /** Remembered source kind (mock|sdk) — sessions start with it. */
  wantedSource: SourceKind = "mock";
  /** Dev-only scenario to use for the next session (validated at call time). */
  devScenario: MockScenario | undefined;

  constructor(id: string, pipeline: ParticipantPipeline, room: Room) {
    this.id = id;
    this.pipeline = pipeline;
    this.room = room;
  }

  get roomId(): string {
    return this.room.id;
  }

  setConsent(granted: boolean): void {
    this.consentGranted = granted;
    if (!granted) {
      // Revoking consent tears down everything sampling-related, preview too.
      this.pipeline.stopPreview();
    }
  }

  /**
   * Start a session. Consent is enforced HERE as well as at the connection
   * layer (defense in depth): no session, hence no sampling, until consent.
   * Returns `{ ok: false, error }` on refusal.
   */
  startSession(
    durationMin: SessionMinutes,
  ): { ok: true; kind: SourceKind; note?: string } | { ok: false; error: string } {
    if (!this.consentGranted) {
      return { ok: false, error: "Consent is required before starting a session." };
    }
    if (this.pipeline.isSessionActive) {
      return { ok: false, error: "A session is already running." };
    }
    const built = this.pipeline.startSession(durationMin, {
      kind: this.wantedSource,
      ...(this.devScenario ? { scenario: this.devScenario } : {}),
    });
    return { ok: true, kind: built.kind, ...(built.note ? { note: built.note } : {}) };
  }

  /** Returns an error message or null on success (dev controls only). */
  setDevScenario(scenario: string, allowed: boolean): string | null {
    if (!allowed) {
      return "Scenario selection is a development-only control and is disabled here.";
    }
    if (!MOCK_SCENARIOS.includes(scenario as MockScenario)) {
      return `Unknown scenario: ${scenario}`;
    }
    this.devScenario = scenario as MockScenario;
    return null;
  }

  /** Start preview (samples only, no coach). Consent required, same as sessions. */
  startPreview(): { ok: true; kind: SourceKind; note?: string } | { ok: false; error: string } {
    if (!this.consentGranted) {
      return { ok: false, error: "Consent is required before previewing the camera." };
    }
    const built = this.pipeline.startPreview({
      kind: this.wantedSource,
      ...(this.devScenario ? { scenario: this.devScenario } : {}),
    });
    return { ok: true, kind: built.kind, ...(built.note ? { note: built.note } : {}) };
  }

  stopPreview(): void {
    this.pipeline.stopPreview();
  }

  /** Start a guide-only session (no sensing). Consent still required. */
  startGuideOnlySession(
    durationMin: SessionMinutes,
  ): { ok: true } | { ok: false; error: string } {
    if (!this.consentGranted) {
      return { ok: false, error: "Consent is required before starting a session." };
    }
    if (this.pipeline.isSessionActive) {
      return { ok: false, error: "A session is already running." };
    }
    this.pipeline.startGuideOnlySession(durationMin);
    return { ok: true };
  }

  stopSession(): void {
    this.pipeline.stopSession();
  }
}

export type { MockScenario, ParticipantPipelineEvent };
