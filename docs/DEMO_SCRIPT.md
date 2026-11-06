# Demo script — narrated walkthrough (draft)

> **Not a medical device. Not for diagnosis or treatment.** Everything shown
> is an observation-only pacing rundown. Nothing on screen is a verdict about
> anyone's body or state of mind.

Total: ~5 minutes live. Run `npm run serve` (mock mode for the demo is
fine and predictable; SDK mode if a key is handy) and open the app.

## 1. Consent screen (~1 min)

- Point out: the camera is **not on yet**. Nothing was requested on load.
- Read aloud from the list: purpose, where processing happens, nothing saved
  by default, how to stop, consent asked again every visit.
- Open **Why camera?** — the short plain-language answer.
- Click **I understand, start camera** → the browser's own permission
  prompt appears (this is the real gate, not ours). Allow it.

## 2. Setup + calibration with live rate (~1 min)

- The preview shows your face; the guidance line reads the live camera
  status ("Center your face…", "Move to better light…", then **Ready**).
- Say: "This is the loop that everything else depends on — the coach only
  ever sees a number and a confidence, never a picture."
- Pick 3 minutes. Note the disabled *Breathe with someone* entry: pair mode
  is planned but not promised here.
- **Begin.** The session opens in *Settling in* (calibration, 45 s). The
  small *Your pace* readout is the observed rhythm; the orb is on the
  gentle default while it calibrates. Nothing is being judged — the coach
  is just taking a baseline.

## 3. Pacer matches, then leads down (~1.5 min)

- At *Matching your pace* the orb snaps to your calibrated rate.
- At *Slowing gently* the coach eases the orb a breath slower every window
  or so, with the notice *"Letting the pace ease a touch slower, with you."*
- Demo tip: breathe a little faster on purpose — after ~10 s of divergence
  the coach stops pushing and switches to *Staying with you* with
  *"Taking it slowly with you."* It never ratchets you down for ignoring it;
  say that sentence out loud.

## 4. Signal-loss recovery (~30 s)

- Cover the camera (or show the dev panel's **dropout** scenario if in mock
  mode): the pacer keeps cycling, the notice says *"No clear view for the
  moment — keeping a steady pace while we wait."* Uncover: *"Clear view
  again."* The guide never froze and never scolded.

## 5. Summary + delete data (~30 s)

- *Winding down*, then the summary: pacing start/end, observed rhythm range,
  time near the pacing rhythm, time without a clear view. Read the last
  line aloud: *"That's everything this summary says — a plain rundown of
  the session, with nothing more implied."*
- Click **Delete my data** — history (off by default) is cleared on the spot.

## If things go wrong mid-demo

- Camera denied → choose *Continue with guide only*; the pacer still runs.
- WebSocket disconnect → session ends, camera off, calm reconnect offer.
- SDK credit/cap surprises → the capped notice appears; guide keeps running.

## After the demo

Point them at `docs/CONSENT_AND_DATA.md` (what leaves the device, what
doesn't), `docs/SDK_NOTES.md §14` (why the SDK runs in its own process),
and `docs/ARCHITECTURE.md` (the 10 Hz pacer sync and failure modes).
