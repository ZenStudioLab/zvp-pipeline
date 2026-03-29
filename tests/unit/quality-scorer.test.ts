import { describe, expect, it } from 'vitest';

import { PIPELINE_RUBRIC, PIPELINE_THRESHOLDS } from '../../src/config';
import { scoreConversionQuality } from '../../src/stages/quality-scorer';

describe('scoreConversionQuality', () => {
  it('uses rubric weights from config and stores the rubric version', () => {
    const result = scoreConversionQuality({
      totalNotes: 100,
      inRangeNotes: 92,
      averageChordSize: 1.8,
      peakChordSize: 3,
      notesPerSecond: 4.2,
      timingJitter: 0.03,
    });

    const expected =
      result.signals.inRangeRatio * PIPELINE_RUBRIC.weights.inRangeRatio +
      result.signals.chordDensity * PIPELINE_RUBRIC.weights.chordDensity +
      result.signals.noteDensity * PIPELINE_RUBRIC.weights.noteDensity +
      result.signals.timingConsistency * PIPELINE_RUBRIC.weights.timingConsistency;

    expect(result.score).toBeCloseTo(expected, 5);
    expect(result.rubricVersion).toBe(PIPELINE_RUBRIC.version);
  });

  it('normalizes every scoring signal into the 0-1 range', () => {
    const result = scoreConversionQuality({
      totalNotes: 48,
      inRangeNotes: 80,
      averageChordSize: 8,
      peakChordSize: 10,
      notesPerSecond: 40,
      timingJitter: 0.5,
    });

    Object.values(result.signals).forEach((value) => {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    });
  });

  it('classifies high-quality output as publishable', () => {
    const result = scoreConversionQuality({
      totalNotes: 120,
      inRangeNotes: 118,
      averageChordSize: 1.4,
      peakChordSize: 3,
      notesPerSecond: 3.8,
      timingJitter: 0.015,
    });

    expect(result.score).toBeGreaterThanOrEqual(PIPELINE_THRESHOLDS.publish);
    expect(result.scoreBand).toBe('publish');
  });

  it('classifies borderline output for review', () => {
    const result = scoreConversionQuality({
      totalNotes: 100,
      inRangeNotes: 78,
      averageChordSize: 2.8,
      peakChordSize: 5,
      notesPerSecond: 8.5,
      timingJitter: 0.06,
    });

    expect(result.score).toBeGreaterThanOrEqual(PIPELINE_THRESHOLDS.review);
    expect(result.score).toBeLessThan(PIPELINE_THRESHOLDS.publish);
    expect(result.scoreBand).toBe('review');
  });

  it('rejects low-quality output below the review threshold', () => {
    const result = scoreConversionQuality({
      totalNotes: 90,
      inRangeNotes: 30,
      averageChordSize: 4.5,
      peakChordSize: 8,
      notesPerSecond: 18,
      timingJitter: 0.2,
    });

    expect(result.score).toBeLessThan(PIPELINE_THRESHOLDS.review);
    expect(result.scoreBand).toBe('reject');
  });

  it('fails closed for empty-note inputs instead of producing a reviewable score', () => {
    const result = scoreConversionQuality({
      totalNotes: 0,
      inRangeNotes: 0,
      averageChordSize: 0,
      peakChordSize: 0,
      notesPerSecond: 0,
      timingJitter: 0,
    });

    expect(result.score).toBe(0);
    expect(result.scoreBand).toBe('reject');
  });

  it('keeps extremely dense charts out of the publish band even when other signals are strong', () => {
    const result = scoreConversionQuality({
      totalNotes: 160,
      inRangeNotes: 160,
      averageChordSize: 1.2,
      peakChordSize: 3,
      notesPerSecond: 11,
      timingJitter: 0.01,
    });

    expect(result.score).toBeLessThan(PIPELINE_THRESHOLDS.publish);
    expect(result.scoreBand).toBe('review');
  });
});