import { describe, expect, it } from "vitest";

import { rerankCanonicalSheets } from "../../src/jobs/rerank-canonical.js";

describe("rerankCanonicalSheets", () => {
  it("promotes a higher combined-score alternate and revalidates affected slugs", async () => {
    const fingerprint = {
      normalizedKey: "hans-zimmer-interstellar",
      canonicalSheetId: "sheet_canonical",
      versionCount: 2,
    };

    const versions = [
      {
        id: "sheet_canonical",
        slug: "interstellar-main-theme-hans-zimmer",
        qualityScore: 0.8,
        ratingScore: 0.2,
        ratingCount: 1,
        isCanonical: true,
      },
      {
        id: "sheet_alt",
        slug: "interstellar-main-theme-alt-hans-zimmer",
        qualityScore: 0.82,
        ratingScore: 0.95,
        ratingCount: 3,
        isCanonical: false,
      },
    ];

    const swapEvents: Array<{
      normalizedKey: string;
      nextCanonicalSheetId: string;
    }> = [];
    const revalidated: string[][] = [];

    const result = await rerankCanonicalSheets({
      listFingerprintsForRerank: async () => [fingerprint],
      listVersionsForFingerprint: async () => versions,
      swapCanonicalSheet: async (swap) => {
        swapEvents.push(swap);
        for (const version of versions) {
          version.isCanonical = version.id === swap.nextCanonicalSheetId;
        }
      },
      revalidatePaths: async (paths) => {
        revalidated.push(paths);
      },
    });

    expect(result).toEqual({
      scannedFingerprints: 1,
      swappedFingerprints: 1,
    });

    expect(swapEvents).toEqual([
      expect.objectContaining({
        normalizedKey: "hans-zimmer-interstellar",
        nextCanonicalSheetId: "sheet_alt",
      }),
    ]);

    expect(revalidated).toHaveLength(1);
    expect(revalidated[0]).toEqual(
      expect.arrayContaining([
        "/",
        "/catalog",
        "/sheet/interstellar-main-theme-hans-zimmer",
        "/sheet/interstellar-main-theme-alt-hans-zimmer",
        "/vi/catalog",
        "/vi/sheet/interstellar-main-theme-hans-zimmer",
        "/vi/sheet/interstellar-main-theme-alt-hans-zimmer",
        "/en_US/catalog",
        "/en_US/sheet/interstellar-main-theme-hans-zimmer",
        "/en_US/sheet/interstellar-main-theme-alt-hans-zimmer",
      ]),
    );
    expect(versions[0]?.isCanonical).toBe(false);
    expect(versions[1]?.isCanonical).toBe(true);
  });
});
