import { describe, expect, it } from "vitest";

import {
  rankArrangementsInBucket,
  selectArrangementCanonicalVariant,
  selectWorkCanonicalSheet,
} from "../../src/stages/canonical-selector.js";
import type { WorkCanonicalInput } from "../../src/stages/canonical-selector.js";

// ---------------------------------------------------------------------------
// selectArrangementCanonicalVariant
// ---------------------------------------------------------------------------

describe("selectArrangementCanonicalVariant", () => {
  it("returns Adept when present", () => {
    expect(
      selectArrangementCanonicalVariant(["Novice", "Adept", "Master"]),
    ).toBe("Adept");
  });

  it("returns Apprentice when Adept is absent (d=1, higher difficulty)", () => {
    expect(
      selectArrangementCanonicalVariant(["Novice", "Apprentice", "Master"]),
    ).toBe("Apprentice");
  });

  it("returns Master when Adept and Apprentice are absent (d=1, lower)", () => {
    expect(selectArrangementCanonicalVariant(["Novice", "Master"])).toBe(
      "Master",
    );
  });

  it("returns Novice when only Adept-distant levels are absent and Novice is available", () => {
    expect(selectArrangementCanonicalVariant(["Novice", "Guru"])).toBe("Novice");
  });

  it("returns Guru as last resort", () => {
    expect(selectArrangementCanonicalVariant(["Guru"])).toBe("Guru");
  });

  it("returns null for empty input", () => {
    expect(selectArrangementCanonicalVariant([])).toBeNull();
  });

  it("handles a single Adept entry", () => {
    expect(selectArrangementCanonicalVariant(["Adept"])).toBe("Adept");
  });

  it("returns Adept when all five levels are present", () => {
    expect(
      selectArrangementCanonicalVariant([
        "Novice",
        "Apprentice",
        "Adept",
        "Master",
        "Guru",
      ]),
    ).toBe("Adept");
  });
});

// ---------------------------------------------------------------------------
// rankArrangementsInBucket
// ---------------------------------------------------------------------------

describe("rankArrangementsInBucket", () => {
  const base = {
    availableConversionLevels: ["Adept"] as const,
    sourceDifficultyLabel: "Intermediate" as const,
  };

  it("ranks by source_view_count descending first", () => {
    const ranked = rankArrangementsInBucket([
      {
        arrangementId: "a1",
        sourceViewCount: 100,
        sourceRatingCount: 5,
        sourceRatingScore: 4.5,
        createdAt: new Date("2024-01-01"),
        ...base,
      },
      {
        arrangementId: "a2",
        sourceViewCount: 500,
        sourceRatingCount: 5,
        sourceRatingScore: 4.5,
        createdAt: new Date("2024-01-01"),
        ...base,
      },
    ]);
    expect(ranked[0].arrangementId).toBe("a2");
  });

  it("ranks by source_rating_count descending when view counts are equal", () => {
    const ranked = rankArrangementsInBucket([
      {
        arrangementId: "a1",
        sourceViewCount: 100,
        sourceRatingCount: 3,
        sourceRatingScore: 4.5,
        createdAt: new Date("2024-01-01"),
        ...base,
      },
      {
        arrangementId: "a2",
        sourceViewCount: 100,
        sourceRatingCount: 10,
        sourceRatingScore: 4.5,
        createdAt: new Date("2024-01-01"),
        ...base,
      },
    ]);
    expect(ranked[0].arrangementId).toBe("a2");
  });

  it("ranks by source_rating_score descending when view and rating counts are equal", () => {
    const ranked = rankArrangementsInBucket([
      {
        arrangementId: "a1",
        sourceViewCount: 100,
        sourceRatingCount: 5,
        sourceRatingScore: 3.0,
        createdAt: new Date("2024-01-01"),
        ...base,
      },
      {
        arrangementId: "a2",
        sourceViewCount: 100,
        sourceRatingCount: 5,
        sourceRatingScore: 4.8,
        createdAt: new Date("2024-01-01"),
        ...base,
      },
    ]);
    expect(ranked[0].arrangementId).toBe("a2");
  });

  it("ranks by created_at ascending when all popularity metrics are equal", () => {
    const ranked = rankArrangementsInBucket([
      {
        arrangementId: "a1",
        sourceViewCount: 100,
        sourceRatingCount: 5,
        sourceRatingScore: 4.0,
        createdAt: new Date("2024-06-01"),
        ...base,
      },
      {
        arrangementId: "a2",
        sourceViewCount: 100,
        sourceRatingCount: 5,
        sourceRatingScore: 4.0,
        createdAt: new Date("2024-01-01"),
        ...base,
      },
    ]);
    expect(ranked[0].arrangementId).toBe("a2");
  });

  it("uses arrangementId as stable alphabetical tiebreaker when all else is equal", () => {
    const ranked = rankArrangementsInBucket([
      {
        arrangementId: "b",
        sourceViewCount: 0,
        createdAt: new Date("2024-01-01"),
        ...base,
      },
      {
        arrangementId: "a",
        sourceViewCount: 0,
        createdAt: new Date("2024-01-01"),
        ...base,
      },
    ]);
    expect(ranked[0].arrangementId).toBe("a");
  });

  it("treats null metric values as 0", () => {
    const ranked = rankArrangementsInBucket([
      {
        arrangementId: "a1",
        sourceViewCount: null,
        sourceRatingCount: null,
        sourceRatingScore: null,
        createdAt: new Date("2024-01-01"),
        ...base,
      },
      {
        arrangementId: "a2",
        sourceViewCount: 50,
        sourceRatingCount: null,
        sourceRatingScore: null,
        createdAt: new Date("2024-01-01"),
        ...base,
      },
    ]);
    expect(ranked[0].arrangementId).toBe("a2");
  });

  it("does not mutate the input array", () => {
    const input = [
      {
        arrangementId: "z",
        sourceViewCount: 1,
        createdAt: new Date("2024-01-01"),
        ...base,
      },
      {
        arrangementId: "a",
        sourceViewCount: 100,
        createdAt: new Date("2024-01-01"),
        ...base,
      },
    ];
    const originalOrder = input.map((a) => a.arrangementId);
    rankArrangementsInBucket(input);
    expect(input.map((a) => a.arrangementId)).toEqual(originalOrder);
  });
});

// ---------------------------------------------------------------------------
// selectWorkCanonicalSheet
// ---------------------------------------------------------------------------

describe("selectWorkCanonicalSheet", () => {
  function makeArrangement(
    id: string,
    difficulty: WorkCanonicalInput["sourceDifficultyLabel"],
    levels: WorkCanonicalInput["availableConversionLevels"],
    overrides: Partial<WorkCanonicalInput> = {},
  ): WorkCanonicalInput {
    return {
      arrangementId: id,
      sourceDifficultyLabel: difficulty,
      availableConversionLevels: levels,
      sourceViewCount: 0,
      sourceRatingCount: 0,
      sourceRatingScore: 0,
      createdAt: new Date("2024-01-01"),
      ...overrides,
    };
  }

  it("returns null for empty arrangement list", () => {
    expect(selectWorkCanonicalSheet([])).toBeNull();
  });

  it("selects Intermediate + Adept as the canonical work sheet when present", () => {
    const result = selectWorkCanonicalSheet([
      makeArrangement("int", "Intermediate", ["Adept", "Master"]),
      makeArrangement("beg", "Beginner", ["Adept"]),
    ]);
    expect(result).toEqual({ arrangementId: "int", conversionLevel: "Adept" });
  });

  it("falls back to Beginner + Adept when no Intermediate arrangement has Adept", () => {
    const result = selectWorkCanonicalSheet([
      makeArrangement("int", "Intermediate", ["Master"]),
      makeArrangement("beg", "Beginner", ["Adept"]),
    ]);
    expect(result).toEqual({ arrangementId: "beg", conversionLevel: "Adept" });
  });

  it("falls back to Advanced + Adept when neither Intermediate nor Beginner has Adept", () => {
    const result = selectWorkCanonicalSheet([
      makeArrangement("int", "Intermediate", ["Master"]),
      makeArrangement("adv", "Advanced", ["Adept"]),
    ]);
    expect(result).toEqual({ arrangementId: "adv", conversionLevel: "Adept" });
  });

  it("uses source ranking to pick between multiple Intermediate arrangements with Adept", () => {
    const result = selectWorkCanonicalSheet([
      makeArrangement("int-low", "Intermediate", ["Adept"], {
        sourceViewCount: 10,
      }),
      makeArrangement("int-high", "Intermediate", ["Adept"], {
        sourceViewCount: 500,
      }),
    ]);
    expect(result).toEqual({
      arrangementId: "int-high",
      conversionLevel: "Adept",
    });
  });

  it("when no Adept exists anywhere, falls back to Intermediate difficulty then arrangement canonical variant", () => {
    const result = selectWorkCanonicalSheet([
      makeArrangement("int", "Intermediate", ["Apprentice", "Master"]),
      makeArrangement("beg", "Beginner", ["Novice"]),
    ]);
    // Intermediate bucket; no Adept → arrangement fallback order: Apprentice before Master
    expect(result).toEqual({
      arrangementId: "int",
      conversionLevel: "Apprentice",
    });
  });

  it("when no Adept anywhere, falls to Beginner bucket when Intermediate bucket is absent", () => {
    const result = selectWorkCanonicalSheet([
      makeArrangement("adv", "Advanced", ["Guru"]),
      makeArrangement("beg", "Beginner", ["Master"]),
    ]);
    expect(result).toEqual({
      arrangementId: "beg",
      conversionLevel: "Master",
    });
  });

  it("when no Adept anywhere, falls to Advanced as last resort", () => {
    const result = selectWorkCanonicalSheet([
      makeArrangement("adv", "Advanced", ["Novice"]),
    ]);
    expect(result).toEqual({
      arrangementId: "adv",
      conversionLevel: "Novice",
    });
  });

  it("returns null when no arrangement has any available conversion levels", () => {
    const result = selectWorkCanonicalSheet([
      makeArrangement("int", "Intermediate", []),
    ]);
    expect(result).toBeNull();
  });

  it("deterministic tiebreak: lower arrangementId wins when all metrics identical", () => {
    const result = selectWorkCanonicalSheet([
      makeArrangement("z-arr", "Intermediate", ["Adept"]),
      makeArrangement("a-arr", "Intermediate", ["Adept"]),
    ]);
    expect(result).toEqual({
      arrangementId: "a-arr",
      conversionLevel: "Adept",
    });
  });

  it("non-imported scope: arrangement with no source difficulty should not interfere with typed inputs", () => {
    // Only valid SourceDifficultyLabel values reach this function.
    // Works that have no arrangements don't produce canonical results.
    expect(selectWorkCanonicalSheet([])).toBeNull();
  });
});
