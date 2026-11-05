# SmartSpectra SDK — research notes (Phase 1, Step 0)

> Scope: read-only research. No SDK code is integrated in Phase 1.
> Sources consulted on 2026-11-05:
>
> - https://smartspectra.presagetech.com/docs/nodejs
> - https://smartspectra.presagetech.com/docs/nodejs/api-reference
> - https://smartspectra.presagetech.com/docs/nodejs/metrics
> - https://smartspectra.presagetech.com/docs/telemetry-and-privacy
> - https://github.com/Presage-Security/SmartSpectra (repo documentarion surfaced through the docs site)
>
> All page content is also available as raw markdown by appending `.md` to any docs URL.

## 1. What the SDK is

`@smartspectra/node-sdk` is a **pure-FFI Node.js/Electron binding** for the
SmartSpectra vitals engine. It uses [`koffi`](https://koffi.dev) to load a C ABI
shim (`libsmartspectra_capi`) at runtime — **no native addon build step**
(no `binding.gyp`, no `node-gyp`, no `electron-rebuild`).

The native runtime ships in per-platform npm packages
(`@smartspectra/node-sdk-<plat>-<arch>`, e.g. `win32-x64`) that arrive as
**dependencies of the main package** — no postinstall script, no system
libraries. Load paths are pre-relocated at publish time.

### Supported platforms

| Platform | Status | Notes |
| --- | --- | --- |
| `darwin-arm64` | Supported | Electron + headless Node |
| `linux-x64` | Supported | glibc ≥ 2.35 (Ubuntu 22.04+) |
| `linux-arm64` | Supported | glibc ≥ 2.35 |
| `win32-x64` | Supported | our target; adjacent-DLL search |

Prereqs: **Node ≥ 20** (matches our Node 20+ requirement), Electron ≥ 28
optional. Windows needs no extra entitlements; macOS needs
`NSCameraUsageDescription`.

> Install note: `npm install` downloads the native runtime for *every*
> supported platform (a few hundred MB total). Expected behavior, documented.

## 2. Installation

```bash
npm install @smartspectra/node-sdk
# optional release-candidate channel:
npm install @smartspectra/node-sdk@rc
```

If a platform package is missing, the first `require()` throws an actionable
error naming the missing package.

## 3. Auth

- **API key** drawn from your account at <https://physiology.presagetech.com/auth/login>.
- Passed in the SDK options: `new SmartSpectraSDK({ apiKey: 'YOUR_API_KEY' })`.
- **Server-validated** auth (the key is checked against Presage's server).
- Auth failure surfaces as error code `kAuthenticationFailed` (value 2) via the
  `'error'` event or thrown from lifecycle methods.
- **No docs page found describing a specific env-var convention** — the
  convention `SMARTSPECTRA_API_KEY` is *our* `.env.example` choice. Feeding that
  env var into the constructor is app code, not SDK behavior. (Open question 1.)
- Credits: a separate error code `kCreditExhausted` (value 4) exists, i.e. the
  API key consumes quotas. Phase 2 must handle it gracefully.
- The docs mention an AI-assistant path: the
  [SmartSpectra MCP Server](https://smartspectra.presagetech.com/docs/mcp-server.md)
  can fetch the key from your account.

## 4. Core API surface (`SmartSpectraSDK`)

```ts
const sdk = new SmartSpectraSDK({
  apiKey: 'YOUR_API_KEY',
  requestedMetrics: [...breathingMetrics, ...cardioMetrics],
});

sdk.on('processingStatus', (status) => {});
sdk.on('validationStatus', (code, tsUs, hint) => {});
sdk.on('metrics',          (buf, tsUs) => { const m = decodeMetrics(buf); });
sdk.on('error',            (code, message, retryable) => {});

sdk.useCamera(CameraSelection.default); // or useCustomInput(); or useFile()
sdk.start();
// …later:
await sdk.stopAsync();   // native stop blocks until pipeline drains
await sdk.destroy();     // idempotent; native SDK state is process-global
```

Key facts:

- **Events, not callbacks in options**: `on(event, cb)`. Note the docs say
  `on()` **replaces any previously registered callback for the same event** —
  one listener per event per SDK instance.
- **Input sources** (all configured before `start()`):
  - `useCamera(CameraSelection, CameraOptions?)` — SDK opens and pumps the
    camera itself, *in this process*.
  - `useCustomInput(FrameTransform?)` + `sendFrame(buf, w, h, stride,
    PixelFormat, timestampUs)` — host-supplied frames (e.g. from a browser via
    WebSocket in Phase 2).
  - `useFile(path, options?)` — video file; useful for recorded test footage.
- **Lifecycle**: `start()`, `stop()`, `stopAsync()`, `reset()` (rebuild after
  `kError`), `destroy()`. `waitUntilComplete(timeoutMs?)` for file sessions.
- `static availableCameras()` — camera discovery without auth/instance.
- `processingStatus` values: `kUninitialized / kIdle / kStarting / kRunning /
  kStopping / kError` — this is what maps to our `SignalStatus "starting"`.
- `reset()` **clears the source** unless the camera selection opted into
  retention; after typed selection it throws while `stopAsync()` is pending.
- **`destroy()`/`await` before constructing a replacement session because
  native SDK state is process-global.** One SDK instance per process is the
  safe pattern — which directly supports the Phase 2 plan of an isolated child
  process.

## 5. Exact metric names and payload shapes

Metrics are selected as **integer `MetricType` codes** delivered via exported
bundles; the `metrics` event yields a protobuf buffer decoded by
`decodeMetrics(buf)` (register a class via `setMetricsClass()` or treat the
return as a Buffer / `any`).

| Bundles (`npm exports`) | What they include |
| --- | --- |
| `breathingMetrics` | default when `requestedMetrics` omitted |
| `cardioMetrics` | pulse rate, arterial pressure trace, HRV |
| `faceMetrics` | landmarks, blinking, talking, expressions |
| `edaMetrics` | EDA trace |

`MetricType` codes (stable integers): `CHEST_BREATHING: 0`,
`ABDOMEN_BREATHING: 1`, `BREATHING_RATE: 2`, `BREATHING_AMPLITUDE: 3`,
`APNEA: 4`, `RESPIRATORY_LINE_LENGTH: 5`, `BASELINE: 6`,
`INHALE_EXHALE_RATIO: 7`, `EDA_TRACE: 10`, `FACE_LANDMARKS: 11`,
`BLINKING: 12`, `TALKING: 13`, `EXPRESSIONS: 14`, `PULSE_RATE: 15`,
`ARTERIAL_PRESSURE_TRACE: 16`, `HRV: 17`.

**Breathing rate** (what our coach consumes):

```ts
sdk.on('metrics', (buf, tsUs) => {
  const m = decodeMetrics(buf);
  const breathingRate = m.breathing?.rate?.at(-1)?.value;   // breaths/min
  const chestTrace    = m.breathing?.upperTrace?.at(-1)?.value;
  const abdomenTrace  = m.breathing?.lowerTrace?.at(-1)?.value;
});
```

- `breathing.rate` is a **series**; each element has `.value` (and the generic
  per-measurement fields). We take the latest element and treat it as a new
  sample.
- **Cardio fields are empty unless you request a cardio metric** (e.g.
  `PULSE_RATE`). Same idea for advanced fields.

**Pulse**:

```ts
const pulseRate = m.cardio?.pulseRate?.at(-1)?.value;
// Cardio = {
//   pulseRate?: MeasurementWithConfidence[],
//   arterialPressureTrace?: MeasurementWithConfidence[],
//   hrv?: Hrv[],
// }
```

`MeasurementWithConfidence` — a value + confidence field per sample (exact field
names of the confidence key are dotted in the docs, not spelled in the snippet;
see Open question 3).

**HRV** (full shape documented):

```ts
type Hrv = {
  rmssd: number;
  meanNn: number;
  sdnn: number;
  baevsky: number;
  timestamp: number;
  confidence: number;
  stable: boolean;
};
```

**Face / expressions** (claim-relevant: yes, EXPRESSIONS exists):

```ts
m.face?.landmarks?.at(-1)?.value;   // landmarks
m.face?.blinking?.at(-1)?.detected; // DetectionStatus
m.face?.talking?.at(-1)?.detected;
m.face?.expression?.at(-1);         // Expression
```

Other events:

- `'accumulatedMetrics'` — an accumulated packet at the end of each session
  when `SmartSpectraOptions.enableAccumulatedOutput` is `true` (default off).
  This is the "session summary" style output; good source for raw-session stats
  (and useful for offline dev comparisons).
- `'insight'` / `requestInsight(text)` — LLM-generated natural-language
  analysis of measured vitals. **Out of scope for this app**: our hard rules
  forbid diagnosis/treatment-style language, and free-form LLM output cannot be
  reliably constrained to observation-only wording at runtime. We will not use
  `requestInsight` unless we can strictly control the output contract.
- `'frameSentThrough'` — feedback whether a pushed frame was accepted
  (back-pressure signal for custom input).
- `'videoOutput'` — processed video frames out of the engine.

## 6. Update frequency & continuous vs. spot measurement

- **Continuous measurement**: the engine streams metric samples continuously
  while `processingStatus === kRunning`. The `metrics` event fires repeatedly
  during the session; there is no documented "scan once" spot-check API.
- **`'accumulatedMetrics'`** arrives at end of session (opt-in) — a batch view,
  not a substitute for live updates.
- **Exact sample cadence of `breathing.rate` (Hz) is NOT documented on the
  pages consulted.** Our normalizer therefore treats each incoming sample as
  an event with its own timestamp and does not assume a fixed rate; the EMA and
  hold windows are time-based (ms), not sample-count-based. (Open question 2.)
- **Timestamps are in microseconds** (`tsUs`) on `validationStatus`, `metrics`,
  and `sendFrame`. Our normalized sample keeps **ms**.
- The **troubleshooting table warns against wall-clock timestamps**:
  `kNonMonotonicTimestamp` — use `process.hrtime.bigint() / 1000n`
  (monotonic microseconds) for `sendFrame`. Our app must map monotonic
  engine time to a stable monotonic ms timeline of its own.
- EDA Proxy "may take longer to produce its first sample than breathing or
  cardio outputs" — first-sample latency varies per metric; breathing is not
  called out as laggy, but we still model **realistic lag** in the mock (Phase 1
  already does).

## 7. Confidence / validity fields

Two distinct layers exist — this is important for our design:

1. **Measurement-readiness codes (`'validationStatus'` event)** — these map
   almost 1:1 to our `SignalStatus`:

   | SDK `ValidationCode` | Our `SignalStatus` |
   | --- | --- |
   | `kOk: 0` | `"ok"` |
   | `kNoFaceFound: 1` | `"no_face"` |
   | `kMultipleFacesFound: 2` | `"no_face"` (ambiguous scene) |
   | `kFaceNotCentered: 3` | `"off_center"` |
   | `kFaceSizeOutOfRange: 4` | `"off_center"` (framing) |
   | `kTooDark: 5` | `"poor_light"` |
   | `kTooBright: 6` | `"poor_light"` |
   | `kChestNotVisible: 7` | `"off_center"` |
   | `kCameraTuning: 10` | `"starting"` (AE/AWB still settling) |
   | `kFrameRateTooLow: 11` | `"lost"` (input quality) |
   | `kExcessiveMotion: 12` | `"lost"` (input quality) |
   | `kFaceTooClose/TooFar/TooHigh/TooLow/NotForward: 13–17` | `"off_center"` |

   Each code arrives as `(code, timestampUs, hint)` — `hint` is a human-readable
   string, usable for gentle notices "about setup (light, centered face)".

   Also: camera capture defaults are 1280x720 @ 30 fps with **AE/AWB/focus
   locked once the graph reports Running** — early samples during warm-up
   should be treated as calibration-time only. This matches our Calibrate
   phase (45–60 s default).

2. **Per-sample confidence values** — documented for HRV (`confidence`,
   `stable` fields) and implied for `MeasurementWithConfidence` types
   (`pulseRate`, `arterialPressureTrace`). Confidence for **breathing rate is
   presumed but not proven** — see Open question 3. Our `NormalizedSample`
   therefore carries confidence 0..1 and keeps **breathingRate optional**, so
   absence of a documented confidence field degrades gracefully (we use
   validation codes + plausibility gating, and `stable`-style flags when
   available).

## 8. Camera handling

- **Native camera (SDK-owned capture)**: `useCamera(CameraSelection.default)`
  — SDK pumps frames internally. Typed selection: `.default`, `.front`,
  `.back`, `.byId(id)`; **explicit requests never fall back**. Discovery:
  `SmartSpectraSDK.availableCameras()` (Windows cameras may have unknown
  facing/lens type — select by discovered ID; `.front`/`.back` **fail with
  `kInputUnavailable` on Windows**).
  `useCamera(selection, { width: 1280, height: 720 })` to set capture size.
  Capture happens **in the calling (Node) process**.
- **Host-supplied frames (Node)**: `useCustomInput(FrameTransform.kNone)` +
  `sendFrame(rgbBuf, width, height, stride, PixelFormat.kRGB, captureTsUs)`.
  Pixel formats: kRGB/kBGR/kRGBA/kBGRA/kNV12/kNV21/kYUYV. Frame transforms:
  none / rotate90CW / rotate90CCW / rotate180 / mirrorH / mirrorV. This is the
  path for **Phase 2's browser UI → local WebSocket server → child process**
  plan.
- **Electron renderer path**: `@smartspectra/node-sdk/renderer` captures in the
  renderer via `MediaStreamTrackProcessor` + `OffscreenCanvas`, ships frames to
  the main process over a MessagePort; `@smartspectra/node-sdk/main`
  (`bindSmartSpectraIpc`) owns one SDK per renderer connection; preload bridge
  via contextBridge. Renderer runs a Web Worker from a `blob:` URL — CSP needs
  `worker-src 'self' blob:'`. Permission flow via Electron's native handler.
- For Phase 2 (web-app-style UI), the docs suggest either the Electron renderer
  path or `useCustomInput`. **Browser-supplied frames over WebSocket land in
  `useCustomInput()`/`sendFrame()`**, which the docs describe as the supported
  integration path for host-supplied frames.

## 9. Known limits, platform quirks, performance notes

- **Native SDK state is process-global**: "Await `destroy()` before
  constructing a replacement session … native SDK state is process-global."
  ⇒ **Run the SDK in a dedicated child process.** This isolates crashes, keeps
  the heavy native pipeline off the UI/host process, and enforces the
  single-session rule cleanly.
- **On the reported community instability** ("Node SDK unstable when fed
  30fps webcam frames from a frontend"): the official docs themselves note that
  the Electron *renderer* path ships every frame across IPC and that
  "renderer→main IPC adds frame-time latency that scales with resolution",
  recommending main-process capture for lowest latency at high resolution. A
  frontend-pushed 30 fps stream over WebSocket/IPC is exactly the pattern where
  back-pressure and marshalling issues bite. Mitigations, in order of
  preference:
  1. **Isolate the SDK in a child process** (as planned) — a stall or crash in
     the SDK cannot take down the host app, and the parent can watchdog it.
  2. Feed frames from the server side (rendered capture in the Node process),
     keeping the browser purely as a viewer of the preview stream.
  3. Subscribe to `'frameSentThrough'` (frame accepted/dropped feedback) to
     detect back-pressure, and use `kFrameRateTooLow` validation codes to react.
  We could not independently verify the community report itself from the
  consulted pages, but the docs' own performance notes and the process-global
  caveat make child-process isolation the right call regardless. Treat the
  report as **unconfirmed but plausible**; Phases 1–2 must design the SDK side
  so it can be restarted without taking the app down.
- koffi FFI overhead ~100 ns per call — negligible at 30 fps `sendFrame()`.
- SDK callbacks arrive on worker threads; koffi marshals them onto the V8 event
  loop (listeners run on the main thread of the SDK's process).
- Windows camera quirks (above): `.front`/`.back` unsupported; facing/lens may
  be "unknown"; select by ID.
- Linux builds need glibc ≥ 2.35. Non-issue for our Windows target.
- `logLevel` option (kDebug/kInfo/kWarning default/kError/kNone); debug-only
  logs are compiled out of the release engine binary.
- `kCreditExhausted` — free/challenge credits can run out mid-development.

## 10. Telemetry behavior

- The SDK reports **one aggregate, per-session telemetry summary** (what
  Presage's docs describe as a "small, aggregate diagnostic summary of release
  quality") to their servers, over the same authenticated, TLS-pinned channel
  used for SDK server requests.
- **Collected**: SDK build/version, platform/OS/device/CPU/binding, session
  shape (source kind, outcome, count of metrics requested), performance stats
  (frame throughput, input fps stats, startup latency, flow-limiter
  throughput, count of produced metrics), quality counts (on-device validation
  state counts, coarse error code for failures), wall-clock timestamp.
- **Never collected**: raw frames, *any measured metric values* (pulse,
  breathing rates, HRV, pressure waveform …), file paths, prompts/free-text,
  user or stable device identifiers. Not linked to identity; not used for
  tracking. App-store privacy mapping is documented.
- **Opt-out**: set `enableTelemetry = false` on the SDK config. Defaults **on**.
- **Our responsibility**: if we embed the SDK, we must **disclose** this
  collection to users and complete app-store data-collection declarations.
- Phase 2 action item: default `enableTelemetry = false` in our wrapper config,
  and add plain-language wording in the UI ("Only your device analyzes the
  camera picture; no video ever leaves it" is NOT true of the API key
  server-validation + telemetry path — wording must acknowledge the aggregate
  telemetry or set it off) before release.

## 11. Contradictions vs. this prompt's assumptions

| # | Prompt assumed | Docs say | Resolution |
| --- | --- | --- | --- |
| 1 | Env var auth ("API key via env var") | Key is passed as a constructor option; no env-var convention documented | We read `SMARTSPECTRA_API_KEY` from env in **our** config and pass it into the SDK (Phase 2). `.env.example` updated accordingly. |
| 2 | Update frequency known/needed | Not documented for `breathing.rate` | Time-based windows in normalizer/coach; no assumptions about sample cadence. |
| 3 | "confidence/validity fields" generically | Validation codes well documented; per-sample confidence documented for HRV and implied for pulse rate; breathing-rate confidence not explicitly documented | `NormalizedSample.confidence` kept; degraded gracefully. |
| 4 | "expressions" available | Yes — `EXPRESSIONS: 14`, `face.expression` series, via `faceMetrics` bundle | OK; not used by the coach in Phase 1. |
| 5 | Continuous vs spot measurement unclear | Continuous streaming while running; opt-in accumulated packet at session end | Confirmed continuous; spot mode would be our own convention. |
| 6 | Stability risk when feeding 30 fps frontend frames | Docs acknowledge IPC frame latency scales with resolution; engine state is process-global; `'frameSentThrough'` feedback exists | Child-process isolation planned for Phase 2 confirmed as advisable. |
| 7 | (not assumed, worth noting) Measurement-tooling vs. wellness framing | SDK produces raw vitals (incl. APNEA flags, HRV "baevsky index"); nothing forces wellness labeling | Our hard rules keep every feature observation-only; we will not surface APNEA or any measurement-sounding flag. |

## 12. Open questions

1. **Env-var convention**: is there an official supported env var for the API
   key, or must it always be constructor-injected? If a challenge template or
   sample shows a convention, follow it.
2. **Sample cadence**: what is the actual emission rate of `breathing.rate`
   samples (per second)? Needed only to tune mock realism; our design doesn't
   depend on it.
3. **Breathing-rate confidence**: does `MeasurementWithConfidence` apply to
   `breathing.rate` too, and what is the exact confidence field name and range?
   (Docs snippet shows `.value` access but doesn't spell the confidence field.)
4. **Null/error CDCs**: what is the behavior of `useCustomInput` when frames
   are starved (e.g. browser tab hidden)? Does `kTimestampGap` fire, and is
   there a recommended filler strategy?
5. **Rate limits / cost per session-minute**: unclear what credit consumption
   looks like for the challenge budget (affects sim-driven development — good
   thing Phase 1 is mock-only).
6. **`Expression` payload shape**: not spelled out beyond the field name;
   needed only if we ever render expression-based notices (we don't plan to).
7. **Community report verification**: find the original thread on the Node SDK
   being unstable with 30 fps frontend frames — the repo issues at
   <https://github.com/Presage-Security/SmartSpectra/issues> are the right
   place to look before Phase 2 platform decisions.
8. **Windows camera selection UX**: with `.front`/`.back` unavailable, how do
   multi-camera laptops pick the right camera? (By discovered ID + name.)
   *(Phase 2 note: mooted by decision 14.1 — the **browser** owns the camera
   and the SDK gets frames, so native camera selection never runs for us.)*
9. **(Phase 2) Minimum acceptable frame rate / resolution for custom input**:
   docs don't state the floor below which the engine reports
   `kFrameRateTooLow` or degrades measurement. Our 320×240 @ 15 fps ceiling is
   a starting point to be validated in the smoke run, guided by
   `'frameSentThrough'` and validation codes.
10. **(Phase 2) Starved-input behavior for `useCustomInput`**: what the engine
    does when the browser tab is hidden and frames pause (open question 4,
    sharpened: does it fire `kTimestampGap`, or `kFrameRateTooLow`? The worker
    will simply stop pushing frames and report `lost` to the parent after a
    configured gap, which is safe under both.)
11. **(Phase 2) Credit spend model**: how quickly the free-trial allowance
    burns per minute of streaming (open question 5 stands for budgeting the
    demo; the daily/session cap in `config.ts` is a guess until observed).

## 13. Note on the assistant-skill install attempt

The prompt suggested installing the SmartSpectra agent skill via
`/plugin marketplace add Presage-Security/SmartSpectra` and
`using-smartspectra`. That plugin command belongs to a different harness
(Claude Code's plugin system) and is not available in this environment
(OpenCode). The underlying docs surface is the same one the plugin would point
to, and all relevant pages were fetched directly and are summarized above. If a
SmartSpectra **MCP server** is installed later, this document can be updated
from live resources. Phase 1 does not depend on it.

## 14. Phase 2 integration decisions (2026-11-05, re-verified against the live docs)

Re-fetched `/docs/nodejs` and `/docs/nodejs/api-reference` before writing these.
The Phase 1 notes above still match the published pages; no contradictions
surfaced. New details found on this pass are called out inline and the affected
open questions are updated in §15.

### 14.1 Who owns the camera → the browser (consent UI), frames shipped to the server

**Decision: browser capture → WebSocket → server → isolated child process →
`useCustomInput()` / `sendFrame()`.**

- The consent flow needs a browser camera prompt (`getUserMedia`), a live
  preview, and a browser-managed capture indicator — all of that only exists
  if the **browser** opens the camera. Server-side native capture
  (`useCamera()` in a Node process) would start the camera with no user-facing
  permission moment of our own, and a "preview" would require streaming
  `videoOutput` frames back to the page (upside-down cost).
- The docs explicitly bless this direction: _"Headless or server-side Node
  process with host-provided frames: use `useCustomInput()` / `sendFrame()`"._
- **Electron was considered and rejected**: the SDK's Electron path is excellent
  (renderer capture + `bindSmartSpectraIpc`), but it adds a heavyweight
  dependency, a packaging/signing surface, and a second app shell to maintain
  — and the challenge app is a plain web app around a local server. The docs
  support the custom-input path without Electron, so that is what we use. The
  child-process isolation we do want comes from our own supervisor (§14.5),
  which gives us the crash-safety benefit Electron's main-process puts the SDK
  behind anyway.
- The failure mode the community report hinted at (unstable when fed 30 fps
  browser frames) is mitigated by throttling and downscaling before transport
  (§14.2), and by isolating the SDK process so a stall can never take the page
  or the coach down.

### 14.2 Frame format, resolution and transport

`sendFrame(buffer, width, height, stride, pixelFormat, timestampUs)` with
`PixelFormat.kRGBA` is the lowest-friction match for browser capture: a canvas
`ImageData` **is** an RGBA buffer — no re-encode. Per frame:

| Aspect | Decision | Why |
| --- | --- | --- |
| Pixel format | `kRGBA` (4 bytes/px) | `canvas.getImageData()` output; zero conversion server-side. (kRGB would save 25% bandwidth but costs a server-side copy per frame — not worth it on localhost.) |
| Resolution | 320×240 (configurable in `config.ts`) | Well below the SDK's native 1280×720 default; rPPG needs face skin texture, not detail. 320×240×4 = 300 KB raw per frame; frame data never leaves the machine (localhost WS). |
| Frame rate | 15 fps max, **throttled in the browser** | The prompt's rule: push the minimum the SDK needs, not 30 fps. The exact *minimum* fps the engine accepts is undocumented (`kFrameRateTooLow` is the feedback channel — see new open question 9). 15 fps is our ceiling, tuned down later if the engine is happy with less. |
| Transport | WebSocket binary frames (ArrayBuffer), one frame per message | Localhost only, no intermediate encoding. Server forwards each buffer to the SDK child process; the child calls `sendFrame()`. |
| Timestamps | Monotonic µs derived from `performance.now()` on the browser side (documented `performance.now()` is monotonic), validated server-side for monotonicity | The troubleshooting table's `kNonMonotonicTimestamp` warning is about wall clocks; `performance.now()` is monotonic by spec. The server still drops/backfills out-of-order stamps defensively. |
| Back-pressure | Page skips a frame entirely if the previous WS send hasn't drained (bufferedAmount watermark) | `'frameSentThrough'` (sent true/false) plus `kFrameRateTooLow` are the SDK-side signals for tuning the cap. |

Never re-encoded to JPEG/WebM — the SDK takes raw pixels, and compression would
just lose the subtle skin-tone variation rPPG reads.

### 14.3 Metrics requested → what the UI may promise

- We request **`breathingMetrics` only** (the default bundle). Breathing rate
  comes from `decodeMetrics(buf).breathing?.rate?.at(-1)?.value`.
- We do **not** request cardio/HRV/EDA. One metric family keeps the free-trial
  credit spend minimal and keeps the UI honest about "one measurement, gently".
- **Update cadence of `breathing.rate` is still undocumented** (open question 2
  stands). The Phase 1 design already treats metrics as timestamped samples
  with no assumed rate; the server decodes each `metrics` event, dedupes by
  (metric, timestampUs), and emits a `NormalizedSample` per *new* value.
- The UI never displays anything we don't stream: no pulse, no HRV numbers, no
  "signal strength percentage" we can't derive honestly (§14.4). The `insight`
  LLM path stays unused (Phase 1 decision — free-form output can't be
  constrained to observation-only wording at runtime).

### 14.4 Confidence / status derivation (documented fields only)

- **`status`** comes from the `'validationStatus'` event via the Phase 1
  mapping table (§7). That table is unchanged in the API reference:
  `kOk→ok`, `kNoFaceFound/kMultipleFacesFound→no_face`,
  `kFaceNotCentered/kFaceSizeOutOfRange/kChestNotVisible/kFaceTooX→off_center`,
  `kTooDark/kTooBright→poor_light`, `kCameraTuning→starting`,
  `kFrameRateTooLow/kExcessiveMotion→lost`, plus `processingStatus`
  `kStarting→starting`.
- **`confidence`**: breathing-rate per-sample confidence is still not spelled
  in the docs (open question 3 stands). Honest derivation, no guessing:
  - If a decoded breathing rate sample exposes a documented confidence field,
    use it directly.
  - Otherwise: `confidence = 1` for samples delivered while the latest
    validation code is `kOk`, and the *status* carries the nuance. No invented
    smoothness scores. The normalizer's plausibility/EMA layers still protect
    the coach from jumpy values.
- We will **not** guess `poor_light` from anything except `kTooDark` /
  `kTooBright`.

### 14.5 Process isolation and lifecycle

- Native SDK state is **process-global** → strictly one SDK instance per
  process, and we give it a **dedicated child process**
  (`src/signal/sdkWorker.ts`, spawned by `src/signal/sdkSource.ts` with
  `fork()`), supervised: heartbeat, restart with capped exponential backoff,
  clean-stop that makes sure `stopAsync()` + `destroy()` run so the camera
  input is released.
- The child is the only process that imports `@smartspectra/node-sdk`. If the
  package (or its platform runtime) is missing, the parent still boots with the
  mock source and the UI says so honestly.
- Auth: `SMARTSPECTRA_API_KEY` from env (our convention, open question 1
  stands); injected into the child's SDK constructor. Missing key → clear
  startup failure, never a silent fallback.
- Credits are finite (`kCreditExhausted` is a first-class error code): the SDK
  source never auto-starts on page load — a session or smoke run starts it, and
  it stops (and usually destroys the child) the moment the session ends or
  consent is revoked. A configurable daily/session cap adds a hard stop with a
  kind message.

### 14.6 Choice if the real SDK can't run here

The dev machine is Windows x64 — a **supported** platform (`win32-x64`,
adjacent-DLL search, no entitlements). So the expectation is that the real SDK
runs; mock mode remains the default dev path anyway, and every Step is built
and tested against the mock first. If the SDK turns out not to run, Steps 1–5
stand alone with the mock and Step 6 ships as a documented, testable adapter
(fake-SDK injected in tests), clearly reported — no faked output.

### 14.7 Step 6 outcome (2026-11-06): real SDK loads natively; integration landed

- The real package installed cleanly: `@smartspectra/node-sdk` **v3.4.0**,
  native runtime for `win32-x64` loaded with no build step, and
  `SmartSpectraSDK.availableCameras()` returned the dev machine's
  **HP HD Camera**. The native-load risk is retired on this machine.
- **Open question 3 is answered** (verified against the installed package's
  own declarations): `Metrics.breathing.rate` items are
  `MeasurementWithConfidence` with a `confidence` percentage **0.0–100.0**.
  The adapter divides by 100. See `src/signal/sdkMapping.ts`.
- `decodeMetrics` is imported from `@smartspectra/node-sdk/messages`
  (the typed facade); the main-package decoder returns an unregistered
  Buffer unless a class is registered — the `/messages` path avoids that.
- Telemetry: `enableTelemetry: false` is set in the worker (verified option
  in the installed `index.d.ts`), so `docs/CONSENT_AND_DATA.md §5` holds.
- **No API key was available in this environment**, so a live authenticated
  session could not be run here. What was verified end-to-end instead:
  native load + camera discovery (`npm run smoke:sdk` keyless portion), the
  full IPC path through the real worker process with the fake SDK injected
  (`BT_FAKE_SDK=1`, test `sdkSource.test.ts`), mapping/failure-mode unit
  tests, and the startup guard (server refuses `SIGNAL_SOURCE=sdk` without a
  key with a clear message). The remaining manual check with a key:
  `SMARTSPECTRA_API_KEY=… npm run smoke:sdk`, then a real session.
- Daily/session budget: `config.sdk.dailyCapMinutes` (60) enforced via the
  git-ignored `.bt-usage.json` counter; the SDK source refuses to start at
  the cap and the UI shows the capped notice.
- Architecture: browser frames → WS binary → server → `ParticipantPipeline.pushFrame`
  → `SdkSource` → `fork()` child (`sdkWorker.ts`, advanced IPC serialization
  for binary) → `sendFrame(rgb, 320, 240, stride, kRGBA, µs)`. The child is
  supervised (rooms.ts wraps `sdk`-kind sources in `SupervisedSource`):
  silence → backoff restart → guide-only degrade with an honest notice.


