// DESIGN NOTE: Config assertions run as module load-time side effects, which guarantees
// fail-fast behaviour in production before any pipeline work starts. This is intentional;
// do not move assertions behind a validate() function unless you also replace all imports
// of this module in tests that might need different config values.
const RUBRIC_WEIGHTS = {
  inRangeRatio: 0.35,
  chordDensity: 0.25,
  noteDensity: 0.2,
  timingConsistency: 0.2,
} as const;

const RUBRIC_WEIGHT_TOTAL = Object.values(RUBRIC_WEIGHTS).reduce((sum, value) => sum + value, 0);

if (Math.abs(RUBRIC_WEIGHT_TOTAL - 1) > 0.000_001) {
  throw new Error(`Rubric weights must sum to 1.0. Received ${RUBRIC_WEIGHT_TOTAL}.`);
}

export const PIPELINE_THRESHOLDS = {
  publish: 0.75,
  review: 0.5,
  dedupPromotionDelta: 0.05,
} as const;

export const PIPELINE_RUBRIC = {
  version: 'v1',
  weights: RUBRIC_WEIGHTS,
} as const;

export const PIPELINE_RERANK = {
  threshold: 2,
  qualityWeight: 0.6,
  ratingWeight: 0.4,
} as const;

if (PIPELINE_THRESHOLDS.publish < PIPELINE_THRESHOLDS.review) {
  throw new Error(
    `Publish threshold (${PIPELINE_THRESHOLDS.publish}) must be >= review threshold (${PIPELINE_THRESHOLDS.review}).`,
  );
}

// Scoring formula calibration parameters for normalizeSignals in quality-scorer.ts.
// All constants are heuristic baselines to be recalibrated against labelled data.
// See docs/reviews/quality-scorer-review.md (Round 1) for detailed rationale.
export const PIPELINE_SCORING_PARAMS = {
  // Chord density: single-note lines (avgSize=1) receive no penalty; full penalty at avgSize=5.
  chordAvgSizeBaseline: 1,
  chordAvgSizeRange: 4,
  // Peak chord penalty slopes in above 3 simultaneous notes; full penalty at 8+.
  chordPeakSizeBaseline: 3,
  chordPeakSizeRange: 5,
  // Blend: dense average chord size impacts playability more than occasional peaks.
  chordAvgPenaltyWeight: 0.7,
  chordPeakPenaltyWeight: 0.3,
  // Note density: 4 nps ≈ moderate piano tempo; score falls to 0 at ±8 nps from optimum.
  noteDensityOptimalNps: 4,
  noteDensitySpread: 8,
  // Timing jitter: normalised step ratio from converter quantisation.
  // Recalibrate this threshold if the converter's quantisation step changes.
  timingJitterThreshold: 0.12,
  // Note rates above 10 nps additionally reduce timing score (spread of 2 nps to full penalty).
  timingHighNpsThreshold: 10,
  timingHighNpsSpread: 2,
} as const;

if (PIPELINE_THRESHOLDS.review < 0 || PIPELINE_THRESHOLDS.publish > 1) {
  throw new Error(
    `Thresholds must be in [0, 1]. Got: review=${PIPELINE_THRESHOLDS.review}, publish=${PIPELINE_THRESHOLDS.publish}`,
  );
}

const CHORD_PENALTY_WEIGHT_TOTAL =
  PIPELINE_SCORING_PARAMS.chordAvgPenaltyWeight + PIPELINE_SCORING_PARAMS.chordPeakPenaltyWeight;

if (Math.abs(CHORD_PENALTY_WEIGHT_TOTAL - 1) > 0.000_001) {
  throw new Error(
    `PIPELINE_SCORING_PARAMS chord penalty weights must sum to 1.0. Received ${CHORD_PENALTY_WEIGHT_TOTAL}.`,
  );
}

if (PIPELINE_SCORING_PARAMS.chordAvgSizeRange <= 0) {
  throw new Error(
    `PIPELINE_SCORING_PARAMS.chordAvgSizeRange must be > 0; received ${PIPELINE_SCORING_PARAMS.chordAvgSizeRange}`,
  );
}

if (PIPELINE_SCORING_PARAMS.chordPeakSizeRange <= 0) {
  throw new Error(
    `PIPELINE_SCORING_PARAMS.chordPeakSizeRange must be > 0; received ${PIPELINE_SCORING_PARAMS.chordPeakSizeRange}`,
  );
}

if (PIPELINE_SCORING_PARAMS.noteDensitySpread <= 0) {
  throw new Error(
    `PIPELINE_SCORING_PARAMS.noteDensitySpread must be > 0; received ${PIPELINE_SCORING_PARAMS.noteDensitySpread}`,
  );
}

if (PIPELINE_SCORING_PARAMS.timingJitterThreshold <= 0) {
  throw new Error(
    `PIPELINE_SCORING_PARAMS.timingJitterThreshold must be > 0; received ${PIPELINE_SCORING_PARAMS.timingJitterThreshold}`,
  );
}

if (PIPELINE_SCORING_PARAMS.timingHighNpsSpread <= 0) {
  throw new Error(
    `PIPELINE_SCORING_PARAMS.timingHighNpsSpread must be > 0; received ${PIPELINE_SCORING_PARAMS.timingHighNpsSpread}`,
  );
}

// Cross-parameter semantic invariant: the high-NPS timing penalty threshold must be above the
// optimal note density rate, otherwise it would penalise 'normal' fast passages at the ideal rate.
if (PIPELINE_SCORING_PARAMS.timingHighNpsThreshold < PIPELINE_SCORING_PARAMS.noteDensityOptimalNps) {
  throw new Error(
    `PIPELINE_SCORING_PARAMS.timingHighNpsThreshold (${PIPELINE_SCORING_PARAMS.timingHighNpsThreshold}) must be >= noteDensityOptimalNps (${PIPELINE_SCORING_PARAMS.noteDensityOptimalNps})`,
  );
}