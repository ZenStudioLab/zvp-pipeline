import { PIPELINE_RUBRIC, PIPELINE_SCORING_PARAMS, PIPELINE_THRESHOLDS } from '../config.js';
import type { QualityAssessment, QualityScoreBand, QualityScorerInput, QualitySignalContributions, QualitySignalSet } from './types.js';

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function safeDivide(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }

  return numerator / denominator;
}

function validateInput(input: QualityScorerInput): void {
  const fields: (keyof QualityScorerInput)[] = [
    'totalNotes',
    'inRangeNotes',
    'averageChordSize',
    'peakChordSize',
    'notesPerSecond',
    'timingJitter',
  ];

  for (const field of fields) {
    if (!Number.isFinite(input[field])) {
      throw new RangeError(`QualityScorerInput.${field} must be finite; received ${input[field]}`);
    }
  }

  if (input.totalNotes < 0) {
    throw new RangeError(`QualityScorerInput.totalNotes must be >= 0; received ${input.totalNotes}`);
  }

  if (input.inRangeNotes < 0) {
    throw new RangeError(`QualityScorerInput.inRangeNotes must be >= 0; received ${input.inRangeNotes}`);
  }

  if (input.inRangeNotes > input.totalNotes) {
    throw new RangeError(
      `QualityScorerInput.inRangeNotes (${input.inRangeNotes}) must be <= totalNotes (${input.totalNotes})`,
    );
  }

  if (input.averageChordSize < 0) {
    throw new RangeError(`QualityScorerInput.averageChordSize must be >= 0; received ${input.averageChordSize}`);
  }

  if (input.peakChordSize < 0) {
    throw new RangeError(`QualityScorerInput.peakChordSize must be >= 0; received ${input.peakChordSize}`);
  }

  if (input.notesPerSecond < 0) {
    throw new RangeError(`QualityScorerInput.notesPerSecond must be >= 0; received ${input.notesPerSecond}`);
  }

  if (input.timingJitter < 0) {
    throw new RangeError(`QualityScorerInput.timingJitter must be >= 0; received ${input.timingJitter}`);
  }

  if (input.totalNotes > 0) {
    if (input.averageChordSize < 1) {
      throw new RangeError(`QualityScorerInput.averageChordSize must be >= 1; received ${input.averageChordSize}`);
    }

    if (input.peakChordSize < input.averageChordSize) {
      throw new RangeError(
        `QualityScorerInput.peakChordSize (${input.peakChordSize}) must be >= averageChordSize (${input.averageChordSize})`,
      );
    }
  }
}

/**
 * Normalizes raw converter signals to [0, 1] quality indicators.
 * All scoring constants come from PIPELINE_SCORING_PARAMS in config.ts.
 *
 * Input field units:
 * - totalNotes / inRangeNotes: integer note counts
 * - averageChordSize / peakChordSize: mean/max simultaneous notes (>= 1 for non-empty charts)
 * - notesPerSecond: real-number rate over the chart duration
 * - timingJitter: normalised step ratio from the converter quantisation step
 */
function normalizeSignals(input: QualityScorerInput): QualitySignalSet {
  validateInput(input);

  if (input.totalNotes <= 0) {
    // Invariant for empty charts: averageChordSize and peakChordSize are accepted as-is
    // (typically 0 from the converter). The chord invariants (>= 1) only apply when
    // totalNotes > 0. If the converter emits non-zero chord sizes for an empty chart,
    // the signal fields are simply unused since all returned signals are 0.
    return {
      inRangeRatio: 0,
      chordDensity: 0,
      noteDensity: 0,
      timingConsistency: 0,
    };
  }

  const inRangeRatio = clamp01(safeDivide(input.inRangeNotes, input.totalNotes));

  // Chord density: penalise average size above 1-note baseline and peak size above 3-note baseline.
  // Blend (0.7 avg / 0.3 peak): dense average chord size impacts playability more than occasional peaks.
  const p = PIPELINE_SCORING_PARAMS;
  const averageChordPenalty = clamp01((input.averageChordSize - p.chordAvgSizeBaseline) / p.chordAvgSizeRange);
  const peakChordPenalty = clamp01((input.peakChordSize - p.chordPeakSizeBaseline) / p.chordPeakSizeRange);
  const chordDensity = clamp01(1 - (averageChordPenalty * p.chordAvgPenaltyWeight + peakChordPenalty * p.chordPeakPenaltyWeight));

  // Note density: optimal at noteDensityOptimalNps; symmetric linear falloff across noteDensitySpread.
  // TODO(calibration): consider an asymmetric curve to penalise very sparse charts more sharply.
  const noteDensity = clamp01(1 - Math.abs(input.notesPerSecond - p.noteDensityOptimalNps) / p.noteDensitySpread);

  // Timing consistency: take the worse of jitter ratio and fast-passage density penalty.
  // TODO(calibration): replace max(...) with a smooth blend to avoid abrupt score cliffs at threshold boundaries.
  const timingPenalty = Math.max(
    input.timingJitter / p.timingJitterThreshold,
    Math.max(0, input.notesPerSecond - p.timingHighNpsThreshold) / p.timingHighNpsSpread,
  );
  const timingConsistency = clamp01(1 - timingPenalty);

  return {
    inRangeRatio,
    chordDensity,
    noteDensity,
    timingConsistency,
  };
}

export function classifyQualityScore(score: number): QualityScoreBand {
  if (score >= PIPELINE_THRESHOLDS.publish) {
    return 'publish';
  }

  if (score >= PIPELINE_THRESHOLDS.review) {
    return 'review';
  }

  return 'reject';
}

export function scoreConversionQuality(input: QualityScorerInput): QualityAssessment {
  const signals = normalizeSignals(input);
  const w = PIPELINE_RUBRIC.weights;
  const contributions: QualitySignalContributions = {
    inRangeRatio: signals.inRangeRatio * w.inRangeRatio,
    chordDensity: signals.chordDensity * w.chordDensity,
    noteDensity: signals.noteDensity * w.noteDensity,
    timingConsistency: signals.timingConsistency * w.timingConsistency,
  };
  const score = clamp01(
    contributions.inRangeRatio +
      contributions.chordDensity +
      contributions.noteDensity +
      contributions.timingConsistency,
  );

  return {
    score,
    rubricVersion: PIPELINE_RUBRIC.version,
    scoreBand: classifyQualityScore(score),
    signals,
    contributions,
  };
}

export { normalizeSignals };