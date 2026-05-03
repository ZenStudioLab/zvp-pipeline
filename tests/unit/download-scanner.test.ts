import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  utimesSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

import { scanDownloadDirectory } from '../../src/importers/download-scanner.js';

function createTempDir(): string {
  return mkdtempSync(join(os.tmpdir(), 'dl-scanner-'));
}

function removeTempDir(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/** Touch a file so its timestamps are ≥ `baseTime`. */
function touchFile(
  filePath: string,
  birthtime: Date,
): void {
  writeFileSync(filePath, 'dummy midi content', 'utf-8');
  // On most Linux fs we can't set birthtime directly, but we set mtime/atime.
  // For tests we rely on birthtime being auto-assigned (≈ now).
  // To simulate ordering we create files sequentially.
}

describe('scanDownloadDirectory', () => {
  it('discovers MIDI files sorted by birthtime', async () => {
    const dir = createTempDir();
    try {
      // Create files in reverse alphabetical order but sequential time
      const fileC = join(dir, 'c.mid');
      const fileB = join(dir, 'b.mid');
      const fileA = join(dir, 'a.mid');

      writeFileSync(fileC, 'content c');
      await new Promise((r) => setTimeout(r, 10));

      writeFileSync(fileB, 'content b');
      await new Promise((r) => setTimeout(r, 10));

      writeFileSync(fileA, 'content a');

      const result = await scanDownloadDirectory(dir);

      expect(result.files).toHaveLength(3);
      // Should be sorted by birthtime (creation order: c, b, a)
      expect(result.files[0].filename).toBe('c.mid');
      expect(result.files[1].filename).toBe('b.mid');
      expect(result.files[2].filename).toBe('a.mid');

      // Each entry has the expected shape
      for (const file of result.files) {
        expect(file.absolutePath).toBeTruthy();
        expect(file.filename).toMatch(/\.mid$/);
        expect(file.birthtime).toBeInstanceOf(Date);
        expect(file.ctime).toBeInstanceOf(Date);
        expect(file.mtime).toBeInstanceOf(Date);
        expect(file.byteSize).toBeGreaterThan(0);
      }

      // Statistics
      expect(result.statistics.totalFiles).toBe(3);
      expect(result.statistics.dateRange).not.toBeNull();
      expect(result.statistics.dateRange!.earliest.getTime()).toBeLessThanOrEqual(
        result.statistics.dateRange!.latest.getTime(),
      );
    } finally {
      removeTempDir(dir);
    }
  });

  it('ignores non-.mid files', async () => {
    const dir = createTempDir();
    try {
      writeFileSync(join(dir, 'song.mid'), 'midi');
      writeFileSync(join(dir, 'notes.txt'), 'text');
      writeFileSync(join(dir, 'audio.mp3'), 'mp3');
      writeFileSync(join(dir, 'readme.md'), '# readme');

      const result = await scanDownloadDirectory(dir);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].filename).toBe('song.mid');
      expect(result.statistics.totalFiles).toBe(1);
    } finally {
      removeTempDir(dir);
    }
  });

  it('errors on missing directory', async () => {
    const missingPath = join(os.tmpdir(), 'dl-scanner-nonexistent-' + Date.now());

    await expect(scanDownloadDirectory(missingPath)).rejects.toThrow(
      /Download directory not found or not readable/,
    );
  });

  it('returns empty for directory with no .mid files', async () => {
    const dir = createTempDir();
    try {
      writeFileSync(join(dir, 'notes.txt'), 'no midi here');
      writeFileSync(join(dir, 'song.mp3'), 'still no');

      const result = await scanDownloadDirectory(dir);

      expect(result.files).toEqual([]);
      expect(result.statistics.totalFiles).toBe(0);
      expect(result.statistics.dateRange).toBeNull();
    } finally {
      removeTempDir(dir);
    }
  });

  it('returns empty for an empty directory', async () => {
    const dir = createTempDir();
    try {
      const result = await scanDownloadDirectory(dir);

      expect(result.files).toEqual([]);
      expect(result.statistics.totalFiles).toBe(0);
      expect(result.statistics.dateRange).toBeNull();
    } finally {
      removeTempDir(dir);
    }
  });

  it('has correct byteSize for each file', async () => {
    const dir = createTempDir();
    try {
      const content = 'X'.repeat(1024);
      writeFileSync(join(dir, 'large.mid'), content);

      const result = await scanDownloadDirectory(dir);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].byteSize).toBe(1024);
    } finally {
      removeTempDir(dir);
    }
  });
});
