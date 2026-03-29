import { describe, expect, it } from 'vitest';

import { normalizeMetadata } from '../../src/stages/normalizer';

describe('normalizeMetadata', () => {
  it('strips noisy title suffixes, normalizes unicode, and computes medium confidence for salvageable metadata', () => {
    const normalized = normalizeMetadata({
      rawTitle: 'Cafe\u0301 del mar (Piano Version) [Easy] - v2',
      rawArtist: 'john doe feat. jane smith',
    });

    expect(normalized.title).toBe('Café Del Mar');
    expect(normalized.artist).toBe('John Doe');
    expect(normalized.confidenceBand).toBe('medium');
    expect(normalized.confidenceScore).toBeGreaterThanOrEqual(0.5);
    expect(normalized.confidenceScore).toBeLessThan(0.8);
  });

  it('keeps clean metadata in the high confidence band', () => {
    const normalized = normalizeMetadata({
      rawTitle: 'River Flows in You',
      rawArtist: 'Yiruma',
    });

    expect(normalized.title).toBe('River Flows In You');
    expect(normalized.artist).toBe('Yiruma');
    expect(normalized.confidenceBand).toBe('high');
    expect(normalized.confidenceScore).toBeGreaterThanOrEqual(0.8);
  });

  it('drops malformed metadata into the low confidence band', () => {
    const normalized = normalizeMetadata({
      rawTitle: 'Track 01 [Tutorial]',
      rawArtist: '',
    });

    expect(normalized.title).toBe('Track 01');
    expect(normalized.artist).toBe('Unknown Artist');
    expect(normalized.confidenceBand).toBe('low');
    expect(normalized.confidenceScore).toBeLessThan(0.5);
  });

  it('reuses an existing artist spelling when fuzzy matching resolves a near-duplicate name', () => {
    const normalized = normalizeMetadata({
      rawTitle: 'Nuvole Bianche',
      rawArtist: 'Ludovico Enaudii with Guest',
      existingArtistNames: ['Ludovico Einaudi'],
    });

    expect(normalized.artist).toBe('Ludovico Einaudi');
    expect(normalized.normalizedArtist).toBe('ludovico einaudi');
  });

  it('preserves legitimate duo names that contain an ampersand', () => {
    const normalized = normalizeMetadata({
      rawTitle: 'The Sound of Silence',
      rawArtist: 'Simon & Garfunkel',
    });

    expect(normalized.artist).toBe('Simon & Garfunkel');
    expect(normalized.normalizedArtist).toBe('simon garfunkel');
  });

  it('keeps non-latin titles in the normalized key instead of collapsing them away', () => {
    const normalized = normalizeMetadata({
      rawTitle: '夜に駆ける',
      rawArtist: 'Yoasobi',
    });

    expect(normalized.normalizedTitle).toBe('夜に駆ける');
    expect(normalized.normalizedKey).toBe('yoasobi-夜に駆ける');
  });
});