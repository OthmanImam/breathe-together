# Breathe Together

A wellness breathing coach for the Presage SmartSpectra SDK Challenge (DEV,
deadline Nov 22, 11:59 PM PST). It follows your breathing rhythm as seen by
your camera and adapts a breathing pacer to you — easing the pace gently
toward slow, quiet breathing over the course of a short session.

> **Not a medical device. Not for diagnosis or treatment.** Everything in this
> app is observation-only. There are no scores, verdicts, warnings, or
> implications about your body — only what the camera saw during the session
> and how the pacing responded.

## Status — Phase 2 (working solo app)

A complete browser session: consent → setup → session (pacer orb + tones) →
observation-only summary. Two signal sources, one coach:

- **mock** (default) — a seeded simulation, no camera measurement. The
  browser still opens the camera after consent (for the preview), but the
  mock ignores frame content.
- **sdk** — the real `@smartspectra/node-sdk` in an isolated child process,
  fed by 320×240 RGBA frames from the browser over WebSocket. Needs an API
  key (see Setup).

`npm test` runs 97 tests, including protocol validation, room lifecycle,
server-over-WebSocket integration, signal supervision, SDK mapping, and a
wording gate that keeps reserved vocabulary out of all shipped copy.

## Setup

```bash
npm install
cp .env.example .env   # then fill in your key (sdk mode only)
```

**Getting a SmartSpectra API key:** sign in at
<https://physiology.presagetech.com/auth/login> and copy your key into
`SMARTSPECTRA_API_KEY` in `.env`. (The env-var name is our convention; the
SDK itself takes the key as a constructor option — see `docs/SDK_NOTES.md`.)

## Run

```bash
npm run typecheck   # strict TS for server + client
npm run lint        # eslint
npm test            # full test suite

npm run serve       # build client + start the server (mock mode, :3000)
```

Open <http://localhost:3000>, read the consent screen, and begin. Everything
runs on your machine; the server binds locally.

**SDK mode:**

```bash
SIGNAL_SOURCE=sdk npm run serve
```

The server refuses to start in this mode without `SMARTSPECTRA_API_KEY`
(fail-fast with a clear message). The SDK child process is spawned per
session and killed when the session ends; a daily budget
(`config.sdk.dailyCapMinutes`, default 60) stops measurement when reached,
with a plain notice in the UI.

**SDK smoke test** (loads the real native SDK, lists cameras, and with a key
runs a 30 s synthetic-frame session — samples only, no images):

```bash
npm run smoke:sdk                         # keyless: load + discovery only
SMARTSPECTRA_API_KEY=… npm run smoke:sdk  # full 30 s check
```

**Headless simulation** (Phase 1; deterministic, accelerated time):

```bash
npm run simulate -- --scenario agitated_then_settling --minutes 3 --seed 42
```

Scenarios: `calm`, `agitated_then_settling`, `ignores_pacer`, `dropout`,
`bad_light`. `--minutes` 3/5/10, `--seed` for byte-identical replays.

## Environment variables

| Name | Default | Meaning |
| --- | --- | --- |
| `SIGNAL_SOURCE` | `mock` | `mock` or `sdk` |
| `SMARTSPECTRA_API_KEY` | — | Required for `sdk` mode |
| `PORT` | `3000` | HTTP/WebSocket port |
| `NODE_ENV` | unset | `production` disables dev controls |

## Troubleshooting

- **"No clear view" notices:** move to even light, face the camera, center
  your face in the preview. The Setup screen shows live guidance.
- **Camera permission denied:** allow it in the browser, or choose
  *Continue with guide only* on the consent screen — a steady pacer with
  no sensing.
- **Signal lag:** camera-derived breathing estimates update gradually (tens
  of seconds to settle). The coach's 45 s calibration phase absorbs this
  by design; don't chase the number.
- **SDK errors / credits:** the server logs SDK error codes; a daily cap
  stops measurement politely when the budget is spent.
- **WebSocket drop:** the session ends safely, the camera turns off, and a
  reconnect is offered.

## Known limitations

- Solo mode only (pair mode is designed for, not built).
- SDK sample cadence (Hz) is undocumented; the normalizer is time-based, so
  this changes nothing structurally, but mock realism vs. real cadence is
  unverified until a live keyed run.
- The minimum frame rate/resolution the engine accepts is undocumented; the
  app sends 320×240 at 15 fps and watches validation codes for feedback.
- A live authenticated SDK session has not been run from this repo yet (no
  key in the build environment); the IPC path is covered by tests using a
  fake SDK, and the keyless smoke verifies native load + camera discovery.

## Structure

```
src/
  config.ts               all tunables, documented
  signal/                 SignalSource contract, normalizer, mock,
                          supervisor, SDK source + worker + mapping, fake SDK
  coach/                  pacer, state machine, observation-only summary
  server/                 protocol, rooms, session pipeline, express+ws
  client/                 browser app (camera, ws, audio, orb, main)
  sim/                    headless simulation CLI + harness
public/                   static client HTML/CSS (+ built assets, git-ignored)
docs/
  SDK_NOTES.md            SDK research + Phase 2 integration decisions
  ARCHITECTURE.md         system diagram, pacer sync, failure modes
  CONSENT_AND_DATA.md     consent + data handling, matching actual behavior
  DEMO_SCRIPT.md          narrated walkthrough for a live demo
```

## Hard rules honored in this repo

- Wellness/relaxation only; user-facing copy is observation-only (enforced
  by `test/wordingGate.test.ts` across `src/`, `docs/`, `public/`).
- No SDK API is invented: unknowns live in `docs/SDK_NOTES.md` and degrade
  honestly (never guessed).
- Camera only after explicit consent; Stop is always visible; consent is
  per page load; nothing is saved by default.
- No secrets: `.env` is git-ignored; `.env.example` holds only empty keys.
