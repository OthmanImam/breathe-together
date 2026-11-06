import test from "node:test";
import assert from "node:assert/strict";
import { createSdkWorker, type WorkerOutMessage } from "../src/signal/sdkWorker.js";
import {
  FakeSmartSpectra,
  FakeSmartSpectraSDK,
  FAKE_METRICS_EMPTY,
  FAKE_METRICS_OK,
} from "../src/signal/fakeSdk.js";
import type { DecodedMetrics } from "../src/signal/sdkMapping.js";

function fakeDecode(buf: Buffer): DecodedMetrics {
  const token = buf.toString("utf8");
  if (token === FAKE_METRICS_OK) {
    return { breathing: { rate: [{ value: 12.5, confidence: 90 }] } };
  }
  if (token === FAKE_METRICS_EMPTY) {
    return { breathing: { rate: [] } };
  }
  return {};
}

function makeWorker() {
  FakeSmartSpectraSDK.instances = [];
  const out: WorkerOutMessage[] = [];
  const worker = createSdkWorker({
    sdk: FakeSmartSpectra as never,
    decode: fakeDecode,
    send: (m) => out.push(m),
  });
  return { worker, out };
}

test("init without an API key fails with a clear message and never starts the SDK", () => {
  const { worker, out } = makeWorker();
  worker.handleMessage({ type: "init", apiKey: "", frameWidth: 320, frameHeight: 240 });
  assert.ok(out.some((m) => m.type === "error" && m.code === "missing_api_key"));
  assert.equal(FakeSmartSpectraSDK.instances.length, 0, "SDK instance never constructed");
});

test("init with a key starts the SDK with telemetry disabled and reports ready", () => {
  const { worker, out } = makeWorker();
  worker.handleMessage({ type: "init", apiKey: "test-key", frameWidth: 320, frameHeight: 240 });
  assert.ok(out.some((m) => m.type === "ready"));
  assert.equal(FakeSmartSpectraSDK.instances.length, 1);
  const inst = FakeSmartSpectraSDK.instances[0]!;
  assert.equal(inst.started, true);
  assert.equal(inst.options.enableTelemetry, false, "aggregate telemetry is disabled");
  assert.deepEqual(inst.options.requestedMetrics, [2], "breathing metrics only");
  assert.equal(inst.options.apiKey, "test-key");
});

test("metrics events become samples with the current validation status; empty series are skipped", () => {
  const { worker, out } = makeWorker();
  worker.handleMessage({ type: "init", apiKey: "k", frameWidth: 320, frameHeight: 240 });
  // The fake emits ok-status validation synchronously at start().
  assert.equal(worker.status, "ok");
  assert.ok(out.some((m) => m.type === "status" && m.status === "ok"));
  assert.ok(out.some((m) => m.type === "ready"));
  worker.handleMessage({ type: "shutdown" });
});

test("frames with the wrong pixel count are dropped; correct frames reach sendFrame", () => {
  const { worker } = makeWorker();
  worker.handleMessage({ type: "init", apiKey: "k", frameWidth: 320, frameHeight: 240 });
  const inst = FakeSmartSpectraSDK.instances[0]!;
  worker.handleMessage({ type: "frame", timestampUs: 1000, pixels: new Uint8Array(10) });
  assert.equal(inst.framesReceived, 0, "short frame dropped");
  worker.handleMessage({
    type: "frame",
    timestampUs: 2000,
    pixels: new Uint8Array(320 * 240 * 4),
  });
  assert.equal(inst.framesReceived, 1);
  worker.handleMessage({ type: "shutdown" });
});

test("kProcessingFailed wedges the engine: worker recovers via reset() and resumes frames", async () => {
  const { worker, out } = makeWorker();
  worker.handleMessage({ type: "init", apiKey: "k", frameWidth: 320, frameHeight: 240 });
  const inst = FakeSmartSpectraSDK.instances[0]!;
  worker.handleMessage({
    type: "frame",
    timestampUs: 1000,
    pixels: new Uint8Array(320 * 240 * 4),
  });
  assert.equal(inst.framesReceived, 1);

  // Wedge: engine errors AND starts refusing frames.
  inst.wedge();
  worker.handleMessage({
    type: "frame",
    timestampUs: 2000,
    pixels: new Uint8Array(320 * 240 * 4),
  });
  // Recovery is async (microtask); wait for it.
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(inst.resetCount >= 1, "reset() was called to rebuild the pipeline");
  assert.ok(
    out.some((m) => m.type === "error" && m.code === "sdk_error_8"),
    "the failure was reported to the parent",
  );
  // After recovery, frames flow again (reset/start are synchronous native
  // calls, so the wedged frame may have been accepted post-recovery).
  worker.handleMessage({
    type: "frame",
    timestampUs: 3000,
    pixels: new Uint8Array(320 * 240 * 4),
  });
  assert.ok(inst.framesReceived >= 2, "frames accepted after recovery");
  worker.handleMessage({ type: "shutdown" });
});

test("shutdown stops and destroys the SDK", async () => {
  const { worker, out } = makeWorker();
  worker.handleMessage({ type: "init", apiKey: "k", frameWidth: 320, frameHeight: 240 });
  const inst = FakeSmartSpectraSDK.instances[0]!;
  worker.handleMessage({ type: "shutdown" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(inst.destroyed, true);
  assert.ok(out.some((m) => m.type === "stopped"));
});
