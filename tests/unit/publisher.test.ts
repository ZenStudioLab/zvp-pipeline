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
});
