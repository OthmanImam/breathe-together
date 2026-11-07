# Build log — Phases 1–3 (curated agent-session record)

A sanitized, publication-ready record of the working sessions. This is
the version meant to be embedded in an article; note at the bottom for how
to produce it from the raw agent transcript.

## Session facts

- Machine: Windows 11, Node v22, git 2.50, `gh` CLI.
- Repo: <https://github.com/OthmanImam/breathe-together>, one commit per step,
  `main`_branch, all work under `C:\Users\<user>\Documents\breathe-together`.
- Result: `tsc --noEmit` clean, `eslint` clean, **50 tests green** in the
  `node --test` runner (with `tsx`), simulation runs for all five mock
  scenarios.

## Phase 2–3 addendum (server, UI, consent, real SDK, pair mode)

The Phase 1 steps above are condensed from the first working session; the
full step-by-step record is in git history. What followed, in the same
process (commit per step, 97→128 tests):

- **Step 0 trap caught before code:** the prompt assumed the camera path
  would be SDK-owned. Re-reading the live docs showed `useCamera` exists —
  the design instead put the camera in the browser (the consent prompt and
  preview need it) and feeds frames via the documented `useCustomInput`
  path. Electron was considered and rejected with reasons. That one
  decision shaped every later step.
- **A real bug found by the user, not the tests:** the client's `hello`
  was sent while the socket was still CONNECTING and silently dropped —
  sessions never started in a real browser. Fixed with an outbound queue
  and a regression test that reproduces the race. Found because a human
  actually used the app.
- **Live SDK findings:** the real `@smartspectra/node-sdk` loads natively
  (win32-x64 + linux-x64), discovered the webcam, authenticated with a
  real key, and emitted genuine validation codes. It also wedged on
  `kProcessingFailed` with synthetic frames — recovery (`reset()` +
  re-select input + restart) implemented and test-verified. A container
  run showed the auth server refusing pairing/authorization from
  datacenter egress (403s) — the app degraded to guide-only instead of
  faking a signal, exactly as the rules require.
- **Coach math updated from docs:** breathing rate is a 30-second trailing
  average (confidence 0 until the window fills), so Hold was made
  trend-aware (35 s sustained-divergence streak + convergence reset) and
  the mock rebuilt to report the same 30 s window. The naïve version
  would have punished users for following "too slowly" — the lag, not the
  person, was the problem.
- **Pair mode (Phase 3)** reused everything: expiring room codes,
  per-participant pipelines on the same substrate, one shared pacer (max
  of solo proposals — the gentle one wins), an alignment metric that
  freezes on signal loss, quota counted per participant-minute with
  pre-start refusal, and an UNVALIDATED-marking policy for every
  threshold with no real-face data yet.

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
