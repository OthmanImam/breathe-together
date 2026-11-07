# Pair mode — design (Phase 3, Step 0)

> Status: design-first document, written before pair code. Decisions 3a–3d
> below are binding for the implementation steps.
>
> **Data validity:** `docs/REAL_FACE_RESULTS.md` does not exist yet, so all
> alignment thresholds below are **UNVALIDATED on real data**. They are
> derived from the documented 30 s reporting window and the solo coach's
> tuned constants; the real-face check (roadmap: a 3-minute SDK session on
> the host machine) is what validates them. Search this repo for
> `UNVALIDATED` to find every one.

## 3a. Topology — one host server, two browsers

```
 laptop browser (host) ──frames──┐
                                 ▼
                          HOST SERVER (one)
                          ├─ RoomCoach (shared pacer, alignment)
                          ├─ SDK worker child #1 (host participant)
                          └─ SDK worker child #2 (joiner)
                                 ▲
 phone browser (joiner) ──frames─┘
```

- Each browser owns its camera after **its own** consent; frames travel to
  the host machine only. They are consumed in memory and discarded — never
  stored, never relayed to the other participant (server routes frames by
  `(roomId, participantId)` to that participant's pipeline only).
- **Disclosure:** the joining participant's consent screen names the host as
  the recipient of their frames. Frames are raw video pixels in transit
  *to the host* — processing happens on the host, using the same
  discard-after-processing rules as solo.
- **Secure context:** `getUserMedia` requires HTTPS (or localhost). The
  host on localhost works directly; a joiner on another device needs an
  HTTPS route (the dev environment's tunnel, a locally trusted certificate,
  or a deployed HTTPS origin). The app detects a non-secure context and
  shows the fix pointer instead of a broken camera step.
- **PeerLink seam:** `src/coach/sync.ts` and `RoomCoach` consume only
  abstract feeds (`SampleFeed`: normalized samples; `PacerFeed`: shared
  pacer snapshots) — never sockets. A future relay topology (each person
  runs a local instance; only abstract values travel) can drive the same
  coordinator without touching coach/sync code. Not built now; the privacy
  advantage (no video leaves either device) is documented future work.

## 3b. Quota — counted per participant-minute

- Two workers run concurrently ⇒ pair sessions consume quota at 2× wall
  clock. Usage is already accumulated per source (each `SdkSource` writes
  its own seconds to `.bt-usage.json`); the file therefore counts
  **participant-minutes** automatically.
- Before a pair session starts, the server checks
  `used + 2 × duration ≤ cap` and refuses with a clear notice if it would
  exceed the cap mid-session. The lobby shows remaining budget.
- Pair sessions are capped: default 3 min, max 5 min (`pair.maxDurationMin`).
- Workers start only after **both** participants consented and the host
  pressed Start — never on page load, never on join.

## 3c. Alignment — `src/coach/sync.ts` (pure, clock-injected)

Inputs per tick: each participant's latest normalized sample
(`rate`, `status`, `confidence`) + the shared pacer rate.

- `rateAgreement = clamp01(1 − |rateA − rateB| / maxRateGapBpm)` — 1 at
  identical reported rates, 0 at a gap of `maxRateGapBpm` (default 6).
- `guideFollowing_i = clamp01(1 − |rate_i − sharedPacer| / maxGuideGapBpm)`,
  same linear shape; pair value `guideFollowing = min(A, B)` — the pair is
  only as aligned as its less-aligned member.
- `alignmentRaw = w1·rateAgreement + w2·guideFollowing` (defaults 0.5/0.5).
- Smoothed by EMA with time constant `emaTauSeconds` (default 30 — never
  below `averagingWindowSeconds`: the rate already lags 30 s; smoothing
  faster than the report would chase noise).
- **Hysteresis:** the displayed value moves only when the EMA differs by ≥
  `hysteresisBand` (0.05), suppressing flicker.
- **FREEZE:** if either participant is not `status ok` or confidence
  < `freezeConfidence` (0.5), the value holds (no decay, no rise) and
  `alignmentStale: true`. After `staleResetSeconds` (30) frozen, the UI
  shows a neutral "waiting for signal" instead of a value.
- Language: alignment describes **rate similarity and guide-following
  only**. No relational or emotional framing; low alignment is a calm, dim
  state, never a score of the pair.

All constants live in `config.pair` and are marked UNVALIDATED (see header).

## 3d. Shared pacer — `RoomCoach` composes two solo coaches

- One pacer per room. The shared rate is the **maximum of the two
  participant proposals** at any moment — the gentler (slower-to-descend)
  proposal wins — subject to solo's step size, floor and ceiling.
- A Lead step-down therefore happened only when **both** coaches proposed
  it: each `CoachStateMachine` runs the full solo logic (calibration,
  trend-tolerant following, lag-aware Hold), and the coordinator takes the
  max. No solo logic is forked.
- One participant lost/low-confidence: their proposal freezes (no step
  down from them), the shared rate holds, calm notice. Divergence Hold per
  participant still applies (their own coach enters `hold`).
- **Calibration:** each coach calibrates independently. A participant still
  calibrating is **excluded from the max** until calibrated or until
  `maxCalibrateWaitSeconds` (90) elapses — then the fallback rate (12) is
  included for them. (Design choice within 3d's latitude: excluding the
  uncalibrated proposal prevents a late joiner from speeding the shared
  pacer up to the fallback rate immediately.)
- Room phase shown in the UI is the **least advanced** of the two
  (calibrate → match → lead → hold → cooldown → ended); cooldown/ended
  require both.
- Approximate coupling, documented: each coach evaluates following against
  its *own* proposal (the coordinated pacer can sit 0.5 bpm higher while
  one partner leads down). The 1.0 bpm follow tolerance absorbs this gap.
- **PeerLink seam:** `RoomCoach` reads `SampleFeed`/`PacerFeed` interfaces
  only, so a future relay can feed it identical data.

## Phase-lock

Both clients interpolate pacer snapshots from the same server-stamped
stream (server clock, 10 Hz + rAF interpolation, as in Phase 2). By
construction, two clients showing the same stream are synchronized to
within one push interval (100 ms) plus network jitter. The pair simulation
measures observed skew between two interpolating clients and documents it
(Phase 3 final report).

## Protocol sketch (Step 1)

`create_room` → `room_created {code}` · `join_room {code, label}` ·
`room_state {participants[], host, phase}` · `participant_ready {ready, label}` ·
`host_start {durationMin}` · `alignment_update {value?, stale}` ·
`peer_status {kind, label}` · `share_rate_toggle {share}` · `peer_rate {rate}`
(only to the peer, only when toggled on) · `peer_left {label}` ·
`room_closed {reason}`. Room codes: unambiguous alphabet, 6 chars, 15 min
expiry, max 2 participants, in-memory only. Origin-checked upgrade,
per-connection rate limits, unknown types rejected. The server never relays
raw frames to the other participant and never relays rates unless that
participant opted in.

## Vocabulary guard

Extension of the Phase 2 wording gate: *connected, bond, compatib,
soulmate, relationship, therapy, calm score, mood* are banned in shipped
copy alongside the Phase 2 list. Alignment is described only as rate
similarity and guide-following.
