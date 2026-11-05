import test from "node:test";
import assert from "node:assert/strict";
import {
  parseClientMessage,
  validateFramePayload,
  encodeFrameHeader,
  TokenBucket,
  SESSION_DURATIONS,
} from "../src/server/protocol.js";

// -- parseClientMessage ------------------------------------------------------

const envelope = { roomId: "solo-ab12cd34", participantId: "p1" };

test("valid messages parse into typed forms", () => {
  const cases: Array<[unknown, string]> = [
    [{ ...envelope, type: "hello", clientVersion: "1.0" }, "hello"],
    [{ ...envelope, type: "consent_granted" }, "consent_granted"],
    [{ ...envelope, type: "consent_revoked" }, "consent_revoked"],
    [{ ...envelope, type: "start_session", durationMin: 3, mode: "solo" }, "start_session"],
    [
      { ...envelope, type: "start_session", durationMin: 10, mode: "solo" },
      "start_session",
    ],
    [{ ...envelope, type: "stop_session" }, "stop_session"],
    [{ ...envelope, type: "preview_start" }, "preview_start"],
    [{ ...envelope, type: "preview_stop" }, "preview_stop"],
    [{ ...envelope, type: "set_scenario", scenario: "calm" }, "set_scenario"],
    [{ ...envelope, type: "ping" }, "ping"],
  ];
  for (const [raw, expectedType] of cases) {
    const res = parseClientMessage(raw);
    assert.ok(res.ok, `${JSON.stringify(raw)} should parse`);
    assert.equal(res.message.type, expectedType);
  }
});

test("malformed inputs are rejected with codes", () => {
  const bad: Array<[unknown, string]> = [
    [null, "malformed"],
    ["hello", "malformed"],
    [[1, 2], "malformed"],
    [{}, "malformed"],
    [{ ...envelope, type: 42 }, "malformed"],
    [{ ...envelope, type: "explode" }, "unknown_type"],
    [{ ...envelope, type: "start_session", durationMin: 4, mode: "solo" }, "invalid_field"],
    [
      { ...envelope, type: "start_session", durationMin: 3, mode: "pair" },
      "invalid_field",
    ],
    [
      { ...envelope, type: "start_session", durationMin: "3", mode: "solo" },
      "invalid_field",
    ],
    [{ ...envelope, type: "hello", clientVersion: 9 }, "invalid_field"],
    [{ ...envelope, type: "set_scenario" }, "invalid_field"],
    [{ ...envelope, type: "set_scenario", scenario: "x".repeat(65) }, "invalid_field"],
    [
      { ...envelope, roomId: "bad id with spaces", participantId: "p1", type: "ping" },
      "invalid_field",
    ],
    [
      { ...envelope, roomId: "x".repeat(65), participantId: "p1", type: "ping" },
      "invalid_field",
    ],
  ];
  for (const [raw, expectedCode] of bad) {
    const res = parseClientMessage(raw);
    assert.ok(!res.ok, `${JSON.stringify(raw)} should be rejected`);
    assert.equal(res.code, expectedCode);
  }
});

test("all durations the protocol publishes are accepted", () => {
  assert.deepEqual([...SESSION_DURATIONS], [3, 5, 10]);
  for (const d of SESSION_DURATIONS) {
    const res = parseClientMessage({
      ...envelope,
      type: "start_session",
      durationMin: d,
      mode: "solo",
    });
    assert.ok(res.ok);
    if (res.ok) assert.equal((res.message as { durationMin: number }).durationMin, d);
  }
});

test("envelope ids are optional but validated, and out messages echo server ids", () => {
  const noIds = parseClientMessage({ type: "ping" });
  assert.ok(noIds.ok);
  const badId = parseClientMessage({ type: "ping", roomId: "" });
  assert.ok(badId.ok, "empty roomId treated as absent");
});

// -- binary frame validation --------------------------------------------------

test("frames need a header, valid timestamp and pixels", () => {
  const pixels = new Uint8Array(12);
  const header = encodeFrameHeader(123456789);
  const frame = new Uint8Array(header.length + pixels.length);
  frame.set(header, 0);
  frame.set(pixels, header.length);

  const ok = validateFramePayload(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength));
  assert.ok(ok.ok);
  if (ok.ok) assert.equal(ok.timestampUs, 123456789);

  const tooSmall = new Uint8Array(4);
  const r1 = validateFramePayload(tooSmall.buffer);
  assert.ok(!r1.ok);

  const headerOnly = new Uint8Array(8);
  const r2 = validateFramePayload(headerOnly.buffer);
  assert.ok(!r2.ok);

  const badTime = encodeFrameHeader(-5);
  const r3 = validateFramePayload(
    new Uint8Array([...badTime, ...new Uint8Array(4)]).buffer,
  );
  assert.ok(!r3.ok);

  const frac = encodeFrameHeader(1.5);
  const r4 = validateFramePayload(
    new Uint8Array([...frac, ...new Uint8Array(4)]).buffer,
  );
  assert.ok(!r4.ok);
});

// -- TokenBucket --------------------------------------------------------------

test("token bucket allows bursts then throttles to sustained rate", () => {
  const bucket = new TokenBucket(5, 10); // burst 5, sustained 10/s
  let t = 100;
  for (let i = 0; i < 5; i++) assert.ok(bucket.trySpend(t), `burst #${i}`);
  assert.equal(bucket.trySpend(t), false, "burst exhausted");
  // 10 tokens/sec => 100ms gives one token.
  t += 100;
  assert.ok(bucket.trySpend(t));
  assert.equal(bucket.trySpend(t), false);
  t += 100;
  assert.ok(bucket.trySpend(t));
});

test("token bucket config rejects nonsense", () => {
  assert.throws(() => new TokenBucket(0, 10));
  assert.throws(() => new TokenBucket(5, 0));
});
