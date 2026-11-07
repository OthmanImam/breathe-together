# Submission — Breathe Together

> **Not a medical device. Not for diagnosis or treatment.** The app is an
> observation-only pacing exercise: it reports breathing rates over time
> and how a guide responded. It makes no medical claims of any kind.

## Prize Categories

Entering **all three**: overall winner, **Most Creative or Delightful
Use**, and **Best Thoughtful Real-World Use**.

## What it is

Breathe Together is a camera-driven breathing coach built on the Presage
SmartSpectra SDK. It estimates your breathing rhythm from your webcam,
then eases a pacing guide gently toward slower breathing over a 3-minute
session — a slow control loop, confidence-gated, that never scolds. Solo
mode is a one-person session; "Breathe with someone" mode gives two
people one shared pacer, with two orbs on screen that drift closer as the
two measured rates get more similar.

The live Presage signal in use: **breathing rate** (the SDK's 30-second
trailing average), plus its documented validation statuses, which drive
setup guidance and signal-loss behavior. Pulse/HRV are not requested.

## Use of underlying technology

- `@smartspectra/node-sdk` v3.4.0 (Presage Technologies), isolated in a
  dedicated child process per participant — native SDK state is
  process-global, so the engine can be restarted and supervised without
  touching the app.
- Browser-owned cameras (`getUserMedia`), frames downscaled to 320×240
  RGBA at 15 fps and pushed over WebSocket into `useCustomInput()` /
  `sendFrame()` — the SDK's documented host-supplied path. Telemetry is
  disabled in our wrapper (`enableTelemetry: false`).
- Reported rate is the documented 30 s trailing average; the coach's
  calibration (45 s) and Hold threshold (35 s sustained divergence) are
  tuned around that lag, and the mock signal models the same 30 s window.
- The shared pacer is a **max of the two solo coaches' proposals** (the
  gentler one wins) and never speeds up to chase anyone.
- See `docs/SDK_NOTES.md §14` and `NOTICE.md`.

## Usability and user experience

Consent (per page load) → setup with live framing guidance and a Ready
indicator → session with an interpolated pacer orb, synthesized tones,
audio-only and reduced-motion modes, friendly state labels
("Settling in", "Matching your pace", "Slowing gently", "Staying with
you", "Winding down") → observation-only summary. Pair mode adds a
lobby (room code, labels, readiness), two orbs with a shared glow, and an
alignment view that is never numeric by default (optional small
percentage toggle). Full keyboard operation, visible focus, ARIA live
regions, responsive dark/light themes.

## Originality and creativity

The shared-pacer rule (one tempo, led by the slower-settling person,
descending only when *both* people follow) turns a solo exercise into a
shared visual that can't fake togetherness — it can only show rate
similarity, slowly, with hysteresis. Privacy defaults are part of the
design: each person sees only their own rate; the partner gets an
abstract visual unless sharing is explicitly toggled on.

## Consent and Data Handling

See `docs/CONSENT_AND_DATA.md` (the full, current document). Short version:

- Camera starts only after an explicit consent click, per person, per
  page load. Nobody consents for someone else. The joiner's consent screen
  names the host's machine as the recipient of their frames.
- Frames travel browser → host server → measurement worker on the **same
  machine**; consumed in memory, discarded immediately, never stored.
  The server never relays frames to the other participant.
- What leaves the device: only the vendor's account-gating calls (API-key
  check, device pairing, metrics authorization, usage verification).
  No frames, no measured values, no identifiers — per the vendor's own
  telemetry/privacy documentation. The aggregate telemetry the SDK
  *defaults on* is switched off in this build.
- Nothing is saved by default (no history; opt-in local history, off,
  deletable in-app). Rooms exist only in memory and vanish when empty.
- A Stop button is always visible while the camera is on; revoking
  consent ends the session and stops sampling. Denied camera → guide-only
  mode (steady pacer, no sensing).

## Running it (for judges)

```bash
npm install
cp .env.example .env   # no key needed for the mock demo

npm run serve          # mock mode: everything works with zero credentials
# open http://localhost:3000, consent, begin, done
```

Mock mode is the full app (both solo and pair) on a seeded simulation —
no account, no key, no camera measurement, but the complete UX including
consent, lobby, shared pacer, alignment, and summaries. Pair mode in
mock: open the page twice (or a second device via HTTPS), choose *Breathe
with someone*, create/join with the code, both sides press ready, host
starts (max 5 minutes — the cap is enforced).

```bash
SIGNAL_SOURCE=sdk npm run serve   # real measurement (needs a free key)
```

Keyed run: get a free key at physiology.presagetech.com, put it in `.env`
as `SMARTSPECTRA_API_KEY`, run the server on a machine with a camera,
open `localhost:3000` locally, and do a 3-minute session. The daily
budget is 60 participant-minutes by default (see `config.sdk`), shown
before pair sessions; usage is counted per person. Smoke test:
`npm run smoke:sdk` (keyless: verifies native load + camera discovery).

No login is required anywhere. If you only try one thing, try the mock
pair demo: two browsers on the same host, create room, join with the
code, watch both orbs follow the shared guide.

## Demo video note

The video shows the live SDK signal (breathing rate driving the coach,
validation statuses, and the shared pacer in pair mode) from the host
machine. Mock-mode footage is labeled as mock wherever it appears; the
repository distinguishes the two everywhere (see `docs/SDK_NOTES.md §14.7`).

## Links

- Repository: https://github.com/OthmanImam/breathe-together
- SDK: `@smartspectra/node-sdk` v3.4.0 — attribution in `NOTICE.md`
- Agent session record: `docs/BUILD_LOG.md` (curated working-session log)
