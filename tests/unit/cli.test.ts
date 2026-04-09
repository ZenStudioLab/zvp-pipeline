import { describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli.js";

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
    seedReferenceData: vi.fn(async () => ({ difficulties: 0, genres: 0 })),
    getCatalogSourceUrlsByStatus: vi.fn(async () => []),
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
      statsCommand,
      seedCommand,
      dispose,
      stdout,
      stderr,
    },
    dispose,
    runCommand,
    statsCommand,
    seedCommand,
    stdout,
    stderr,
  };
}

describe("runCli", () => {
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
      status: undefined,
      concurrency: 3,
    });
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining("FATAL_MAX_NOTE_DENSITY"),
    );
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining("qualityReasons"),
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

  it("dispatches the seed command", async () => {
    const { deps, seedCommand, stdout } = createDependencies();

    const exitCode = await runCli(["seed"], deps);

    expect(exitCode).toBe(0);
    expect(seedCommand).toHaveBeenCalledTimes(1);
    expect(stdout).toHaveBeenCalledWith("Seeded 4 difficulties and 3 genres.");
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
