import { describe, expect, it } from "vitest";

import {
  determinePublicationOutcome,
  publishSheet,
} from "../../src/stages/publisher";

function createPublisherInput(
  overrides: Partial<Parameters<typeof publishSheet>[0]> = {},
): Parameters<typeof publishSheet>[0] {
  return {
    title: "Interstellar Main Theme OST",
    slug: "interstellar-main-theme-ost-hans-zimmer",
    artist: { id: "artist_1", slug: "hans-zimmer", name: "Hans Zimmer" },
    genre: { id: "genre_1", slug: "soundtrack", name: "Soundtrack" },
    difficulty: {
      id: "difficulty_1",
      slug: "advanced",
      label: "Advanced",
      level: 3,
    },
    thumbnailUrl: "https://img.youtube.com/vi/zSWdZVtXT7E/hqdefault.jpg",
    sheetData: "[tu]y--d",
    bpm: 120,
    durationSeconds: 90,
    noteCount: 320,
    notesPerSecond: 3.55,
    qualityScore: 0.82,
    confidenceScore: 0.91,
    source: "pipeline",
    sourceUrl: "https://example.com/interstellar.mid",
    tips: ["Start slowly", "Keep a steady left hand pulse"],
    youtubeUrl: "https://www.youtube.com/watch?v=zSWdZVtXT7E",
    isCanonical: true,
    canonicalSheetId: null,
    normalizedKey: "hans zimmer-interstellar main theme ost",
    nextVersionCount: 1,
    dryRun: false,
    ...overrides,
  };
}

describe("publishSheet", () => {
  it("auto-publishes high-quality, high-confidence sheets and triggers revalidation", async () => {
    const insertedSheets: Array<Record<string, unknown>> = [];
    const fingerprintUpdates: Array<Record<string, unknown>> = [];
    const revalidatedPaths: string[][] = [];

    const result = await publishSheet(createPublisherInput(), {
      insertSheet: async (sheet) => {
        insertedSheets.push(sheet);
        return { id: "sheet_1", slug: String(sheet.slug) };
      },
      promoteCanonicalFamily: async () => undefined,
      updateFingerprint: async (update) => {
        fingerprintUpdates.push(update);
      },
      revalidatePaths: async (paths) => {
        revalidatedPaths.push(paths);
      },
    });

    expect(result.outcome).toBe("published");
    expect(insertedSheets[0]).toEqual(
      expect.objectContaining({
        isPublished: true,
        needsReview: false,
        qualityScore: 0.82,
        metadataConfidence: "high",
        tips: ["Start slowly", "Keep a steady left hand pulse"],
      }),
    );
    expect(fingerprintUpdates[0]).toEqual(
      expect.objectContaining({
        normalizedKey: "hans zimmer-interstellar main theme ost",
        canonicalSheetId: "sheet_1",
        versionCount: 1,
      }),
    );
    expect(revalidatedPaths).toEqual([
      [
        "/",
        "/catalog",
        "/artist/hans-zimmer",
        "/genre/soundtrack",
        "/sheet/interstellar-main-theme-ost-hans-zimmer",
      ],
    ]);
  });

  it("completes publish when revalidation fails after durable writes", async () => {
    const insertedSheets: Array<Record<string, unknown>> = [];
    const fingerprintUpdates: Array<Record<string, unknown>> = [];

    const result = await publishSheet(createPublisherInput(), {
      insertSheet: async (sheet) => {
        insertedSheets.push(sheet);
        return { id: "sheet_1", slug: String(sheet.slug) };
      },
      promoteCanonicalFamily: async () => undefined,
      updateFingerprint: async (update) => {
        fingerprintUpdates.push(update);
      },
      revalidatePaths: async () => {
        throw new Error("ISR unavailable");
      },
    });

    expect(result).toEqual({
      outcome: "published",
      revalidatedPaths: [
        "/",
        "/catalog",
        "/artist/hans-zimmer",
        "/genre/soundtrack",
        "/sheet/interstellar-main-theme-ost-hans-zimmer",
      ],
      sheetId: "sheet_1",
    });
    expect(insertedSheets).toHaveLength(1);
    expect(fingerprintUpdates).toHaveLength(1);
  });

  it("preserves canonical fingerprint pointer when publishing alternates", async () => {
    const insertedSheets: Array<Record<string, unknown>> = [];
    const fingerprintUpdates: Array<Record<string, unknown>> = [];

    await publishSheet(
      createPublisherInput({
        isCanonical: false,
        canonicalSheetId: "sheet_canonical_existing",
        nextVersionCount: 2,
      }),
      {
        insertSheet: async (sheet) => {
          insertedSheets.push(sheet);
          return { id: "sheet_alternate_2", slug: String(sheet.slug) };
        },
        promoteCanonicalFamily: async () => undefined,
        updateFingerprint: async (update) => {
          fingerprintUpdates.push(update);
        },
        revalidatePaths: async () => undefined,
      },
    );

    expect(insertedSheets[0]).toEqual(
      expect.objectContaining({
        isCanonical: false,
        canonicalSheetId: "sheet_canonical_existing",
      }),
    );
    expect(fingerprintUpdates[0]).toEqual(
      expect.objectContaining({
        normalizedKey: "hans zimmer-interstellar main theme ost",
        canonicalSheetId: "sheet_canonical_existing",
        versionCount: 2,
      }),
    );
  });

  it("rewires canonical family when publishing a promote-canonical decision", async () => {
    const rewires: Array<Record<string, unknown>> = [];
    const fingerprintUpdates: Array<Record<string, unknown>> = [];

    await publishSheet(
      createPublisherInput({
        isCanonical: true,
        canonicalSheetId: "sheet_canonical_old",
        nextVersionCount: 2,
      }),
      {
        insertSheet: async (sheet) => ({
          id: "sheet_canonical_new",
          slug: String(sheet.slug),
        }),
        promoteCanonicalFamily: async (rewire) => {
          rewires.push(rewire);
        },
        updateFingerprint: async (update) => {
          fingerprintUpdates.push(update);
        },
        revalidatePaths: async () => undefined,
      },
    );

    expect(rewires).toEqual([
      {
        previousCanonicalSheetId: "sheet_canonical_old",
        nextCanonicalSheetId: "sheet_canonical_new",
      },
    ]);
    expect(fingerprintUpdates[0]).toEqual(
      expect.objectContaining({
        canonicalSheetId: "sheet_canonical_new",
        versionCount: 2,
      }),
    );
  });

  it("maps publication outcome from pipeline-owned score bands", () => {
    expect(determinePublicationOutcome(0.76, 0.8)).toBe("published");
    expect(determinePublicationOutcome(0.76, 0.79)).toBe("needs_review");
    expect(determinePublicationOutcome(0.49, 0.95)).toBe("rejected");
  });

  it("stores borderline sheets for review instead of auto-publishing them", async () => {
    const insertedSheets: Array<Record<string, unknown>> = [];
    const fingerprintUpdates: Array<Record<string, unknown>> = [];

    const result = await publishSheet(
      createPublisherInput({ confidenceScore: 0.65 }),
      {
        insertSheet: async (sheet) => {
          insertedSheets.push(sheet);
          return { id: "sheet_review", slug: String(sheet.slug) };
        },
        promoteCanonicalFamily: async () => undefined,
        updateFingerprint: async (update) => {
          fingerprintUpdates.push(update);
        },
        revalidatePaths: async () => undefined,
      },
    );

    expect(result.outcome).toBe("needs_review");
    expect(insertedSheets[0]).toEqual(
      expect.objectContaining({
        isPublished: false,
        needsReview: true,
        metadataConfidence: "medium",
      }),
    );
    expect(fingerprintUpdates[0]).toEqual(
      expect.objectContaining({
        canonicalSheetId: "sheet_review",
      }),
    );
  });

  it("keeps existing canonical during review for promote-canonical dedup decisions", async () => {
    const insertedSheets: Array<Record<string, unknown>> = [];
    const rewires: Array<Record<string, unknown>> = [];
    const fingerprintUpdates: Array<Record<string, unknown>> = [];

    const result = await publishSheet(
      createPublisherInput({
        confidenceScore: 0.65,
        isCanonical: true,
        canonicalSheetId: "sheet_canonical_old",
        nextVersionCount: 2,
      }),
      {
        insertSheet: async (sheet) => {
          insertedSheets.push(sheet);
          return { id: "sheet_review_candidate", slug: String(sheet.slug) };
        },
        promoteCanonicalFamily: async (rewire) => {
          rewires.push(rewire);
        },
        updateFingerprint: async (update) => {
          fingerprintUpdates.push(update);
        },
        revalidatePaths: async () => undefined,
      },
    );

    expect(result.outcome).toBe("needs_review");
    expect(insertedSheets[0]).toEqual(
      expect.objectContaining({
        isCanonical: false,
        canonicalSheetId: "sheet_canonical_old",
        isPublished: false,
        needsReview: true,
      }),
    );
    expect(rewires).toEqual([]);
    expect(fingerprintUpdates[0]).toEqual(
      expect.objectContaining({
        canonicalSheetId: "sheet_canonical_old",
        versionCount: 2,
      }),
    );
  });

  it("normalizes fractional bpm and duration before inserting a sheet", async () => {
    const insertedSheets: Array<Record<string, unknown>> = [];

    await publishSheet(
      createPublisherInput({
        bpm: 65.000065000065,
        durationSeconds: 306.545,
      }),
      {
        insertSheet: async (sheet) => {
          insertedSheets.push(sheet);
          return { id: "sheet_metrics", slug: String(sheet.slug) };
        },
        promoteCanonicalFamily: async () => undefined,
        updateFingerprint: async () => undefined,
        revalidatePaths: async () => undefined,
      },
    );

    expect(insertedSheets[0]).toEqual(
      expect.objectContaining({
        bpm: 65,
        durationSeconds: 307,
      }),
    );
  });

  it("rejects low-scoring sheets without writing to the database", async () => {
    let insertCount = 0;

    const result = await publishSheet(
      createPublisherInput({ qualityScore: 0.42, confidenceScore: 0.92 }),
      {
        insertSheet: async () => {
          insertCount += 1;
          return { id: "sheet_rejected", slug: "nope" };
        },
        promoteCanonicalFamily: async () => undefined,
        updateFingerprint: async () => undefined,
        revalidatePaths: async () => undefined,
      },
    );

    expect(result).toEqual({
      outcome: "rejected",
      revalidatedPaths: [],
      sheetId: null,
    });
    expect(insertCount).toBe(0);
  });

  it("skips writes and revalidation during dry runs", async () => {
    let insertCount = 0;
    let revalidateCount = 0;

    const result = await publishSheet(createPublisherInput({ dryRun: true }), {
      insertSheet: async () => {
        insertCount += 1;
        return { id: "sheet_dry_run", slug: "dry-run" };
      },
      promoteCanonicalFamily: async () => undefined,
      updateFingerprint: async () => undefined,
      revalidatePaths: async () => {
        revalidateCount += 1;
      },
    });

    expect(result).toEqual({
      outcome: "dry_run",
      revalidatedPaths: [],
      sheetId: null,
    });
    expect(insertCount).toBe(0);
    expect(revalidateCount).toBe(0);
  });

  it("persists import provenance fields on the inserted sheet", async () => {
    const insertedSheets: Array<Record<string, unknown>> = [];

    await publishSheet(
      createPublisherInput({
        workId: "work_abc",
        arrangementId: "arr_xyz",
        sourceDifficultyLabel: "Intermediate",
        conversionLevel: "Adept",
      }),
      {
        insertSheet: async (sheet) => {
          insertedSheets.push(sheet);
          return { id: "sheet_imported", slug: String(sheet.slug) };
        },
        promoteCanonicalFamily: async () => undefined,
        updateFingerprint: async () => undefined,
        revalidatePaths: async () => undefined,
      },
    );

    expect(insertedSheets[0]).toEqual(
      expect.objectContaining({
        workId: "work_abc",
        arrangementId: "arr_xyz",
        sourceDifficultyLabel: "Intermediate",
        conversionLevel: "Adept",
      }),
    );
  });

  it("uses provenance-aware slugs for imported source-item variants", async () => {
    const insertedSheets: Array<Record<string, unknown>> = [];
    const revalidatedPaths: string[][] = [];

    await publishSheet(
      createPublisherInput({
        slug: "golden-hour-jvke-updated-ver-unknown-artist",
        sourceUrl: "https://musescore.com/user/1/scores/8772048",
        workId: "work_golden_hour",
        arrangementId: "arr_beginner",
        sourceDifficultyLabel: "Beginner",
        conversionLevel: "Adept",
      }),
      {
        insertSheet: async (sheet) => {
          insertedSheets.push(sheet);
          return { id: "sheet_imported", slug: String(sheet.slug) };
        },
        promoteCanonicalFamily: async () => undefined,
        updateFingerprint: async () => undefined,
        revalidatePaths: async (paths) => {
          revalidatedPaths.push(paths);
        },
      },
    );

    expect(insertedSheets[0]).toEqual(
      expect.objectContaining({
        slug: "golden-hour-jvke-updated-ver-unknown-artist-beginner-adept-8772048",
      }),
    );
    expect(revalidatedPaths[0]).toContain(
      "/sheet/golden-hour-jvke-updated-ver-unknown-artist-beginner-adept-8772048",
    );
  });

  it("keeps same-title imported source-item variant slugs unique", async () => {
    const insertedSheets: Array<Record<string, unknown>> = [];

    const repository = {
      insertSheet: async (sheet: Record<string, unknown>) => {
        insertedSheets.push(sheet);
        return { id: `sheet_${insertedSheets.length}`, slug: String(sheet.slug) };
      },
      promoteCanonicalFamily: async () => undefined,
      updateFingerprint: async () => undefined,
      revalidatePaths: async () => undefined,
    };

    for (const variant of [
      { sourceDifficultyLabel: "Beginner", scoreId: "8772048" },
      { sourceDifficultyLabel: "Intermediate", scoreId: "8775498" },
      { sourceDifficultyLabel: "Advanced", scoreId: "8668713" },
    ] as const) {
      await publishSheet(
        createPublisherInput({
          slug: "golden-hour-jvke-updated-ver-unknown-artist",
          sourceUrl: `https://musescore.com/user/1/scores/${variant.scoreId}`,
          workId: "work_golden_hour",
          arrangementId: `arr_${variant.sourceDifficultyLabel.toLowerCase()}`,
          sourceDifficultyLabel: variant.sourceDifficultyLabel,
          conversionLevel: "Adept",
        }),
        repository,
      );
    }

    const slugs = insertedSheets.map((sheet) => sheet["slug"]);
    expect(new Set(slugs).size).toBe(3);
    expect(slugs).toEqual([
      "golden-hour-jvke-updated-ver-unknown-artist-beginner-adept-8772048",
      "golden-hour-jvke-updated-ver-unknown-artist-intermediate-adept-8775498",
      "golden-hour-jvke-updated-ver-unknown-artist-advanced-adept-8668713",
    ]);
  });

  it("stores forced generation metadata and defaults to review-first", async () => {
    const insertedSheets: Array<Record<string, unknown>> = [];

    await publishSheet(
      createPublisherInput({
        generationMode: "forced",
        forcedAt: new Date("2026-02-01T12:00:00.000Z"),
        forceReason: "operator override for known-good MIDI",
        forceContext: { arrangementId: "arr_123", sourceUrl: "https://example.com/song.mid" },
      } as never),
      {
        insertSheet: async (sheet) => {
          insertedSheets.push(sheet);
          return { id: "sheet_forced", slug: String(sheet.slug) };
        },
        promoteCanonicalFamily: async () => undefined,
        updateFingerprint: async () => undefined,
        revalidatePaths: async () => undefined,
      },
    );

    expect(insertedSheets[0]).toEqual(
      expect.objectContaining({
        isPublished: false,
        needsReview: true,
        generationMode: "forced",
        forcedAt: new Date("2026-02-01T12:00:00.000Z"),
        forceReason: "operator override for known-good MIDI",
        forceContext: expect.objectContaining({ arrangementId: "arr_123" }),
      }),
    );
  });

  it("persists null provenance fields for non-imported sheets", async () => {
    const insertedSheets: Array<Record<string, unknown>> = [];

    await publishSheet(
      createPublisherInput({
        // provenance fields omitted (non-imported run)
      }),
      {
        insertSheet: async (sheet) => {
          insertedSheets.push(sheet);
          return { id: "sheet_local", slug: String(sheet.slug) };
        },
        promoteCanonicalFamily: async () => undefined,
        updateFingerprint: async () => undefined,
        revalidatePaths: async () => undefined,
      },
    );

    expect(insertedSheets[0]).toEqual(
      expect.objectContaining({
        workId: null,
        arrangementId: null,
        sourceDifficultyLabel: null,
        conversionLevel: null,
      }),
    );
  });

  it("fails fast when required metadata ids are missing", async () => {
    await expect(
      publishSheet(createPublisherInput({ artist: { id: "", slug: "hans-zimmer", name: "Hans Zimmer" } }), {
        insertSheet: async () => ({ id: "sheet_invalid", slug: "invalid" }),
        promoteCanonicalFamily: async () => undefined,
        updateFingerprint: async () => undefined,
        revalidatePaths: async () => undefined,
      }),
    ).rejects.toThrow("publisher invariant: missing artist.id");
  });
});
