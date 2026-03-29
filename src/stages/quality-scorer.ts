import { PIPELINE_RUBRIC, PIPELINE_THRESHOLDS } from '../config.js';
import type { QualityAssessment, QualityScoreBand, QualityScorerInput, QualitySignalSet } from './types.js';

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function safeDivide(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }

  return numerator / denominator;
}

function normalizeSignals(input: QualityScorerInput): QualitySignalSet {
  if (input.totalNotes <= 0) {
    return {
      inRangeRatio: 0,
      chordDensity: 0,
      noteDensity: 0,
      timingConsistency: 0,
    };
  }

  const inRangeRatio = clamp01(safeDivide(input.inRangeNotes, input.totalNotes));

  const averageChordPenalty = clamp01((input.averageChordSize - 1) / 4);
  const peakChordPenalty = clamp01((input.peakChordSize - 3) / 5);
  const chordDensity = clamp01(1 - (averageChordPenalty * 0.7 + peakChordPenalty * 0.3));

  const noteDensity = clamp01(1 - Math.abs(input.notesPerSecond - 4) / 8);
  const timingPenalty = Math.max(input.timingJitter / 0.12, Math.max(0, input.notesPerSecond - 10) / 2);
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
  const score = clamp01(
    signals.inRangeRatio * PIPELINE_RUBRIC.weights.inRangeRatio +
      signals.chordDensity * PIPELINE_RUBRIC.weights.chordDensity +
      signals.noteDensity * PIPELINE_RUBRIC.weights.noteDensity +
      signals.timingConsistency * PIPELINE_RUBRIC.weights.timingConsistency,
  );

  return {
    score,
    rubricVersion: PIPELINE_RUBRIC.version,
    scoreBand: classifyQualityScore(score),
    signals,
  };
}

export { normalizeSignals };