/**
 * SmartSpectra SDK worker — runs in ITS OWN process (native SDK state is
 * process-global; see docs/SDK_NOTES.md §9). The parent (`sdkSource.ts`)
 * forks this file and exchanges typed messages; this file is the only place
 * that imports `@smartspectra/node-sdk`.
 *
 * Messages:
 * - parent -> worker:  {type:"init", apiKey, frameWidth, frameHeight}
 *                       {type:"frame", timestampUs, pixels: Buffer}
 *                       {type:"shutdown"}
 * - worker -> parent:  {type:"ready"}
 *                       {type:"sample", breathingRate, confidence, status}
 *                       {type:"status", status, hint}   (validation changes)
 *                       {type:"error", code, message, retryable}
 *                       {type:"stopped"}
 *
 * Samples are stamped with the PARENT's clock (sdkSource assigns `t` on
 * receipt) because `performance.now()` origins differ between processes.
 *
 * Test seam: `createSdkWorker` takes the SDK module + decoder as deps, so
 * tests inject `fakeSdk.ts` without touching the real SDK. The `main()`
 * entry (below) loads the real packages — or the fake when `BT_FAKE_SDK=1`,
 * which is how the IPC integration test runs without an API key.
 */

import {
  metricsToSample,
  validationCodeToStatus,
  type DecodedMetrics,
} from "./sdkMapping.js";
import type { SignalStatus } from "./SignalSource.js";

// -- dependency shapes (structural subset of @smartspectra/node-sdk) --------

export interface SdkLike {
  new (options: Record<string, unknown>): SdkInstanceLike;
}

export interface SdkInstanceLike {
  on(event: string, cb: (...args: never[]) => void): unknown;
  useCustomInput(transform?: number): unknown;
  start(): void;
  sendFrame(
    buffer: Uint8Array,
    width: number,
    height: number,
    stride: number,
    pixelFormat: number,
    timestampUs: number,
  ): boolean;
  /** Rebuild the pipeline after kProcessingFailed / kError (docs lifecycle). */
  reset?(): void;
  stopAsync(): Promise<void>;
  destroy(): Promise<void>;
}

export interface SdkModuleLike {
  SmartSpectraSDK: SdkLike;
  FrameTransform: { kNone: number };
  PixelFormat: { kRGBA: number };
  breathingMetrics: number[];
  SmartSpectraLogLevel: { kWarning: number };
}

export type WorkerOutMessage =
  | { type: "ready" }
  | { type: "sample"; breathingRate: number; confidence: number; status: SignalStatus }
  | { type: "status"; status: SignalStatus; hint: string }
  | { type: "error"; code: string; message: string; retryable: boolean }
  | { type: "stopped" };

export type WorkerInMessage =
  | { type: "init"; apiKey: string; frameWidth: number; frameHeight: number }
  | { type: "frame"; timestampUs: number; pixels: Uint8Array }
  | { type: "shutdown" };

export interface WorkerDeps {
  sdk: SdkModuleLike;
  decode: (buf: Buffer) => DecodedMetrics;
  /** Sink for outbound messages (process.send in production). */
  send: (msg: WorkerOutMessage) => void;
  /** Optional line logger (stderr in production; silent in tests). */
  log?: (line: string) => void;
}

export interface SdkWorkerHandle {
  handleMessage(msg: WorkerInMessage): void;
  /** For tests: current mapped status. */
  readonly status: SignalStatus;
}

export function createSdkWorker(deps: WorkerDeps): SdkWorkerHandle {
  let sdk: SdkInstanceLike | undefined;
  let frameWidth = 0;
  let frameHeight = 0;
  let status: SignalStatus = "starting";
  let shuttingDown = false;
  // After kProcessingFailed the engine refuses frames ("not in a valid
  // state for this operation") until reset(). Frames are dropped meanwhile;
  // the supervisor's silence-restart is the slower backstop.
  let broken = false;
  let recovering = false;

  function fail(code: string, message: string, retryable: boolean): void {
    deps.send({ type: "error", code, message, retryable });
  }

  /** Rebuild the SDK pipeline after kProcessingFailed (docs lifecycle). */
  function recover(): void {
    if (recovering || shuttingDown) return;
    broken = true;
    recovering = true;
    void (async () => {
      try {
        sdk?.reset?.();
        sdk?.useCustomInput(deps.sdk.FrameTransform.kNone);
        sdk?.start();
        deps.log?.("SDK pipeline rebuilt after processing failure.");
      } catch (err) {
        deps.log?.(`SDK rebuild failed: ${String(err)}`);
      } finally {
        broken = false;
        recovering = false;
      }
    })();
  }

  const worker: SdkWorkerHandle = {
    get status() {
      return status;
    },
    handleMessage(msg: WorkerInMessage): void {
      if (msg.type === "init") {
        if (!msg.apiKey) {
          fail(
            "missing_api_key",
            "SMARTSPECTRA_API_KEY is required for the SDK source. Set it in the environment (see .env.example).",
            false,
          );
          return;
        }
        frameWidth = msg.frameWidth;
        frameHeight = msg.frameHeight;
        try {
          sdk = new deps.sdk.SmartSpectraSDK({
            apiKey: msg.apiKey,
            requestedMetrics: deps.sdk.breathingMetrics,
            // Aggregate telemetry defaults ON in the SDK; our consent copy
            // (docs/CONSENT_AND_DATA.md §5) promises it is off here.
            enableTelemetry: false,
            logLevel: deps.sdk.SmartSpectraLogLevel.kWarning,
          });
          sdk.useCustomInput(deps.sdk.FrameTransform.kNone);
          wireEvents(sdk);
          sdk.start();
          deps.send({ type: "ready" });
        } catch (err) {
          fail("start_failed", `SDK failed to start: ${String(err)}`, true);
        }
        return;
      }
      if (msg.type === "frame") {
        if (!sdk || shuttingDown || broken || recovering) return;
        const expected = frameWidth * frameHeight * 4;
        if (msg.pixels.length !== expected) return; // wrong geometry: drop, don't guess
        try {
          sdk.sendFrame(
            msg.pixels,
            frameWidth,
            frameHeight,
            frameWidth * 4,
            deps.sdk.PixelFormat.kRGBA,
            msg.timestampUs,
          );
        } catch (err) {
          // Engine in an error state refuses frames; a kProcessingFailed
          // event normally arrives alongside and starts recovery too.
          deps.log?.(`sendFrame refused (engine error state): ${String(err)}`);
          recover();
        }
        return;
      }
      if (msg.type === "shutdown") {
        shuttingDown = true;
        void (async () => {
          try {
            await sdk?.stopAsync();
            await sdk?.destroy();
          } catch {
            // Shutdown is best-effort; the parent kills us if we linger.
          }
          deps.send({ type: "stopped" });
        })();
      }
    },
  };

  function wireEvents(instance: SdkInstanceLike): void {
    instance.on("validationStatus", (code: number, _tsUs: number, hint: string) => {
      const mapped = validationCodeToStatus(code);
      if (mapped !== undefined) {
        status = mapped;
        deps.send({ type: "status", status: mapped, hint: String(hint ?? "") });
      }
    });
    instance.on("processingStatus", (p: number) => {
      if (p === 2) status = "starting"; // kStarting
    });
    instance.on("metrics", (buf: Buffer) => {
      let decoded: DecodedMetrics;
      try {
        decoded = deps.decode(buf);
      } catch (err) {
        fail("decode_failed", `Could not decode metrics: ${String(err)}`, true);
        return;
      }
      const sample = metricsToSample(decoded, status, 0);
      if (sample && sample.breathingRate !== undefined) {
        deps.send({
          type: "sample",
          breathingRate: sample.breathingRate,
          confidence: sample.confidence,
          status: sample.status,
        });
      }
    });
    instance.on("error", (code: number, message: string, retryable: boolean) => {
      fail(`sdk_error_${code}`, `SDK error code ${code}: ${message}`, retryable);
      // kProcessingFailed (8): the pipeline is wedged — reset() rebuilds it,
      // the input source must be re-selected, then start() again (docs
      // lifecycle). Runs once per burst; frames drop while recovering.
      if (code === 8) recover();
    });
  }

  return worker;
}

// -- production main (only when forked) --------------------------------------

export async function main(): Promise<void> {
  const send = (msg: WorkerOutMessage): void => {
    process.send?.(msg);
  };
  const log = (line: string): void => {
    process.stderr.write(`[sdk-worker] ${line}\n`);
  };

  let sdkModule: SdkModuleLike;
  let decode: (buf: Buffer) => DecodedMetrics;
  if (process.env.BT_FAKE_SDK === "1") {
    const fake = await import("./fakeSdk.js");
    const { FAKE_METRICS_EMPTY, FAKE_METRICS_OK } = fake;
    sdkModule = fake.FakeSmartSpectra as unknown as SdkModuleLike;
    decode = (buf: Buffer) => {
      const token = buf.toString("utf8");
      if (token === FAKE_METRICS_OK) {
        return { breathing: { rate: [{ value: 12, confidence: 90 }] } };
      }
      if (token === FAKE_METRICS_EMPTY) {
        return { breathing: { rate: [] } };
      }
      return {};
    };
  } else {
    const sdkPkg = (await import("@smartspectra/node-sdk")) as unknown as SdkModuleLike;
    const { decodeMetrics } = (await import(
      "@smartspectra/node-sdk/messages"
    )) as { decodeMetrics: (buf: Buffer) => DecodedMetrics };
    sdkModule = sdkPkg;
    decode = (buf: Buffer) => decodeMetrics(buf);
  }

  const worker = createSdkWorker({ sdk: sdkModule, decode, send, log });
  process.on("message", (raw: unknown) => {
    const msg = raw as WorkerInMessage;
    worker.handleMessage(msg);
    if (msg.type === "shutdown") {
      // Exit once the stopped ack is flushed.
      setTimeout(() => process.exit(0), 250).unref();
    }
  });
  process.on("disconnect", () => {
    process.exit(0);
  });
}

const invokedAsMain =
  typeof process !== "undefined" &&
  typeof process.argv?.[1] === "string" &&
  process.argv[1].replaceAll("\\", "/").endsWith("src/signal/sdkWorker.ts");
if (invokedAsMain && typeof process.send === "function") {
  void main();
}
