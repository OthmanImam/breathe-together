/**
 * `npm run smoke:sdk` — exercise the real SDK path for ~30 s and print what
 * comes back (samples and statuses only — never images).
 *
 * What it verifies, in order:
 * 1. The native package loads and camera discovery works.
 * 2. With an API key: a short custom-input session on synthetic frames
 *    (solid mid-gray — the engine will report `no_face`, which still proves
 *    frames-in / validation-out works end to end). Any breathing-rate samples
 *    that arrive are printed.
 *
 * Without a key it stops after step 1 with a clear message — that portion is
 * the only part verifiable without an account, and it is exactly the part
 * that crashes most often (native load failures).
 *
 * Usage: SMARTSPECTRA_API_KEY=... npm run smoke:sdk
 */

import type { RawSample, SignalStatus } from "./SignalSource.js";

const DURATION_MS = 30_000;
const FRAME_W = 320;
const FRAME_H = 240;
const FRAME_INTERVAL_MS = 100; // 10 fps synthetic feed

async function main(): Promise<void> {
  console.log("[smoke] loading @smartspectra/node-sdk …");
  const sdkPkg = (await import("@smartspectra/node-sdk")) as unknown as {
    SmartSpectraSDK: {
      new (options: Record<string, unknown>): {
        on(event: string, cb: (...args: never[]) => void): unknown;
        useCustomInput(t: number): unknown;
        start(): void;
        sendFrame(b: Uint8Array, w: number, h: number, s: number, f: number, ts: number): boolean;
        stopAsync(): Promise<void>;
        destroy(): Promise<void>;
      };
      version: string;
      availableCameras(): Array<{ id: string; name: string | null }>;
    };
    PixelFormat: { kRGBA: number };
    FrameTransform: { kNone: number };
    breathingMetrics: number[];
  };
  console.log(`[smoke] SDK version: ${sdkPkg.SmartSpectraSDK.version}`);
  const cameras = sdkPkg.SmartSpectraSDK.availableCameras();
  console.log(`[smoke] cameras discovered: ${cameras.length}`);
  for (const c of cameras) console.log(`[smoke]   - ${c.name ?? "(unnamed)"}`);

  const apiKey = process.env.SMARTSPECTRA_API_KEY ?? "";
  if (!apiKey) {
    console.log(
      "[smoke] SMARTSPECTRA_API_KEY not set. Native load + discovery OK; " +
        "set the key to run the 30 s session portion.",
    );
    return;
  }

  const { decodeMetrics } = (await import(
    "@smartspectra/node-sdk/messages"
  )) as {
    decodeMetrics: (buf: Buffer) => {
      breathing?: { rate?: Array<{ value?: number; confidence?: number }> | null } | null;
    };
  };
  const { metricsToSample, validationCodeToStatus } = await import("./sdkMapping.js");

  console.log("[smoke] starting 30 s custom-input session on synthetic frames …");
  const sdk = new sdkPkg.SmartSpectraSDK({
    apiKey,
    requestedMetrics: sdkPkg.breathingMetrics,
    enableTelemetry: false,
  });
  sdk.useCustomInput(sdkPkg.FrameTransform.kNone);

  let status: SignalStatus = "starting";
  let samples = 0;
  let lastPrintedStatus = "";
  sdk.on("validationStatus", (code: number, _ts: number, hint: string) => {
    const mapped = validationCodeToStatus(code);
    if (mapped) status = mapped;
    const label = `${code}:${mapped ?? "?"}`;
    if (label !== lastPrintedStatus) {
      lastPrintedStatus = label;
      console.log(`[smoke] validation code=${code} status=${mapped ?? "unknown"} hint=${hint}`);
    }
  });
  sdk.on("metrics", (buf: Buffer) => {
    const decoded = decodeMetrics(buf);
    const sample: RawSample | undefined = metricsToSample(decoded, status, Date.now());
    if (sample) {
      samples++;
      console.log(
        `[smoke] sample #${samples}: rate=${sample.breathingRate} bpm confidence=${sample.confidence} status=${sample.status}`,
      );
    }
  });
  sdk.on("error", (code: number, message: string, retryable: boolean) => {
    console.log(`[smoke] SDK error code=${code} retryable=${retryable}: ${message}`);
  });
  sdk.start();

  const gray = new Uint8Array(FRAME_W * FRAME_H * 4).fill(128);
  const t0 = Date.now();
  const timer = setInterval(() => {
    const tsUs = Math.round((Date.now() - t0) * 1000);
    sdk.sendFrame(gray, FRAME_W, FRAME_H, FRAME_W * 4, sdkPkg.PixelFormat.kRGBA, tsUs);
  }, FRAME_INTERVAL_MS);

  await new Promise((r) => setTimeout(r, DURATION_MS));
  clearInterval(timer);
  await sdk.stopAsync();
  await sdk.destroy();
  console.log(
    `[smoke] done. samples=${samples} lastStatus=${status}. ` +
      "(Synthetic gray frames are expected to yield no face / no rate; " +
      "a real face in front of a real camera is the remaining manual check.)",
  );
}

main().catch((err: unknown) => {
  console.error(`[smoke] failed: ${String(err)}`);
  process.exit(1);
});
