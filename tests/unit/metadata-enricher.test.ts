import { describe, expect, it } from 'vitest';

import { enrichSheetMetadata } from '../../src/stages/metadata-enricher';

const genres = [
  { id: 'genre_soundtrack', slug: 'soundtrack', name: 'Soundtrack' },
  { id: 'genre_anime', slug: 'anime', name: 'Anime' },
  { id: 'genre_classical', slug: 'classical', name: 'Classical' },
];

const difficulties = [
  { id: 'difficulty_beginner', slug: 'beginner', label: 'Beginner', level: 1 },
  { id: 'difficulty_intermediate', slug: 'intermediate', label: 'Intermediate', level: 2 },
  { id: 'difficulty_advanced', slug: 'advanced', label: 'Advanced', level: 3 },
  { id: 'difficulty_expert', slug: 'expert', label: 'Expert', level: 4 },
];

describe('enrichSheetMetadata', () => {
  it('assigns a genre from keywords and maps notes_per_second to difficulty', async () => {
    const metadata = await enrichSheetMetadata(
      {
        title: 'Interstellar Main Theme OST',
        artist: 'Hans Zimmer',
        normalizedArtist: 'hans zimmer',
        notesPerSecond: 5.4,
        youtubeUrl: 'https://www.youtube.com/watch?v=zSWdZVtXT7E',
      },
      {
        genres,
        difficulties,
        findArtistByNormalizedName: async () => ({ id: 'artist_existing', slug: 'hans-zimmer', name: 'Hans Zimmer' }),
        createArtist: async () => {
          throw new Error('should not create artist');
        },
      },
    );

    expect(metadata.genre.slug).toBe('soundtrack');
    expect(metadata.difficulty.slug).toBe('advanced');
    expect(metadata.slug).toBe('interstellar-main-theme-ost-hans-zimmer');
    expect(metadata.artist.id).toBe('artist_existing');
    expect(metadata.thumbnailUrl).toBe('https://img.youtube.com/vi/zSWdZVtXT7E/hqdefault.jpg');
  });

  it('creates a new artist record when the normalized artist is unknown', async () => {
    const createdArtists: Array<{ name: string; slug: string; normalizedName: string }> = [];
    const metadata = await enrichSheetMetadata(
      {
        title: 'Merry-Go-Round of Life',
        artist: 'Joe Hisaishi',
        normalizedArtist: 'joe hisaishi',
        notesPerSecond: 1.9,
      },
      {
        genres,
        difficulties,
        findArtistByNormalizedName: async () => null,
        createArtist: async (artist) => {
          createdArtists.push(artist);
          return { id: 'artist_new', slug: artist.slug, name: artist.name };
        },
      },
    );

    expect(createdArtists).toEqual([
      {
        name: 'Joe Hisaishi',
        slug: 'joe-hisaishi',
        normalizedName: 'joe hisaishi',
      },
    ]);
    expect(metadata.artist.id).toBe('artist_new');
    expect(metadata.difficulty.slug).toBe('beginner');
    expect(metadata.thumbnailUrl).toContain('/images/placeholders/');
  });

  it('falls back to a safe default genre when no keyword match exists', async () => {
    const metadata = await enrichSheetMetadata(
      {
        title: 'Moonlight Sonata',
        artist: 'Ludwig van Beethoven',
        normalizedArtist: 'ludwig van beethoven',
        notesPerSecond: 3.1,
      },
      {
        genres,
        difficulties,
        findArtistByNormalizedName: async () => ({ id: 'artist_classical', slug: 'ludwig-van-beethoven', name: 'Ludwig van Beethoven' }),
        createArtist: async () => {
          throw new Error('should not create artist');
        },
      },
    );

    expect(metadata.genre.slug).toBe('classical');
    expect(metadata.slug).toBe('moonlight-sonata-ludwig-van-beethoven');
    expect(metadata.difficulty.slug).toBe('intermediate');
  });
});