# Breathe Together

A wellness breathing coach that watches nothing, tracks you at your own rhythm, and adapts
a visual breathing pacer to your **live breathing rate** — pacing you gently toward a slower,
quieter breathing pattern over the course of a short session.

- **Not a medical device. Not for diagnosis or treatment.** All wording in the app is
  observation-only; we never frame anything as a health outcome.
- Personal project for the Presage SmartSpectra SDK Challenge.

## Status (Phase 1)

Foundation only: signal contract, mock signal source, normalizer, coach state machine,
pacer, and a headless simulation. No UI and no SDK integration yet.

## Run

```bash
npm install
npm run typecheck
npm run lint
npm test

# headless simulation (accelerated time, no camera):
npm run simulate -- --scenario agitated_then_settling --minutes 3 --seed 42
```

Scenarios: `calm`, `agitated_then_settling`, `ignores_pacer`, `dropout`, `bad_light`.

`npm run dev` runs the same simulation in watch mode.

See `docs/ARCHITECTURE.md` and `docs/SDK_NOTES.md`.
