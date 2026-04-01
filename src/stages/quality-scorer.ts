import { scoreConversionQuality as scoreMidiConversionQuality } from '@zen/midi-to-vp';

import { PIPELINE_THRESHOLDS, WARNING_FLOOR_REASON_CODES } from '../config.js';
import type { QualityAssessment, QualityScoreBand, ConverterQualitySignals } from './types.js';

export function classifyQualityScore(score: number): QualityScoreBand {
  if (score >= PIPELINE_THRESHOLDS.publish) {
    return 'publish';
  }

  if (score >= PIPELINE_THRESHOLDS.review) {
    return 'review';
  }

  return 'reject';
}

export function classifyWithPrecedence(assessment: Omit<QualityAssessment, 'scoreBand'>): QualityAssessment {
  const cappedScore = assessment.reasons.some((reason) => WARNING_FLOOR_REASON_CODES.includes(reason))
    ? Math.min(assessment.score, PIPELINE_THRESHOLDS.publish - 0.001)
    : assessment.score;
  const score = Number(cappedScore.toFixed(6));

  return {
    scoreBand: classifyQualityScore(score),
    ...assessment,
    score,
  };
}

export function scoreConversionQuality(input: ConverterQualitySignals): QualityAssessment {
  return classifyWithPrecedence(scoreMidiConversionQuality(input));
}