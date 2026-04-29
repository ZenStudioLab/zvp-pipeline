import { beforeEach, describe, expect, it, vi } from "vitest";

const seededGenreRows = [
  {
    id: "genre_soundtrack",
    slug: "soundtrack",
    name: "Soundtrack",
  },
];

const seededDifficultyRows = [
  {
    id: "difficulty_beginner",
    slug: "beginner",
    label: "Beginner",
    level: 1,
  },
];

const dbClientEnd = vi.fn(async () => undefined);
const orderBy = vi.fn(async () => {
  throw new Error("bootstrap failed");
});
const from = vi.fn(() => ({ orderBy }));
const select = vi.fn(() => ({ from }));
const createDbClient = vi.fn(() => ({
  $client: { end: dbClientEnd },
  select,
}));

vi.mock("@zen/db", () => ({
  artist: { id: "artist_id", slug: "artist_slug", name: "artist_name" },
  createDbClient,
  difficulty: {
    id: "difficulty_id",
    slug: "difficulty_slug",
    label: "difficulty_label",
    level: "difficulty_level",
  },
  genre: {
    id: "genre_id",
    slug: "genre_slug",
    name: "genre_name",
    displayOrder: "genre_display_order",
  },
  pipelineJob: {
    id: "pipeline_job_id",
    status: "status",
    sourceUrl: "source_url",
    outputSheetId: "output_sheet_id",
    createdAt: "created_at",
    qualityScore: "quality_score",
    rejectionReason: "rejection_reason",
    sourceSite: "source_site",
    rawTitle: "raw_title",
    normalizedArtist: "normalized_artist",
  },
  sheet: {
    id: "sheet_id",
    isPublished: "is_published",
    needsReview: "needs_review",
    qualityScore: "quality_score",
    slug: "slug",
  },
  songFingerprint: {
    normalizedKey: "normalized_key",
    canonicalSheetId: "canonical_sheet_id",
    versionCount: "version_count",
  },
}));

describe("createPipelineRuntimeRepository", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.DISABLE_REVALIDATION;
  });

  it("closes the owned database client when bootstrap queries fail", async () => {
    const { createPipelineRuntimeRepository } =
      await import("../../src/lib/runtime-repository.js");

    await expect(createPipelineRuntimeRepository()).rejects.toThrow(
      "bootstrap failed",
    );
    expect(createDbClient).toHaveBeenCalledTimes(1);
    expect(dbClientEnd).toHaveBeenCalledWith({ timeout: 5 });
  });

  it("preserves the bootstrap error when db client shutdown also fails", async () => {
    dbClientEnd.mockRejectedValueOnce(new Error("close failed"));

    const { createPipelineRuntimeRepository } =
      await import("../../src/lib/runtime-repository.js");

    await expect(createPipelineRuntimeRepository()).rejects.toThrow(
      "bootstrap failed",
    );
    expect(dbClientEnd).toHaveBeenCalledWith({ timeout: 5 });
  });

  it("skips ISR fetches when DISABLE_REVALIDATION is truthy", async () => {
    vi.resetModules();
    vi.doUnmock("@zen/db");

    const fetchImpl: typeof fetch = vi.fn(async () =>
      new Response(null, {
        status: 200,
      }),
    );

    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          orderBy: vi
            .fn()
            .mockResolvedValueOnce(seededGenreRows)
            .mockResolvedValueOnce(seededDifficultyRows),
        })),
      })),
    } as any;

    process.env.DISABLE_REVALIDATION = "true";

    const { createPipelineRuntimeRepository } =
      await import("../../src/lib/runtime-repository.js");
    const repository = await createPipelineRuntimeRepository({
      db,
      siteUrl: "https://zenpiano.art",
      revalidationSecret: "secret",
      fetchImpl,
    });

    await repository.revalidatePaths(["/", "/catalog"]);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "genres",
      genreRows: [],
      difficultyRows: [
        {
          id: "difficulty_beginner",
          slug: "beginner",
          label: "Beginner",
          level: 1,
        },
      ],
    },
    {
      label: "difficulties",
      genreRows: [
        {
          id: "genre_soundtrack",
          slug: "soundtrack",
          name: "Soundtrack",
        },
      ],
      difficultyRows: [],
    },
  ])(
    "fails fast when required $label reference data is missing at bootstrap",
    async ({ genreRows, difficultyRows }) => {
      vi.resetModules();
      vi.doUnmock("@zen/db");

      let selectCallCount = 0;
      const db = {
        select: vi.fn(() => {
          selectCallCount += 1;

          return {
            from: vi.fn(() => ({
              orderBy: vi.fn(async () =>
                selectCallCount === 1 ? genreRows : difficultyRows,
              ),
            })),
          };
        }),
      } as any;

      const { createPipelineRuntimeRepository } =
        await import("../../src/lib/runtime-repository.js");

      await expect(createPipelineRuntimeRepository({ db })).rejects.toThrow(
        "Pipeline reference data is missing. Run 'node dist/cli.js seed' to seed genres and difficulties before running the pipeline.",
      );
    },
  );

  it("swaps canonical sheet inside a single transaction", async () => {
    vi.resetModules();
    vi.doUnmock("@zen/db");

    const tx = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(async () => undefined),
        })),
      })),
    };

    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          orderBy: vi
            .fn()
            .mockResolvedValueOnce(seededGenreRows)
            .mockResolvedValueOnce(seededDifficultyRows),
        })),
      })),
      transaction: vi.fn(
        async (callback: (txClient: typeof tx) => Promise<void>) =>
          callback(tx),
      ),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(async () => undefined),
        })),
      })),
    } as any;

    const { createPipelineRuntimeRepository } =
      await import("../../src/lib/runtime-repository.js");
    const repository = await createPipelineRuntimeRepository({ db });

    await repository.swapCanonicalSheet({
      normalizedKey: "hans-zimmer-interstellar",
      nextCanonicalSheetId: "sheet_alt",
      versionSheetIds: ["sheet_canonical", "sheet_alt"],
    });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledTimes(3);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("rewires previous canonical family when promoting a new canonical sheet", async () => {
    vi.resetModules();
    vi.doUnmock("@zen/db");

    const tx = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(async () => undefined),
        })),
      })),
    };

    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          orderBy: vi
            .fn()
            .mockResolvedValueOnce(seededGenreRows)
            .mockResolvedValueOnce(seededDifficultyRows),
        })),
      })),
      transaction: vi.fn(
        async (callback: (txClient: typeof tx) => Promise<void>) =>
          callback(tx),
      ),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(async () => undefined),
        })),
      })),
    } as any;

    const { createPipelineRuntimeRepository } =
      await import("../../src/lib/runtime-repository.js");
    const repository = await createPipelineRuntimeRepository({ db });

    await repository.promoteCanonicalFamily({
      previousCanonicalSheetId: "sheet_old",
      nextCanonicalSheetId: "sheet_new",
    });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledTimes(2);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("returns the existing artist when concurrent creates race on the same slug", async () => {
    vi.resetModules();

    const existingArtist = {
      id: "artist_1",
      slug: "hans-zimmer",
      name: "Hans Zimmer",
    };

    let selectCallCount = 0;
    let insertAttemptCount = 0;

    const db = {
      select: vi.fn(() => {
        selectCallCount += 1;

        if (selectCallCount <= 2) {
          return {
            from: vi.fn(() => ({
              orderBy: vi.fn(async () =>
                selectCallCount === 1 ? seededGenreRows : seededDifficultyRows,
              ),
            })),
          };
        }

        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => [existingArtist]),
            })),
          })),
        };
      }),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => {
            insertAttemptCount += 1;
            if (insertAttemptCount === 1) {
              return [existingArtist];
            }

            throw new Error(
              'duplicate key value violates unique constraint "artist_slug_key"',
            );
          }),
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(async () => {
              insertAttemptCount += 1;
              return insertAttemptCount === 1 ? [existingArtist] : [];
            }),
          })),
        })),
      })),
    } as any;

    const { createPipelineRuntimeRepository } =
      await import("../../src/lib/runtime-repository.js");
    const repository = await createPipelineRuntimeRepository({ db });

    await expect(
      Promise.all([
        repository.createArtist({
          name: "Hans Zimmer",
          slug: "hans-zimmer",
          normalizedName: "hans zimmer",
        }),
        repository.createArtist({
          name: "Hans Zimmer",
          slug: "hans-zimmer",
          normalizedName: "hans zimmer",
        }),
      ]),
    ).resolves.toEqual([existingArtist, existingArtist]);
  });
});
