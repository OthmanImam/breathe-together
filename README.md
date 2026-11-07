# Breathe Together

A wellness breathing coach for the Presage SmartSpectra SDK Challenge (DEV,
deadline Nov 22, 11:59 PM PST). It follows your breathing rhythm as seen by
your camera and adapts a breathing pacer to you — easing the pace gently
toward slow, quiet breathing over the course of a short session. In pair
mode, two people share one pacer, led by the slower-settling person.

> **Not a medical device. Not for diagnosis or treatment.** Everything in this
> app is observation-only. There are no scores, verdicts, warnings, or
> implications about your body — only what the camera saw during the session
> and how the pacing responded.

## Status — complete (Phases 1–3)

A complete browser app: consent → setup → session (pacer orb + tones) →
observation-only summary, in solo mode and in two-person pair mode. Two
signal sources, one coach:

- **mock** (default) — a seeded simulation, no camera measurement. The
  browser still opens the camera after consent (for the preview), but the
  mock ignores frame content.
- **sdk** — the real `@smartspectra/node-sdk` v3.4.0 in an isolated child
  process per participant, fed by 320×240 RGBA frames from the browser over
  WebSocket. Needs an API key (see Setup). Telemetry is disabled in the
  wrapper; a live keyed run authenticated and emitted real validation
  codes (see `docs/SDK_NOTES.md §14.7`).

`npm test` runs 128 tests, including protocol validation, room lifecycle,
server-over-WebSocket integration (solo and pair), signal supervision, SDK
mapping, pair simulation scenarios, the observed phase-lock skew, and a
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
runs on your machine; the server binds locally. Pair mode
(`simulate:pair`, lobby flow, HTTPS note) is below — the app speaks for
itself once the page is open.

**Pair mode ("Breathe with someone"):**

1. Host: choose *Breathe with someone* in Setup → **Create room** → share
   the 6-letter code.
2. Joiner: open the app (HTTPS required off the host machine — localhost
   works for the host; a phone needs an HTTPS route such as the dev
   workspace tunnel), read the consent (their frames go to the host machine
   — the consent screen says so plainly), enter the code, press **I'm
   ready**.
3. The host sees both people ready → **Start together**. Each side keeps
   their own rate private by default; toggle *Share my breathing rate* to
   see each other's numbers. The shared pacer is the gentler of the two
   solo paces, and never speeds up to chase anyone. Pair sessions are
   capped at 5 minutes and count against the daily SDK budget **twice**
   (one measurement worker per person) — the lobby shows the remaining
   budget before starting.

Pair simulation (two mock participants, one coordinator, timeline + the
measured phase-lock skew between the two screens):

```bash
npm run simulate:pair -- --a agitated_then_settling --b calm --minutes 3 --seed 7
```

## Built with

- [`@smartspectra/node-sdk` v3.4.0](https://www.npmjs.com/package/@smartspectra/node-sdk)
  (Presage Technologies) — see `NOTICE.md` for attribution and terms.
- The [`using-smartspectra` agent skill](https://smartspectra.presagetech.com/skill.md)
  and the [SmartSpectra docs](https://smartspectra.presagetech.com/) —
  every SDK decision in `docs/SDK_NOTES.md` traces to a published page.
- The [model cards and limitations](https://smartspectra.presagetech.com/docs/model-cards-and-limitations.md),
  one of which pins the breathing-rate facts our coach is tuned around:
  a 30-second trailing average, confidence 0 until the window fills.

**SDK mode:**

```bash
SIGNAL_SOURCE=sdk npm run serve
```

The server refuses to start in this mode without `SMARTSPECTRA_API_KEY`
(fail-fast with a clear message). The SDK child process is spawned per
session and killed when the session ends; a daily budget
(`config.sdk.dailyCapMinutes`, default 60 participant-minutes) stops
measurement when reached, with a plain notice in the UI.

**SDK smoke test** (loads the real native SDK, lists cameras, and with a key
runs a 30 s synthetic-frame session — samples only, no images):

```bash
npm run smoke:sdk                         # keyless: load + discovery only
SMARTSPECTRA_API_KEY=… npm run smoke:sdk  # full 30 s check
```

**Headless simulation** (deterministic, accelerated time):

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

`.env` is loaded automatically by the `serve` and `smoke:sdk` scripts
(`--env-file-if-exists=.env`).

## Troubleshooting

- **"No clear view" notices:** move to even light, face the camera, center
  your face in the preview. The Setup screen shows live guidance.
- **Camera permission denied:** allow it in the browser, or choose
  *Continue with guide only* on the consent screen — a steady pacer with
  no sensing.
- **Signal lag:** the SDK reports breathing rate as a **30-second trailing
  average** (confidence 0 until the window fills), so the first trustworthy
  reading lands around 30 s. The coach's 45 s calibration phase absorbs
  this by design — don't chase the number, and expect a slow reaction
  (Hold engages after ~35–65 s of sustained divergence, never at the
  first wobble).
- **SDK errors / credits:** the server logs SDK error codes; a daily cap
  stops measurement politely when the budget is spent. Auth failures
  (403s) degrade the session to the guide with an honest notice — they
  never fabricate a signal.
- **Pair room code not found / expired:** codes live 15 minutes and die
  with the room. Ask the host to create a new one.
- **Joining from a phone?** The page must be served over HTTPS (or be
  localhost). The app says so plainly if the camera can't start.
- **WebSocket drop:** the session ends safely, the camera turns off, and a
  reconnect is offered.

## Known limitations

- Pair mode runs on a **host-topology**: the joiner's frames travel to the
  host machine (disclosed in consent; discarded in memory, never stored).
  A local-relay design would avoid this and is seam-ready
  (`docs/PAIR_DESIGN.md §3a`) but not built.
- Alignment thresholds are **UNVALIDATED** on real data (no real-face
  results file yet); the mock models the documented 30 s reporting window,
  so the coach logic is lag-tested, but the pair constants need a real
  two-person session to tune against.
- SDK sample cadence (Hz) is undocumented; the normalizer is time-based, so
  this changes nothing structurally, but mock realism vs. real cadence is
  unverified until a live keyed run.
- The minimum frame rate/resolution the engine accepts is undocumented; the
  app sends 320×240 at 15 fps and watches validation codes for feedback.

## Structure

```
src/
  config.ts               all tunables, documented (incl. UNVALIDATED pair consts)
  signal/                 SignalSource contract, normalizer, mock (30s window),
                          supervisor, SDK source + worker + mapping, fake SDK
  coach/                  pacer, state machine, sync (alignment), roomCoach
                          (shared pacer), observation-only summary
  server/                 protocol, rooms (pair codes/expiry/host), session
                          pipeline, express+ws
  client/                 browser app (camera, ws, audio, orb, lobby, main)
  sim/                    headless solo + pair simulation CLIs
public/
  index.html              client shell (all screens, all element ids)
  styles.css              calm dark/light theme (pure CSS, no external assets)
docs/
  SDK_NOTES.md            SDK research + Phase 2 integration decisions
  PAIR_DESIGN.md          pair topology, quota, alignment, shared-pacer rule
  ARCHITECTURE.md         system diagrams (solo + pair), sync, failure modes
  CONSENT_AND_DATA.md     consent + data handling incl. pair data-flow table
  DEMO_SCRIPT.md          narrated walkthroughs (solo + pair)
  SUBMISSION.md           DEV challenge submission (template-shaped)
  DEV_POST.md             DEV post content (both prize categories)
  BUILD_LOG.md            curated agent-session record (embed-ready)
NOTICE.md                 third-party (Presage) attribution + terms
```

## Hard rules honored in this repo

- Wellness/relaxation only; user-facing copy is observation-only (enforced
  by `test/wordingGate.test.ts` across `src/`, `docs/`, `public/` —
  including relational vocabulary the pair UI must never imply).
- No SDK API is invented: unknowns live in `docs/SDK_NOTES.md` and degrade
  honestly (never guessed).
- Camera only after explicit consent, per person; Stop is always visible;
  consent is per page load; nothing is saved by default.
- No secrets: `.env` is git-ignored; `.env.example` holds only empty keys.
