import test from "node:test";
import assert from "node:assert/strict";
import {
  validationCodeToStatus,
  metricsToSample,
  clamp01,
} from "../src/signal/sdkMapping.js";

test("validation codes map per the documented table", () => {
  const cases: Array<[number, string]> = [
    [0, "ok"],
    [1, "no_face"],
    [2, "no_face"],
    [3, "off_center"],
    [4, "off_center"],
    [5, "poor_light"],
    [6, "poor_light"],
    [7, "off_center"],
    [10, "starting"],
    [11, "lost"],
    [12, "lost"],
    [13, "off_center"],
    [17, "off_center"],
  ];
  for (const [code, expected] of cases) {
    assert.equal(validationCodeToStatus(code), expected, `code ${code}`);
  }
  assert.equal(validationCodeToStatus(99), undefined, "unknown codes are not guessed");
  assert.equal(validationCodeToStatus(-1), undefined);
});

test("latest breathing-rate element wins, confidence is the documented percentage", () => {
  const s = metricsToSample(
    {
      breathing: {
        rate: [
          { value: 11.1, confidence: 40 },
          { value: 10.8, confidence: 87 },
        ],
      },
    },
    "ok",
    1234,
  );
  assert.ok(s);
  assert.equal(s.breathingRate, 10.8);
  assert.equal(s.confidence, 0.87);
  assert.equal(s.t, 1234);
  assert.equal(s.status, "ok");
});

test("missing confidence degrades honestly: 1 when ok, 0 otherwise", () => {
  const ok = metricsToSample({ breathing: { rate: [{ value: 12 }] } }, "ok", 0);
  assert.equal(ok?.confidence, 1);
  const noFace = metricsToSample(
    { breathing: { rate: [{ value: 12 }] } },
    "no_face",
    0,
  );
  assert.equal(noFace?.confidence, 0);
});

test("confidence is clamped into 0..1", () => {
  assert.equal(clamp01(-0.5), 0);
  assert.equal(clamp01(1.7), 1);
  const s = metricsToSample(
    { breathing: { rate: [{ value: 12, confidence: 150 }] } },
    "ok",
    0,
  );
  assert.equal(s?.confidence, 1);
});

test("empty or malformed series produce no sample (never a fake value)", () => {
  assert.equal(metricsToSample({}, "ok", 0), undefined);
  assert.equal(metricsToSample({ breathing: { rate: [] } }, "ok", 0), undefined);
  assert.equal(metricsToSample({ breathing: { rate: null } }, "ok", 0), undefined);
  assert.equal(
    metricsToSample({ breathing: { rate: [{ value: NaN }] } }, "ok", 0),
    undefined,
  );
  assert.equal(
    metricsToSample({ breathing: { rate: [{}] } }, "ok", 0),
    undefined,
  );
});
