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
- Demo tip: breathe a little faster on purpose — after ~35–60 s of
  sustained divergence (35 s streak + the 30 s reporting lag) the coach
  stops pushing and switches to *Staying with you* with
  *"Taking it slowly with you."* It never ratchets you down for ignoring it;
  say that sentence out loud. **Give the moment room on camera: this is a
  slow coach by design — don't promise quick reactions.**

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

## Pair-mode segment (~4 min, two real people)

**Logistics checklist (before filming):**
- [ ] Host machine running `npm run serve` (mock is fine for rehearsal)
- [ ] Joiner's device on an **HTTPS** route (localhost only works for the
      host; use the workspace tunnel or a local HTTPS origin)
- [ ] Even light and framing on both sides (Setup screen will say)
- [ ] Who is host decided; the joiner has the room code in hand
- [ ] Quota: pair sessions count twice — the lobby shows remaining minutes
      (demo in mock mode if credits are tight)

**Script:**
1. **Both consent screens.** The joiner's copy names the host's computer as
   the recipient of their frames — say that out loud.
2. **Lobby.** Host creates the room, shows the code; joiner enters it;
   both labels appear, both press *I'm ready*; the host's *Start together*
   enables. Point out: no workers started before this moment.
3. **Session.** Two orbs, one per person, breathing on the shared pacer.
   The orbs drift closer and the shared glow strengthens as the two
   measured rates get more similar — with sharing toggled ON for the demo
   only (explain on camera that it's off by default and shows a number).
4. **Deliberate divergence.** One person breathes faster on purpose for
   35–60 s: the alignment view goes dim, the shared guide holds steady —
   *Staying with you* — it never speeds up to chase anyone and never
   scolds. Don't promise quick reactions; the coach is slow by design.
5. **Signal-loss freeze.** Cover one camera briefly: alignment freezes
   ("Waiting for a clear view…"), the guide keeps cycling, and resumes
   when the view returns.
6. **Summary.** Each person sees their own observation-only summary plus
   one plain-language pair line ("the two measured breathing rates were
   mostly similar") with its definition behind a tap. *Leave room* and
   *Delete my data* end things cleanly.

## After the demo

Point them at `docs/CONSENT_AND_DATA.md` (what leaves the device, what
doesn't), `docs/SDK_NOTES.md §14` (why the SDK runs in its own process),
and `docs/ARCHITECTURE.md` (the 10 Hz pacer sync and failure modes).
