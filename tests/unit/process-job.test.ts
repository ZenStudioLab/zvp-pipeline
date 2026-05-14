/**
 * process-job.test.ts
 *
 * Focused tests for import-provenance forwarding in processPipelineJob.
 * The run-stages evaluation layer is mocked so the test asserts only that
 * workId / arrangementId / sourceDifficultyLabel / conversionLevel from
 * ProcessPipelineInput reach the insertSheet repository call unchanged.
 */

import { describe, expect, it, vi } from "vitest";
import { processPipelineJob } from "../../src/lib/process-job.js";

// ── Mock evaluatePipelineStages ──────────────────────────────────────────────

vi.mock("../../src/lib/run-stages.js", () => ({
  evaluatePipelineStages: vi.fn().mockResolvedValue({
    ok: true,
    normalized: {
      title: "Test Song",
      artist: "Test Artist",
      normalizedTitle: "test song",
      normalizedArtist: "test artist",
      normalizedKey: "test-artist-test-song",
      confidenceScore: 0.92,
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
      score: 0.82,
      rubricVersion: "v1",
      reasons: [],
      scoreBand: "publish",
    },
    dedupDecision: {
      action: "create-fingerprint",
      isCanonical: true,
      canonicalSheetId: null,
      nextVersionCount: 1,
      fingerprint: {
        normalizedKey: "test-artist-test-song",
        canonicalSheetId: null,
        versionCount: 1,
        shouldCreate: true,
        shouldPromoteCanonical: false,
      },
    },
    enrichment: {
      slug: "test-song-test-artist",
      thumbnailUrl: "https://example.com/thumb.jpg",
      genre: { id: "genre_1", slug: "soundtrack", name: "Soundtrack" },
      difficulty: { id: "diff_1", slug: "advanced", label: "Advanced", level: 3 },
      artist: { id: "artist_1", slug: "test-artist", name: "Test Artist" },
    },
  }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMinimalRepository(
  overrides: Partial<Parameters<typeof processPipelineJob>[1]> = {},
): Parameters<typeof processPipelineJob>[1] {
  return {
    genres: [{ id: "genre_1", slug: "soundtrack", name: "Soundtrack" }],
    difficulties: [{ id: "diff_1", slug: "advanced", label: "Advanced", level: 3 }],
    getJobBySourceUrl: async () => null,
    findSheetBySourceUrl: async () => null,
    saveJobStatus: async () => undefined,
    getExistingArtistNames: async () => [],
    findArtistByNormalizedName: async () => null,
    createArtist: async (input) => ({ id: "artist_1", slug: input.slug, name: input.name }),
    findFingerprintByKey: async () => null,
    insertSheet: async (sheet) => ({ id: "sheet_1", slug: String(sheet.slug) }),
    promoteCanonicalFamily: async () => undefined,
    updateFingerprint: async () => undefined,
    revalidatePaths: async () => undefined,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("processPipelineJob — import provenance forwarding", () => {
  it("forwards all four provenance fields to insertSheet for imported jobs", async () => {
    const insertedSheets: Array<Record<string, unknown>> = [];

    const repository = createMinimalRepository({
      insertSheet: async (sheet) => {
        insertedSheets.push(sheet as Record<string, unknown>);
        return { id: "sheet_imported", slug: String(sheet.slug) };
      },
    });

    await processPipelineJob(
      {
        sourceUrl: "https://musescore.com/score/12345",
        sourceSite: "musescore",
        rawTitle: "Test Song",
        rawArtist: "Test Artist",
        file: new Uint8Array(0),
        dryRun: false,
        // ── import provenance ──
        workId: "work_abc",
        arrangementId: "arr_xyz",
        sourceDifficultyLabel: "Intermediate",
        conversionLevel: "Adept",
      },
      repository,
    );

    expect(insertedSheets).toHaveLength(1);
    expect(insertedSheets[0]).toEqual(
      expect.objectContaining({
        workId: "work_abc",
        arrangementId: "arr_xyz",
        sourceDifficultyLabel: "Intermediate",
        conversionLevel: "Adept",
      }),
    );
  });

  it("passes null provenance fields when none are supplied (local run)", async () => {
    const insertedSheets: Array<Record<string, unknown>> = [];

    const repository = createMinimalRepository({
      insertSheet: async (sheet) => {
        insertedSheets.push(sheet as Record<string, unknown>);
        return { id: "sheet_local", slug: String(sheet.slug) };
      },
    });

    await processPipelineJob(
      {
        sourceUrl: "https://example.com/local.mid",
        sourceSite: "local",
        rawTitle: "Local Song",
        rawArtist: "Some Artist",
        file: new Uint8Array(0),
        dryRun: false,
        // no provenance fields
      },
      repository,
    );

    expect(insertedSheets).toHaveLength(1);
    expect(insertedSheets[0]).toEqual(
      expect.objectContaining({
        workId: null,
        arrangementId: null,
        sourceDifficultyLabel: null,
        conversionLevel: null,
      }),
    );
  });
});

// ── Canonical refresh ─────────────────────────────────────────────────────────

describe("processPipelineJob — canonical refresh", () => {
  it("calls updateWorkCanonicalSheet with workId after successful import publish", async () => {
    const updatedWorkIds: string[] = [];

    const repository = createMinimalRepository({
      updateWorkCanonicalSheet: async (workId) => {
        updatedWorkIds.push(workId);
      },
    });

    await processPipelineJob(
      {
        sourceUrl: "https://musescore.com/score/55555",
        sourceSite: "musescore",
        rawTitle: "Canonical Song",
        rawArtist: "Artist",
        file: new Uint8Array(0),
        dryRun: false,
        workId: "work_canon",
        arrangementId: "arr_canon",
        sourceDifficultyLabel: "Intermediate",
        conversionLevel: "Adept",
      },
      repository,
    );

    expect(updatedWorkIds).toEqual(["work_canon"]);
  });

  it("skips updateWorkCanonicalSheet when workId is absent (local run)", async () => {
    const updatedWorkIds: string[] = [];

    const repository = createMinimalRepository({
      updateWorkCanonicalSheet: async (workId) => {
        updatedWorkIds.push(workId);
      },
    });

    await processPipelineJob(
      {
        sourceUrl: "https://example.com/local.mid",
        sourceSite: "local",
        rawTitle: "Local Song",
        rawArtist: "Artist",
        file: new Uint8Array(0),
        dryRun: false,
        // no workId
      },
      repository,
    );

    expect(updatedWorkIds).toHaveLength(0);
  });

  it("skips updateWorkCanonicalSheet when publish is rejected", async () => {
    const { evaluatePipelineStages } = await import(
      "../../src/lib/run-stages.js"
    );
    const mockEval = vi.mocked(evaluatePipelineStages);
    mockEval.mockResolvedValueOnce({
      ok: false,
      rejectionReason: "low_quality",
      normalized: {
        title: "Rejected Song",
        artist: "Artist",
        normalizedTitle: "rejected song",
        normalizedArtist: "artist",
        normalizedKey: "artist-rejected-song",
        confidenceScore: 0.5,
        confidenceBand: "low" as const,
      },
      conversion: { sheetData: "", bpm: 0, durationSeconds: 0, noteCount: 0, notesPerSecond: 0 },
      qualityAssessment: { score: 0, rubricVersion: "v1", reasons: [], scoreBand: "reject" as const },
      dedupDecision: { action: "create-fingerprint", isCanonical: false, canonicalSheetId: null, nextVersionCount: 0, fingerprint: null },
      enrichment: { slug: "rejected-song-artist", thumbnailUrl: null, genre: null, difficulty: null, artist: null },
    } as never);

    const updatedWorkIds: string[] = [];

    const repository = createMinimalRepository({
      updateWorkCanonicalSheet: async (workId) => {
        updatedWorkIds.push(workId);
      },
    });

    await processPipelineJob(
      {
        sourceUrl: "https://musescore.com/score/99999",
        sourceSite: "musescore",
        rawTitle: "Rejected Song",
        rawArtist: "Artist",
        file: new Uint8Array(0),
        dryRun: false,
        workId: "work_rejected",
        arrangementId: "arr_rejected",
        sourceDifficultyLabel: "Beginner",
        conversionLevel: "Adept",
      },
      repository,
    );

    expect(updatedWorkIds).toHaveLength(0);
  });
});
