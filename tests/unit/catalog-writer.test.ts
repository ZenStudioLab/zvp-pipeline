import { describe, expect, it, vi } from "vitest";

import type { MuseScoreExport } from "../../src/importers/catalog-writer.js";
import {
  slugify,
  writeCatalog,
} from "../../src/importers/catalog-writer.js";

describe("slugify", () => {
  it("converts to lowercase and replaces non-alphanumeric with hyphens", () => {
    expect(slugify("Hello World!")).toBe("hello-world");
  });

  it("collapses multiple hyphens", () => {
    expect(slugify("foo   bar---baz")).toBe("foo-bar-baz");
  });

  it("trims hyphens from ends", () => {
    expect(slugify("--hello-world--")).toBe("hello-world");
  });

  it("handles empty input", () => {
    expect(slugify("")).toBe("");
  });
});

function createSampleExport(
  overrides: Partial<MuseScoreExport> = {},
): MuseScoreExport {
  return {
    provider: "musescore",
    provider_item_id: "musescore:12345",
    source_site: "musescore",
    source_url: "https://musescore.com/user/12345/scores/67890",
    canonical_url: "https://musescore.com/user/12345/scores/67890",
    title: "Interstellar Main Theme",
    artist: "Hans Zimmer",
    artist_url: "https://musescore.com/user/12345",
    song_url: null,
    uploader_name: "piano_fan",
    uploader_url: "https://musescore.com/user/12345",
    difficulty_label: "Advanced",
    difficulty_rank: 3,
    duration_seconds: 210,
    bpm: 120,
    view_count: 15420,
    like_count: 892,
    comment_count: 45,
    rating_score: 4.5,
    rating_count: 120,
    pages: "5",
    measures: "98",
    key: "A minor",
    parts: "Piano Solo",
    credits: "Arranged by piano_fan",
    uploaded_at: "2024-01-15T10:00:00Z",
    updated_at: "2024-06-20T14:30:00Z",
    license_label: "Creative Commons Attribution",
    license_url: "https://creativecommons.org/licenses/by/4.0/",
    privacy: "public",
    tags: ["piano", "soundtrack", "film"],
    related_versions: null,
    raw_metadata: { source: "musescore_api_v3" },
    scraped_at: "2024-06-21T08:00:00Z",
    ...overrides,
  };
}

describe("writeCatalog", () => {
  it("creates a new work and arrangement with full metadata", async () => {
    const insertedArrangements: Array<Record<string, unknown>> = [];
    const insertedJobs: Array<Record<string, unknown>> = [];

    const workFindByTitleArtist = vi.fn(async () => null);
    const workFindBySlug = vi.fn(async () => null);
    const workInsert = vi.fn(async () => ({ id: "work_1" }));
    const arrangementFindByItem = vi.fn(async () => null);
    const arrangementInsert = vi.fn(async (input) => {
      insertedArrangements.push(input as unknown as Record<string, unknown>);
      return { id: "arrangement_1" };
    });
    const arrangementUpdate = vi.fn(async () => undefined);
    const jobFindByKey = vi.fn(async () => null);
    const jobInsert = vi.fn(async (input) => {
      insertedJobs.push(input as unknown as Record<string, unknown>);
      return { id: "job_1" };
    });
    const jobUpdate = vi.fn(async () => undefined);

    const input = createSampleExport();

    const result = await writeCatalog(input, {
      work: {
        findByCanonicalTitleAndArtist: workFindByTitleArtist,
        findBySlug: workFindBySlug,
        insertWork: workInsert,
      },
      arrangement: {
        findByProviderItem: arrangementFindByItem,
        insertArrangement: arrangementInsert,
        updateArrangement: arrangementUpdate,
      },
      pipelineJob: {
        findBySourceKey: jobFindByKey,
        insertPipelineJob: jobInsert,
        updatePipelineJob: jobUpdate,
      },
      sheetAssetId: "asset_1",
    });

    // Work created
    expect(workInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalTitle: "Interstellar Main Theme",
        canonicalArtistName: "Hans Zimmer",
        slug: "interstellar-main-theme",
      }),
    );

    // Arrangement inserted with all metadata
    expect(arrangementInsert).toHaveBeenCalledTimes(1);
    expect(insertedArrangements[0]).toEqual(
      expect.objectContaining({
        workId: "work_1",
        provider: "musescore",
        providerItemId: "musescore:12345",
        sourceUrl: input.source_url,
        canonicalUrl: input.canonical_url,
        sourceTitle: "Interstellar Main Theme",
        sourceArtistName: "Hans Zimmer",
        uploaderName: "piano_fan",
        uploaderUrl: input.uploader_url,
        sourceDifficultyLabel: "Advanced",
        sourceDifficultyRank: 3,
        durationSecondsSource: 210,
        bpmSource: 120,
        sourceViewCount: 15420,
        sourceLikeCount: 892,
        sourceCommentCount: 45,
        sourceRatingScore: 4.5,
        sourceRatingCount: 120,
        sourcePages: "5",
        sourceMeasures: "98",
        sourceKey: "A minor",
        sourceParts: "Piano Solo",
        sourceCredits: "Arranged by piano_fan",
        sourceUploadedAt: expect.any(Date),
        sourceUpdatedAt: expect.any(Date),
        sourceLicenseLabel: "Creative Commons Attribution",
        sourceLicenseUrl: input.license_url,
        sourcePrivacy: "public",
        sourceTags: ["piano", "soundtrack", "film"],
        sourceRelatedVersions: null,
        rawMetadata: { source: "musescore_api_v3" },
        scrapedAt: expect.any(Date),
      }),
    );
    expect((insertedArrangements[0].sourceUploadedAt as Date).toISOString()).toBe("2024-01-15T10:00:00.000Z");
    expect((insertedArrangements[0].sourceUpdatedAt as Date).toISOString()).toBe("2024-06-20T14:30:00.000Z");
    expect((insertedArrangements[0].scrapedAt as Date).toISOString()).toBe("2024-06-21T08:00:00.000Z");

    // Pipeline job enqueued
    expect(jobInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: "musescore:12345",
        sourceUrl: input.source_url,
        sourceSite: "musescore",
        rawTitle: "Interstellar Main Theme",
        sourceItemId: "arrangement_1",
        inputAssetId: "asset_1",
        status: "pending",
      }),
    );

    expect(result).toEqual({
      workSlug: "interstellar-main-theme",
      arrangementId: "arrangement_1",
      arrangementNew: true,
      pipelineJobId: "job_1",
      pipelineJobNew: true,
    });
  });

  it("reuses existing work matched by title and artist", async () => {
    const workFindByTitleArtist = vi.fn(async () => ({
      id: "existing_work",
      slug: "interstellar-main-theme",
      canonicalTitle: "Interstellar Main Theme",
      canonicalArtistName: "Hans Zimmer",
    }));
    const workFindBySlug = vi.fn(async () => null);
    const workInsert = vi.fn(async () => ({ id: "never_called" }));
    const arrangementFindByItem = vi.fn(async () => null);
    const arrangementInsert = vi.fn(async () => ({ id: "arrangement_1" }));
    const arrangementUpdate = vi.fn(async () => undefined);
    const jobFindByKey = vi.fn(async () => null);
    const jobInsert = vi.fn(async () => ({ id: "job_1" }));
    const jobUpdate = vi.fn(async () => undefined);

    const result = await writeCatalog(createSampleExport(), {
      work: {
        findByCanonicalTitleAndArtist: workFindByTitleArtist,
        findBySlug: workFindBySlug,
        insertWork: workInsert,
      },
      arrangement: {
        findByProviderItem: arrangementFindByItem,
        insertArrangement: arrangementInsert,
        updateArrangement: arrangementUpdate,
      },
      pipelineJob: {
        findBySourceKey: jobFindByKey,
        insertPipelineJob: jobInsert,
        updatePipelineJob: jobUpdate,
      },
      sheetAssetId: "asset_1",
    });

    expect(workInsert).not.toHaveBeenCalled();
    expect(arrangementInsert).toHaveBeenCalledWith(
      expect.objectContaining({ workId: "existing_work" }),
    );
    expect(result.workSlug).toBe("interstellar-main-theme");
  });

  it("updates existing arrangement on re-import", async () => {
    const arrangementUpdates: Array<Record<string, unknown>> = [];

    const workFindByTitleArtist = vi.fn(async () => null);
    const workFindBySlug = vi.fn(async () => null);
    const workInsert = vi.fn(async () => ({ id: "work_1" }));
    const arrangementFindByItem = vi.fn(async () => ({
      id: "existing_arr",
      provider: "musescore",
      providerItemId: "musescore:12345",
      sourceViewCount: 1000,
      sourceLikeCount: 50,
      sourceCommentCount: 5,
      sourceRatingScore: 4.0,
      sourceRatingCount: 30,
    }));
    const arrangementInsert = vi.fn(async () => ({ id: "never_called" }));
    const arrangementUpdate = vi.fn(async (id, payload) => {
      arrangementUpdates.push({ id, ...payload } as unknown as Record<string, unknown>);
    });
    const jobFindByKey = vi.fn(async () => null);
    const jobInsert = vi.fn(async () => ({ id: "job_1" }));
    const jobUpdate = vi.fn(async () => undefined);

    const result = await writeCatalog(
      createSampleExport({
        view_count: 20000,
        like_count: 1200,
        rating_score: 4.8,
      }),
      {
        work: {
          findByCanonicalTitleAndArtist: workFindByTitleArtist,
          findBySlug: workFindBySlug,
          insertWork: workInsert,
        },
        arrangement: {
          findByProviderItem: arrangementFindByItem,
          insertArrangement: arrangementInsert,
          updateArrangement: arrangementUpdate,
        },
        pipelineJob: {
          findBySourceKey: jobFindByKey,
          insertPipelineJob: jobInsert,
          updatePipelineJob: jobUpdate,
        },
        sheetAssetId: "asset_1",
      },
    );

    expect(arrangementInsert).not.toHaveBeenCalled();
    expect(arrangementUpdate).toHaveBeenCalledTimes(1);
    expect(arrangementUpdates[0]).toEqual(
      expect.objectContaining({
        id: "existing_arr",
        sourceViewCount: 20000,
        sourceLikeCount: 1200,
        sourceCommentCount: 45,
        sourceRatingScore: 4.8,
        sourceRatingCount: 120,
        rawMetadata: { source: "musescore_api_v3" },
        scrapedAt: expect.any(Date),
      }),
    );
    expect((arrangementUpdates[0].scrapedAt as Date).toISOString()).toBe("2024-06-21T08:00:00.000Z");
    expect(result.arrangementId).toBe("existing_arr");
    expect(result.arrangementNew).toBe(false);
  });

  it("enqueues pipeline_job and reuses existing non-failed job", async () => {
    const workFindByTitleArtist = vi.fn(async () => null);
    const workFindBySlug = vi.fn(async () => null);
    const workInsert = vi.fn(async () => ({ id: "work_1" }));
    const arrangementFindByItem = vi.fn(async () => null);
    const arrangementInsert = vi.fn(async () => ({ id: "arr_1" }));
    const arrangementUpdate = vi.fn(async () => undefined);
    const jobFindByKey = vi.fn(async () => ({
      id: "existing_job",
      status: "pending",
    }));
    const jobInsert = vi.fn(async () => ({ id: "never_called" }));
    const jobUpdate = vi.fn(async () => undefined);

    const result = await writeCatalog(createSampleExport(), {
      work: {
        findByCanonicalTitleAndArtist: workFindByTitleArtist,
        findBySlug: workFindBySlug,
        insertWork: workInsert,
      },
      arrangement: {
        findByProviderItem: arrangementFindByItem,
        insertArrangement: arrangementInsert,
        updateArrangement: arrangementUpdate,
      },
      pipelineJob: {
        findBySourceKey: jobFindByKey,
        insertPipelineJob: jobInsert,
        updatePipelineJob: jobUpdate,
      },
      sheetAssetId: "asset_1",
    });

    expect(jobInsert).not.toHaveBeenCalled();
    expect(jobUpdate).not.toHaveBeenCalled();
    expect(result.pipelineJobId).toBe("existing_job");
    expect(result.pipelineJobNew).toBe(false);
  });

  it("retries a failed pipeline_job by resetting to pending", async () => {
    const jobUpdates: Array<Record<string, unknown>> = [];

    const workFindByTitleArtist = vi.fn(async () => null);
    const workFindBySlug = vi.fn(async () => null);
    const workInsert = vi.fn(async () => ({ id: "work_1" }));
    const arrangementFindByItem = vi.fn(async () => null);
    const arrangementInsert = vi.fn(async () => ({ id: "arr_1" }));
    const arrangementUpdate = vi.fn(async () => undefined);
    const jobFindByKey = vi.fn(async () => ({
      id: "failed_job",
      status: "failed",
    }));
    const jobInsert = vi.fn(async () => ({ id: "never_called" }));
    const jobUpdate = vi.fn(async (id, payload) => {
      jobUpdates.push({ id, ...payload } as unknown as Record<string, unknown>);
    });

    const result = await writeCatalog(createSampleExport(), {
      work: {
        findByCanonicalTitleAndArtist: workFindByTitleArtist,
        findBySlug: workFindBySlug,
        insertWork: workInsert,
      },
      arrangement: {
        findByProviderItem: arrangementFindByItem,
        insertArrangement: arrangementInsert,
        updateArrangement: arrangementUpdate,
      },
      pipelineJob: {
        findBySourceKey: jobFindByKey,
        insertPipelineJob: jobInsert,
        updatePipelineJob: jobUpdate,
      },
      sheetAssetId: "asset_1",
    });

    expect(jobInsert).not.toHaveBeenCalled();
    expect(jobUpdates[0]).toEqual(
      expect.objectContaining({
        id: "failed_job",
        status: "pending",
        lastError: null,
      }),
    );
    expect(result.pipelineJobId).toBe("failed_job");
    expect(result.pipelineJobNew).toBe(false);
  });

  it("handles slug collision by appending -2, -3, etc.", async () => {
    const workFindByTitleArtist = vi.fn(async () => null);
    const workFindBySlug = vi
      .fn()
      .mockResolvedValueOnce({ id: "collision_1" }) // slug "interstellar-main-theme" taken
      .mockResolvedValueOnce({ id: "collision_2" }) // slug "interstellar-main-theme-2" taken
      .mockResolvedValueOnce(null); // slug "interstellar-main-theme-3" free
    const workInsert = vi.fn(async () => ({ id: "work_1" }));
    const arrangementFindByItem = vi.fn(async () => null);
    const arrangementInsert = vi.fn(async () => ({ id: "arr_1" }));
    const arrangementUpdate = vi.fn(async () => undefined);
    const jobFindByKey = vi.fn(async () => null);
    const jobInsert = vi.fn(async () => ({ id: "job_1" }));
    const jobUpdate = vi.fn(async () => undefined);

    const result = await writeCatalog(createSampleExport(), {
      work: {
        findByCanonicalTitleAndArtist: workFindByTitleArtist,
        findBySlug: workFindBySlug,
        insertWork: workInsert,
      },
      arrangement: {
        findByProviderItem: arrangementFindByItem,
        insertArrangement: arrangementInsert,
        updateArrangement: arrangementUpdate,
      },
      pipelineJob: {
        findBySourceKey: jobFindByKey,
        insertPipelineJob: jobInsert,
        updatePipelineJob: jobUpdate,
      },
      sheetAssetId: "asset_1",
    });

    expect(workInsert).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "interstellar-main-theme-3" }),
    );
    expect(result.workSlug).toBe("interstellar-main-theme-3");
    // Slug was checked 3 times (collision, collision-2, collision-3 free)
    expect(workFindBySlug).toHaveBeenCalledTimes(3);
  });
});
