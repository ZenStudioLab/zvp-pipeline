import { Midi } from '@tonejs/midi';
import { convertMidiToVp } from '@zen/midi-to-vp';

import type { ConverterResult } from './types.js';

const MIN_VP_MIDI = 48;
const MAX_VP_MIDI = 95;

export function convertMidiSource(input: { file: Uint8Array | Buffer }): ConverterResult {
  let midi: Midi;

  try {
    midi = new Midi(input.file instanceof Uint8Array ? input.file : new Uint8Array(input.file));
  } catch (error) {
    return {
      ok: false,
      rejectionReason: 'corrupted_midi',
      details: {
        message: error instanceof Error ? error.message : 'Unknown MIDI parsing error',
      },
    };
  }

  const pitchedNotes = midi.tracks.flatMap((track) =>
    track.channel === 9 ? [] : track.notes.map((note) => ({ ...note, channel: track.channel ?? 0 })),
  );

  if (pitchedNotes.length === 0) {
    const hasPercussion = midi.tracks.some((track) => track.channel === 9 && track.notes.length > 0);
    return {
      ok: false,
      rejectionReason: hasPercussion ? 'percussion_only' : 'empty_midi',
    };
  }

  const converted = convertMidiToVp(input.file, {
    notationMode: 'extended',
    includePercussion: false,
  });

  const noteCount = converted.transformedNotes.length;
  if (noteCount === 0) {
    return {
      ok: false,
      rejectionReason: 'empty_midi',
    };
  }

  const durationSeconds = Number(Math.max(...converted.transformedNotes.map((note) => note.endSec)).toFixed(3));
  const notesPerSecond = durationSeconds > 0 ? Number((noteCount / durationSeconds).toFixed(6)) : noteCount;
  const occupiedSlots = converted.timeline.filter((slot) => slot.notes.length > 0);
  const chordSizes = occupiedSlots.map((slot) => slot.notes.length);
  const stepSec = converted.metadata.stepSec;
  const jitterOffsets = converted.normalizedNotes
    .filter((note) => note.channel !== 9)
    .map((note) => {
      const nearestGrid = Math.round(note.startSec / stepSec) * stepSec;
      return Math.abs(note.startSec - nearestGrid) / Math.max(stepSec, 0.000001);
    });

  return {
    ok: true,
    sheetData: converted.notation.selected,
    bpm: converted.metadata.tempoBpm,
    durationSeconds,
    noteCount,
    notesPerSecond,
    warnings: converted.warnings,
    qualitySignals: {
      totalNotes: pitchedNotes.length,
      inRangeNotes: pitchedNotes.filter((note) => note.midi >= MIN_VP_MIDI && note.midi <= MAX_VP_MIDI).length,
      averageChordSize: chordSizes.length === 0 ? 0 : chordSizes.reduce((sum, value) => sum + value, 0) / chordSizes.length,
      peakChordSize: chordSizes.length === 0 ? 0 : Math.max(...chordSizes),
      notesPerSecond,
      timingJitter: jitterOffsets.length === 0 ? 0 : Number((jitterOffsets.reduce((sum, value) => sum + value, 0) / jitterOffsets.length).toFixed(6)),
    },
  };
}