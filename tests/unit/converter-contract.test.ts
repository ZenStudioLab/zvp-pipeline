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
    expect(result.qualitySignals.totalRawNotes).toBe(2);
    expect(result.qualitySignals.inRangeNotes).toBe(2);
    expect(result.qualitySignals.avgNotesPerSecond).toBeGreaterThan(0);
    expect(result.notesPerSecond).toBe(result.qualitySignals.avgNotesPerSecond);
    expect(result.qualitySignals.averageChordSize).toBeLessThanOrEqual(result.qualitySignals.p95ChordSize);
    expect(result.qualitySignals.p95ChordSize).toBeLessThanOrEqual(result.qualitySignals.peakChordSize);
    expect(result.qualitySignals.p95NotesPerSecond).toBeLessThanOrEqual(result.qualitySignals.maxNotesPerSecond);
    expect(result.qualitySignals.p95NotesPerSecond).toBeGreaterThan(0);
    expect(result.qualitySignals.gridConfidence).toBeGreaterThanOrEqual(0);
    expect(result.qualitySignals.gridConfidence).toBeLessThanOrEqual(1);
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