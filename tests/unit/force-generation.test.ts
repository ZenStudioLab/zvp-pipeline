import { describe, expect, it, vi } from "vitest";

import { processPipelineJob } from "../../src/lib/process-job.js";

vi.mock("../../src/lib/run-stages.js", () => ({
  evaluatePipelineStages: vi.fn(),
}));

import { evaluatePipelineStages } from "../../src/lib/run-stages.js";

function createRepository(overrides: Partial<Parameters<typeof processPipelineJob>[1]> = {}) {
  const jobStatuses: Array<Record<string, unknown>> = [];
  const forcedUpdates: Array<Record<string, unknown>> = [];
  const insertedSheets: Array<Record<string, unknown>> = [];

  const repository = {
    genres: [{ id: "genre_1", slug: "soundtrack", name: "Soundtrack" }],
    difficulties: [{ id: "diff_1", slug: "advanced", label: "Advanced", level: 3 }],
    getJobBySourceUrl: async () => null,
    findSheetBySourceUrl: async () => null,
    saveJobStatus: async (event: Record<string, unknown>) => {
      jobStatuses.push(event);
    },
    getExistingArtistNames: async () => [],
    findArtistByNormalizedName: async () => null,
    createArtist: async (input: { name: string; slug: string }) => ({ id: "artist_1", slug: input.slug, name: input.name }),
    findFingerprintByKey: async () => null,
    insertSheet: async (sheet: Record<string, unknown>) => {
      insertedSheets.push(sheet);
      return { id: "sheet_1", slug: String(sheet.slug) };
    },
    promoteCanonicalFamily: async () => undefined,
    updateFingerprint: async () => undefined,
    revalidatePaths: async () => undefined,
    recordForcedGeneration: async (event: Record<string, unknown>) => {
      forcedUpdates.push(event);
    },
    ...overrides,
  };

  return Object.assign(repository, {
    jobStatuses,
    forcedUpdates,
    insertedSheets,
  });
}

describe("force generation", () => {
  it("rejects forced generation when the MIDI has no note events", async () => {
    vi.mocked(evaluatePipelineStages).mockResolvedValueOnce({
      ok: true,
      normalized: {
        title: "Song",
        artist: "Artist",
        normalizedTitle: "song",
        normalizedArtist: "artist",
        normalizedKey: "artist-song",
        confidenceScore: 0.4,
        confidenceBand: "low",
      },
      conversion: {
        sheetData: "[tu]",
        bpm: 120,
        durationSeconds: 12,
        noteCount: 0,
        notesPerSecond: 0,
      },
      qualityAssessment: {
        score: 0.12,
        rubricVersion: "v1",
        reasons: ["LOW_QUALITY"],
        scoreBand: "reject",
      },
      dedupDecision: {
        action: "create-fingerprint",
        isCanonical: true,
        canonicalSheetId: null,
        nextVersionCount: 1,
        fingerprint: null,
      },
      enrichment: {
        slug: "song-artist",
        thumbnailUrl: "https://example.com/thumb.jpg",
        genre: { id: "genre_1", slug: "soundtrack", name: "Soundtrack" },
        difficulty: { id: "diff_1", slug: "advanced", label: "Advanced", level: 3 },
        artist: { id: "artist_1", slug: "artist", name: "Artist" },
      },
    } as never);

    await expect(
      processPipelineJob(
        {
          sourceUrl: "https://example.com/song.mid",
          sourceSite: "freemidi",
          rawTitle: "Song",
          rawArtist: "Artist",
          file: new Uint8Array([1, 2, 3]),
          dryRun: false,
          forceGeneration: {
            jobId: "job_123",
            forcedAt: new Date("2026-02-01T12:00:00.000Z"),
            forceReason: "operator override",
            forceContext: { arrangementId: "arr_123" },
            publish: false,
          },
        },
        createRepository(),
      ),
    ).rejects.toThrow(/force generation requires at least one note event/);
  });

  it("persists review-first force sheets with forced metadata", async () => {
    vi.mocked(evaluatePipelineStages).mockResolvedValue({
      ok: true,
      normalized: {
        title: "Song",
        artist: "Artist",
        normalizedTitle: "song",
        normalizedArtist: "artist",
        normalizedKey: "artist-song",
        confidenceScore: 0.4,
        confidenceBand: "low",
      },
      conversion: { sheetData: "[tu]", bpm: 120, durationSeconds: 12, noteCount: 4, notesPerSecond: 2 },
      qualityAssessment: { score: 0.12, rubricVersion: "v1", reasons: ["LOW_QUALITY"], scoreBand: "reject" },
      dedupDecision: {
        action: "create-fingerprint",
        isCanonical: true,
        canonicalSheetId: null,
        nextVersionCount: 1,
        fingerprint: null,
      },
      enrichment: {
        slug: "song-artist",
        thumbnailUrl: "https://example.com/thumb.jpg",
        genre: { id: "genre_1", slug: "soundtrack", name: "Soundtrack" },
        difficulty: { id: "diff_1", slug: "advanced", label: "Advanced", level: 3 },
        artist: { id: "artist_1", slug: "artist", name: "Artist" },
      },
    } as never);

    const repository = createRepository();

    const result = await processPipelineJob(
      {
        sourceUrl: "https://example.com/song.mid",
        sourceSite: "freemidi",
        rawTitle: "Song",
        rawArtist: "Artist",
        file: new Uint8Array([1, 2, 3]),
        dryRun: false,
        forceGeneration: {
          jobId: "job_123",
          forcedAt: new Date("2026-02-01T12:00:00.000Z"),
          forceReason: "operator override",
          forceContext: { arrangementId: "arr_123" },
          publish: false,
        },
      },
      repository,
    );

    expect(result.outcome).toBe("needs_review");
    expect((repository as { jobStatuses: unknown[] }).jobStatuses).toHaveLength(0);
    expect((repository as { forcedUpdates: unknown[] }).forcedUpdates).toHaveLength(1);
    expect((repository as { insertedSheets: Array<Record<string, unknown>> }).insertedSheets).toHaveLength(1);
    expect((repository as { insertedSheets: Array<Record<string, unknown>> }).insertedSheets[0]).toEqual(
      expect.objectContaining({
        isPublished: false,
        needsReview: true,
        generationMode: "forced",
        forcePublish: false,
        forcedAt: new Date("2026-02-01T12:00:00.000Z"),
        forceReason: "operator override",
        forceContext: { arrangementId: "arr_123" },
      }),
    );
    expect((repository as { forcedUpdates: unknown[] }).forcedUpdates[0]).toEqual(
      expect.objectContaining({
        id: "job_123",
        forceReason: "operator override",
      }),
    );
  });

  it("publishes forced sheets when publish is true", async () => {
    vi.mocked(evaluatePipelineStages).mockResolvedValueOnce({
      ok: true,
      normalized: {
        title: "Song",
        artist: "Artist",
        normalizedTitle: "song",
        normalizedArtist: "artist",
        normalizedKey: "artist-song",
        confidenceScore: 0.4,
        confidenceBand: "low",
      },
      conversion: { sheetData: "[tu]", bpm: 120, durationSeconds: 12, noteCount: 4, notesPerSecond: 2 },
      qualityAssessment: { score: 0.12, rubricVersion: "v1", reasons: ["LOW_QUALITY"], scoreBand: "reject" },
      dedupDecision: {
        action: "create-fingerprint",
        isCanonical: true,
        canonicalSheetId: null,
        nextVersionCount: 1,
        fingerprint: null,
      },
      enrichment: {
        slug: "song-artist",
        thumbnailUrl: "https://example.com/thumb.jpg",
        genre: { id: "genre_1", slug: "soundtrack", name: "Soundtrack" },
        difficulty: { id: "diff_1", slug: "advanced", label: "Advanced", level: 3 },
        artist: { id: "artist_1", slug: "artist", name: "Artist" },
      },
    } as never);

    const repository = createRepository();

    const result = await processPipelineJob(
      {
        sourceUrl: "https://example.com/song.mid",
        sourceSite: "freemidi",
        rawTitle: "Song",
        rawArtist: "Artist",
        file: new Uint8Array([1, 2, 3]),
        dryRun: false,
        forceGeneration: {
          jobId: "job_456",
          forcedAt: new Date("2026-02-02T12:00:00.000Z"),
          forceReason: "publish immediately",
          forceContext: { arrangementId: "arr_456" },
          publish: true,
        },
      },
      repository,
    );

    expect(result.outcome).toBe("published");
    expect((repository as { insertedSheets: Array<Record<string, unknown>> }).insertedSheets[0]).toEqual(
      expect.objectContaining({
        isPublished: true,
        needsReview: false,
        generationMode: "forced",
        forcePublish: true,
        forcedAt: new Date("2026-02-02T12:00:00.000Z"),
        forceReason: "publish immediately",
        forceContext: { arrangementId: "arr_456" },
      }),
    );
  });

  it("throws on non-parseable forced midi", async () => {
    vi.mocked(evaluatePipelineStages).mockResolvedValueOnce({
      ok: false,
      normalized: {
        title: "Song",
        artist: "Artist",
        normalizedTitle: "song",
        normalizedArtist: "artist",
        normalizedKey: "artist-song",
        confidenceScore: 0.4,
        confidenceBand: "low",
      },
      rejectionReason: "corrupted_midi",
    } as never);

    await expect(
      processPipelineJob(
        {
          sourceUrl: "https://example.com/song.mid",
          sourceSite: "freemidi",
          rawTitle: "Song",
          rawArtist: "Artist",
          file: new Uint8Array([1, 2, 3]),
          dryRun: false,
          forceGeneration: {
            jobId: "job_123",
            forcedAt: new Date("2026-02-01T12:00:00.000Z"),
            forceReason: "operator override",
            forceContext: { arrangementId: "arr_123" },
            publish: false,
          },
        },
        createRepository(),
      ),
    ).rejects.toThrow(/force generation requires parseable MIDI/);
  });
});
