import { describe, expect, it } from 'vitest';

import { PipelineLogger } from '../../src/lib/logger';

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
      rejected: 1,
      failed: 1,
      averageQualityScore: 0.6,
      autoPublishRate: 0.333333,
      reasons: {
        'low-quality': 1,
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