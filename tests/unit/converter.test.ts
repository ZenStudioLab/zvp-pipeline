import { beforeEach, describe, expect, it, vi } from 'vitest';

const { convertMidiToVpMock, midiCtorMock, tryConvertMidiToVpMock } = vi.hoisted(() => ({
  convertMidiToVpMock: vi.fn(() => {
    throw new Error('legacy convertMidiToVp path should not be used');
  }),
  midiCtorMock: vi.fn(() => ({
    tracks: [
      {
        channel: 0,
        notes: [{ midi: 60, time: 0, duration: 0.25, velocity: 0.8 }],
      },
    ],
  })),
  tryConvertMidiToVpMock: vi.fn(),
}));

vi.mock('@tonejs/midi', () => ({
  default: {
    Midi: midiCtorMock,
  },
}));

vi.mock('@zen/midi-to-vp', () => ({
  convertMidiToVp: convertMidiToVpMock,
  tryConvertMidiToVp: tryConvertMidiToVpMock,
  MIN_VP_MIDI: 48,
  MAX_VP_MIDI: 95,
}));

import { convertMidiSource } from '../../src/stages/converter';

describe('convertMidiSource', () => {
  beforeEach(() => {
    convertMidiToVpMock.mockClear();
    midiCtorMock.mockClear();
    tryConvertMidiToVpMock.mockClear();
  });

  it('maps successful conversion outcomes from tryConvertMidiToVp', () => {
    tryConvertMidiToVpMock.mockReturnValue({
      ok: true,
      transformedNotes: [{ midi: 60 }, { midi: 64 }, { midi: 67 }, { midi: 72 }],
      warnings: ['folded note'],
      notation: {
        selected: '[tu]y--d',
      },
      metadata: {
        tempoBpm: 120,
        qualitySignals: {
          totalRawNotes: 5,
          inRangeNotes: 4,
          averageChordSize: 1.5,
          peakChordSize: 3,
          notesPerSecond: 6.4,
          timingJitter: 0.125,
        },
      },
    });

    const result = convertMidiSource({ file: Uint8Array.from([1, 2, 3]) });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected successful conversion');
    }

    expect(tryConvertMidiToVpMock).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({
        notationMode: 'extended',
        includePercussion: false,
      }),
    );
    expect(convertMidiToVpMock).not.toHaveBeenCalled();
    expect(result.sheetData).toBe('[tu]y--d');
    expect(result.noteCount).toBe(4);
    expect(result.notesPerSecond).toBe(6.4);
    expect(result.qualitySignals).toEqual({
      totalNotes: 5,
      inRangeNotes: 4,
      averageChordSize: 1.5,
      peakChordSize: 3,
      notesPerSecond: 6.4,
      timingJitter: 0.125,
    });
  });

  it('maps internal_error to corrupted_midi and preserves diagnostics', () => {
    tryConvertMidiToVpMock.mockReturnValue({
      ok: false,
      reason: 'internal_error',
      details: {
        code: 'TypeError',
        message: 'Unable to resolve Midi constructor from @tonejs/midi',
        source: 'runtime_error',
      },
    });

    const result = convertMidiSource({ file: Uint8Array.from([1, 2, 3]) });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected failed conversion');
    }

    expect(result).toEqual({
      ok: false,
      rejectionReason: 'corrupted_midi',
      details: {
        code: 'TypeError',
        message: 'Unable to resolve Midi constructor from @tonejs/midi',
        source: 'runtime_error',
      },
    });
  });

  it('passes through typed conversion failures unchanged', () => {
    tryConvertMidiToVpMock.mockReturnValue({
      ok: false,
      reason: 'empty_midi',
      details: {
        code: 'EMPTY_MIDI',
        message: 'No MIDI notes were found',
        source: 'validation',
      },
    });

    const result = convertMidiSource({ file: Uint8Array.from([1, 2, 3]) });

    expect(result).toEqual({
      ok: false,
      rejectionReason: 'empty_midi',
      details: {
        code: 'EMPTY_MIDI',
        message: 'No MIDI notes were found',
        source: 'validation',
      },
    });
  });
});