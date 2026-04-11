import { describe, expect, it } from "vitest";

import { computeRerankScore } from "../../src/jobs/rerank-canonical.js";

describe("computeRerankScore", () => {
  it("uses 100% quality score when rating count is below the threshold", () => {
    const score = computeRerankScore(
      {
        qualityScore: 0.72,
        ratingScore: 0.15,
        ratingCount: 1,
      },
      {
        threshold: 2,
        qualityWeight: 0.6,
        ratingWeight: 0.4,
      },
    );

    expect(score).toBe(0.72);
  });

  it("uses weighted quality + rating score at or above threshold", () => {
    const score = computeRerankScore(
      {
        qualityScore: 0.72,
        ratingScore: 0.15,
        ratingCount: 2,
      },
      {
        threshold: 2,
        qualityWeight: 0.6,
        ratingWeight: 0.4,
      },
    );

    expect(score).toBeCloseTo(0.492, 6);
  });

  it("respects configurable threshold and weights", () => {
    const config = {
      threshold: 5,
      qualityWeight: 0.25,
      ratingWeight: 0.75,
    } as const;

    expect(
      computeRerankScore(
        {
          qualityScore: 0.8,
          ratingScore: 0.1,
          ratingCount: 4,
        },
        config,
      ),
    ).toBe(0.8);

    expect(
      computeRerankScore(
        {
          qualityScore: 0.8,
          ratingScore: 0.1,
          ratingCount: 5,
        },
        config,
      ),
    ).toBeCloseTo(0.275, 6);
  });
});
