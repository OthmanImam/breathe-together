# Breathe Together

A wellness breathing coach for the Presage SmartSpectra SDK Challenge (DEV,
deadline Nov 22, 11:59 PM PST). It follows your breathing rhythm as seen by
your camera and adapts a breathing pacer to you — easing the pace gently
toward slow, quiet breathing over the course of a short session.

> **Not a medical device. Not for diagnosis or treatment.** Everything in this
> app is observation-only. There are no scores, verdicts, warnings, or
> implications about your body — only what the camera saw during the session
> and how the pacing responded.

## Status — Phase 1 (foundation only)

No UI and no real SDK integration yet. What exists:

- `docs/SDK_NOTES.md` — research on `@smartspectra/node-sdk` (install, auth,
  metric names and payload shapes, validation codes, telemetry) + open
  questions.
- `src/config.ts` — every tunable in one documented place.
- `src/signal/` — `SignalSource` contract, deterministic mock source (5
  scenarios), and a normalizer (EMA smoothing, plausibility bounds, spike
  rejection, confidence gating with hold-then-lost).
- `src/coach/` — pacer (pure timing, next-boundary rate changes), coach state
  machine (calibrate → match → lead → hold → cooldown), and an
  observation-only session summary.
- `src/sim/` — headless simulation CLI and shared harness running at
  accelerated virtual time.

## Run

```bash
npm install
npm run typecheck   # strict TypeScript
npm run lint        # eslint
npm test            # node:test suite (48 tests)

# headless simulation — accelerated time, no camera, prints a timeline:
npm run simulate -- --scenario agitated_then_settling --minutes 3 --seed 42
```

Simulation scenarios: `calm`, `agitated_then_settling`, `ignores_pacer`,
`dropout`, `bad_light`. Options: `--minutes` 3/5/10 (default 3), `--seed`
integer (same seed = identical run).

`npm run dev` reruns the agitated-then-settling simulation in watch mode.

## Structure

```
src/
  config.ts              all tunables, documented
  signal/SignalSource.ts contract + types (what the real SDK source will implement)
  signal/mockSource.ts   seeded, scenario-driven mock
  signal/normalizer.ts   smoothing, bounds, spikes, hold/lost
  coach/pacer.ts         inhale/exhale timing as a pure function of time
  coach/stateMachine.ts  calibrate/match/lead/hold/cooldown + events
  coach/summary.ts       observation-only wording (regression-tested)
  sim/harness.ts         deterministic pipeline wiring on a virtual clock
  sim/run.ts             CLI
docs/
  SDK_NOTES.md
  ARCHITECTURE.md
```

## Hard rules honored in this repo

- Wellness/relaxation only; all observation wording is deliberately neutral
  (the wording-safety test enforces a restricted-terms list over summary and
  notice copy).
- No SDK API is invented: Phase 1 contains no SDK code; unknowns are in
  `docs/SDK_NOTES.md`, everything else runs on the mock.
- No secrets: `.env` is git-ignored; `.env.example` holds only empty keys.
