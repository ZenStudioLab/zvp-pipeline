import { describe, expect, it } from 'vitest';

import { PIPELINE_THRESHOLDS } from '../../src/config';
import { classifyQualityScore, classifyWithPrecedence } from '../../src/stages/quality-scorer';

describe('classifyQualityScore', () => {
  it('maps scores to publish, review, and reject bands at the configured thresholds', () => {
    expect(classifyQualityScore(PIPELINE_THRESHOLDS.publish)).toBe('publish');
    expect(classifyQualityScore(PIPELINE_THRESHOLDS.review)).toBe('review');
    expect(classifyQualityScore(PIPELINE_THRESHOLDS.review - 0.001)).toBe('reject');
  });
});

describe('classifyWithPrecedence', () => {
  it('caps warning-floor reasons below the publish threshold', () => {
    const result = classifyWithPrecedence({
      score: 0.93,
      rubricVersion: 'v1',
      signals: {
        inRangeRatio: 0.8,
        chordComplexity: 0.7,
        noteDensity: 0.75,
        timingConsistency: 0.8,
      },
      reasons: ['LOW_IN_RANGE_RATIO'],
      stats: {
        totalNotes: 100,
        inRangeNotes: 60,
        averageChordSize: 1.5,
        peakChordSize: 3,
        p95ChordSize: 2,
        hardChordRate: 0.05,
        avgNotesPerSecond: 4.1,
        p95NotesPerSecond: 5,
        maxNotesPerSecond: 6,
        timingJitter: 0.02,
        gridConfidence: 0.9,
        durationSeconds: 24.39,
      },
    });

    expect(result.score).toBeLessThan(PIPELINE_THRESHOLDS.publish);
    expect(result.scoreBand).toBe('review');
  });

  it('does not cap low tempo grid confidence on its own', () => {
    const result = classifyWithPrecedence({
      score: 0.82,
      rubricVersion: 'v1',
      signals: {
        inRangeRatio: 0.95,
        chordComplexity: 0.9,
        noteDensity: 0.8,
        timingConsistency: 0.6,
      },
      reasons: ['LOW_TEMPO_GRID_CONFIDENCE'],
      stats: {
        totalNotes: 90,
        inRangeNotes: 88,
        averageChordSize: 1.4,
        peakChordSize: 3,
        p95ChordSize: 2,
        hardChordRate: 0.02,
        avgNotesPerSecond: 4,
        p95NotesPerSecond: 5,
        maxNotesPerSecond: 7,
        timingJitter: 0.09,
        gridConfidence: 0.2,
        durationSeconds: 22.5,
      },
    });

    expect(result.score).toBe(0.82);
    expect(result.scoreBand).toBe('publish');
  });

  it('preserves scorer metadata while rounding the effective score', () => {
    const result = classifyWithPrecedence({
      score: 0.7499996,
      rubricVersion: 'v2',
      signals: {
        inRangeRatio: 0.91,
        chordComplexity: 0.7,
        noteDensity: 0.71,
        timingConsistency: 0.69,
      },
      reasons: [],
      stats: {
        totalNotes: 80,
        inRangeNotes: 73,
        averageChordSize: 1.7,
        peakChordSize: 4,
        p95ChordSize: 3,
        hardChordRate: 0.06,
        avgNotesPerSecond: 4.7,
        p95NotesPerSecond: 6.2,
        maxNotesPerSecond: 7.1,
        timingJitter: 0.04,
        gridConfidence: 0.85,
        durationSeconds: 17.02,
      },
    });

    expect(result.score).toBe(0.75);
    expect(result.scoreBand).toBe('publish');
    expect(result.rubricVersion).toBe('v2');
    expect(result.signals.noteDensity).toBe(0.71);
    expect(result.reasons).toEqual([]);
    expect(result.stats.maxNotesPerSecond).toBe(7.1);
  });
});