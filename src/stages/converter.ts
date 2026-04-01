import { tryConvertMidiToVp } from '@zen/midi-to-vp';

import type { ConverterResult } from './types.js';

export function convertMidiSource(input: { file: Uint8Array | Buffer }): ConverterResult {
  const bytes = input.file instanceof Uint8Array ? input.file : new Uint8Array(input.file);
  const converted = tryConvertMidiToVp(bytes, {
    notationMode: 'extended',
    includePercussion: false,
  });

  if (!converted.ok) {
    const mappedReason = converted.reason === 'internal_error' ? 'corrupted_midi' : converted.reason;
    const details = converted.details ? { ...converted.details } : undefined;

    return details
      ? {
          ok: false,
          rejectionReason: mappedReason,
          details,
        }
      : {
          ok: false,
          rejectionReason: mappedReason,
        };
  }

  const noteCount = converted.transformedNotes.length;
  const durationSeconds = noteCount === 0
    ? 0
    : Number(Math.max(...converted.transformedNotes.map((note) => note.endSec)).toFixed(3));
  const notesPerSecond = converted.metadata.qualitySignals.avgNotesPerSecond;

  return {
    ok: true,
    sheetData: converted.notation.selected,
    bpm: converted.metadata.tempoBpm,
    durationSeconds,
    noteCount,
    notesPerSecond,
    warnings: converted.warnings,
    qualitySignals: {
      totalRawNotes: converted.metadata.qualitySignals.totalRawNotes,
      inRangeNotes: converted.metadata.qualitySignals.inRangeNotes,
      averageChordSize: converted.metadata.qualitySignals.averageChordSize,
      peakChordSize: converted.metadata.qualitySignals.peakChordSize,
      avgNotesPerSecond: notesPerSecond,
      timingJitter: converted.metadata.qualitySignals.timingJitter,
      p95ChordSize: converted.metadata.qualitySignals.p95ChordSize,
      hardChordRate: converted.metadata.qualitySignals.hardChordRate,
      p95NotesPerSecond: converted.metadata.qualitySignals.p95NotesPerSecond,
      maxNotesPerSecond: converted.metadata.qualitySignals.maxNotesPerSecond,
      gridConfidence: converted.metadata.qualitySignals.gridConfidence,
    },
  };
}