/**
 * Orb interpolation between server pacer updates.
 *
 * The server pushes a pacer snapshot every ~100 ms (10 Hz). Between pushes
 * the client advances the snapshot's phase progress linearly — exactly the
 * same math the server's `Pacer` uses within a phase (phase progress is a
 * linear function of elapsed time, and rate changes commit at cycle
 * boundaries). Every new snapshot re-anchors the interpolation, so error can
 * never accumulate beyond one update interval. See `orb.test.ts` for the
 * measured bound over a simulated 10-minute session.
 */

export interface PacerSnapshotLike {
  rate: number;
  phase: "inhale" | "exhale";
  phaseProgress: number;
  /** Client-side receipt time (performance.now() scale, ms). */
  receivedAtMs: number;
}

export interface OrbState {
  phase: "inhale" | "exhale";
  /** 0..1 progress within the current phase. */
  phaseProgress: number;
  /** Orb scale factor (1 = resting, ~1.35 = full inhale). */
  scale: number;
}

const INHALE_SCALE = 1.35;

function smoothstep(x: number): number {
  return x * x * (3 - 2 * x);
}

/** Advance a snapshot by `elapsedMs`, rolling across phase boundaries. */
export function advanceSnapshot(
  snap: PacerSnapshotLike,
  nowMs: number,
  inhaleShare: number,
): { phase: "inhale" | "exhale"; phaseProgress: number } {
  const cycleMs = (60 / Math.max(1, snap.rate)) * 1000;
  const inhaleMs = cycleMs * inhaleShare;
  let phase = snap.phase;
  let progress = Math.min(1, Math.max(0, snap.phaseProgress));
  let remainingMs = Math.max(0, nowMs - snap.receivedAtMs);

  // Roll forward through as many phases as the elapsed time spans. Bounded
  // iterations: even a 60s stall at the fastest rate is < 100 phases.
  for (let i = 0; i < 256 && remainingMs > 0; i++) {
    const phaseMs = phase === "inhale" ? inhaleMs : cycleMs - inhaleMs;
    const phaseLeftMs = (1 - progress) * phaseMs;
    if (remainingMs < phaseLeftMs) {
      progress += remainingMs / Math.max(1, phaseMs);
      remainingMs = 0;
    } else {
      remainingMs -= phaseLeftMs;
      phase = phase === "inhale" ? "exhale" : "inhale";
      progress = 0;
    }
  }
  return { phase, phaseProgress: Math.min(1, Math.max(0, progress)) };
}

/**
 * Orb state at `nowMs` given the last server snapshot.
 * `reducedMotion` renders phase flips as steps instead of smooth growth.
 */
export function orbStateAt(
  snap: PacerSnapshotLike,
  nowMs: number,
  inhaleShare: number,
  reducedMotion: boolean,
): OrbState {
  const { phase, phaseProgress } = advanceSnapshot(snap, nowMs, inhaleShare);
  const eased = smoothstep(phaseProgress);
  const scale = reducedMotion
    ? phase === "inhale"
      ? INHALE_SCALE
      : 1
    : phase === "inhale"
      ? 1 + (INHALE_SCALE - 1) * eased
      : INHALE_SCALE - (INHALE_SCALE - 1) * eased;
  return { phase, phaseProgress, scale };
}
