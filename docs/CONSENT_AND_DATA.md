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
  measurement engine running in its own process on the same machine.
- **Nothing is saved by default.** No video is stored, no history is kept, and
  the session data in memory is discarded when the page is closed.
- The camera picture itself never leaves your device. It is analyzed where it
  was taken.
- Consent is asked again on every page load. The Stop button — always visible
  while the camera is on — ends the session and releases the camera
  immediately.

## 2. Exactly what is collected

| Item | Collected? | Details |
| --- | --- | --- |
| Camera frames | While consented only | The browser captures 320×240 RGBA frames at up to 15 fps and sends them over a WebSocket to the local server on this machine. Frames are never written to disk. |
| Breathing rhythm estimate | While a session/preview runs | A number (breaths per minute), a confidence value, and a readiness status (`ok`, `no_face`, `poor_light`, `off_center`, `starting`, `lost`). This is the only per-person measurement the coach consumes. |
| Session summary numbers | In memory only | Start/end pacing rates, minutes near the pacing rhythm, minutes without a clear view. Kept in RAM to render the summary screen; discarded with the page. |
| Account / identity | No | No accounts, no names, no emails, no device identifiers. |
| IP address / location | No | Everything runs against `localhost`. The server binds locally and is not exposed. |
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

## 5. The measurement SDK's own data behavior (per its privacy documentation)

The SmartSpectra SDK's documented telemetry behavior, quoted and paraphrased
from <https://smartspectra.presagetech.com/docs/telemetry-and-privacy>:

- The SDK sends **one aggregate, per-session telemetry summary** to the
  vendor's servers: build/version, platform/device info, session shape,
  performance counters, quality counts, and a wall-clock timestamp.
- **Never collected, per that documentation:** raw frames, any measured metric
  values (breathing rates, pulse, and so on), file paths, prompts or free
  text, user or stable device identifiers. It is not linked to identity and not
  used for tracking.
- Telemetry **defaults to on** in the raw SDK. **Our wrapper disables it**
  (`enableTelemetry: false`) — see `docs/SDK_NOTES.md` §10/§14. Stated here so
  the app's behavior matches this document; the step-6 integration test
  verifies the flag is set.

Separately, the SDK validates your API key against the vendor's server when a
session starts (standard account/key check). Per the documentation, no frames
or measurement values travel with that check.

## 6. What is NOT involved

- No third-party or AI service. The SDK's natural-language "insight" feature
  is deliberately unused: free-form output cannot be constrained to
  observation-only wording, which this app's rules require.
- No advertising, no fingerprinting, no cross-site tracking.

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
