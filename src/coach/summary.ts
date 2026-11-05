/**
 * Observation-only session summary.
 *
 * HARD RULE: wording below is intentionally neutral — it describes only what
 * the pacing session observed (rates seen, time spent near the pacing rhythm,
 * time without a clear camera view). It must never imply health outcomes,
 * states of mind, or any form of clinical assessment. A regression test
 * (`test/stateMachine.test.ts`) asserts none of the reserved restricted terms
 * ever appears in summary text.
 */

export interface SummaryData {
  /** Rate the pacing started with (bpm), if calibration produced one. */
  startRate?: number;
  /** First confidently observed user breathing rate (bpm), if any. */
  firstRate?: number;
  /** Last confidently observed user breathing rate (bpm), if any. */
  endRate?: number;
  /** Minutes with confident observations near the pacing rhythm. */
  minutesFollowed: number;
  /** Minutes without a trustworthy view (pacing held steady meanwhile). */
  minutesUnavailable: number;
  /** Session length in minutes. */
  minutesTotal: number;
  /** Pacing rate at the end of the session (bpm). */
  finalPacerRate: number;
}

export function formatRate(x: number | undefined): string {
  if (x === undefined) return "n/a";
  return String(Math.round(x * 10) / 10);
}

export function buildSummaryLines(d: SummaryData): string[] {
  const total = String(Math.round(d.minutesTotal * 10) / 10);
  return [
    "Session wrap-up — pacing observations only.",
    `Pacing began at about ${formatRate(d.startRate)} breaths per minute and finished at about ${formatRate(d.finalPacerRate)} breaths per minute.`,
    `With a clear view, your breathing rhythm read between about ${formatRate(d.firstRate ?? d.startRate)} and about ${formatRate(d.endRate)} breaths per minute.`,
    `You stayed close to the pacing rhythm for about ${d.minutesFollowed.toFixed(1)} of the ${total}-minute session.`,
    `We were without a clear view for about ${d.minutesUnavailable.toFixed(1)} minutes; pacing held steady during that stretch.`,
    "That's everything this summary says — a plain rundown of the session, with nothing more implied.",
  ];
}

/**
 * Reserved restricted terms derived from the project's hard rules
 * (docs list them as banned in code, comments, strings, and docs):
 * diagnosing, medicating, curing, weighted emotional labels, organ-health
 * framing, professional-context claims, regulatory claims.
 * (Kept deliberately lowercase; matching is case-insensitive.)
 */
export const FORBIDDEN_TERMS: readonly string[] = [
  "diagnos",
  "treat",
  "cure",
  "stress level",
  "anxiety",
  "heart health",
  "clinical",
  "fda",
];

export function containsForbiddenTerm(text: string): boolean {
  const lower = text.toLowerCase();
  return FORBIDDEN_TERMS.some((term) => lower.includes(term));
}

export function assertSummaryIsClean(lines: string[]): string[] {
  const violations: string[] = [];
  for (const line of lines) {
    if (containsForbiddenTerm(line)) violations.push(line);
  }
  return violations;
}
