const RUBRIC_WEIGHTS = {
  inRangeRatio: 0.35,
  chordDensity: 0.25,
  noteDensity: 0.2,
  timingConsistency: 0.2,
} as const;

const RUBRIC_WEIGHT_TOTAL = Object.values(RUBRIC_WEIGHTS).reduce(
  (sum, value) => sum + value,
  0,
);

if (Math.abs(RUBRIC_WEIGHT_TOTAL - 1) > 0.000_001) {
  throw new Error(
    `Rubric weights must sum to 1.0. Received ${RUBRIC_WEIGHT_TOTAL}.`,
  );
}

export const PIPELINE_THRESHOLDS = {
  publish: 0.75,
  review: 0.5,
  dedupPromotionDelta: 0.05,
} as const;

const PIPELINE_THRESHOLDS_VALIDATION = PIPELINE_THRESHOLDS;

if (
  PIPELINE_THRESHOLDS_VALIDATION.review < 0 ||
  PIPELINE_THRESHOLDS_VALIDATION.review > 1 ||
  PIPELINE_THRESHOLDS_VALIDATION.publish < 0 ||
  PIPELINE_THRESHOLDS_VALIDATION.publish > 1
) {
  throw new Error(
    `PIPELINE_THRESHOLDS values must be between 0 and 1. Received: publish=${PIPELINE_THRESHOLDS_VALIDATION.publish}, review=${PIPELINE_THRESHOLDS_VALIDATION.review}`,
  );
}

export const PIPELINE_RUBRIC = {
  version: "v1",
  weights: RUBRIC_WEIGHTS,
} as const;

export const PIPELINE_RERANK = {
  threshold: 2,
  qualityWeight: 0.6,
  ratingWeight: 0.4,
} as const;
