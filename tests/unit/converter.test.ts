import { Midi } from '@tonejs/midi';
import { describe, expect, it } from 'vitest';

import { convertMidiSource } from '../../src/stages/converter';

function createSingleTrackMidi(): Uint8Array {
  const midi = new Midi();
  midi.header.setTempo(120);

  const track = midi.addTrack();
  track.channel = 0;
  track.addNote({ midi: 60, time: 0, duration: 0.25, velocity: 0.8 });
  track.addNote({ midi: 64, time: 0.25, duration: 0.25, velocity: 0.82 });
  track.addNote({ midi: 67, time: 0.5, duration: 0.25, velocity: 0.84 });

  return new Uint8Array(midi.toArray());
}

function createPercussionOnlyMidi(): Uint8Array {
  const midi = new Midi();
  midi.header.setTempo(120);

  const track = midi.addTrack();
  track.channel = 9;
  track.addNote({ midi: 36, time: 0, duration: 0.25, velocity: 0.8 });

  return new Uint8Array(midi.toArray());
}

function createEmptyMidi(): Uint8Array {
  const midi = new Midi();
  midi.header.setTempo(120);
  midi.addTrack();
  return new Uint8Array(midi.toArray());
}

describe('convertMidiSource', () => {
  it('converts valid MIDI into notation and scoring metrics', () => {
    const result = convertMidiSource({ file: createSingleTrackMidi() });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected successful conversion');
    }

    expect(result.sheetData).toBeTruthy();
    expect(result.noteCount).toBe(3);
    expect(result.notesPerSecond).toBeGreaterThan(0);
    expect(result.qualitySignals.totalNotes).toBe(3);
    expect(result.qualitySignals.inRangeNotes).toBe(3);
  });

  it('rejects percussion-only MIDI files before scoring', () => {
    const result = convertMidiSource({ file: createPercussionOnlyMidi() });

    expect(result).toEqual({
      ok: false,
      rejectionReason: 'percussion_only',
    });
  });

  it('rejects empty MIDI files before scoring', () => {
    const result = convertMidiSource({ file: createEmptyMidi() });

    expect(result).toEqual({
      ok: false,
      rejectionReason: 'empty_midi',
    });
  });

  it('returns a corrupted-midi rejection for invalid bytes', () => {
    const result = convertMidiSource({ file: Uint8Array.from([1, 2, 3, 4]) });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected failed conversion');
    }

    expect(result.rejectionReason).toBe('corrupted_midi');
    expect(result.details).toEqual(expect.objectContaining({ message: expect.any(String) }));
  });
});