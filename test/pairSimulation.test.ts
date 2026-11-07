import test from "node:test";
import assert from "node:assert/strict";
import { runPairSimulation } from "../src/sim/runPair.js";

const sim = (a: "calm" | "agitated_then_settling" | "ignores_pacer" | "dropout" | "bad_light",
  b: "calm" | "agitated_then_settling" | "ignores_pacer" | "dropout" | "bad_light",
  seed = 7) =>
  runPairSimulation({ a, b, minutes: 3, seed });

test("(settling, calm): alignment rises over the session as the settling partner converges", () => {
  const res = sim("agitated_then_settling", "calm", 42);
  assert.ok(res.alignmentEnd !== undefined && res.alignmentEnd > 0, "alignment became positive");
  // The settling participant's rate converges toward the calm one's.
  const lastA = res.rows.at(-1)!.rateA!;
  const lastB = res.rows.at(-1)!.rateB!;
  assert.ok(
    Math.abs(lastA - lastB) < 5,
    `rates converged (A ${lastA} vs B ${lastB})`,
  );
});

test("(ignores_pacer, calm): alignment stays low; shared rate does NOT descend aggressively", () => {
  const res = sim("ignores_pacer", "calm", 42);
  // Ignorer pins ~23; the shared pacer (max proposal) stays high.
  assert.ok(res.sharedEnd >= 18, `shared rate held up (${res.sharedEnd})`);
  assert.ok(
    (res.alignmentEnd ?? 1) < 0.3,
    `alignment stayed low (${res.alignmentEnd})`,
  );
});

test("(dropout, calm): alignment freezes during dropout, then resumes fresh", () => {
  const res = sim("dropout", "calm", 42);
  // Dropout silence is 90-110 s (mock config): alignment must be stale there.
  const at95 = res.rows.find((r) => r.t === 95_000)!;
  const at120 = res.rows.find((r) => r.t === 120_000)!;
  assert.equal(at95.stale, true, "frozen during dropout");
  assert.equal(at120.stale, false, "recovered after dropout");
  // Frozen value held, did not decay to zero during the blackout.
  assert.ok(at95.alignment !== undefined && at95.alignment > 0);
});

test("(bad_light, settling): alignment never fabricates a value during the dark stretch", () => {
  const res = sim("bad_light", "agitated_then_settling", 42);
  // bad_light is poor_light for the first 90 s: waiting or frozen, never a
  // number from thin air.
  const early = res.rows.find((r) => r.t === 60_000)!;
  assert.equal(early.waiting, true, "waiting during the bad-light stretch");
});

test("phase-lock: two clients on the same stream stay within one push interval", () => {
  const res = sim("calm", "calm", 7);
  assert.ok(
    res.maxSkewMs <= 100,
    `max skew ${res.maxSkewMs} ms <= 100 ms (one push interval)`,
  );
});
