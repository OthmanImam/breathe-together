/**
 * Wire protocol for the browser <-> server WebSocket connection.
 *
 * Pure TypeScript: no Node imports, no runtime deps — the browser client
 * imports the very same types and validators, so the two sides cannot drift.
 *
 * Envelope rule: every message carries `roomId` and `participantId`. Solo is
 * a room of one; pair mode (later) adds participants without changing this
 * shape. The SERVER owns the truth of both ids: a client's stale or forged
 * values are ignored in favor of the connection's assigned ones (they are
 * still validated as strings so garbage inputs are rejected up front).
 *
 * Camera frames are NOT JSON messages: binary WebSocket frames carry an
 * 8-byte little-endian microsecond timestamp header followed by raw pixels
 * (see FRAME_HEADER_BYTES / encodeFrameHeader). JSON messages are all
 * control-plane.
 */

import type { SessionMinutes } from "../config.js";
import type { SignalStatus } from "../signal/SignalSource.js";

// ---------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------

export type SessionMode = "solo";
/** Modes that can be requested today; pair arrives in a later phase. */
export const SESSION_MODES: readonly SessionMode[] = ["solo"];

/** Valid session lengths (mirrors the coach's config). */
export const SESSION_DURATIONS: readonly SessionMinutes[] = [3, 5, 10];

/** Notice levels are deliberately calm — there is no "error" notice level. */
export type NoticeLevel = "info" | "guidance";

export interface ClientSample {
  /** Sample timestamp, ms (server-monotonic timeline). */
  t: number;
  breathingRate?: number;
  confidence: number;
  status: SignalStatus;
}

// ---------------------------------------------------------------------------
// Client -> server (JSON)
// ---------------------------------------------------------------------------

export type ClientMessage =
  | {
      type: "hello";
      clientVersion?: string;
      /** Optional room id for a later pair mode; solo ignores it. `^[\w-]{1,64}$`. */
      wantedRoomId?: string;
    }
  | { type: "consent_granted" }
  | { type: "consent_revoked" }
  | {
      type: "start_session";
      durationMin: SessionMinutes;
      mode: SessionMode;
      /** Guide-only: run the pacing guide with no sensing (no camera). */
      guideOnly?: boolean;
    }
  | { type: "stop_session" }
  /** Begin streaming normalized samples only (no coach): Setup-screen framing guidance. */
  | { type: "preview_start" }
  | { type: "preview_stop" }
  /** Dev-only: choose which mock scenario the NEXT session uses. Server refuses in production. */
  | { type: "set_scenario"; scenario: string }
  | { type: "ping" };

// ---------------------------------------------------------------------------
// Server -> client (JSON)
// ---------------------------------------------------------------------------

export type ServerMessage =
  | {
      type: "welcome";
      roomId: string;
      participantId: string;
      /** Which source will actually feed the signal ("mock" | "sdk"). Never a lie: if the SDK could not start, this says "mock". */
      signalSource: "mock" | "sdk";
      /** Populated when the SDK source was requested but unavailable, watched by dev tooling and the UI's small honesty note. */
      signalSourceNote?: string;
      /** True only when the server offers dev-only mock scenario selection. */
      devControls: boolean;
    }
  | { type: "sample"; sample: ClientSample }
  | {
      type: "pacer_update";
      t: number;
      rate: number;
      pendingRate?: number;
      phase: "inhale" | "exhale";
      phaseProgress: number;
      cycles: number;
    }
  | { type: "state_changed"; t: number; from: string; to: string }
  | { type: "notice"; t: number; kind: string; text: string; level: NoticeLevel }
  | {
      type: "session_end";
      t: number;
      /** Undefined only for early stops/endings (no summary); otherwise the observation-only summary fields. */
      summary?: Record<string, number> | undefined;
      /** Ready-to-display summary lines (observation-only wording). */
      lines: string[];
    }
  | { type: "pong" }
  | { type: "error"; code: string; message: string };

// ---------------------------------------------------------------------------
// Binary frame format (client -> server, camera pixels)
// ---------------------------------------------------------------------------

/** Monotonic microseconds, little-endian 64-bit float holding an integer. */
export const FRAME_HEADER_BYTES = 8;

export function encodeFrameHeader(timestampUs: number): Uint8Array {
  const buf = new Uint8Array(FRAME_HEADER_BYTES);
  const view = new DataView(buf.buffer);
  view.setFloat64(0, timestampUs, true);
  return buf;
}

export function decodeFrameHeader(payload: ArrayBuffer): { timestampUs: number; pixels: Uint8Array } {
  const view = new DataView(payload);
  const timestampUs = view.getFloat64(0, true);
  return { timestampUs, pixels: new Uint8Array(payload, FRAME_HEADER_BYTES) };
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/** Classic token bucket, one instance per channel per connection. */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  constructor(
    private readonly capacity: number,
    /** Allowed events per second, sustained. */
    private readonly refillPerSec: number,
  ) {
    if (!(capacity >= 1) || !(refillPerSec > 0)) {
      throw new Error("TokenBucket requires capacity>=1 and refillPerSec>0");
    }
    this.tokens = capacity;
    this.lastRefill = 0;
  }

  /** `nowMs` is any monotonic ms clock. Returns false when the caller should be throttled. */
  trySpend(nowMs: number, cost = 1): boolean {
    if (this.lastRefill !== 0) {
      const elapsedSec = Math.max(0, (nowMs - this.lastRefill) / 1000);
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    }
    this.lastRefill = nowMs;
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ParsedClientMessage {
  ok: true;
  message: ClientMessage;
}

export interface ParseFailure {
  ok: false;
  /** Short machine code for the `error` reply. */
  code: "malformed" | "unknown_type" | "invalid_field" | "oversize";
  message: string;
}

const ID_PATTERN = /^[\w-]{1,64}$/;
/** Longest acceptable free-text field (clientVersion etc.). */
const MAX_STRING_FIELD = 128;

export const CLIENT_ERROR_CODES = {
  bad_json: "malformed_json",
  too_big: "oversize",
  unknown_type: "unknown_type",
} as const;

function fail(code: ParseFailure["code"], message: string): ParseFailure {
  return { ok: false, code, message };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkEnvelope(raw: Record<string, unknown>): ParseFailure | null {
  // Envelope ids are required so the wire shape is frozen now for pair mode.
  // (The server stamps its own authoritative ids on replies regardless.)
  if (typeof raw.roomId === "string" && raw.roomId.length > 0 && !ID_PATTERN.test(raw.roomId)) {
    return fail("invalid_field", "roomId must match ^[\\w-]{1,64}$ when present");
  }
  if (
    typeof raw.participantId === "string" &&
    raw.participantId.length > 0 &&
    !ID_PATTERN.test(raw.participantId)
  ) {
    return fail("invalid_field", "participantId must match ^[\\w-]{1,64}$ when present");
  }
  return null;
}

function checkString(v: unknown, name: string, max = MAX_STRING_FIELD): ParseFailure | null {
  if (v === undefined) return null;
  if (typeof v !== "string" || v.length === 0 || v.length > max) {
    return fail("invalid_field", `${name} must be a non-empty string of at most ${max} chars`);
  }
  return null;
}

/**
 * Validate one JSON-parsed client message. Dev-only affordances are gated by
 * message type/flags, not here; the base protocol stays identical either way.
 */
export function parseClientMessage(parsed: unknown): ParsedClientMessage | ParseFailure {
  if (!isRecord(parsed)) return fail("malformed", "message must be a JSON object");
  if (typeof parsed.type !== "string") return fail("malformed", "missing type");
  const envFailure = checkEnvelope(parsed);
  if (envFailure) return envFailure;

  switch (parsed.type as string) {
    case "hello": {
      const v = checkString(parsed.clientVersion, "clientVersion");
      if (v) return v;
      const w = checkString(parsed.wantedRoomId, "wantedRoomId", 64);
      if (w) return w;
      return {
        ok: true,
        message: {
          type: "hello",
          ...(typeof parsed.clientVersion === "string" ? { clientVersion: parsed.clientVersion } : {}),
          ...(typeof parsed.wantedRoomId === "string" ? { wantedRoomId: parsed.wantedRoomId } : {}),
        },
      };
    }
    case "consent_granted":
      return { ok: true, message: { type: "consent_granted" } };
    case "consent_revoked":
      return { ok: true, message: { type: "consent_revoked" } };
    case "start_session": {
      const d = parsed.durationMin;
      if (typeof d !== "number" || !SESSION_DURATIONS.includes(d as SessionMinutes)) {
        return fail("invalid_field", "durationMin must be one of 3, 5, 10");
      }
      if (parsed.mode !== "solo") {
        return fail("invalid_field", 'mode must be "solo" (pair mode arrives in a later phase)');
      }
      if (parsed.guideOnly !== undefined && typeof parsed.guideOnly !== "boolean") {
        return fail("invalid_field", "guideOnly must be a boolean when present");
      }
      return {
        ok: true,
        message: {
          type: "start_session",
          durationMin: d as SessionMinutes,
          mode: "solo",
          ...(parsed.guideOnly === true ? { guideOnly: true } : {}),
        },
      };
    }
    case "stop_session":
      return { ok: true, message: { type: "stop_session" } };
    case "preview_start":
      return { ok: true, message: { type: "preview_start" } };
    case "preview_stop":
      return { ok: true, message: { type: "preview_stop" } };
    case "set_scenario": {
      if (parsed.scenario === undefined) {
        return fail("invalid_field", "scenario is required");
      }
      const s = checkString(parsed.scenario, "scenario", 64);
      if (s) return s;
      return { ok: true, message: { type: "set_scenario", scenario: String(parsed.scenario) } };
    }
    case "ping":
      return { ok: true, message: { type: "ping" } };
    default:
      return fail("unknown_type", `unknown message type: ${String(parsed.type)}`);
  }
}

/** Validate an inbound binary camera frame (before any handler runs). */
export function validateFramePayload(payload: ArrayBuffer): { ok: true; timestampUs: number } | ParseFailure {
  const view = new DataView(payload);
  if (view.byteLength < FRAME_HEADER_BYTES) {
    return fail("malformed", "frame payload too small to hold a timestamp header");
  }
  const us = view.getFloat64(0, true);
  if (!Number.isFinite(us) || us < 0 || !Number.isInteger(us)) {
    return fail("invalid_field", "frame timestamp must be a non-negative integer (monotonic µs)");
  }
  // Empty-pixel frames are malformed by definition.
  if (view.byteLength === FRAME_HEADER_BYTES) {
    return fail("malformed", "frame carries no pixel data");
  }
  return { ok: true, timestampUs: us };
}
