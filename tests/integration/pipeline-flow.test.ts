import TonejsMidi from '@tonejs/midi';
import { describe, expect, it } from 'vitest';

import { processPipelineJob } from '../../src/lib/process-job';
import type { ArtistRecord, DifficultyRecord, FingerprintRecord, GenreRecord } from '../../src/stages/types';

const { Midi } = TonejsMidi;

function createPipelineMidi(): Uint8Array {
  const midi = new Midi();
  midi.header.setTempo(120);

  const track = midi.addTrack();
  track.channel = 0;
  track.addNote({ midi: 60, time: 0, duration: 0.25, velocity: 0.8 });
  track.addNote({ midi: 64, time: 0.25, duration: 0.25, velocity: 0.82 });
  track.addNote({ midi: 67, time: 0.5, duration: 0.25, velocity: 0.84 });

  return new Uint8Array(midi.toArray());
}

class InMemoryPipelineRepository {
  public readonly genres: GenreRecord[] = [{ id: 'genre_soundtrack', slug: 'soundtrack', name: 'Soundtrack' }];
  public readonly difficulties: DifficultyRecord[] = [
    { id: 'difficulty_beginner', slug: 'beginner', label: 'Beginner', level: 1 },
    { id: 'difficulty_intermediate', slug: 'intermediate', label: 'Intermediate', level: 2 },
    { id: 'difficulty_advanced', slug: 'advanced', label: 'Advanced', level: 3 },
    { id: 'difficulty_expert', slug: 'expert', label: 'Expert', level: 4 },
  ];

  public readonly statusTransitions: string[] = [];
  public readonly sheets: Array<Record<string, unknown>> = [];
  public readonly revalidated: string[][] = [];

  private readonly jobs = new Map<string, { status: string; sheetId: string | null }>();
  private readonly artists = new Map<string, ArtistRecord>();
  private readonly fingerprints = new Map<string, FingerprintRecord>();

  async getJobBySourceUrl(sourceUrl: string): Promise<{ status: string; sheetId: string | null } | null> {
    return this.jobs.get(sourceUrl) ?? null;
  }

  async saveJobStatus(event: { sourceUrl: string; status: string; sheetId?: string | null }): Promise<void> {
    this.statusTransitions.push(event.status);
    this.jobs.set(event.sourceUrl, { status: event.status, sheetId: event.sheetId ?? null });
  }

  async getExistingArtistNames(): Promise<string[]> {
    return [...this.artists.values()].map((artist) => artist.name);
  }

  async findArtistByNormalizedName(normalizedName: string): Promise<ArtistRecord | null> {
    return this.artists.get(normalizedName) ?? null;
  }

  async createArtist(input: { name: string; slug: string; normalizedName: string }): Promise<ArtistRecord> {
    const artist = { id: `artist_${this.artists.size + 1}`, slug: input.slug, name: input.name };
    this.artists.set(input.normalizedName, artist);
    return artist;
  }

  async findFingerprintByKey(normalizedKey: string): Promise<FingerprintRecord | null> {
    return this.fingerprints.get(normalizedKey) ?? null;
  }

  async insertSheet(sheet: Record<string, unknown>): Promise<{ id: string; slug: string }> {
    const inserted: Record<string, unknown> = { id: `sheet_${this.sheets.length + 1}`, ...sheet };
    this.sheets.push(inserted);
    return { id: String(inserted.id), slug: String(inserted['slug']) };
  }

  async updateFingerprint(update: { normalizedKey: string; canonicalSheetId: string; versionCount: number }): Promise<void> {
    this.fingerprints.set(update.normalizedKey, {
      normalizedKey: update.normalizedKey,
      canonicalSheetId: update.canonicalSheetId,
      canonicalQualityScore: 0.82,
      versionCount: update.versionCount,
    });
  }

  async revalidatePaths(paths: string[]): Promise<void> {
    this.revalidated.push(paths);
  }
}

describe('processPipelineJob', () => {
  it('runs the pipeline end-to-end and remains idempotent on rerun', async () => {
    const repository = new InMemoryPipelineRepository();
    const input = {
      sourceUrl: 'https://example.com/interstellar.mid',
      sourceSite: 'freemidi',
      rawTitle: 'Interstellar Main Theme OST',
      rawArtist: 'Hans Zimmer',
      youtubeUrl: 'https://www.youtube.com/watch?v=zSWdZVtXT7E',
      file: createPipelineMidi(),
      dryRun: false,
    };

    const firstRun = await processPipelineJob(input, repository);

    expect(firstRun).toEqual({
      idempotent: false,
      outcome: 'published',
      sheetId: 'sheet_1',
      transitions: ['pending', 'converting', 'scoring', 'dedup', 'published'],
    });
    expect(repository.sheets).toHaveLength(1);
    expect(repository.revalidated).toEqual([
      ['/', '/catalog', '/artist/hans-zimmer', '/genre/soundtrack', '/sheet/interstellar-main-theme-ost-hans-zimmer'],
    ]);
    expect(repository.statusTransitions).toEqual(['pending', 'converting', 'scoring', 'dedup', 'published']);

    const secondRun = await processPipelineJob(input, repository);

    expect(secondRun).toEqual({
      idempotent: true,
      outcome: 'published',
      sheetId: 'sheet_1',
      transitions: [],
    });
    expect(repository.sheets).toHaveLength(1);
  });
});