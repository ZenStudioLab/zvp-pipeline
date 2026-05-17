import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/cli.js';
import { createPipelineRuntimeRepository } from '../../src/lib/runtime-repository.js';

vi.mock('../../src/env.js', () => ({
  loadPipelineEnvFile: vi.fn(),
}));

vi.mock('../../src/lib/runtime-repository.js', () => ({
  createPipelineRuntimeRepository: vi.fn(async () => ({
    getStats: vi.fn(async () => ({
      totalJobs: 0,
      published: 0,
      reviewQueue: 0,
      rejected: 0,
      failed: 0,
      averageQualityScore: 0,
      reasons: {},
    })),
    close: vi.fn(async () => undefined),
  })),
}));

const fixtureDir = fileURLToPath(new URL('../fixtures/midi-scraper-real', import.meta.url));
const exportFile = path.join(fixtureDir, 'scraper-export.json');

describe('import command with copied real midi-scraper fixture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUPABASE_URL = 'http://127.0.0.1:54331';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  });

  it('emits concrete matched or unmatched file details from the real fixture', async () => {
    const stdoutChunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const exitCode = await runCli([
        'import',
        `--export-file=${exportFile}`,
        `--download-dir=${fixtureDir}`,
        '--dry-run',
      ]);

      expect(exitCode).toBe(0);
      expect(createPipelineRuntimeRepository).toHaveBeenCalledTimes(1);

      const parsed = JSON.parse(stdoutChunks.join('').trim());
      const detailedLocalFiles = [
        ...parsed.summary.matchedFileDetails,
        ...parsed.summary.unmatchedLocalFileDetails,
      ];

      expect(parsed.filesScanned).toBe(3);
      expect(detailedLocalFiles).toHaveLength(parsed.filesScanned);
      expect(detailedLocalFiles.map((entry: { localFilename: string }) => entry.localFilename).sort()).toEqual([
        'golden-hour-jvke-updated-ver.mid',
        'golden-hour-jvke.mid',
        'golden-hour.mid',
      ]);
      expect(parsed.summary.unmatchedLocalFileDetails[0]).toEqual(
        expect.objectContaining({
          localFilename: expect.stringMatching(/golden-hour/),
          reasonCode: expect.any(String),
          reasonMessage: expect.any(String),
          localFileBirthtime: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          nearestCandidate: expect.objectContaining({
            exportDownloadStartedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
            maxMatchingWindowSeconds: expect.any(Number),
          }),
          candidateComparisons: expect.arrayContaining([
            expect.objectContaining({
              exportDifficultyLabel: 'Advanced',
              exportDownloadStartedAt: '2026-05-15T12:49:04.450Z',
              timeDeltaSeconds: expect.any(Number),
              withinMatchingWindow: expect.any(Boolean),
            }),
          ]),
        }),
      );
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
