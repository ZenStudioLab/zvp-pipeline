import type { ReasonCode } from "@zen/midi-to-vp";

// DESIGN NOTE: Config assertions run as module load-time side effects, which guarantees
// fail-fast behaviour in production before any pipeline work starts. This is intentional;
// do not move assertions behind a validate() function unless you also replace all imports
// of this module in tests that might need different config values.

export const PIPELINE_THRESHOLDS = {
  publish: 0.75,
  review: 0.5,
  dedupPromotionDelta: 0.05,
} as const;

export const PIPELINE_RERANK = {
  threshold: 2,
  qualityWeight: 0.6,
  ratingWeight: 0.4,
} as const;

export const WARNING_FLOOR_REASON_CODES: readonly ReasonCode[] = [
  "LOW_IN_RANGE_RATIO",
  "HIGH_PEAK_CHORD_SIZE",
  "HIGH_HARD_CHORD_RATE",
  "HIGH_LOCAL_NOTE_DENSITY",
  "LOW_TIMING_CONSISTENCY",
] as const;

if (PIPELINE_THRESHOLDS.publish < PIPELINE_THRESHOLDS.review) {
  throw new Error(
    `Publish threshold (${PIPELINE_THRESHOLDS.publish}) must be >= review threshold (${PIPELINE_THRESHOLDS.review}).`,
  );
}

if (
  PIPELINE_THRESHOLDS.review < 0 ||
  PIPELINE_THRESHOLDS.review > 1 ||
  PIPELINE_THRESHOLDS.publish < 0 ||
  PIPELINE_THRESHOLDS.publish > 1
) {
  throw new Error(
    `Thresholds must be in [0, 1]. Got: review=${PIPELINE_THRESHOLDS.review}, publish=${PIPELINE_THRESHOLDS.publish}`,
  );
}
