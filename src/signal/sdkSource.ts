/**
 * Real SmartSpectra-backed SignalSource (parent-process side).
 *
 * Owns no native state itself: it forks `sdkWorker.ts` (the only process
 * that imports the SDK) and relays:
 * - browser camera frames (pushed via `pushFrame`, fed from WS binary
 *   messages by the server) -> worker -> `sendFrame()`;
 * - decoded metric samples + validation statuses <- worker -> normalized
 *   samples for the coach, stamped on the parent's monotonic clock.
 *
 * Economical with credits and privacy-sensitive by construction:
 * - The worker is spawned ONLY by `start()` (a session or smoke run) and
 *   killed by `stop()`; nothing auto-starts on page load, and consent
 *   revocation / session end stops it immediately (via pipeline stop).
 * - A configurable daily budget (usage file) stops the SDK from starting
 *   once reached, with `onCapReached` so the UI can say so plainly.
 * - Telemetry is disabled inside the worker (`enableTelemetry: false`).
 *
 * Failure behavior: an auth failure or a worker crash is NOT disguised as
 * data. The source goes silent; the supervisor (rooms.ts) restarts it with
 * backoff and eventually degrades to guide-only with an honest notice.
 */

import { fork, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type {
  Clock,
  RawSample,
  SampleListener,
  SignalSource,
} from "./SignalSource.js";
import type { SdkSettings } from "../config.js";
import type { WorkerOutMessage } from "./sdkWorker.js";

export interface SdkSourceDeps {
  clock: Clock;
  settings: SdkSettings;
  /** From SMARTSPECTRA_API_KEY (server env). Never logged. */
  apiKey: string;
  /** Fired once when the daily budget blocks a start. */
  onCapReached?: () => void;
  log?: (line: string) => void;
}

interface UsageRecord {
  date: string;
  seconds: number;
}

export class SdkSource implements SignalSource {
  /** Set by the pipeline's wireSource (like SupervisedSource.onDegraded). */
  onCapReached: (() => void) | undefined;

  private readonly clock: Clock;
  private readonly cfg: SdkSettings;
  private readonly apiKey: string;
  private readonly log: (line: string) => void;

  private child: ChildProcess | undefined;
  private readonly listeners: SampleListener[] = [];
  private running = false;
  private startedAtMs = 0;

  constructor(deps: SdkSourceDeps) {
    this.clock = deps.clock;
    this.cfg = deps.settings;
    this.apiKey = deps.apiKey;
    this.log = deps.log ?? (() => undefined);
    this.onCapReached = deps.onCapReached;
  }

  start(): void {
    if (this.running) return;
    if (!this.apiKey) {
      // Fail loud in logs; silence (no samples) drives the honest degrade path.
      this.log("SMARTSPECTRA_API_KEY missing: SDK source cannot start.");
      return;
    }
    if (this.overDailyCap()) {
      this.onCapReached?.();
      return;
    }
    this.running = true;
    this.startedAtMs = this.clock.now();
    this.spawn();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.recordUsage();
    this.shutdownChild();
  }

  onSample(cb: SampleListener): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Frame sink (see FunctionalCore note in rooms.ts): called by the server. */
  pushFrame(timestampUs: number, pixels: Uint8Array): void {
    if (!this.running || !this.child) return;
    if (pixels.length !== this.cfg.frameWidth * this.cfg.frameHeight * 4) return;
    this.child.send({ type: "frame", timestampUs, pixels: Buffer.from(pixels) });
  }

  // ---- internals ---------------------------------------------------------

  private spawn(): void {
    const workerPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "sdkWorker.ts",
    );
    const child = fork(workerPath, [], {
      execPath: process.execPath,
      execArgv: ["--import", "tsx"],
      serialization: "advanced",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.child = child;
    child.stdout?.on("data", (d: Buffer) => this.log(`[sdk] ${d.toString().trim()}`));
    child.stderr?.on("data", (d: Buffer) => this.log(`[sdk-err] ${d.toString().trim()}`));
    child.on("message", (raw: unknown) => this.onWorkerMessage(raw as WorkerOutMessage));
    child.on("exit", (code, signal) => {
      if (this.child === child) {
        this.child = undefined;
        if (this.running) {
          this.log(`SDK worker exited (code=${code} signal=${signal}); supervisor will restart it.`);
        }
      }
    });
    child.send({
      type: "init",
      apiKey: this.apiKey,
      frameWidth: this.cfg.frameWidth,
      frameHeight: this.cfg.frameHeight,
    });
  }

  private onWorkerMessage(msg: WorkerOutMessage): void {
    if (msg.type === "sample") {
      const sample: RawSample = {
        t: this.clock.now(),
        breathingRate: msg.breathingRate,
        confidence: msg.confidence,
        status: msg.status,
      };
      for (const cb of this.listeners) cb(sample);
    } else if (msg.type === "error") {
      this.log(`SDK worker error ${msg.code}: ${msg.message}`);
      if (
        msg.code === "missing_api_key" ||
        msg.code.startsWith("sdk_error_2") || // kAuthenticationFailed
        msg.code.startsWith("sdk_error_4") // kCreditExhausted
      ) {
        // Fatal for this key: stop the child so supervision degrades fast
        // instead of respawning a doomed worker.
        this.shutdownChild();
      }
    }
    // "ready" / "status" / "stopped" need no parent-side action here.
  }

  private shutdownChild(): void {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    try {
      child.send({ type: "shutdown" });
    } catch {
      // Child may already be gone.
    }
    // Give the worker a moment to stopAsync/destroy, then force it.
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already exited.
      }
    }, 1_500).unref();
  }

  // ---- daily budget -------------------------------------------------------

  private overDailyCap(): boolean {
    const rec = this.readUsage();
    return rec.seconds >= this.cfg.dailyCapMinutes * 60;
  }

  private recordUsage(): void {
    const elapsedSec = Math.max(0, (this.clock.now() - this.startedAtMs) / 1000);
    if (elapsedSec <= 0) return;
    const rec = this.readUsage();
    rec.seconds += elapsedSec;
    try {
      writeFileSync(this.cfg.usageFile, JSON.stringify(rec), "utf8");
    } catch {
      // Best-effort: a read-only disk must not break sessions.
    }
  }

  private readUsage(): UsageRecord {
    const today = new Date().toISOString().slice(0, 10);
    try {
      const raw = readFileSync(this.cfg.usageFile, "utf8");
      const parsed = JSON.parse(raw) as UsageRecord;
      if (parsed.date === today && typeof parsed.seconds === "number") return parsed;
    } catch {
      // No file / unreadable / corrupt: start fresh.
    }
    return { date: today, seconds: 0 };
  }
}
