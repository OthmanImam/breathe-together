# Breathe Together — dev post

> **Not a medical device. Not for diagnosis or treatment.** Everything the
> app shows is an observation-only pacing rundown: breathing rates over time
> and how a shared guide responded. Nothing is a verdict about anyone's
> body or state of mind.

## Creative — the shared breathing visual

A breathing coach is usually one person, one camera, one circle. The
interesting design question was: what does it look like when two people's
rhythm shares one pacer?

Pair mode shows two soft orbs — one per person — breathing the same shared
guide, phase-locked to within 100 ms across screens. As the two measured
breathing rates move closer together and each matches the shared guide
better, the orbs drift nearer and a shared glow strengthens; at low
alignment they sit apart and dim. A slow "grow" accumulates over time held
above the alignment threshold. Reduced motion swaps all of that for
opacity and size; audio-only mode keeps one shared tone phrase, gentle
enough for eyes closed.

The shared pacer itself is the creative constraint that makes the visual
work: one guide, led by the slower-settling person, never pushed faster
than either person's calibrated pace. The visual therefore can't fake
togetherness — it can only show rate similarity, honestly, slowly, and
with hysteresis so nothing flickers.

## Real-world — consent-first, privacy defaults, honest limitations

- **Consent-first.** The camera opens only after an explicit button click,
  per person — nobody can consent for someone else. Consent is per page
  load, and Stop (always visible while the camera is on) ends everything
  instantly.
- **Privacy defaults.** In pair mode each person sees only their own
  breathing rate. Their partner sees the two-orb visual — and a number
  only if they explicitly toggle sharing on. Sharing is off by default,
  revocable at any time, and the app labels who can see what.
- **Honest limitations.** The architecture is one host machine: the
  joiner's frames travel to the host (disclosed on the consent screen, named
  as the recipient; discarded in memory, never stored). Camera access
  needs a secure context (localhost for the host, HTTPS for the joiner) —
  the app says so plainly instead of failing silently. The measurement
  SDK's own vendor traffic (key check, device pairing, usage) is
  documented, and its aggregate telemetry is disabled by our wrapper (the
  raw SDK defaults it on). Alignment thresholds are marked UNVALIDATED —
  no real-face data exists yet to tune them against, and the repo says so
  in plain text. Free-trial quota is counted per participant-minute with a
  daily cap shown before a session starts, so testing never silently
  burns it.
- **Room hygiene.** Rooms exist only in memory, codes expire in 15 minutes,
  and when someone leaves or the host disconnects, everything stops —
  cameras off, workers killed, nothing lingering.
