import { Midi } from '@tonejs/midi';
import { describe, expect, it } from 'vitest';

import { convertMidiSource } from '../../src/stages/converter';

function createMidiFixture(): Uint8Array {
  const midi = new Midi();
  midi.header.setTempo(120);

  const track = midi.addTrack();
  track.channel = 0;
  track.addNote({ midi: 60, time: 0, duration: 0.25, velocity: 0.8 });
  track.addNote({ midi: 64, time: 0.25, duration: 0.25, velocity: 0.76 });

  return new Uint8Array(midi.toArray());
}

describe('convertMidiSource contract', () => {
  it('converts real midi-to-vp output into pipeline quality signals', () => {
    const result = convertMidiSource({ file: createMidiFixture() });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected successful conversion');
    }

    expect(result.noteCount).toBe(2);
    expect(result.qualitySignals.totalNotes).toBe(2);
    expect(result.qualitySignals.inRangeNotes).toBe(2);
    expect(result.qualitySignals.notesPerSecond).toBeGreaterThan(0);
    expect(result.sheetData.length).toBeGreaterThan(0);
  });

  it('maps real converter failures for invalid bytes', () => {
    const result = convertMidiSource({ file: Uint8Array.from([1, 2, 3, 4]) });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected failed conversion');
    }

    expect(result.rejectionReason).toBe('corrupted_midi');
    expect(result.details).toEqual(
      expect.objectContaining({
        message: expect.any(String),
      }),
    );
  });
});