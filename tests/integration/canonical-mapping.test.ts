/**
 * Integration test: canonical-mapping end-to-end
 *
 * Exercises the full canonical-mapping contract against the real
 * processPipelineJob + publishSheet execution path, backed by an
 * in-memory repository that mirrors the updateWorkCanonicalSheet
 * logic from runtime-repository.ts.
 *
 * Coverage areas:
 *   1. Import provenance — provenance fields (workId, arrangementId,
 *      sourceDifficultyLabel, conversionLevel) flow through the real
 *      processPipelineJob → publishSheet → insertSheet chain.
 *   2. Canonical selection — updateWorkCanonicalSheet runs
 *      selectWorkCanonicalSheet and persists the winning sheet id on
 *      work.canonicalSheetId after each imported-sheet publish.
 *   3. Work-level discovery — filtering sheets to work.canonicalSheetId
 *      (mirroring isWorkCanonical from api/src/routes/sheets.ts) yields
 *      exactly the canonical sheet; all non-canonical variants are excluded.
 *   4. Arrangement-scoped retrieval — all variants for an arrangement
 *      remain accessible by arrangementId; the canonical variant is one
 *      of them but non-canonical variants are also reachable for explicit
 *      share resolution.
 *
 * Out of scope: DB-level uniqueness constraint on (arrangement_id,
 * conversion_level) cannot be exercised without a live database.
 * That invariant is covered by migration 016_sheet_canonical_mapping.sql
 * and must be validated with a real DB smoke test against a seeded
 * Postgres instance.
 *
 * Cross-workspace note: api/src/routes/sheets.ts isWorkCanonical logic
 * cannot be imported here because api/ and pipeline/ are separate Yarn
 * workspaces with no declared dependency between them. The isWorkCanonical
 * filter is replicated inline below with a comment citing the source.
 */

import TonejsMidi from "@tonejs/midi";
import { describe, expect, it } from "vitest";

import { processPipelineJob } from "../../src/lib/process-job";
import {
  selectWorkCanonicalSheet,
  type SourceDifficultyLabel,
  type WorkCanonicalInput,
} from "../../src/stages/canonical-selector";
import type {
  ArtistRecord,
  DifficultyRecord,
  FingerprintRecord,
  GenreRecord,
} from "../../src/stages/types";
import type { DifficultyLevel } from "@zen/midi-to-vp";

const { Midi } = TonejsMidi;

// ---------------------------------------------------------------------------
// MIDI fixture (C major chord — same quality as pipeline-flow.test.ts)
// ---------------------------------------------------------------------------

function createPipelineMidi(): Uint8Array {
  const midi = new Midi();
  midi.header.setTempo(120);

  const track = midi.addTrack();
  track.channel = 0;
  track.addNote({ midi: 60, time: 0, duration: 0.25, velocity: 0.8 });
  track.addNote({ midi: 64, time: 0.25, duration: 0.25, velocity: 0.82 });
  track.addNote({ midi: 67, time: 0.5, duration: 0.25, velocity: 0.84 });

  return new Uint8Array(midi.toArray());
}

// ---------------------------------------------------------------------------
// In-memory repository with real updateWorkCanonicalSheet logic
//
// The updateWorkCanonicalSheet implementation below is a faithful in-memory
// mirror of runtime-repository.ts:960-1081. It accumulates arrangement-linked
// sheets, calls selectWorkCanonicalSheet (the same pure selector used in
// production), and updates the works map — exercising the real selection
// algorithm without a live database.
// ---------------------------------------------------------------------------

class CanonicalMappingRepository {
  public readonly genres: GenreRecord[] = [
    { id: "genre_soundtrack", slug: "soundtrack", name: "Soundtrack" },
  ];
  public readonly difficulties: DifficultyRecord[] = [
    {
      id: "difficulty_beginner",
      slug: "beginner",
      label: "Beginner",
      level: 1,
    },
    {
      id: "difficulty_intermediate",
      slug: "intermediate",
      label: "Intermediate",
      level: 2,
    },
    {
      id: "difficulty_advanced",
      slug: "advanced",
      label: "Advanced",
      level: 3,
    },
    { id: "difficulty_expert", slug: "expert", label: "Expert", level: 4 },
  ];

  public readonly sheets: Array<Record<string, unknown>> = [];
  public readonly works = new Map<string, { canonicalSheetId: string | null }>();

  private readonly jobs = new Map<
    string,
    { status: string; state: string; phase: string | null; sheetId: string | null }
  >();
  private readonly artists = new Map<string, ArtistRecord>();
  private readonly fingerprints = new Map<string, FingerprintRecord>();

  async getJobBySourceUrl(
    sourceUrl: string,
  ): Promise<{ status: string; state: string; phase: string | null; sheetId: string | null } | null> {
    return this.jobs.get(sourceUrl) ?? null;
  }

  async findSheetBySourceUrl(
    sourceUrl: string,
  ): Promise<{ id: string; slug: string } | null> {
    const existing = this.sheets.find((s) => s["sourceUrl"] === sourceUrl);
    if (!existing) return null;
    return { id: String(existing["id"]), slug: String(existing["slug"]) };
  }

  async saveJobStatus(event: {
    sourceUrl: string;
    status: string;
    state?: string;
    phase?: string | null;
    sheetId?: string | null;
    [key: string]: unknown;
  }): Promise<void> {
    this.jobs.set(event.sourceUrl, {
      status: event.status,
      state: event.state ?? "queued",
      phase: event.phase ?? null,
      sheetId: event.sheetId ?? null,
    });
  }

  async getExistingArtistNames(): Promise<string[]> {
    return [...this.artists.values()].map((a) => a.name);
  }

  async findArtistByNormalizedName(
    normalizedName: string,
  ): Promise<ArtistRecord | null> {
    return this.artists.get(normalizedName) ?? null;
  }

  async createArtist(input: {
    name: string;
    slug: string;
    normalizedName: string;
  }): Promise<ArtistRecord> {
    const existing = this.artists.get(input.normalizedName);
    if (existing) return existing;
    const artist: ArtistRecord = {
      id: `artist_${this.artists.size + 1}`,
      slug: input.slug,
      name: input.name,
    };
    this.artists.set(input.normalizedName, artist);
    return artist;
  }

  async findFingerprintByKey(
    normalizedKey: string,
  ): Promise<FingerprintRecord | null> {
    return this.fingerprints.get(normalizedKey) ?? null;
  }

  async insertSheet(
    sheet: Record<string, unknown>,
  ): Promise<{ id: string; slug: string }> {
    const id = `sheet_${this.sheets.length + 1}`;
    this.sheets.push({ id, ...sheet });
    return { id, slug: String(sheet["slug"]) };
  }

  async updateFingerprint(update: {
    normalizedKey: string;
    canonicalSheetId: string;
    versionCount: number;
  }): Promise<void> {
    this.fingerprints.set(update.normalizedKey, {
      normalizedKey: update.normalizedKey,
      canonicalSheetId: update.canonicalSheetId,
      canonicalQualityScore: 0.82,
      versionCount: update.versionCount,
    });
  }

  async promoteCanonicalFamily(): Promise<void> {
    // no-op for in-memory
  }

  async revalidatePaths(): Promise<void> {
    // no-op for in-memory
  }

  /**
   * In-memory mirror of runtime-repository.ts updateWorkCanonicalSheet (L960-1081).
   *
   * Accumulates arrangement-linked sheets (those with all four provenance fields),
   * runs selectWorkCanonicalSheet, and persists the winner's sheet id on
   * this.works.  Ranking signals (sourceViewCount / sourceRatingCount /
   * sourceRatingScore / createdAt) are not available from the sheet rows alone;
   * they default to null / epoch so ranking within a difficulty bucket is
   * stable but not realistic — sufficient for canonical-selection coverage.
   */
  async updateWorkCanonicalSheet(workId: string): Promise<void> {
    type Accumulator = WorkCanonicalInput & {
      sheetsByLevel: Map<string, string>;
    };
    const byArrangement = new Map<string, Accumulator>();

    for (const s of this.sheets) {
      if (s["workId"] !== workId) continue;
      if (!s["arrangementId"] || !s["conversionLevel"] || !s["sourceDifficultyLabel"])
        continue;

      const label = s["sourceDifficultyLabel"] as string;
      if (label !== "Beginner" && label !== "Intermediate" && label !== "Advanced")
        continue;

      const arrId = s["arrangementId"] as string;
      const level = s["conversionLevel"] as DifficultyLevel;
      const sheetId = s["id"] as string;

      const existing = byArrangement.get(arrId);
      if (existing) {
        (existing.availableConversionLevels as DifficultyLevel[]).push(level);
        existing.sheetsByLevel.set(level, sheetId);
      } else {
        byArrangement.set(arrId, {
          arrangementId: arrId,
          sourceDifficultyLabel: label as SourceDifficultyLabel,
          availableConversionLevels: [level],
          sourceViewCount: null,
          sourceRatingCount: null,
          sourceRatingScore: null,
          createdAt: new Date(0),
          sheetsByLevel: new Map([[level, sheetId]]),
        });
      }
    }

    const inputs: WorkCanonicalInput[] = [...byArrangement.values()];
    const winner = selectWorkCanonicalSheet(inputs);

    if (!winner) {
      this.works.set(workId, { canonicalSheetId: null });
      return;
    }

    const winnerEntry = byArrangement.get(winner.arrangementId);
    const winnerSheetId = winnerEntry?.sheetsByLevel.get(winner.conversionLevel);
    if (!winnerSheetId) {
      throw new Error(
        `updateWorkCanonicalSheet: winner (arrangementId=${winner.arrangementId}, ` +
          `conversionLevel=${winner.conversionLevel}) not found in accumulator ` +
          `for workId=${workId}`,
      );
    }

    this.works.set(workId, { canonicalSheetId: winnerSheetId });
  }
}

// ---------------------------------------------------------------------------
// isWorkCanonical — replicated from api/src/routes/sheets.ts:294-300.
//
// Cross-workspace import is not feasible because api/ and pipeline/ are
// separate Yarn workspaces.  Any change to the production function must be
// mirrored here.
// ---------------------------------------------------------------------------

function isWorkCanonical(
  sheet: Record<string, unknown>,
  canonicalSheetId: string | null,
): boolean {
  // Non-imported sheets (no arrangement_id) are always surfaced.
  if (!sheet["arrangementId"]) return true;
  // If no canonical pointer, imported sheet is excluded (provenance incomplete).
  if (canonicalSheetId === null) return false;
  return sheet["id"] === canonicalSheetId;
}

// ---------------------------------------------------------------------------
// 1. Import provenance — provenance fields persisted via real pipeline path
// ---------------------------------------------------------------------------

describe("canonical-mapping — import provenance via real pipeline path", () => {
  it("persists all four provenance fields through processPipelineJob → insertSheet", async () => {
    const repository = new CanonicalMappingRepository();

    const result = await processPipelineJob(
      {
        sourceUrl: "https://example.com/moonlight-adept.mid",
        sourceSite: "musescore",
        rawTitle: "Moonlight Sonata",
        rawArtist: "Beethoven",
        file: createPipelineMidi(),
        dryRun: false,
        workId: "work_beethoven_moonlight",
        arrangementId: "arr_intermediate",
        sourceDifficultyLabel: "Intermediate",
        conversionLevel: "Adept",
      },
      repository,
    );

    expect(result.outcome).toBe("published");
    expect(result.sheetId).toBe("sheet_1");
    expect(repository.sheets).toHaveLength(1);

    const stored = repository.sheets[0];
    expect(stored["workId"]).toBe("work_beethoven_moonlight");
    expect(stored["arrangementId"]).toBe("arr_intermediate");
    expect(stored["sourceDifficultyLabel"]).toBe("Intermediate");
    expect(stored["conversionLevel"]).toBe("Adept");
  });

  it("preserves independent provenance for each variant when multiple pipeline jobs share an arrangement", async () => {
    const repository = new CanonicalMappingRepository();

    await processPipelineJob(
      {
        sourceUrl: "https://example.com/fur-elise-adept.mid",
        sourceSite: "musescore",
        rawTitle: "Fur Elise",
        rawArtist: "Beethoven",
        file: createPipelineMidi(),
        dryRun: false,
        workId: "work_fur_elise",
        arrangementId: "arr_beginner",
        sourceDifficultyLabel: "Beginner",
        conversionLevel: "Adept",
      },
      repository,
    );

    await processPipelineJob(
      {
        sourceUrl: "https://example.com/fur-elise-apprentice.mid",
        sourceSite: "musescore",
        rawTitle: "Fur Elise",
        rawArtist: "Beethoven",
        file: createPipelineMidi(),
        dryRun: false,
        workId: "work_fur_elise",
        arrangementId: "arr_beginner",
        sourceDifficultyLabel: "Beginner",
        conversionLevel: "Apprentice",
      },
      repository,
    );

    expect(repository.sheets).toHaveLength(2);

    const adeptSheet = repository.sheets.find(
      (s) => s["conversionLevel"] === "Adept",
    );
    const apprenticeSheet = repository.sheets.find(
      (s) => s["conversionLevel"] === "Apprentice",
    );

    expect(adeptSheet?.["workId"]).toBe("work_fur_elise");
    expect(adeptSheet?.["arrangementId"]).toBe("arr_beginner");
    expect(adeptSheet?.["sourceDifficultyLabel"]).toBe("Beginner");

    expect(apprenticeSheet?.["workId"]).toBe("work_fur_elise");
    expect(apprenticeSheet?.["arrangementId"]).toBe("arr_beginner");
    expect(apprenticeSheet?.["sourceDifficultyLabel"]).toBe("Beginner");

    // Same arrangement, distinct conversion levels
    expect(adeptSheet?.["arrangementId"]).toBe(apprenticeSheet?.["arrangementId"]);
    expect(adeptSheet?.["conversionLevel"]).not.toBe(
      apprenticeSheet?.["conversionLevel"],
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Canonical selection — updateWorkCanonicalSheet with real selector
// ---------------------------------------------------------------------------

describe("canonical-mapping — updateWorkCanonicalSheet selects correct canonical", () => {
  it("sets work.canonicalSheetId after publishing a single variant", async () => {
    const repository = new CanonicalMappingRepository();

    const result = await processPipelineJob(
      {
        sourceUrl: "https://example.com/canon-in-d-adept.mid",
        sourceSite: "musescore",
        rawTitle: "Canon in D",
        rawArtist: "Pachelbel",
        file: createPipelineMidi(),
        dryRun: false,
        workId: "work_canon_in_d",
        arrangementId: "arr_intermediate",
        sourceDifficultyLabel: "Intermediate",
        conversionLevel: "Adept",
      },
      repository,
    );

    expect(result.outcome).toBe("published");

    const work = repository.works.get("work_canon_in_d");
    expect(work?.canonicalSheetId).toBe("sheet_1");
  });

  it("prefers Intermediate+Adept over Beginner+Adept when both are present", async () => {
    const repository = new CanonicalMappingRepository();

    // Publish Beginner+Adept first
    await processPipelineJob(
      {
        sourceUrl: "https://example.com/claire-beginner-adept.mid",
        sourceSite: "musescore",
        rawTitle: "Clair de Lune",
        rawArtist: "Debussy",
        file: createPipelineMidi(),
        dryRun: false,
        workId: "work_clair_de_lune",
        arrangementId: "arr_beginner",
        sourceDifficultyLabel: "Beginner",
        conversionLevel: "Adept",
      },
      repository,
    );

    const afterFirstPublish = repository.works.get("work_clair_de_lune");
    expect(afterFirstPublish?.canonicalSheetId).toBe("sheet_1");

    // Publish Intermediate+Adept second
    await processPipelineJob(
      {
        sourceUrl: "https://example.com/claire-intermediate-adept.mid",
        sourceSite: "musescore",
        rawTitle: "Clair de Lune",
        rawArtist: "Debussy",
        file: createPipelineMidi(),
        dryRun: false,
        workId: "work_clair_de_lune",
        arrangementId: "arr_intermediate",
        sourceDifficultyLabel: "Intermediate",
        conversionLevel: "Adept",
      },
      repository,
    );

    // Intermediate+Adept wins — canonical pointer must update to sheet_2
    const afterSecondPublish = repository.works.get("work_clair_de_lune");
    const intermediateSheet = repository.sheets.find(
      (s) =>
        s["arrangementId"] === "arr_intermediate" &&
        s["conversionLevel"] === "Adept",
    );
    expect(intermediateSheet?.["id"]).toBe("sheet_2");
    expect(afterSecondPublish?.canonicalSheetId).toBe("sheet_2");
  });

  it("falls back to Beginner+Adept when no Intermediate arrangement is present", async () => {
    const repository = new CanonicalMappingRepository();

    await processPipelineJob(
      {
        sourceUrl: "https://example.com/nocturne-beginner-adept.mid",
        sourceSite: "musescore",
        rawTitle: "Nocturne Op.9",
        rawArtist: "Chopin",
        file: createPipelineMidi(),
        dryRun: false,
        workId: "work_nocturne",
        arrangementId: "arr_beginner",
        sourceDifficultyLabel: "Beginner",
        conversionLevel: "Adept",
      },
      repository,
    );

    const work = repository.works.get("work_nocturne");
    const beginnerSheet = repository.sheets.find(
      (s) =>
        s["arrangementId"] === "arr_beginner" &&
        s["conversionLevel"] === "Adept",
    );
    expect(work?.canonicalSheetId).toBe(beginnerSheet?.["id"]);
  });

  it("resolves Phase-2 fallback when no Adept variant exists in any arrangement", async () => {
    const repository = new CanonicalMappingRepository();

    // Publish Intermediate+Apprentice (no Adept)
    await processPipelineJob(
      {
        sourceUrl: "https://example.com/turkish-march-apprentice.mid",
        sourceSite: "musescore",
        rawTitle: "Turkish March",
        rawArtist: "Mozart",
        file: createPipelineMidi(),
        dryRun: false,
        workId: "work_turkish_march",
        arrangementId: "arr_intermediate",
        sourceDifficultyLabel: "Intermediate",
        conversionLevel: "Apprentice",
      },
      repository,
    );

    // Phase 2: Intermediate bucket exists, Apprentice is the arrangement-level
    // canonical when Adept is absent.
    const work = repository.works.get("work_turkish_march");
    expect(work?.canonicalSheetId).toBe("sheet_1");

    const canonicalSheet = repository.sheets.find(
      (s) => s["id"] === work?.canonicalSheetId,
    );
    expect(canonicalSheet?.["conversionLevel"]).toBe("Apprentice");
    expect(canonicalSheet?.["sourceDifficultyLabel"]).toBe("Intermediate");
  });
});

// ---------------------------------------------------------------------------
// 3. Work-level discovery — isWorkCanonical filter yields single canonical sheet
// ---------------------------------------------------------------------------

describe("canonical-mapping — work-level discovery via canonical pointer", () => {
  it("filters to exactly the canonical sheet when the work has multiple variants", async () => {
    const repository = new CanonicalMappingRepository();

    // Publish Intermediate+Adept (will become canonical after second publish)
    await processPipelineJob(
      {
        sourceUrl: "https://example.com/prelude-intermediate-adept.mid",
        sourceSite: "musescore",
        rawTitle: "Prelude in C",
        rawArtist: "Bach",
        file: createPipelineMidi(),
        dryRun: false,
        workId: "work_prelude_c",
        arrangementId: "arr_intermediate",
        sourceDifficultyLabel: "Intermediate",
        conversionLevel: "Adept",
      },
      repository,
    );

    // Publish Beginner+Adept
    await processPipelineJob(
      {
        sourceUrl: "https://example.com/prelude-beginner-adept.mid",
        sourceSite: "musescore",
        rawTitle: "Prelude in C",
        rawArtist: "Bach",
        file: createPipelineMidi(),
        dryRun: false,
        workId: "work_prelude_c",
        arrangementId: "arr_beginner",
        sourceDifficultyLabel: "Beginner",
        conversionLevel: "Adept",
      },
      repository,
    );

    // Publish a non-Adept variant on the same Intermediate arrangement
    await processPipelineJob(
      {
        sourceUrl: "https://example.com/prelude-intermediate-master.mid",
        sourceSite: "musescore",
        rawTitle: "Prelude in C",
        rawArtist: "Bach",
        file: createPipelineMidi(),
        dryRun: false,
        workId: "work_prelude_c",
        arrangementId: "arr_intermediate",
        sourceDifficultyLabel: "Intermediate",
        conversionLevel: "Master",
      },
      repository,
    );

    expect(repository.sheets).toHaveLength(3);

    const work = repository.works.get("work_prelude_c");
    const canonicalSheetId = work?.canonicalSheetId ?? null;
    expect(canonicalSheetId).not.toBeNull();

    // The canonical sheet must be Intermediate+Adept (Phase 1 winner)
    const canonicalSheet = repository.sheets.find(
      (s) => s["id"] === canonicalSheetId,
    );
    expect(canonicalSheet?.["arrangementId"]).toBe("arr_intermediate");
    expect(canonicalSheet?.["conversionLevel"]).toBe("Adept");

    // isWorkCanonical filter (mirrors api/src/routes/sheets.ts:294-300)
    const discoveryResult = repository.sheets.filter((s) =>
      isWorkCanonical(s, canonicalSheetId),
    );
    expect(discoveryResult).toHaveLength(1);
    expect(discoveryResult[0]["id"]).toBe(canonicalSheetId);
  });

  it("returns empty discovery when no sheets have been published for a work", () => {
    const repository = new CanonicalMappingRepository();
    const canonicalSheetId =
      repository.works.get("work_nonexistent")?.canonicalSheetId ?? null;
    const discoveryResult = repository.sheets.filter((s) =>
      isWorkCanonical(s, canonicalSheetId),
    );
    expect(discoveryResult).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Arrangement-scoped retrieval — all variants accessible; canonical is one
// ---------------------------------------------------------------------------

describe("canonical-mapping — arrangement-scoped retrieval", () => {
  it("all variants for an arrangement are accessible; canonical is one of them", async () => {
    const repository = new CanonicalMappingRepository();

    await processPipelineJob(
      {
        sourceUrl: "https://example.com/gymnopedie-adept.mid",
        sourceSite: "musescore",
        rawTitle: "Gymnopedie No.1",
        rawArtist: "Satie",
        file: createPipelineMidi(),
        dryRun: false,
        workId: "work_gymnopedie",
        arrangementId: "arr_intermediate",
        sourceDifficultyLabel: "Intermediate",
        conversionLevel: "Adept",
      },
      repository,
    );

    await processPipelineJob(
      {
        sourceUrl: "https://example.com/gymnopedie-master.mid",
        sourceSite: "musescore",
        rawTitle: "Gymnopedie No.1",
        rawArtist: "Satie",
        file: createPipelineMidi(),
        dryRun: false,
        workId: "work_gymnopedie",
        arrangementId: "arr_intermediate",
        sourceDifficultyLabel: "Intermediate",
        conversionLevel: "Master",
      },
      repository,
    );

    await processPipelineJob(
      {
        sourceUrl: "https://example.com/gymnopedie-apprentice.mid",
        sourceSite: "musescore",
        rawTitle: "Gymnopedie No.1",
        rawArtist: "Satie",
        file: createPipelineMidi(),
        dryRun: false,
        workId: "work_gymnopedie",
        arrangementId: "arr_intermediate",
        sourceDifficultyLabel: "Intermediate",
        conversionLevel: "Apprentice",
      },
      repository,
    );

    expect(repository.sheets).toHaveLength(3);

    // Arrangement-scoped retrieval surfaces all variants
    const arrangementVariants = repository.sheets.filter(
      (s) => s["arrangementId"] === "arr_intermediate",
    );
    expect(arrangementVariants).toHaveLength(3);

    const levels = arrangementVariants.map((s) => s["conversionLevel"]);
    expect(levels).toContain("Adept");
    expect(levels).toContain("Master");
    expect(levels).toContain("Apprentice");

    // Canonical pointer resolves to Adept
    const work = repository.works.get("work_gymnopedie");
    const canonicalSheetId = work?.canonicalSheetId ?? null;
    const canonicalSheet = arrangementVariants.find(
      (s) => s["id"] === canonicalSheetId,
    );
    expect(canonicalSheet?.["conversionLevel"]).toBe("Adept");

    // Non-canonical variants remain reachable for explicit share resolution
    const masterSheet = arrangementVariants.find(
      (s) => s["conversionLevel"] === "Master",
    );
    const apprenticeSheet = arrangementVariants.find(
      (s) => s["conversionLevel"] === "Apprentice",
    );
    expect(masterSheet).toBeDefined();
    expect(apprenticeSheet).toBeDefined();
    expect(masterSheet?.["id"]).not.toBe(canonicalSheetId);
    expect(apprenticeSheet?.["id"]).not.toBe(canonicalSheetId);
  });

  it("resolves arrangement canonical to Apprentice for explicit share when Adept is absent", async () => {
    const repository = new CanonicalMappingRepository();

    await processPipelineJob(
      {
        sourceUrl: "https://example.com/waltz-apprentice.mid",
        sourceSite: "musescore",
        rawTitle: "Waltz Op.64",
        rawArtist: "Chopin",
        file: createPipelineMidi(),
        dryRun: false,
        workId: "work_waltz_op64",
        arrangementId: "arr_beginner",
        sourceDifficultyLabel: "Beginner",
        conversionLevel: "Apprentice",
      },
      repository,
    );

    await processPipelineJob(
      {
        sourceUrl: "https://example.com/waltz-master.mid",
        sourceSite: "musescore",
        rawTitle: "Waltz Op.64",
        rawArtist: "Chopin",
        file: createPipelineMidi(),
        dryRun: false,
        workId: "work_waltz_op64",
        arrangementId: "arr_beginner",
        sourceDifficultyLabel: "Beginner",
        conversionLevel: "Master",
      },
      repository,
    );

    expect(repository.sheets).toHaveLength(2);

    const work = repository.works.get("work_waltz_op64");
    const canonicalSheetId = work?.canonicalSheetId ?? null;

    // Phase 2: no Adept → Apprentice is the arrangement-level canonical
    const canonicalSheet = repository.sheets.find(
      (s) => s["id"] === canonicalSheetId,
    );
    expect(canonicalSheet?.["conversionLevel"]).toBe("Apprentice");

    // Master variant is still reachable for an explicit share link
    const masterSheet = repository.sheets.find(
      (s) => s["conversionLevel"] === "Master",
    );
    expect(masterSheet).toBeDefined();
    expect(masterSheet?.["id"]).not.toBe(canonicalSheetId);
  });
});
