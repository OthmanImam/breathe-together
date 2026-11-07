*This is a submission for the [Presage SmartSpectra SDK Challenge](https://dev.to/challenges/presage-2026-11-04)*

> **Not a medical device. Not for diagnosis or treatment.** Everything below
> describes an observation-only pacing exercise: breathing rates over time
> and how a shared guide responded. Nothing is a verdict about anyone's
> body or state of mind.

## What I Built

Breathe Together is a camera-driven breathing coach built on the Presage
SmartSpectra SDK. It estimates your breathing rhythm from your webcam and
then eases a pacing guide gently toward slower breathing over a short
session — a slow control loop, confidence-gated, that never scolds. Solo
mode is a one-person session; **"Breathe with someone"** mode gives two
people one shared pacer, with two orbs on screen that drift closer as the
two measured rates get more similar.

The experience: consent (nothing opens the camera until you say so) →
setup with live framing guidance ("Center your face", "Move to better
light", then "Ready") → a session with a luminous pacer orb, synthesized
inhale/exhale tones, small rate readout, and friendly state labels
("Settling in", "Matching your pace", "Slowing gently", "Staying with
you", "Winding down") → an observation-only summary: what the pacing did,
what the camera saw, and nothing beyond that.

## Demo

<!-- FACE(S) + LIVE SDK SIGNAL GO HERE: this must be SDK mode (SIGNAL_SOURCE=sdk),
     not the mock. Record on the host machine: consent -> live rate ->
     orb matching -> deliberately breathe faster -> Hold ("Taking it
     slowly with you") -> summary. Label any mock footage as mock. -->

[Your demo video here — 3-minute live SDK run]

What to look for in the video: the observed breathing rate tracking the
camera, the pacer starting at the gentle default during calibration and
then leading down, the Hold behavior when the person deliberately diverges
(the coach slows to "Staying with you" instead of pushing), and the final
observation-only summary.

## Code

Repository: https://github.com/OthmanImam/breathe-together

Setup:

```bash
npm install
cp .env.example .env   # no key needed for the mock demo

npm run serve          # mock mode: everything works with zero credentials
# open http://localhost:3000
```

Real measurement:

```bash
# free key from https://physiology.presagetech.com/auth/login into .env
SIGNAL_SOURCE=sdk npm run serve    # on a machine with a camera
```

Pair mode (both mock and SDK): choose *Breathe with someone* → Create room
→ join from a second browser (needs HTTPS off the host machine) → lobby →
host presses Start. Pair sessions are capped at 5 minutes and count
against the daily SDK budget twice (one worker per person) — the lobby
shows the remaining budget before starting. Test commands:

```bash
npm test                                   # 128 tests
npm run simulate:pair -- --a agitated_then_settling --b calm --minutes 3 --seed 7
npm run smoke:sdk                          # SDK native-load + camera discovery
```

## How It Responds to Human Signals

**Signal used:** breathing rate — the SDK's 30-second trailing average —
plus its documented validation statuses (`ok`, `no_face`, `poor_light`,
`off_center`, `starting`, `lost`), which drive setup guidance, the signal-
loss behavior, and when the coach trusts a reading.

**Integration:** the browser owns the camera (consent prompt and preview
only exist there), downscales frames to 320×240 RGBA at 15 fps, and pushes
them over WebSocket into `useCustomInput()` / `sendFrame()` in a **dedicated
child process** — the native SDK state is process-global, so the engine
gets its own process that can be restarted and supervised without touching
the app. Only the breathing-metrics bundle is requested; aggregate
telemetry is disabled (`enableTelemetry: false`), credibly matching the
SDK's own privacy documentation.

**Response:** the coach is a slow control loop over windowed evaluations,
never per-second reactions. Calibrate (45 s — comfortably covers the 30 s
reporting window), match, lead (one 0.5 bpm step at a time toward a 7 bpm
floor), hold (sustained divergence ≥ 35 s, trend-aware so the reporting
lag alone can't trigger it), and a signal-lost overlay where the pacer keeps
cycling steadily. The shared pair pacer is the maximum of the two solo
coaches' proposals — the gentler person leads it, and it never speeds up to
chase anyone. Alignment is a separate slow metric (EMA with τ ≥ 30 s,
hysteresis, freeze-on-loss) describing rate similarity only.

## Prize Categories

Entering **both** prize categories (and the overall pool).

**Most Creative or Delightful Use.** The question we started from: what
does a shared breathing guide *look like*? Pair mode answers with two orbs
of light that breathe one shared pacer — phase-locked to within 100 ms
across the two screens — and drift closer with a strengthening glow as the
two measured rates converge. It's playful but honest: the visual can't
fake togetherness; it only shows rate similarity, slowly, with hysteresis
so nothing flickers. The most creative constraint, though, is negative:
the shared pacer never pushes anyone. If one person diverges, the guide
holds steady — delight without pressure.

**Best Thoughtful Real-World Use.** The real-world need is wellbeing that
doesn't surveil: people want breathing exercises without trusting a camera
feed to a server, a dashboard, or a verdict about their emotions. So the
defaults are the product: consent per person per visit (nobody consents
for someone else), frames discarded in memory (never stored, never
relayed to the partner), per-person rates private unless explicitly shared,
a visible Stop, guide-only mode when the camera is denied, and a summary
that says exactly what it says — "a plain rundown of the session, with
nothing more implied." Room hygiene matches: in-memory rooms, expiring
codes, expiring credentials-free design, quota counted per person so free-
trial credits can't be silently burned.

## Consent and Data Handling

- The camera opens **only after an explicit consent click**, per person,
  per page load. Revoking ends the session and stops sampling; Stop is
  always visible while the camera is on; cameras stop when the room
  closes, consent is revoked, or the server shuts down.
- Frames travel browser → host server → measurement worker on the **same
  machine** (the architecture is localhost; deployments elsewhere would
  move frames onto that infrastructure and are out of scope). They are
  consumed in memory and discarded — never written to disk, never relayed
  to the other participant. The server never relays raw frames, and never
  relays breathing rates unless that person opted in (off by default).
- Vendor traffic (observed in live SDK logs): the engine contacts Presage
  for account gating only — API-key check, device pairing, metrics
  authorization, usage verification. No frames, no measured values, no
  identifiers. The aggregate telemetry the SDK defaults **on** is disabled
  in this build (`enableTelemetry: false`); that is stronger than disclosure.
- Storage: nothing by default. No history, no database, no server logs
  beyond counters and ids. An optional local history (off) stores summary
  text lines in `localStorage`, deletable in-app ("Delete my data").
- Retention/deletion: rooms vanish when empty; closing the tab discards
  the in-memory session; there is nothing server-side to delete.
- Third-party/AI service use: none. The SDK's natural-language "insight"
  feature is deliberately unused (free-form output can't be constrained
  to observation-only wording). The build itself used Presage's agent
  skill and docs (see below), which doesn't affect your data.
- Live behavior with denials: camera denied → guide-only (steady pacer,
  zero sensing); signal lost mid-session → pacer continues, gentle notice,
  automatic recovery; source crash → supervised restart with backoff, then
  guide-only with an honest notice.

Full current document: `docs/CONSENT_AND_DATA.md` in the repository.

## Agent Session

Built with AI assistance (OpenCode agent + the Presage `using-smartspectra`
agent skill and published docs). A curated, publication-ready record of the
working sessions — including honest debugging beats, the real bugs found,
and the SDK findings — is at `docs/BUILD_LOG.md` in the repository.
<!-- Upload the transcript via https://dev.to/agent_sessions/new, make it
     public, and embed it here. Scrub keys first (revoke anything that
     appears). The curated record above is the fallback if you skip it. -->

<!-- Thanks for participating! -->
