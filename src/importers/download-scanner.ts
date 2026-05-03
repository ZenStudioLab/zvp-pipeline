/**
 * Download scanner – discovers .mid files in a given directory,
 * returns them sorted by birthtime (with fallbacks), plus scan statistics.
 *
 * @module importers/download-scanner
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ScannedFile {
  absolutePath: string;
  filename: string;
  birthtime: Date;
  ctime: Date;
  mtime: Date;
  byteSize: number;
}

export interface ScanStatistics {
  totalFiles: number;
  dateRange: { earliest: Date; latest: Date } | null;
}

export interface ScanResult {
  files: ScannedFile[];
  statistics: ScanStatistics;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Best-effort effective timestamp for sorting: birthtime → ctime → mtime.
 * Filesystems that don't support birthtime return epoch (0), so we fall back.
 */
function effectiveTimestamp(file: ScannedFile): number {
  const bt = file.birthtime.getTime();
  if (bt > 0) return bt;
  const ct = file.ctime.getTime();
  if (ct > 0) return ct;
  return file.mtime.getTime();
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Scan a directory for MIDI files and return metadata + statistics.
 *
 * @param dirPath - Absolute or relative path to the download directory.
 * @throws If the directory does not exist or is not readable.
 */
export async function scanDownloadDirectory(dirPath: string): Promise<ScanResult> {
  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : String(err);
    throw new Error(
      `Download directory not found or not readable: ${dirPath} — ${message}`,
    );
  }

  const midiFiles = entries.filter((name) =>
    name.toLowerCase().endsWith('.mid'),
  );

  if (midiFiles.length === 0) {
    return {
      files: [],
      statistics: { totalFiles: 0, dateRange: null },
    };
  }

  const scanned: ScannedFile[] = await Promise.all(
    midiFiles.map(async (filename) => {
      const absolutePath = join(dirPath, filename);
      const stats = await stat(absolutePath);
      return {
        absolutePath,
        filename,
        birthtime: stats.birthtime,
        ctime: stats.ctime,
        mtime: stats.mtime,
        byteSize: stats.size,
      };
    }),
  );

  // Sort by effective timestamp (birthtime → ctime → mtime)
  scanned.sort(
    (a, b) => effectiveTimestamp(a) - effectiveTimestamp(b),
  );

  // Build date range from the best available timestamp
  const allTimestamps = scanned
    .map((f) => {
      const bt = f.birthtime.getTime();
      if (bt > 0) return f.birthtime;
      const ct = f.ctime.getTime();
      if (ct > 0) return f.ctime;
      return f.mtime;
    })
    .filter((d) => d.getTime() > 0);

  const dateRange =
    allTimestamps.length > 0
      ? {
          earliest: allTimestamps.reduce((min, d) =>
            d < min ? d : min,
          ),
          latest: allTimestamps.reduce((max, d) =>
            d > max ? d : max,
          ),
        }
      : null;

  return {
    files: scanned,
    statistics: {
      totalFiles: scanned.length,
      dateRange,
    },
  };
}
