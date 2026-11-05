/**
 * Pure mapping from SmartSpectra SDK outputs to our `RawSample` shape.
 *
 * Everything here is derived from fields the installed SDK (v3.4.0) actually
 * exposes — verified against its bundled type declarations
 * (`node_modules/@smartspectra/node-sdk/js/messages/generated.d.ts`):
 *
 * - `Metrics.breathing.rate` is `MeasurementWithConfidence[]`: each element
 *   carries `.value` (breaths per minute) and `.confidence` (a percentage,
 *   0.0–100.0). This answers SDK_NOTES open question 3: breathing rate DOES
 *   have per-sample confidence, as a percentage.
 * - `'validationStatus'` codes are `ValidationCode` integers; the mapping to
 *   our `SignalStatus` is the table in SDK_NOTES §7 (unchanged here).
 *
 * No imports from the SDK package: the worker feeds this module plain decoded
 * objects, which is also what makes it directly unit-testable with synthetic
 * metrics.
 */

import type { RawSample, SignalStatus } from "./SignalSource.js";

/** Decoded `Metrics` shape (subset we consume). Plain-object friendly. */
export interface DecodedMetrics {
  breathing?: {
    rate?: Array<{ value?: number; confidence?: number }> | null;
  } | null;
}

/**
 * ValidationCode -> SignalStatus (SDK integer values are stable; see
 * SDK_NOTES §7). Codes we can't derive a named status for are NOT guessed:
 * unknown codes keep the previous status (the caller holds state).
 */
const VALIDATION_TO_STATUS: Record<number, SignalStatus> = {
  0: "ok", // kOk
  1: "no_face", // kNoFaceFound
  2: "no_face", // kMultipleFacesFound (ambiguous scene)
  3: "off_center", // kFaceNotCentered
  4: "off_center", // kFaceSizeOutOfRange
  5: "poor_light", // kTooDark
  6: "poor_light", // kTooBright
  7: "off_center", // kChestNotVisible
  10: "starting", // kCameraTuning (AE/AWB settling)
  11: "lost", // kFrameRateTooLow (input quality)
  12: "lost", // kExcessiveMotion (input quality)
  13: "off_center", // kFaceTooClose
  14: "off_center", // kFaceTooFar
  15: "off_center", // kFaceTooHigh
  16: "off_center", // kFaceTooLow
  17: "off_center", // kFaceNotForward
};

/** Map a validation code to a status, or undefined when the code is unknown. */
export function validationCodeToStatus(code: number): SignalStatus | undefined {
  return VALIDATION_TO_STATUS[code];
}

/** Clamp helper for percentages and rates. */
export function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * Build a RawSample from a decoded metrics packet.
 *
 * - Takes the LATEST breathing-rate element (series are chronological; the
 *   docs' own snippet uses `.at(-1)`).
 * - `confidence` is the sample's documented percentage divided by 100. When
 *   absent, confidence is 1 only if the current validation status is `ok`
 *   (measured well), else 0 — never a fabricated smoothness score.
 * - `t` is the app-side monotonic ms (the worker stamps at receipt).
 */
export function metricsToSample(
  metrics: DecodedMetrics,
  status: SignalStatus,
  tMs: number,
): RawSample | undefined {
  const series = metrics.breathing?.rate;
  if (!series || series.length === 0) return undefined;
  const latest = series[series.length - 1];
  if (!latest || typeof latest.value !== "number" || !Number.isFinite(latest.value)) {
    return undefined;
  }
  const confidence =
    typeof latest.confidence === "number" && Number.isFinite(latest.confidence)
      ? clamp01(latest.confidence / 100)
      : status === "ok"
        ? 1
        : 0;
  return {
    t: tMs,
    breathingRate: latest.value,
    confidence,
    status,
  };
}
