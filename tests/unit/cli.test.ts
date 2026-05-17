import { describe, expect, it, vi } from "vitest";

import { asSourceDifficultyLabel, runCli } from "../../src/cli.js";
import type { CliDependencies } from "../../src/cli.js";
import { createPipelineRuntimeRepository } from "../../src/lib/runtime-repository.js";

vi.mock("../../src/env.js", () => ({
  loadPipelineEnvFile: vi.fn(),
}));

vi.mock("../../src/lib/runtime-repository.js", () => ({
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
    getSourceItemInventory: vi.fn(async () => ({
      queued: 0,
      running: 2,
      failed: 1,
      rejected: 1,
      published: 3,
      stranded: 2,
      stale: 1,
      warnings: [
        {
          kind: "stale_running",
          sourceUrl: "https://example.com/stuck.mid",
          state: "running",
          phase: "convert",
          phaseStartedAt: new Date().toISOString(),
        },
      ],
    })),
    requeueFailedJobs: vi.fn(async () => ({ requeued: 0, warnings: [] })),
    requeueStrandedJobs: vi.fn(async () => ({ requeued: 0, warnings: [] })),
    seedReferenceData: vi.fn(async () => ({ difficulties: 0, genres: 0 })),
    getCatalogSourceUrlsByStatus: vi.fn(async () => []),
    findAssetBySha256: vi.fn(async () => null),
    insertAsset: vi.fn(async () => ({ id: "asset_mock" })),
    listJobsWithAssets: vi.fn(async () => []),
    updateWorkCanonicalSheet: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  })),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
  promises: {
    readFile: vi.fn(async (filePath: string) => {
      if (String(filePath).endsWith("midi-scraper/catalog.json")) {
        return JSON.stringify({ entries: [] });
      }

      return new Uint8Array([77, 84, 104, 100]);
    }),
  },
}));

vi.mock("../../src/lib/run-stages.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/run-stages.js")>();
  return {
    ...actual,
    evaluatePipelineStages: vi.fn(actual.evaluatePipelineStages),
  };
});

import { evaluatePipelineStages } from "../../src/lib/run-stages.js";

function createDependencies() {
  const stdout = vi.fn();
  const stderr = vi.fn();
  const dispose = vi.fn(async () => undefined);
  type MockImportResult = Awaited<ReturnType<CliDependencies["importCommand"]>>;
  const runCommand = vi.fn(async () => ({
    preview: {
      sourceUrl: "./test.mid",
      title: "Test Song",
      artist: "Unknown Artist",
      quality: {
        scoreBand: "reject",
        score: 0,
        reasons: ["FATAL_MAX_NOTE_DENSITY", "LOW_TIMING_CONSISTENCY"],
      },
      publicationOutcome: "rejected",
    },
    summary: {
      processed: 1,
      published: 0,
      needs_review: 0,
      dry_run: 1,
      qualityReasons: {
        FATAL_MAX_NOTE_DENSITY: 1,
        LOW_TIMING_CONSISTENCY: 1,
      },
    },
  }));
  const importCommand = vi.fn(async (): Promise<MockImportResult> => ({
    filesScanned: 0,
    filesMatched: 0,
    filesUploaded: 0,
    rowsCreated: 0,
    dryRun: false,
    importRunId: null,
    diagnostics: [],
  }));
  const statsCommand = vi.fn(async () => ({
    totalJobs: 12,
    published: 8,
    reviewQueue: 2,
    rejected: 1,
    failed: 1,
    averageQualityScore: 0.78,
    reasons: { low_quality: 1 },
  }));
  const seedCommand = vi.fn(async () => ({ difficulties: 4, genres: 3 }));

  return {
    deps: {
      runCommand,
      importCommand,
      statsCommand,
      seedCommand,
      dispose,
      stdout,
      stderr,
    },
    dispose,
    runCommand,
    importCommand,
    statsCommand,
    seedCommand,
    stdout,
    stderr,
  };
}

describe("runCli", () => {
  it("normalizes source-item difficulty labels from imported arrangement rows", () => {
    expect(asSourceDifficultyLabel("beginner")).toBe("Beginner");
    expect(asSourceDifficultyLabel("intermediate")).toBe("Intermediate");
    expect(asSourceDifficultyLabel("advanced")).toBe("Advanced");
    expect(asSourceDifficultyLabel("Advanced")).toBe("Advanced");
    expect(asSourceDifficultyLabel("expert")).toBeNull();
    expect(asSourceDifficultyLabel(null)).toBeNull();
  });

  it("dispatches the run command with parsed options", async () => {
    const { deps, runCommand, dispose, stdout } = createDependencies();

    const exitCode = await runCli(
      ["run", "--file=./test.mid", "--dry-run", "--concurrency=3"],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(runCommand).toHaveBeenCalledWith({
      source: undefined,
      limit: 100,
      file: "./test.mid",
      dryRun: true,
      skipRevalidation: false,
      status: undefined,
      concurrency: 3,
      sourceItems: false,
      forceGenerate: false,
      arrangementId: undefined,
      reason: undefined,
      publish: false,
      retryFailed: false,
      requeueStranded: false,
    });
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining("FATAL_MAX_NOTE_DENSITY"),
    );
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining("qualityReasons"),
    );
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("includes a self-explanatory summary in import output", async () => {
    const { deps, importCommand, stdout } = createDependencies();

    const importResult = {
      filesScanned: 3,
      filesMatched: 1,
      filesUploaded: 1,
      rowsCreated: 1,
      dryRun: false,
      importRunId: "run_1",
      diagnostics: [],
      matchedFileDetails: [
        {
          localFilePath: "/downloads/matched.mid",
          localFilename: "matched.mid",
          localFileBirthtime: "2026-05-15T12:50:04.120Z",
          exportTitle: "Matched Song",
          exportSourceUrl: "https://example.com/matched",
          exportDifficultyLabel: "Intermediate",
          exportDownloadStartedAt: "2026-05-15T12:49:04.450Z",
          matchMethod: "time_window",
          confidence: "high",
          timeDeltaSeconds: 4.2,
          maxMatchingWindowSeconds: 60,
          windowDescription: "1:1 match within 4.2s of download_started_at",
          upload: {
            performed: true,
            reused: false,
            assetId: "asset_1",
            publicUrl: "https://storage.example.com/asset_1",
            byteSize: 1024,
          },
          catalog: {
            performed: true,
            arrangementNew: true,
            arrangementId: "arr_1",
            pipelineJobNew: true,
            pipelineJobId: "job_1",
          },
          reviewStatus: null,
        },
      ],
      unmatchedLocalFileDetails: [
        {
          localFilePath: "/downloads/unmatched.mid",
          localFilename: "unmatched.mid",
          localFileBirthtime: "2026-05-15T12:50:20.065Z",
          reasonCode: "outside_window",
          reasonMessage: "Nearest export variant was 73.1s away, outside the 60s window.",
          nearestCandidate: {
            exportTitle: "Closest Song",
            exportSourceUrl: "https://example.com/closest",
            exportDifficultyLabel: "Beginner",
            exportDownloadStartedAt: "2026-05-15T12:49:06.965Z",
            timeDeltaSeconds: 73.1,
            maxMatchingWindowSeconds: 60,
            alreadyMatchedToOtherFile: false,
            windowDescription: "Closest candidate is 73.1s away, outside the 60s window.",
          },
          candidateComparisons: [
            {
              exportTitle: "Closest Song",
              exportSourceUrl: "https://example.com/closest",
              exportDifficultyLabel: "Beginner",
              exportDownloadStartedAt: "2026-05-15T12:49:06.965Z",
              timeDeltaSeconds: 73.1,
              withinMatchingWindow: false,
              alreadyMatchedToOtherFile: false,
            },
          ],
        },
      ],
      unmatchedExportVariantDetails: [
        {
          exportTitle: "Orphan Song",
          exportSourceUrl: "https://example.com/orphan",
          exportDifficultyLabel: "Advanced",
          reasonCode: "no_local_file_in_window",
          reasonMessage: "No local file remained within the timing window.",
          nearestCandidate: null,
        },
      ],
    } satisfies Awaited<ReturnType<CliDependencies["importCommand"]>>;

    importCommand.mockResolvedValueOnce(importResult);

    const exitCode = await runCli(
      ["import", "--export-file=/tmp/export.json", "--download-dir=/tmp/downloads"],
      deps,
    );

    expect(exitCode).toBe(0);
    const output = stdout.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);

    expect(parsed).toMatchObject({
      filesScanned: 3,
      filesMatched: 1,
      filesUploaded: 1,
      rowsCreated: 1,
      diagnostics: [],
    });
    expect(parsed.summary).toMatchObject({
      scannedLocalFiles: 3,
      matchedFiles: 1,
      unmatchedLocalFiles: 2,
      newUploads: 1,
      reusedAssets: 0,
      catalogRowsProcessed: 1,
      catalogRowsWritten: 1,
      explanation: expect.stringContaining("2 local file(s) did not match"),
    });
    expect(parsed.summary.matchedFileDetails[0]).toMatchObject({
      localFilename: "matched.mid",
      exportTitle: "Matched Song",
      upload: { assetId: "asset_1", reused: false },
      catalog: { arrangementNew: true, pipelineJobNew: true },
    });
    expect(parsed.summary.unmatchedLocalFileDetails[0]).toMatchObject({
      localFilename: "unmatched.mid",
      reasonCode: "outside_window",
    });
    expect(parsed.summary.unmatchedExportVariantDetails[0]).toMatchObject({
      exportTitle: "Orphan Song",
      reasonCode: "no_local_file_in_window",
    });

    expect(parsed).not.toHaveProperty("matchedFileDetails");
    expect(parsed).not.toHaveProperty("unmatchedLocalFileDetails");
    expect(parsed).not.toHaveProperty("unmatchedExportVariantDetails");
  });

  it("reports zero processed catalog rows on dry-run", async () => {
    const { deps, importCommand, stdout } = createDependencies();

    const importResult = {
      filesScanned: 2,
      filesMatched: 2,
      filesUploaded: 0,
      rowsCreated: 0,
      dryRun: true,
      importRunId: null,
      diagnostics: [],
      matchedFileDetails: [],
      unmatchedLocalFileDetails: [],
      unmatchedExportVariantDetails: [],
    } satisfies Awaited<ReturnType<CliDependencies["importCommand"]>>;

    importCommand.mockResolvedValueOnce(importResult);

    const exitCode = await runCli(
      ["import", "--export-file=/tmp/export.json", "--download-dir=/tmp/downloads", "--dry-run"],
      deps,
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.mock.calls[0][0] as string);

    expect(parsed.summary).toMatchObject({
      catalogRowsProcessed: 0,
      catalogRowsWritten: 0,
      explanation: expect.stringContaining("Dry run skipped uploads and catalog writes."),
    });
  });

  it("passes matching-window override to import command", async () => {
    const { deps, importCommand } = createDependencies();

    const exitCode = await runCli(
      [
        "import",
        "--export-file=/tmp/export.json",
        "--download-dir=/tmp/downloads",
        "--matching-window=240",
      ],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(importCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        maxMatchingWindowSeconds: 240,
      }),
    );
  });

  it("rejects invalid matching-window override", async () => {
    const { deps, stderr } = createDependencies();

    const exitCode = await runCli(
      ["import", "--export-file=/tmp/export.json", "--download-dir=/tmp/downloads", "--matching-window=0"],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith("--matching-window must be a positive number.");
  });

  it("makes retry-failed use the source-items recovery path", async () => {
    const { deps, runCommand, dispose } = createDependencies();

    const exitCode = await runCli(["run", "--retry-failed"], deps);

    expect(exitCode).toBe(0);
    expect(runCommand).toHaveBeenCalledWith({
      source: undefined,
      limit: 100,
      file: undefined,
      dryRun: false,
      skipRevalidation: false,
      status: undefined,
      concurrency: 5,
      sourceItems: true,
      forceGenerate: false,
      arrangementId: undefined,
      reason: undefined,
      publish: false,
      retryFailed: true,
      requeueStranded: false,
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("makes requeue-stranded use the source-items recovery path", async () => {
    const { deps, runCommand, dispose } = createDependencies();

    const exitCode = await runCli(["run", "--requeue-stranded"], deps);

    expect(exitCode).toBe(0);
    expect(runCommand).toHaveBeenCalledWith({
      source: undefined,
      limit: 100,
      file: undefined,
      dryRun: false,
      skipRevalidation: false,
      status: undefined,
      concurrency: 5,
      sourceItems: true,
      forceGenerate: false,
      arrangementId: undefined,
      reason: undefined,
      publish: false,
      retryFailed: false,
      requeueStranded: true,
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects retry-failed with requeue-stranded together", async () => {
    const { deps, stderr, dispose } = createDependencies();

    const exitCode = await runCli(
      ["run", "--retry-failed", "--requeue-stranded"],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      "--retry-failed cannot be combined with --requeue-stranded.",
    );
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("forwards the skip revalidation flag to the run command", async () => {
    const { deps, runCommand, dispose } = createDependencies();

    const exitCode = await runCli(["run", "--skip-revalidation"], deps);

    expect(exitCode).toBe(0);
    expect(runCommand).toHaveBeenCalledWith({
      source: undefined,
      limit: 100,
      file: undefined,
      dryRun: false,
      skipRevalidation: true,
      status: undefined,
      concurrency: 5,
      sourceItems: false,
      forceGenerate: false,
      arrangementId: undefined,
      reason: undefined,
      publish: false,
      retryFailed: false,
      requeueStranded: false,
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("dispatches force generation options to the run command", async () => {
    const { deps, runCommand, dispose } = createDependencies();

    const exitCode = await runCli(
      [
        "run",
        "--source-items",
        "--force-generate",
        "--arrangement-id=arr_123",
        "--reason=operator override",
        "--publish",
      ],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceItems: true,
        forceGenerate: true,
        arrangementId: "arr_123",
        reason: "operator override",
        publish: true,
      }),
    );
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects force generation without source-items", async () => {
    const { deps, stderr, dispose } = createDependencies();

    const exitCode = await runCli([
      "run",
      "--force-generate",
      "--arrangement-id=arr_123",
      "--reason=operator override",
    ], deps);

    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      "--force-generate requires --source-items.",
    );
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects force generation without arrangement-id", async () => {
    const { deps, stderr, dispose } = createDependencies();

    const exitCode = await runCli([
      "run",
      "--source-items",
      "--force-generate",
      "--reason=operator override",
    ], deps);

    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      "--arrangement-id is required with --force-generate.",
    );
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects blank force reason", async () => {
    const { deps, stderr, dispose } = createDependencies();

    const exitCode = await runCli([
      "run",
      "--source-items",
      "--force-generate",
      "--arrangement-id=arr_123",
      "--reason=   ",
    ], deps);

    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("--reason must be a non-empty string"),
    );
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported status filters", async () => {
    const { deps, stderr, dispose } = createDependencies();

    const exitCode = await runCli([
      "run",
      "--status=unknown",
    ], deps);

    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("--status must be one of:"),
    );
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps dry-run preview publication outcome aligned with pipeline scoring bands", async () => {
    vi.mocked(evaluatePipelineStages).mockResolvedValueOnce({
      ok: true,
      normalized: {
        title: "Test Song",
        artist: "Test Artist",
        normalizedTitle: "test song",
        normalizedArtist: "test artist",
        normalizedKey: "test artist-test song",
        confidenceScore: 0.91,
        confidenceBand: "high",
      },
      conversion: {
        sheetData: "[tu]y--d",
        bpm: 120,
        durationSeconds: 90,
        noteCount: 320,
        notesPerSecond: 3.55,
      },
      qualityAssessment: {
        score: 0.749,
        scoreBand: "review",
        rubricVersion: "v2",
        signals: {
          inRangeRatio: 0.68,
          chordComplexity: 0.82,
          noteDensity: 0.74,
          timingConsistency: 0.81,
        },
        reasons: ["LOW_IN_RANGE_RATIO"],
        stats: {
          totalNotes: 100,
          inRangeNotes: 68,
          averageChordSize: 1.6,
          peakChordSize: 4,
          p95ChordSize: 3,
          hardChordRate: 0.08,
          avgNotesPerSecond: 4.3,
          p95NotesPerSecond: 5.2,
          maxNotesPerSecond: 6.1,
          timingJitter: 0.03,
          gridConfidence: 0.9,
          durationSeconds: 23.255814,
        },
      },
      dedupDecision: {
        action: "create-fingerprint",
        isCanonical: true,
        canonicalSheetId: null,
        nextVersionCount: 1,
        fingerprint: {
          normalizedKey: "test artist-test song",
          canonicalSheetId: null,
          versionCount: 1,
          shouldCreate: true,
          shouldPromoteCanonical: false,
        },
      },
      enrichment: {
        slug: "test-song-test-artist",
        thumbnailUrl: "https://img.youtube.com/vi/test/hqdefault.jpg",
        genre: { id: "genre_1", slug: "classical", name: "Classical" },
        difficulty: {
          id: "difficulty_1",
          slug: "beginner",
          label: "Beginner",
          level: 1,
        },
        artist: { id: "artist_1", slug: "test-artist", name: "Test Artist" },
      },
    });

    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    const exitCode = await runCli(["run", "--file=./test.mid", "--dry-run"]);

    expect(exitCode).toBe(0);
    expect(evaluatePipelineStages).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining('"scoreBand": "review"'),
    );
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining('"publicationOutcome": "needs_review"'),
    );
    writeSpy.mockRestore();
  });

  it("rejects conflicting file and source flags", async () => {
    const { deps, stderr, dispose } = createDependencies();

    const exitCode = await runCli(
      ["run", "--file=./test.mid", "--source=freemidi"],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      "--file cannot be combined with --source.",
    );
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects conflicting file and status flags", async () => {
    const { deps, stderr, dispose } = createDependencies();

    const exitCode = await runCli(
      ["run", "--file=./test.mid", "--status=published"],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      "--file cannot be combined with --status.",
    );
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported status filters", async () => {
    const { deps, stderr, dispose } = createDependencies();

    const exitCode = await runCli(["run", "--status=unknown"], deps);

    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      "--status must be one of: pending, converting, scoring, dedup, published, needs_review, rejected, failed.",
    );
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("prints formatted stats output", async () => {
    const { deps, stdout } = createDependencies();

    const exitCode = await runCli(["stats"], deps);

    expect(exitCode).toBe(0);
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining("Pipeline Stats"),
    );
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining("Total jobs:        12"),
    );
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining("Avg quality score: 0.78"),
    );
    expect(stdout).toHaveBeenCalledWith(
      expect.not.stringContaining("Quality reasons:"),
    );
  });

  it("prints inventory counts and stranded warnings for empty source-items runs", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.mocked(createPipelineRuntimeRepository).mockResolvedValueOnce({
      getSourceItemInventory: vi.fn(async () => ({
        queued: 0,
        running: 2,
        failed: 1,
        rejected: 1,
        published: 3,
        stranded: 2,
        stale: 1,
        warnings: [
          {
            kind: "stale_running",
            sourceUrl: "https://example.com/stuck.mid",
            status: "converting",
            state: "running",
            phase: "convert",
            processedAt: null,
            phaseStartedAt: new Date().toISOString(),
          },
        ],
      })),
      listJobsWithAssets: vi.fn(async () => []),
      close: vi.fn(async () => undefined),
    } as never);

    const exitCode = await runCli(["run", "--source-items", "--limit=10"]);

    expect(exitCode).toBe(0);
    const output = JSON.parse(writeSpy.mock.calls[0][0] as string);
    expect(output.inventory).toEqual(
      expect.objectContaining({
        queued: 0,
        running: 2,
        failed: 1,
        rejected: 1,
        published: 3,
      }),
    );
    expect(output.warnings).toHaveLength(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("[stranded] kind=stale_running"),
    );
    writeSpy.mockRestore();
    stderrSpy.mockRestore();
    expect(output.note).toContain("No queued source items");
  });

  it("dispatches the seed command", async () => {
    const { deps, seedCommand, stdout } = createDependencies();

    const exitCode = await runCli(["seed"], deps);

    expect(exitCode).toBe(0);
    expect(seedCommand).toHaveBeenCalledTimes(1);
    expect(stdout).toHaveBeenCalledWith("Seeded 4 difficulties and 3 genres.");
  });

  it("allows seed to run even when normal runtime bootstrap would reject missing reference data", async () => {
    const deps = createDependencies();
    const exitCode = await runCli(["seed"], deps.deps);

    expect(exitCode).toBe(0);
    expect(deps.seedCommand).toHaveBeenCalledTimes(1);
  });

  it("reports cleanup failures without masking command completion", async () => {
    const { deps, stderr } = createDependencies();
    deps.dispose = vi.fn(async () => {
      throw new Error("cleanup failed");
    });

    const exitCode = await runCli(["stats"], deps);

    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith("cleanup failed");
  });
});
