/**
 * Local app server (Phase 2): express serves the static client, `ws` handles
 * the browser connection, and a RoomManager owns rooms/sessions on an
 * injected clock.
 *
 * Responsibilities here are deliberately thin: protocol validation lives in
 * protocol.ts, session wiring in sessionPipeline.ts/rooms.ts. This file adds
 * only transport, connection state, rate limiting, source selection from env,
 * logs and graceful shutdown.
 *
 * Privacy-relevant rules enforced HERE (not left to the client):
 * - camera frames are refused unless that connection granted consent;
 * - consent revocation stops the session and the source immediately;
 * - signal content is never logged (counters only).
 */

import express from "express";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Clock, NormalizedSample } from "../signal/SignalSource.js";
import { FROZEN_DEFAULT_SETTINGS, type Settings } from "../config.js";
import {
  decodeFrameHeader,
  parseClientMessage,
  validateFramePayload,
  TokenBucket,
  type ServerMessage,
} from "./protocol.js";
import { RoomManager, type RoomParticipant, type SourceKind } from "./rooms.js";
import type { ParticipantPipelineEvent } from "./sessionPipeline.js";

/** Monotonic wall clock for production use. */
export class RealClock implements Clock {
  now(): number {
    return performance.now();
  }
}

interface ConnState {
  socket: WebSocket;
  welcomeSent: boolean;
  room?: string;
  participantId?: string;
  controlBucket: TokenBucket;
  frameBucket: TokenBucket;
  consentGranted: boolean;
  framesReceived: number;
}

export type FrameHandler = (info: {
  roomId: string;
  participantId: string;
  timestampUs: number;
  pixels: Uint8Array;
}) => void;

export interface ServerOptions {
  port?: number;
  clock?: Clock;
  settings?: Settings;
  /** Requested signal source kind (mock|sdk). Default "mock". */
  signalSource?: SourceKind;
  /** Dev-only mock scenario switches. Default false. */
  allowDevControls?: boolean;
  /** "interval" (production driver) or "manual" (tests drive tickAll directly). */
  driver?: "interval" | "manual";
  /** Optional camera-frame consumer (Step 6 attaches the SDK bridge). */
  onFrame?: FrameHandler;
  log?: (entry: Record<string, unknown>) => void;
}

export interface RunningServer {
  port: number;
  manager: RoomManager;
  /** Tests push time through this instead of any real interval. */
  tickAll(nowMs: number): void;
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const settings = withPort(opts.settings ?? FROZEN_DEFAULT_SETTINGS, opts.port);
  const clock = opts.clock ?? new RealClock();
  const signalSource: SourceKind = opts.signalSource ?? "mock";
  const manager = new RoomManager({
    clock,
    settings,
    allowDevControls: opts.allowDevControls ?? signalSource === "mock",
  });
  const log = opts.log ?? (() => undefined);

  // -- HTTP surface -------------------------------------------------------
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      uptimeSec: Math.round(performance.now() / 1000),
      rooms: manager.roomCount,
      source: signalSource,
    });
  });
  const publicDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../public",
  );
  app.use(express.static(publicDir));

  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({
    noServer: true,
    // Two-tier size defense: ws itself hard-caps at 2x the app limit (a
    // payload beyond that tears the connection down with 1009 — logged, not
    // crashed), while the app layer rejects anything over the limit with a
    // typed error and keeps serving the connection.
    maxPayload: settings.server.maxMessageBytes * 2,
    perMessageDeflate: false,
  });
  wss.on("error", (err) => log({ event: "ws_error", message: String(err) }));

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  // -- websocket handling --------------------------------------------------
  const connections = new Set<ConnState>();

  const send = (conn: ConnState, msg: ServerMessage): void =>
    wsSend(conn.socket, msg);

  // Participant pipelines created at join time; wire their events here.
  manager.onRoomEvent((e) => {
    if (e.kind !== "participant_added") return;
    const room = manager.getRoom(e.roomId);
    const p = room?.getParticipant(e.participantId);
    if (p) attachPipeline(p);
  });

  function attachPipeline(p: RoomParticipant): void {
    p.pipeline.onEvent((ev: ParticipantPipelineEvent) => {
      const conn = findConn(p.roomId, p.id);
      if (!conn) return; // participant with no live socket: drop quietly
      if (ev.type === "sample") {
        sendSample(conn, ev.sample);
      } else if (ev.type === "pacer_update") {
        send(conn, {
          type: "pacer_update",
          t: ev.t,
          rate: ev.snap.rate,
          ...(ev.snap.pendingRate !== undefined ? { pendingRate: ev.snap.pendingRate } : {}),
          phase: ev.snap.phase,
          phaseProgress: ev.snap.phaseProgress,
          cycles: ev.snap.cyclesCompleted,
        });
      } else if (ev.type === "state_changed") {
        send(conn, { type: "state_changed", t: ev.t, from: ev.from, to: ev.to });
      } else if (ev.type === "notice") {
        send(conn, {
          type: "notice",
          t: ev.t,
          kind: ev.kind,
          text: ev.text,
          level: ev.kind === "unavailable" || ev.kind === "hold" ? "guidance" : "info",
        });
      } else if (ev.type === "source_degraded") {
        send(conn, {
          type: "notice",
          t: ev.t,
          kind: "source_degraded",
          text: "The camera feed paused, so the guide is running on its own. Your pace is not being observed.",
          level: "guidance",
        });
      } else if (ev.type === "source_capped") {
        send(conn, {
          type: "notice",
          t: ev.t,
          kind: "source_capped",
          text: "The daily measurement time for this app is used up. The guide keeps running on its own.",
          level: "guidance",
        });
      } else if (ev.type === "session_ended") {
        send(conn, {
          type: "session_end",
          t: ev.t,
          ...(ev.summary ? { summary: ev.summary as unknown as Record<string, number> } : {}),
          lines: ev.lines,
        });
        log({
          event: "session_ended",
          roomId: p.roomId,
          participantId: p.id,
          natural: ev.natural,
        });
      }
    });
  }

  function findConn(roomId: string, participantId: string): ConnState | undefined {
    for (const c of connections) {
      if (c.room === roomId && c.participantId === participantId) return c;
    }
    return undefined;
  }

  function sendSample(conn: ConnState, s: NormalizedSample): void {
    send(conn, {
      type: "sample",
      sample: {
        t: s.t,
        ...(s.breathingRate !== undefined ? { breathingRate: s.breathingRate } : {}),
        confidence: s.confidence,
        status: s.status,
      },
    });
  }

  wss.on("connection", (socket: WebSocket) => {
    const conn: ConnState = {
      socket,
      welcomeSent: false,
      controlBucket: new TokenBucket(
        settings.server.controlBurst,
        settings.server.controlRatePerSec,
      ),
      frameBucket: new TokenBucket(
        settings.server.frameBurst,
        settings.server.frameRatePerSec,
      ),
      consentGranted: false,
      framesReceived: 0,
    };
    connections.add(conn);

    socket.on("message", (data: RawData, isBinary: boolean) => {
      const now = clock.now();
      if (isBinary) {
        handleBinaryFrame(conn, data, now);
        return;
      }
      handleClientText(conn, data, now);
    });

    socket.on("close", () => {
      if (conn.room && conn.participantId) {
        manager.removeParticipant(conn.room, conn.participantId);
        log({
          event: "disconnected",
          roomId: conn.room,
          participantId: conn.participantId,
        });
      }
      connections.delete(conn);
    });
  });

  function handleClientText(conn: ConnState, data: RawData, now: number): void {
    const text = data.toString("utf8");
    const oversized = Buffer.byteLength(text, "utf8") > settings.server.maxMessageBytes;
    if (oversized || !conn.controlBucket.trySpend(now)) {
      send(conn, {
        type: "error",
        code: oversized ? "oversize" : "rate_limited",
        message: oversized ? "Message too large." : "Too many messages; dropping.",
      });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      send(conn, { type: "error", code: "malformed_json", message: "Not valid JSON." });
      return;
    }
    handleClientMessage(conn, parsed, now);
  }

  function handleClientMessage(conn: ConnState, parsed: unknown, now: number): void {
    const result = parseClientMessage(parsed);
    if (!result.ok) {
      send(conn, { type: "error", code: result.code, message: result.message });
      return;
    }
    const msg = result.message;
    const participant = conn.participantId
      ? manager.getRoom(conn.room ?? "")?.getParticipant(conn.participantId)
      : undefined;

    if (!conn.welcomeSent && msg.type !== "hello" && msg.type !== "ping") {
      send(conn, {
        type: "error",
        code: "hello_first",
        message: "Send hello before anything else.",
      });
      return;
    }

    switch (msg.type) {
      case "hello": {
        if (conn.welcomeSent) {
          send(conn, {
            type: "error",
            code: "already_helloed",
            message: "hello already sent.",
          });
          return;
        }
        const joined = manager.join(
          msg.wantedRoomId ? { wantedRoomId: msg.wantedRoomId } : {},
        );
        conn.room = joined.roomId;
        conn.participantId = joined.participantId;
        conn.welcomeSent = true;
        send(conn, {
          type: "welcome",
          roomId: joined.roomId,
          participantId: joined.participantId,
          signalSource,
          devControls: manager.devControlsAllowed,
        });
        log({
          event: "connected",
          roomId: joined.roomId,
          participantId: joined.participantId,
          source: signalSource,
        });
        break;
      }

      case "consent_granted": {
        participant?.setConsent(true);
        conn.consentGranted = true;
        break;
      }

      case "consent_revoked": {
        conn.consentGranted = false;
        participant?.setConsent(false);
        participant?.stopSession();
        send(conn, {
          type: "notice",
          t: now,
          kind: "consent_revoked",
          text: "Consent removed — the session is closed and nothing further is observed.",
          level: "info",
        });
        break;
      }

      case "start_session": {
        if (!participant) return;
        if (msg.guideOnly) {
          const started = participant.startGuideOnlySession(msg.durationMin);
          if (!started.ok) {
            send(conn, {
              type: "error",
              code: "start_refused",
              message: started.error,
            });
          }
          break;
        }
        const started = participant.startSession(msg.durationMin);
        if (!started.ok) {
          send(conn, {
            type: "error",
            code: "start_refused",
            message: started.error,
          });
          break;
        }
        if (started.note) {
          send(conn, {
            type: "notice",
            t: now,
            kind: "source_fallback",
            text: started.note,
            level: "info",
          });
        }
        break;
      }

      case "stop_session": {
        participant?.stopSession();
        break;
      }

      case "preview_start": {
        if (!participant) return;
        const started = participant.startPreview();
        if (!started.ok) {
          send(conn, {
            type: "error",
            code: "preview_refused",
            message: started.error,
          });
          break;
        }
        if (started.note) {
          send(conn, {
            type: "notice",
            t: now,
            kind: "source_fallback",
            text: started.note,
            level: "info",
          });
        }
        break;
      }

      case "preview_stop": {
        participant?.stopPreview();
        break;
      }

      case "set_scenario": {
        if (!participant) return;
        const err = participant.setDevScenario(
          msg.scenario,
          manager.devControlsAllowed,
        );
        if (err) {
          send(conn, { type: "error", code: "dev_controls_off", message: err });
        }
        break;
      }

      case "ping":
        send(conn, { type: "pong" });
        break;
    }
  }

  function handleBinaryFrame(conn: ConnState, data: RawData, now: number): void {
    if (!conn.frameBucket.trySpend(now)) return; // silently throttled
    if (!conn.consentGranted || !conn.room || !conn.participantId) {
      send(conn, {
        type: "error",
        code: "consent_required",
        message: "Camera data arrives only after consent; frames dropped.",
      });
      return;
    }
    const buf = toArrayBuffer(data);
    const check = validateFramePayload(buf);
    if (!check.ok) {
      send(conn, { type: "error", code: check.code, message: check.message });
      return;
    }
    conn.framesReceived++;
    const { timestampUs, pixels } = decodeFrameHeader(buf);
    (opts.onFrame ?? (signalSource === "sdk" ? frameRouter : undefined))?.({
      roomId: conn.room,
      participantId: conn.participantId,
      timestampUs,
      pixels,
    });
    // In mock mode frames are counted but not consumed: the mock is the
    // source of truth by design. Step 6 attaches the SDK bridge here.
  }

  // -- driver + lifecycle ---------------------------------------------------
  // Camera frames (SDK mode): route each binary frame to the owning
  // participant's pipeline, which forwards it to the SDK source.
  const frameRouter: FrameHandler = (info) => {
    manager
      .getRoom(info.roomId)
      ?.getParticipant(info.participantId)
      ?.pipeline.pushFrame(info.timestampUs, info.pixels);
  };

  let driverInterval: NodeJS.Timeout | undefined;
  if ((opts.driver ?? "interval") === "interval") {
    const stepMs = Math.round(1000 / settings.server.pacerUpdateHz);
    driverInterval = setInterval(() => manager.tickAll(clock.now()), stepMs);
    driverInterval.unref();
  }

  const port = settings.server.port;
  await new Promise<void>((resolve) => httpServer.listen(port, () => resolve()));
  const addr = httpServer.address();
  // Port 0 (ephemeral) is used by tests; report the real bound port.
  const boundPort =
    addr && typeof addr === "object" && "port" in addr ? (addr.port as number) : port;

  async function close(): Promise<void> {
    if (driverInterval) clearInterval(driverInterval);
    manager.shutdownAll();
    for (const c of connections) {
      c.socket.close(1001, "server shutting down");
      c.socket.terminate();
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    httpServer.closeAllConnections?.();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }

  return {
    port: boundPort,
    manager,
    tickAll: (nowMs: number) => manager.tickAll(nowMs),
    close,
  };
}

// -- helpers ----------------------------------------------------------------

function withPort(base: Settings, port?: number): Settings {
  const chose = port ?? readPortFromEnv() ?? base.server.port;
  return { ...base, server: { ...base.server, port: chose } };
}

function readPortFromEnv(): number | undefined {
  const raw = process.env.PORT;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
}

function wsSend(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

function toArrayBuffer(data: RawData): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  if (Array.isArray(data)) return Buffer.concat(data).buffer as ArrayBuffer;
  const buf = data as Buffer;
  const out = new ArrayBuffer(buf.byteLength);
  new Uint8Array(out).set(buf);
  return out;
}

// -- CLI entrypoint (npm run serve) -----------------------------------------

export function main(): void {
  const sourceKind: SourceKind = process.env.SIGNAL_SOURCE === "sdk" ? "sdk" : "mock";
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const log = (entry: Record<string, unknown>): void => {
    // Structured logs: counters and ids only — never signal content or frames.
    process.stdout.write(`${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`);
  };
  if (sourceKind === "sdk" && !process.env.SMARTSPECTRA_API_KEY) {
    // Fail fast with a clear message instead of starting a server that could
    // never measure anything (auth is constructor-injected; see SDK_NOTES §3).
    log({
      event: "startup_failed",
      message:
        "SIGNAL_SOURCE=sdk requires SMARTSPECTRA_API_KEY in the environment (copy .env.example to .env).",
    });
    process.exit(1);
  }
  startServer({
    signalSource: sourceKind,
    allowDevControls: nodeEnv !== "production" && sourceKind === "mock",
    log,
  })
    .then((srv) => {
      log({ event: "listening", port: srv.port, source: sourceKind });
      const stop = (): void => {
        log({ event: "shutdown_begin" });
        srv
          .close()
          .then(() => {
            log({ event: "shutdown_complete" });
            process.exit(0);
          })
          .catch(() => process.exit(0));
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    })
    .catch((err: unknown) => {
      log({ event: "startup_failed", message: String(err) });
      process.exit(1);
    });
}

// Only run as CLI when invoked directly (not under the test runner imports).
if (process.argv[1]?.replaceAll("\\", "/").endsWith("src/server/index.ts")) {
  main();
}
