import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbClientEnd = vi.fn(async () => undefined);
const orderBy = vi.fn(async () => {
  throw new Error('bootstrap failed');
});
const from = vi.fn(() => ({ orderBy }));
const select = vi.fn(() => ({ from }));
const createDbClient = vi.fn(() => ({
  $client: { end: dbClientEnd },
  select,
}));

vi.mock('@zen/db', () => ({
  artist: { id: 'artist_id', slug: 'artist_slug', name: 'artist_name' },
  createDbClient,
  difficulty: { id: 'difficulty_id', slug: 'difficulty_slug', label: 'difficulty_label', level: 'difficulty_level' },
  genre: { id: 'genre_id', slug: 'genre_slug', name: 'genre_name', displayOrder: 'genre_display_order' },
  pipelineJob: { id: 'pipeline_job_id', status: 'status', sourceUrl: 'source_url', outputSheetId: 'output_sheet_id', createdAt: 'created_at', qualityScore: 'quality_score', rejectionReason: 'rejection_reason', sourceSite: 'source_site', rawTitle: 'raw_title', normalizedArtist: 'normalized_artist' },
  sheet: { id: 'sheet_id', isPublished: 'is_published', needsReview: 'needs_review', qualityScore: 'quality_score', slug: 'slug' },
  songFingerprint: { normalizedKey: 'normalized_key', canonicalSheetId: 'canonical_sheet_id', versionCount: 'version_count' },
}));

describe('createPipelineRuntimeRepository', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('closes the owned database client when bootstrap queries fail', async () => {
    const { createPipelineRuntimeRepository } = await import('../../src/lib/runtime-repository.js');

    await expect(createPipelineRuntimeRepository()).rejects.toThrow('bootstrap failed');
    expect(createDbClient).toHaveBeenCalledTimes(1);
    expect(dbClientEnd).toHaveBeenCalledWith({ timeout: 5 });
  });

  it('preserves the bootstrap error when db client shutdown also fails', async () => {
    dbClientEnd.mockRejectedValueOnce(new Error('close failed'));

    const { createPipelineRuntimeRepository } = await import('../../src/lib/runtime-repository.js');

    await expect(createPipelineRuntimeRepository()).rejects.toThrow('bootstrap failed');
    expect(dbClientEnd).toHaveBeenCalledWith({ timeout: 5 });
  });
});