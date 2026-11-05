import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { SdkSource } from "../src/signal/sdkSource.js";
import { SimClock } from "../src/sim/harness.js";
import { FROZEN_DEFAULT_SETTINGS, patchSettings } from "../src/config.js";

function settings() {
  return patchSettings(FROZEN_DEFAULT_SETTINGS, {
    sdk: { usageFile: ".bt-usage-test.json", dailyCapMinutes: 60 },
  }).sdk;
}

test("sdkSource drives the real worker process end to end (fake SDK via env)", async () => {
  process.env.BT_FAKE_SDK = "1";
  const clock = new SimClock();
  const source = new SdkSource({
    clock,
    settings: settings(),
    apiKey: "fake-key",
  });
  const samples: Array<{ rate: number; confidence: number; status: string }> = [];
  source.onSample((s) => {
    if (s.breathingRate !== undefined) {
      samples.push({
        rate: s.breathingRate,
        confidence: s.confidence,
        status: s.status,
      });
    }
  });
  source.start();
  // Push frames (the fake counts them; samples come from its metrics timer).
  const pixels = new Uint8Array(320 * 240 * 4);
  for (let i = 0; i < 5; i++) source.pushFrame(i * 100_000, pixels);
  await new Promise((r) => setTimeout(r, 1200));
  source.stop();
  assert.ok(samples.length >= 2, `samples arrived over IPC (${samples.length})`);
  assert.equal(samples[0]!.rate, 12);
  assert.equal(samples[0]!.status, "ok");
  assert.ok(samples[0]!.confidence > 0.8);
});

test("sdkSource refuses with a clear log when the API key is missing", () => {
  const clock = new SimClock();
  const logs: string[] = [];
  const source = new SdkSource({
    clock,
    settings: settings(),
    apiKey: "",
    log: (line) => logs.push(line),
  });
  const got: unknown[] = [];
  source.onSample((s) => got.push(s));
  source.start();
  assert.ok(logs.some((l) => l.includes("SMARTSPECTRA_API_KEY")), "clear startup message");
  assert.equal(got.length, 0, "no fabricated samples without a key");
});

test("daily cap blocks the start and reports onCapReached (no child spawned)", () => {
  const clock = new SimClock();
  // Pre-seed an over-cap usage file (2 hours used, cap 60 min).
  const file = ".bt-usage-capped.json";
  writeFileSync(
    file,
    JSON.stringify({ date: new Date().toISOString().slice(0, 10), seconds: 7200 }),
  );
  try {
    let capped = false;
    const source = new SdkSource({
      clock,
      settings: { ...settings(), usageFile: file },
      apiKey: "fake-key",
      onCapReached: () => {
        capped = true;
      },
    });
    const got: unknown[] = [];
    source.onSample((s) => got.push(s));
    source.start();
    assert.equal(capped, true, "cap reported");
    assert.equal(got.length, 0, "no samples when capped");
  } finally {
    rmSync(file, { force: true });
  }
});
