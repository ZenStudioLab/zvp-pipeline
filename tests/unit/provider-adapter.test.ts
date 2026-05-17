import { describe, expect, it } from 'vitest';

import fixture from '../fixtures/scraper-export.json' with { type: 'json' };
import {
  adaptScraperExportRecords,
  parseProviderItemId,
  resolveProviderAdapter,
} from '../../src/importers/provider-adapter.js';

describe('provider adapter contract', () => {
  it('resolves a MuseScore adapter from a provider-qualified item id', () => {
    const adapter = resolveProviderAdapter('musescore:4383881');
    expect(adapter.provider).toBe('musescore');
    expect(parseProviderItemId('musescore:4383881')).toEqual({ provider: 'musescore', itemId: '4383881' });
  });

  it('rejects malformed provider item ids', () => {
    expect(() => parseProviderItemId('4383881')).toThrow();
  });

  it('adapts the current hierarchical MuseScore export without legacy field names or numeric score ids', () => {
    const result = adaptScraperExportRecords(fixture.records);

    expect(result.diagnostics).toEqual([]);
    expect(result.records).toHaveLength(2);

    const [record] = result.records;
    const [variant] = record.variants;

    expect(record).toMatchObject({
      work_order: 1,
      canonical_title: 'Nocturne in E-flat Major',
      artist_name: 'Frédéric Chopin',
      artist_url: 'https://musescore.com/user/991122',
      song_url: 'https://musescore.com/user/991122/scores/4383881',
    });
    expect(variant).toMatchObject({
      provider: 'musescore',
      provider_item_id: 'musescore:4383881',
      source_site: 'musescore',
      source_url: 'https://musescore.com/user/991122/scores/4383881',
      score_id: 'musescore:4383881',
      title: 'Nocturne in E-flat Major',
      artist: 'Frédéric Chopin',
      view_count: 128340,
      like_count: 4812,
      comment_count: 219,
      rating_score: 4.91,
      rating_count: 1503,
      difficulty_rank: 2,
      duration_seconds: 282,
      scraped_at: '2026-05-01T10:00:00.000Z',
    });
    expect(typeof variant.provider_item_id).toBe('string');
    expect(variant.raw_metadata).toEqual({
      raw_record: expect.objectContaining({ artist_name: 'Frédéric Chopin' }),
      raw_variant: expect.objectContaining({ score_id: 'musescore:4383881' }),
    });
  });

  it('canonicalizes an unprefixed MuseScore score id when score_url identifies MuseScore', () => {
    const result = adaptScraperExportRecords([
      {
        canonical_title: 'Prelude',
        artist_name: 'Composer',
        variants: [
          {
            score_id: '4383881',
            score_url: 'https://musescore.com/user/1/scores/4383881',
            difficulty_label: 'Beginner',
            download_started_at: '2026-05-01T10:00:00.000Z',
          },
        ],
      },
    ]);

    expect(result.diagnostics).toEqual([]);
    expect(result.records[0].variants[0].provider_item_id).toBe('musescore:4383881');
    expect(result.records[0].variants[0].raw_metadata.raw_variant).toEqual(
      expect.objectContaining({ score_id: '4383881' }),
    );
  });

  it('normalizes MuseScore difficulty labels for source-item provenance', () => {
    const result = adaptScraperExportRecords([
      {
        canonical_title: 'Golden Hour',
        artist_name: 'JVKE',
        variants: [
          {
            score_id: 'musescore:8772048',
            score_url: 'https://musescore.com/user/1/scores/8772048',
            difficulty_label: 'beginner',
            download_started_at: '2026-05-01T10:00:00.000Z',
          },
        ],
      },
    ]);

    expect(result.diagnostics).toEqual([]);
    expect(result.records[0].variants[0].difficulty_label).toBe('Beginner');
  });

  it('reports unsupported providers, conflicting evidence, and missing timestamps without normalized variants', () => {
    const result = adaptScraperExportRecords([
      {
        canonical_title: 'Malformed',
        variants: [
          { score_id: 'unknown:1', score_url: 'https://example.com/scores/1', difficulty_label: 'Beginner' },
          { score_id: 'musescore:2', score_url: 'https://example.com/scores/2', difficulty_label: 'Beginner' },
          { score_id: 'musescore:3', score_url: 'https://musescore.com/user/1/scores/3', difficulty_label: 'Beginner' },
        ],
      },
    ]);

    expect(result.records[0].variants).toHaveLength(0);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'unsupported-provider' }),
      expect.objectContaining({ code: 'malformed-provider' }),
      expect.objectContaining({ code: 'missing-timestamp' }),
    ]);
  });
});
