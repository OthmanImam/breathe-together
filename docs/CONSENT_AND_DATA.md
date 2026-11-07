# Consent and data — what Breathe Together collects, and what it does not

> **Not a medical device. Not for diagnosis or treatment.**
>
> This document describes the app's actual behavior as built. If any line here
> stops matching the code, the code wins and this document must be updated in
> the same change. A plain-language version of the same points appears on the
> consent screen and in the in-app "Why camera?" note.

## 1. The short version

- The camera is used only to estimate your breathing rhythm so the pacing
  guide can keep pace with you.
- Processing happens on your own computer: a small local server plus the
  measurement engine running in its own process on the same machine. **No
  camera frames ever leave this device.**
- **Nothing is saved by default.** No video is stored, no history is kept,
  and the session data in memory is discarded when the page is closed.
- The vendor (Presage) is contacted **only** for account gating, never with
  frames or measurements: checking your API key, pairing the device, asking
  which metrics your key may use, and verifying usage. No video, no
  breathing numbers, and no other personal data are sent (see §5).
- Consent is asked again on every page load. The Stop button — always
  visible while the camera is on — ends the session and releases the camera
  immediately.

**Deployment note:** the architecture above assumes the server runs on this
same machine (the app's design). If it is ever deployed to a shared server
or a cloud workspace, camera frames would transit that infrastructure —
deployments other than your own machine are not part of this build, and the
consent copy would need to change accordingly.

## 2. Exactly what is collected

| Item | Collected? | Details |
| --- | --- | --- |
| Camera frames | While consented only | The browser captures 320×240 RGBA frames at up to 15 fps and sends them over a WebSocket to the local server on this machine. Buffer handling: every frame is consumed in memory and then dropped — **nothing is written to disk, and frames are discarded as soon as they are processed** (in mock mode they are counted for rate-limiting and discarded without ever being measured; in SDK mode each frame is handed to the measurement engine process and then dropped). |
| Breathing rhythm estimate | While a session/preview runs | A number (breaths per minute — the SDK's 30-second trailing average), a confidence value, and a readiness status (`ok`, `no_face`, `poor_light`, `off_center`, `starting`, `lost`). This is the only per-person measurement the coach consumes. |
| Session summary numbers | In memory only | Start/end pacing rates, minutes near the pacing rhythm, minutes without a clear view. Kept in RAM to render the summary screen; discarded with the page. |
| Software telemetry | Off by our choice | The measurement SDK's own aggregate session summary would otherwise default to ON; our wrapper disables it (`enableTelemetry: false`), so in this build it sends nothing. See §5. |
| Account / identity | No | No accounts, no names, no emails, no device identifiers. |
| IP address / location | No (beyond the vendor gating calls) | The server binds locally and is not exposed. The one exception is the vendor gating traffic in §5, which the engine makes on its own. |
| Audio | No | The microphone is never requested. |
| Third-party analytics | No | No trackers, no crash reporters, no AI services. |

## 3. Where processing happens

```
browser (camera, consent UI, pacing orb)
   │  localhost WebSocket only
   ▼
local Node server (protocol, rooms, coach state machine, pacing)
   │  typed IPC (SDK mode) / direct calls (mock mode)
   ▼
measurement engine in its own child process (SDK mode) — or the mock generator (mock mode)
```

- **Mock mode** (default, `SIGNAL_SOURCE=mock`): no real measurement happens
  at all — the "signal" is a seeded simulation, and camera frames sent by the
  browser are counted for rate-limiting and then discarded without ever being
  measured.
- **SDK mode** (`SIGNAL_SOURCE=sdk`): frames are forwarded to the SmartSpectra
  engine in an isolated child process, which returns breathing-rate samples
  that flow through the same normalizer and coach as the mock.

## 4. Storage, retention, deletion

- **Server: nothing is stored.** There is no database and no log file. Server
  logs carry event counters and room/participant ids only — never signal
  values, never frames, never anything personal.
- **Browser: nothing by default.** An optional session-history feature exists
  (off by default; enable it in the app) which stores only summary *text
  lines* in `localStorage`. It is off unless you turn it on.
- **Deletion:** the Stop button ends the session and stops sampling; the
  "Delete my data" button removes anything in `localStorage`. Closing the tab
  discards the in-memory session. There is nothing server-side to delete.

## 5. What the measurement SDK sends to the vendor (Presage)

Metric computation itself runs **entirely on this device**, inside the
vendor's SDK. But the SDK contacts Presage's servers for account gating —
this is real network traffic, observed in the SDK's own logs during a live
run (device pairing, metrics authorization, usage verification). Precisely:

**Sent to Presage (account gating only):**
- Your API key (constructor-injected from `SMARTSPECTRA_API_KEY`), to check
  it is valid and its subscription/usage is current.
- A device-pairing / key-provisioning request when the engine starts.
- A metrics-authorization request naming the metric types you asked for
  (breathing only in this app).
- A usage-verification request counting the session against your plan.

**Never sent (per the vendor's telemetry/privacy documentation):**
- Raw camera frames or any video.
- Any measured metric values — breathing rates, pulse, waveforms, or any
  other measurement output.
- File paths, prompts or free text, user or stable device identifiers.

**SDK telemetry (aggregate session stats):** the SDK *can* send one
aggregate release-quality summary per session (build/version, platform, session
shape, performance and quality counters, timestamp) — but it **defaults to
on only in the raw SDK**. Our wrapper sets `enableTelemetry: false`, so in
this build that summary is **not sent at all**. The claim in this document
is therefore stronger than the SDK's default: telemetry off, not merely
disclosed.

If any of the gating calls fail, the session does not start measuring —
you will see a clear error rather than a degraded guess, and the guide
falls back to running on its own (§7).

## 6. What is NOT involved

- No third-party or AI service. The SDK's natural-language "insight" feature
  is deliberately unused: free-form output cannot be constrained to
  observation-only wording, which this app's rules require.
- No advertising, no fingerprinting, no cross-site tracking.

## 8. Pair mode — data flow

Pair mode runs on **one host server and two browsers**. The host runs the
local program (server, one SDK worker per participant). The joining
participant's browser sends frames to the host; the host's own browser sends
its frames to the same local server. Everything below that is already true
in solo mode stops being quite so local for the joiner:

| Item | Joiner's device | Host's machine | Other participant |
| --- | --- | --- | --- |
| Camera frames | Captured in the browser; sent to host over the connection; discarded in memory after processing | Received, routed to that participant's own measurement worker only; discarded after processing; never stored | **Never received.** The server never relays frames to the other participant |
| Breathing estimates | Their own estimate arrives back (their screen) | Their own estimate arrives back too | Only the measuring person's own estimate — and only if they toggle sharing on |
| Alignment | Abstract two-orb visual + band | Same | Same (rate similarity only, no numbers by default) |
| Peer presence/signals | Abstract status ("waiting for signal") | Same | Same |
| Consent, labels, room code | Sent (label + code) | Sent (label + code) | Shown as label only |
| Vendor (Presage) traffic | None directly | Key check, device pairing, metrics authorization, usage verification (§5) — **twice** the usage for a pair session (one worker per participant) | None |

- **Privacy defaults:** each person sees only their own breathing rate.
  The partner's rate is shown **only** if that person explicitly toggles
  "Share my breathing rate with my partner" (off by default, revocable
  anytime, each side labeled with who sees what).
- **Rooms exist only in memory** and vanish when empty; codes expire after
  15 minutes unused; nothing about the room is logged beyond ids and
  counters.
- **Topology limitation (stated plainly):** the joining participant's
  frames leave their device and reach the host machine. Camera access
  requires a secure context (localhost for the host; HTTPS — e.g. a secure
  tunnel — for another device). If the host is a shared/cloud machine,
  frames transit that infrastructure. A future relay design (each person
  runs a local instance; only abstract values travel) would avoid this;
  it is documented in `docs/PAIR_DESIGN.md` and not yet built.


## 7. Consent behavior

- Consent is per page load: reloading asks again.
- The camera is opened only after the explicit "I understand, start camera"
  button is clicked. Page load alone opens nothing.
- Revoking consent mid-session ends the session and stops all sampling.
- If you decline the camera permission, you are offered **guide-only mode**:
  a steady pacing guide with no sensing at all (see the Step 5 robustness
  work). In guide-only mode nothing is collected.
- Camera denied/unplugged mid-session ends sensing safely; the camera is
  released rather than left running.
- **Pair mode:** consent is per person and can never be given for someone
  else. The joiner's consent screen states plainly that their frames go to
  the host's computer (see §8). Revoking consent ends only that side; the
  partner is told calmly and the guide keeps running for them.
