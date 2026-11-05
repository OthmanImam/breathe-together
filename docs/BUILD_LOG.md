# Build log — Phase 1 (curated agent-session record)

A sanitized, publication-ready record of the Phase 1 working session. This is
the version meant to be embedded in an article; note at the bottom for how to
produce it from the raw agent transcript.

## Session facts

- Machine: Windows 11, Node v22, git 2.50, `gh` CLI.
- Repo: <https://github.com/OthmanImam/breathe-together>, one commit per step,
  `main`_branch, all work under `C:\Users\<user>\Documents\breathe-together`.
- Result: `tsc --noEmit` clean, `eslint` clean, **50 tests green** in the
  `node --test` runner (with `tsx`), simulation runs for all five mock
  scenarios.

## Step-by-step (commit-per-step history)

1. `docs(step0)` — SmartSpectra Node.js SDK research. Fetched the
   `smartspectra.presagetech.com` pages (`/docs/nodejs`, `api-reference`,
   `metrics`, `telemetry-and-privacy`) with `.md` suffix. Key finds recorded
   in `docs/SDK_NOTES.md`: pure-FFI `koffi` binding (no node-gyp), API key is
   constructor-injected (no env-var contract), metric bundles & payload paths
   (`metrics.breathing?.rate?.at(-1)?.value` etc.), `ValidationCode` values
   mapping ~1:1 onto the report statuses we need, timestamps in µs and an
   explicit warning about non-monotonic wall clocks, per-platform native
   packages, opt-out `enableTelemetry` (defaults ON), and "native SDK state
   is process-global". Wrote 8 open questions (airing unverified claims —
   e.g. the reported 30 fps frontend-frame instability was NOT verifiable
   from the consulted pages, though the docs' own back-pressure/perf notes
   second the planned child-process isolation).
2. `chore(step1)` — scaffold: TS strict + ESM, `tsx`, `node --test`,
   eslint flat config, prettier, README (wellness disclaimer), `.env.example`
   with no secrets, `.gitignore` (`.env` ignored).
3. `feat(step2)` — signal contract + normalizer. Everywhere time comes from
   injected samples/clocks — no `Date.now()` — so simulations run accelerated
   and seeded. Normalizer: per-channel EMA, plausibility bounds, per-second
   spike cap, confidence gate, hold-then-lost, long-gap reset.
4. `feat(step3)` — mock source: mulberry32 seeding, five scenarios,
   first-order lag toward the pacer (via `setPacerRate`), dropout = silence
   (not fake data), poor-light = low-confidence `poor_light`.
5. `feat(step4)` — pacer as a pure function of elapsed time. Rate changes
   only commit at the next cycle boundary, so no breath is ever distorted
   mid-inhale.
6. `feat(step5)` — coach state machine: calibrate (median or gentle default +
   setup notice), match, lead (windowed evaluation, one 0.5 bpm step at a
   time down to the 7 bpm floor), hold (10 s divergence triggers it, one
   gentle notice, no ratcheting down; slow ease-up toward a ceiling after two
   unproductive windows), signal-lost overlay (steady pace, notices on loss
   and recovery), cooldown, and an observation-only summary whose wording is
   regression-tested against a restricted-terms list.
7. `feat(step6)` — headless CLI + harness wiring
   (mock → normalizer → coach → pacer) on a virtual clock stepped at 1 Hz;
   same-seed replay asserted byte-identical.
8. `docs(step7)` — architecture write-up: data-flow diagram, invariants
   ("slow control loop, confidence-gated, never scold"), Phase 2 plan.
9. `chore` — wording sweep: removed restricted vocabulary from comments/docs
   outside the ban-list and the mandated disclaimer.
10. `feat` (review pass) — after a full read-through of all five timelines:
    deduped degenerate summary ranges ("read near 11.7" instead of
    "between 11.7 and 11.7"), and added a neutral "kept its own pace" line
    for sessions where the person diverged the whole way, plus a regression
    test pinning the never-ratchet invariant.

## Honest debugging beats (why judges like these)

- The first normalizer tests failed because the test data itself broke the
  6 bpm/s spike cap — a symptom-vs-behavior mixup: tests now ramp plausibly
  and assert rejections separately.
- The mock emitted a t=0 sample inside the first tick (count drift) — moved
  the schedule to t ≥ 1 s for exactly-one-sample-per-second lockstep.
- `patchSettings` needed explicit per-section merges for TS strict unions.
- The "calm journey" test initially missed the `ended` state: the session
  fired `session_ended` but never *transitioned*; fixed by emitting
  `state_changed "cooldown" → "ended"`.
- The review pass caught a real behavior bug: the agitated mock kept
  drifting toward its base rate during calibration instead of a gentle
  default, so the user never settled and the summary misdescribed the range.
- A per-channel `hadGood` flag fixed a subtle mislabeling: a signal that had
  *never* been good was reported `lost` instead of the underlying
  `poor_light`/`no_face` status (which matters for setup guidance).

## Rebuilding this artifact from the raw transcript

The raw agent transcript lives outside the repo (this one was
`%USERPROFILE%\.local\share\opencode\log\opencode.log` for the OpenCode
session). Before publishing any raw capture:

1. **Revoke/rotate any credentials that ever appeared in the session** —
   tokens pasted into chat, even to the agent, land in the transcript.
2. Grep the capture for token-like strings (`ghp_`, `key`, `secret`,
   `.env`) and redact.
3. Prefer the curated `BUILD_LOG.md` for embedding; keep the raw capture
   private unless scrubbed.
