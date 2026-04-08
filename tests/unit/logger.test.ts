import { describe, expect, it } from 'vitest';

import { PipelineLogger } from '../../src/lib/logger.js';

describe('PipelineLogger', () => {
  it('stores structured entries with status, quality_score, and rejection_reason fields', () => {
    const logger = new PipelineLogger();

    logger.log({
      status: 'published',
      source_url: 'https://example.com/song.mid',
      quality_score: 0.88,
      rejection_reason: 'none',
    });

    expect(logger.getEntries()).toEqual([
      {
        status: 'published',
        source_url: 'https://example.com/song.mid',
        quality_score: 0.88,
        rejection_reason: 'none',
      },
    ]);
  });

  it('filters entries by status and minimum quality threshold', () => {
    const logger = new PipelineLogger();

    logger.log({ status: 'published', quality_score: 0.91 });
    logger.log({ status: 'published', quality_score: 0.68, needs_review: true });
    logger.log({ status: 'rejected', quality_score: 0.2, rejection_reason: 'too-dense' });

    expect(logger.filterByStatus('published')).toHaveLength(2);
    expect(logger.filterByStatus('rejected')).toHaveLength(1);
    expect(logger.filterByMinimumQuality(0.7)).toEqual([{ status: 'published', quality_score: 0.91 }]);
  });

  it('summarizes terminal statuses and rejection reasons from logged entries', () => {
    const logger = new PipelineLogger();

    logger.log({ status: 'pending' });
    logger.log({ status: 'converting' });
    logger.log({ status: 'published', quality_score: 0.9 });
    logger.log({ status: 'rejected', quality_score: 0.3, rejection_reason: 'low-quality' });
    logger.log({ status: 'failed' });

    expect(logger.summarize()).toEqual({
      processed: 3,
      pending: 1,
      converting: 1,
      scoring: 0,
      dedup: 0,
      published: 1,
      needs_review: 0,
      dry_run: 0,
      rejected: 1,
      failed: 1,
      averageQualityScore: 0.6,
      autoPublishRate: 0.333333,
      reasons: {
        'low-quality': 1,
      },
      qualityReasons: {},
    });
  });

  it('aggregates quality reasons separately from coarse rejection reasons', () => {
    const logger = new PipelineLogger();

    logger.log({
      status: 'rejected',
      source_url: 'https://example.com/a.mid',
      quality_score: 0,
      rejection_reason: 'low_quality',
      quality_reasons: ['FATAL_MAX_NOTE_DENSITY', 'LOW_TIMING_CONSISTENCY'],
    });

    logger.log({
      status: 'needs_review',
      source_url: 'https://example.com/b.mid',
      quality_score: 0.62,
      quality_reasons: ['HIGH_LOCAL_NOTE_DENSITY'],
    });

    expect(logger.summarize()).toMatchObject({
      rejected: 1,
      needs_review: 1,
      reasons: {
        low_quality: 1,
      },
      qualityReasons: {
        FATAL_MAX_NOTE_DENSITY: 1,
        LOW_TIMING_CONSISTENCY: 1,
        HIGH_LOCAL_NOTE_DENSITY: 1,
      },
    });
  });

  it('tracks needs-review and dry-run outcomes separately from published results', () => {
    const logger = new PipelineLogger();

    logger.log({ status: 'needs_review', quality_score: 0.62, quality_reasons: ['HIGH_LOCAL_NOTE_DENSITY'] });
    logger.log({ status: 'dry_run', quality_score: 0.71, quality_reasons: ['LOW_TIMING_CONSISTENCY'] });

    expect(logger.summarize()).toMatchObject({
      processed: 2,
      published: 0,
      needs_review: 1,
      dry_run: 1,
      autoPublishRate: 0,
      qualityReasons: {
        HIGH_LOCAL_NOTE_DENSITY: 1,
        LOW_TIMING_CONSISTENCY: 1,
      },
    });
  });

  it('renders valid JSON output with entries and summary payloads', () => {
    const logger = new PipelineLogger();

    logger.log({ status: 'published', quality_score: 0.82, source_url: 'https://example.com/one.mid' });
    logger.log({ status: 'published', quality_score: 0.61, source_url: 'https://example.com/two.mid', needs_review: true });

    const parsed = JSON.parse(logger.toJson()) as {
      entries: Array<Record<string, unknown>>;
      summary: Record<string, unknown>;
    };

    expect(parsed.entries).toHaveLength(2);
    expect(parsed.summary.published).toBe(2);
    expect(parsed.summary.averageQualityScore).toBe(0.715);
  });
});