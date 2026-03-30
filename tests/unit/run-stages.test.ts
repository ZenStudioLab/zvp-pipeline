import { describe, expect, it, vi } from 'vitest';
import TonejsMidi from '@tonejs/midi';

import { evaluatePipelineStages } from '../../src/lib/run-stages.js';

const { Midi } = TonejsMidi;

function createMidiBuffer(): Uint8Array {
  const midi = new Midi();
  midi.header.setTempo(120);

  const track = midi.addTrack();
  track.addNote({ midi: 60, time: 0, duration: 0.25, velocity: 0.8 });
  track.addNote({ midi: 64, time: 0.25, duration: 0.25, velocity: 0.82 });
  track.addNote({ midi: 67, time: 0.5, duration: 0.25, velocity: 0.84 });

  return new Uint8Array(midi.toArray());
}

describe('evaluatePipelineStages', () => {
  it('does not create artists during preview evaluation when artist creation is disabled', async () => {
    const createArtist = vi.fn(async () => ({ id: 'artist_1', slug: 'hans-zimmer', name: 'Hans Zimmer' }));

    const result = await evaluatePipelineStages(
      {
        rawTitle: 'Interstellar Main Theme OST',
        rawArtist: 'Hans Zimmer',
        file: createMidiBuffer(),
      },
      {
        genres: [{ id: 'genre_soundtrack', slug: 'soundtrack', name: 'Soundtrack' }],
        difficulties: [
          { id: 'difficulty_beginner', slug: 'beginner', label: 'Beginner', level: 1 },
          { id: 'difficulty_intermediate', slug: 'intermediate', label: 'Intermediate', level: 2 },
          { id: 'difficulty_advanced', slug: 'advanced', label: 'Advanced', level: 3 },
          { id: 'difficulty_expert', slug: 'expert', label: 'Expert', level: 4 },
        ],
        getExistingArtistNames: async () => [],
        findArtistByNormalizedName: async () => null,
        createArtist,
        findFingerprintByKey: async () => null,
      },
      { allowArtistCreation: false },
    );

    expect(result.ok).toBe(true);
    expect(createArtist).not.toHaveBeenCalled();
  });
});