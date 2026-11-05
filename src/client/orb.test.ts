import test from "node:test";
import assert from "node:assert/strict";
import { Pacer } from "../coach/pacer.js";
import { FROZEN_DEFAULT_SETTINGS } from "../config.js";
import { orbStateAt } from "./orb.js";

/**
 * The client's orb must track the server pacer over a full 10-minute
 * session. We drive the real server-side Pacer, snapshot it at 10 Hz (what
 * the wire carries), interpolate between snapshots exactly like the browser
 * does, and compare against the pacer's own state at the same instant.
 */
test("orb interpolation tracks the server pacer with bounded error over 10 minutes", () => {
  const cfg = FROZEN_DEFAULT_SETTINGS.pacer;
  const pacer = new Pacer(cfg, 12);
  const share = cfg.inhaleShare;

  // Scripted rate changes mid-session (what the coach would command).
  const rateChanges: Array<[number, number]> = [
    [60_000, 11.5],
    [180_000, 10],
    [300_000, 8.5],
    [480_000, 7],
  ];

  const snapEveryMs = 100; // server push cadence
  let lastSnap: { rate: number; phase: "inhale" | "exhale"; phaseProgress: number; receivedAtMs: number } | undefined;
  let maxScaleError = 0;
  let maxPhaseMismatchMs = 0;
  let checked = 0;

  for (let t = 0; t <= 600_000; t += 16) {
    // ~60 fps render loop against 10 Hz snapshots.
    for (const [at, rate] of rateChanges) {
      if (t === at) pacer.setRate(rate);
    }
    if (t % snapEveryMs === 0 || lastSnap === undefined) {
      const s = pacer.advance(t);
      lastSnap = {
        rate: s.rate,
        phase: s.phase,
        phaseProgress: s.phaseProgress,
        receivedAtMs: t,
      };
    }
    const snap = lastSnap!;
    const truth = pacer.advance(t);
    const client = orbStateAt(snap, t, share, false);

    // True scale from the pacer's own phase progress.
    const eased = (x: number) => x * x * (3 - 2 * x);
    const truthScale =
      truth.phase === "inhale"
        ? 1 + 0.35 * eased(truth.phaseProgress)
        : 1.35 - 0.35 * eased(truth.phaseProgress);

    maxScaleError = Math.max(maxScaleError, Math.abs(client.scale - truthScale));
    if (client.phase !== truth.phase) {
      // A phase disagreement can only be a boundary crossing within the last
      // snapshot interval; measure how far into the new phase the truth is.
      const cycleMs = (60 / truth.rate) * 1000;
      const phaseMs =
        truth.phase === "inhale" ? cycleMs * share : cycleMs * (1 - share);
      maxPhaseMismatchMs = Math.max(
        maxPhaseMismatchMs,
        truth.phaseProgress * phaseMs,
      );
    }
    checked++;
  }

  assert.ok(checked > 10_000, "checked many render frames");
  assert.ok(
    maxScaleError <= 0.03,
    `orb scale stays within one update interval of error (got ${maxScaleError})`,
  );
  assert.ok(
    maxPhaseMismatchMs <= 120,
    `phase disagreement never exceeds ~one push interval (${maxPhaseMismatchMs} ms)`,
  );
});

test("reduced motion renders phase steps, not smooth growth", () => {
  const snap = { rate: 12, phase: "inhale" as const, phaseProgress: 0, receivedAtMs: 0 };
  const mid = orbStateAt(snap, 1000, 0.4, true); // halfway through inhale
  assert.equal(mid.scale, 1.35, "step to full size during inhale");
  const exhale = orbStateAt(
    { rate: 12, phase: "exhale" as const, phaseProgress: 0.5, receivedAtMs: 0 },
    0,
    0.4,
    true,
  );
  assert.equal(exhale.scale, 1, "step back to rest during exhale");
});

test("interpolation rolls across phase and cycle boundaries", () => {
  // At 12 bpm the cycle is 5 s: 2 s inhale, 3 s exhale.
  const snap = { rate: 12, phase: "inhale" as const, phaseProgress: 0, receivedAtMs: 0 };
  const atExhale = orbStateAt(snap, 3000, 0.4, false);
  assert.equal(atExhale.phase, "exhale");
  assert.ok(atExhale.phaseProgress > 0.3 && atExhale.phaseProgress < 0.4);
  const nextCycle = orbStateAt(snap, 6000, 0.4, false);
  assert.equal(nextCycle.phase, "inhale");
  assert.ok(nextCycle.phaseProgress > 0.4 && nextCycle.phaseProgress < 0.6);
});
