import {
  artist,
  createDbClient,
  difficulty,
  genre,
  pipelineJob,
  sheet,
  songFingerprint,
  type ZenDatabase,
} from "@zen/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import type {
  ArtistRecord,
  DifficultyRecord,
  GenreRecord,
} from "../stages/types.js";

type PersistedPipelineStatus =
  | "pending"
  | "converting"
  | "scoring"
  | "dedup"
  | "published"
  | "rejected"
  | "failed";
type CatalogStatusFilter = PersistedPipelineStatus | "needs_review";

const VALID_CATALOG_STATUS_FILTERS = [
  "pending",
  "converting",
  "scoring",
  "dedup",
  "published",
  "needs_review",
  "rejected",
  "failed",
] as const;

type RuntimeRepositoryOptions = {
  db?: ZenDatabase;
  databaseUrl?: string;
  siteUrl?: string;
  revalidationSecret?: string;
  fetchImpl?: typeof fetch;
};

type SaveJobStatusEvent = {
  sourceUrl: string;
  status: PersistedPipelineStatus;
  sheetId?: string | null;
  normalizedTitle?: string;
  normalizedArtist?: string;
  metadataConfidence?: "high" | "medium" | "low";
  qualityScore?: number;
  rubricVersion?: string;
  rejectionReason?: string;
  lastError?: string;
  sourceSite?: string;
  rawTitle?: string;
};

type StatsSummary = {
  totalJobs: number;
  published: number;
  reviewQueue: number;
  rejected: number;
  failed: number;
  averageQualityScore: number;
  reasons: Record<string, number>;
};

type SheetAiRecord = {
  sheetId: string;
  title: string;
  artistName: string;
  genreName: string;
  difficultyLabel: string;
  sheetData: string;
  qualityScore: number;
  tips: string[];
};

type SeedSummary = {
  difficulties: number;
  genres: number;
};

function normalizeLookupKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function terminalStatus(status: PersistedPipelineStatus): boolean {
  return status === "published" || status === "rejected" || status === "failed";
}

function isCatalogStatusFilter(value: string): value is CatalogStatusFilter {
  return (VALID_CATALOG_STATUS_FILTERS as readonly string[]).includes(value);
}

function buildCatalogStatusCondition(status: CatalogStatusFilter) {
  if (status === "needs_review") {
    return and(
      eq(pipelineJob.status, "published"),
      eq(sheet.needsReview, true),
    );
  }

  if (status === "published") {
    return and(
      eq(pipelineJob.status, "published"),
      eq(sheet.needsReview, false),
    );
  }

  return eq(pipelineJob.status, status);
}

function mapArtistRecord(record: typeof artist.$inferSelect): ArtistRecord {
  return {
    id: record.id,
    slug: record.slug,
    name: record.name,
  };
}

function mapDifficultyRecord(
  record: typeof difficulty.$inferSelect,
): DifficultyRecord {
  return {
    id: record.id,
    slug: record.slug,
    label: record.label,
    level: record.level,
  };
}

function mapGenreRecord(record: typeof genre.$inferSelect): GenreRecord {
  return {
    id: record.id,
    slug: record.slug,
    name: record.name,
  };
}

export async function createPipelineRuntimeRepository(
  options: RuntimeRepositoryOptions = {},
) {
  const db = options.db ?? createDbClient(options.databaseUrl);
  const ownsDbClient = !options.db;
  const fetchImpl = options.fetchImpl ?? fetch;
  const siteUrl = (options.siteUrl ?? process.env.SITE_URL ?? "").replace(
    /\/$/,
    "",
  );
  const revalidationSecret =
    options.revalidationSecret ?? process.env.REVALIDATION_SECRET ?? "";

  let genreRows: (typeof genre.$inferSelect)[];
  let difficultyRows: (typeof difficulty.$inferSelect)[];

  try {
    [genreRows, difficultyRows] = await Promise.all([
      db.select().from(genre).orderBy(asc(genre.displayOrder), asc(genre.name)),
      db.select().from(difficulty).orderBy(asc(difficulty.level)),
    ]);
  } catch (error) {
    if (ownsDbClient) {
      try {
        await db.$client.end({ timeout: 5 });
      } catch {
        // Preserve the bootstrap failure as the primary error.
      }
    }

    throw error;
  }

  async function getExistingArtistNames(): Promise<string[]> {
    const rows = await db
      .select({ name: artist.name })
      .from(artist)
      .orderBy(asc(artist.name));
    return rows.map((row) => row.name);
  }

  async function findArtistByNormalizedName(
    normalizedName: string,
  ): Promise<ArtistRecord | null> {
    const rows = await db.select().from(artist);
    const match = rows.find(
      (row) => normalizeLookupKey(row.name) === normalizedName,
    );
    return match ? mapArtistRecord(match) : null;
  }

  async function createArtist(input: {
    name: string;
    slug: string;
    normalizedName: string;
  }): Promise<ArtistRecord> {
    const [inserted] = await db
      .insert(artist)
      .values({
        name: input.name,
        slug: input.slug,
      })
      .returning();

    return mapArtistRecord(inserted);
  }

  async function findFingerprintByKey(normalizedKey: string) {
    const [record] = await db
      .select({
        normalizedKey: songFingerprint.normalizedKey,
        canonicalSheetId: songFingerprint.canonicalSheetId,
        versionCount: songFingerprint.versionCount,
        canonicalQualityScore: sheet.qualityScore,
      })
      .from(songFingerprint)
      .leftJoin(sheet, eq(songFingerprint.canonicalSheetId, sheet.id))
      .where(eq(songFingerprint.normalizedKey, normalizedKey))
      .limit(1);

    if (!record) {
      return null;
    }

    return {
      normalizedKey: record.normalizedKey,
      canonicalSheetId: record.canonicalSheetId,
      versionCount: record.versionCount,
      canonicalQualityScore: record.canonicalQualityScore,
    };
  }

  async function getJobBySourceUrl(
    sourceUrl: string,
  ): Promise<{ status: string; sheetId: string | null } | null> {
    const [record] = await db
      .select({
        status: pipelineJob.status,
        sheetId: pipelineJob.outputSheetId,
      })
      .from(pipelineJob)
      .where(eq(pipelineJob.sourceUrl, sourceUrl))
      .limit(1);

    return record ?? null;
  }

  async function saveJobStatus(event: SaveJobStatusEvent): Promise<void> {
    const [existing] = await db
      .select({ id: pipelineJob.id, attemptCount: pipelineJob.attemptCount })
      .from(pipelineJob)
      .where(eq(pipelineJob.sourceUrl, event.sourceUrl))
      .limit(1);

    const payload = {
      sourceUrl: event.sourceUrl,
      sourceSite: event.sourceSite,
      rawTitle: event.rawTitle,
      normalizedTitle: event.normalizedTitle,
      normalizedArtist: event.normalizedArtist,
      metadataConfidence: event.metadataConfidence,
      status: event.status,
      qualityScore: event.qualityScore,
      rubricVersion: event.rubricVersion,
      rejectionReason: event.rejectionReason,
      outputSheetId: event.sheetId,
      lastError: event.lastError,
      processedAt: terminalStatus(event.status) ? new Date() : undefined,
    };

    if (!existing) {
      await db.insert(pipelineJob).values({
        ...payload,
        attemptCount: event.status === "failed" ? 1 : 0,
      });
      return;
    }

    await db
      .update(pipelineJob)
      .set({
        ...payload,
        attemptCount:
          event.status === "failed"
            ? existing.attemptCount + 1
            : existing.attemptCount,
      })
      .where(eq(pipelineJob.id, existing.id));
  }

  async function insertSheet(input: {
    slug: string;
    title: string;
    artistId: string;
    genreId: string;
    difficultyId: string;
    bpm: number;
    durationSeconds: number;
    noteCount: number;
    notesPerSecond: number;
    sheetData: string;
    qualityScore: number;
    isCanonical: boolean;
    canonicalSheetId: string | null;
    youtubeUrl?: string;
    thumbnailUrl: string;
    source: string;
    sourceUrl: string;
    tips?: string[] | null;
    isAutoGenerated: boolean;
    metadataConfidence: "high" | "medium" | "low";
    isPublished: boolean;
    needsReview: boolean;
  }): Promise<{ id: string; slug: string }> {
    const [inserted] = await db
      .insert(sheet)
      .values({
        slug: input.slug,
        title: input.title,
        artistId: input.artistId,
        genreId: input.genreId,
        difficultyId: input.difficultyId,
        bpm: input.bpm,
        durationSeconds: input.durationSeconds,
        noteCount: input.noteCount,
        notesPerSecond: input.notesPerSecond,
        sheetData: input.sheetData,
        qualityScore: input.qualityScore,
        isCanonical: input.isCanonical,
        canonicalSheetId: input.canonicalSheetId,
        youtubeUrl: input.youtubeUrl,
        thumbnailUrl: input.thumbnailUrl,
        source: input.source,
        sourceUrl: input.sourceUrl,
        tips: input.tips ?? null,
        isAutoGenerated: input.isAutoGenerated,
        metadataConfidence: input.metadataConfidence,
        isPublished: input.isPublished,
        needsReview: input.needsReview,
      })
      .returning({ id: sheet.id, slug: sheet.slug });

    return inserted;
  }

  async function updateFingerprint(update: {
    normalizedKey: string;
    canonicalSheetId: string;
    versionCount: number;
  }): Promise<void> {
    const existing = await findFingerprintByKey(update.normalizedKey);

    if (!existing) {
      await db.insert(songFingerprint).values({
        normalizedKey: update.normalizedKey,
        canonicalSheetId: update.canonicalSheetId,
        versionCount: update.versionCount,
      });
      return;
    }

    await db
      .update(songFingerprint)
      .set({
        canonicalSheetId: update.canonicalSheetId,
        versionCount: update.versionCount,
        updatedAt: new Date(),
      })
      .where(eq(songFingerprint.normalizedKey, update.normalizedKey));
  }

  async function revalidatePaths(paths: string[]): Promise<void> {
    if (!siteUrl || !revalidationSecret || paths.length === 0) {
      return;
    }

    const response = await fetchImpl(`${siteUrl}/api/revalidate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${revalidationSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ paths }),
    });

    if (!response.ok) {
      throw new Error(
        `ISR revalidation failed with status ${response.status}.`,
      );
    }
  }

  async function getSheetForAiEnrichment(
    sheetId: string,
  ): Promise<SheetAiRecord | null> {
    const [record] = await db
      .select({
        sheetId: sheet.id,
        title: sheet.title,
        artistName: artist.name,
        genreName: genre.name,
        difficultyLabel: difficulty.label,
        sheetData: sheet.sheetData,
        qualityScore: sheet.qualityScore,
        tips: sheet.tips,
      })
      .from(sheet)
      .innerJoin(artist, eq(sheet.artistId, artist.id))
      .innerJoin(genre, eq(sheet.genreId, genre.id))
      .innerJoin(difficulty, eq(sheet.difficultyId, difficulty.id))
      .where(eq(sheet.id, sheetId))
      .limit(1);

    if (!record || typeof record.qualityScore !== "number") {
      return null;
    }

    return {
      sheetId: record.sheetId,
      title: record.title,
      artistName: record.artistName,
      genreName: record.genreName,
      difficultyLabel: record.difficultyLabel,
      sheetData: record.sheetData,
      qualityScore: record.qualityScore,
      tips: Array.isArray(record.tips)
        ? record.tips.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
    };
  }

  async function updateSheetAiMetadata(update: {
    sheetId: string;
    seoTitle: string;
    seoDescription: string;
    tips: string[];
  }): Promise<void> {
    await db
      .update(sheet)
      .set({
        seoTitle: update.seoTitle,
        seoDescription: update.seoDescription,
        tips: update.tips,
        updatedAt: new Date(),
      })
      .where(eq(sheet.id, update.sheetId));
  }

  async function listJobs(filters: {
    source?: string;
    status?: string;
    limit: number;
  }): Promise<
    Array<{
      sourceUrl: string;
      sourceSite: string | null;
      rawTitle: string | null;
      normalizedArtist: string | null;
    }>
  > {
    const validatedStatus: CatalogStatusFilter | undefined =
      filters.status && isCatalogStatusFilter(filters.status)
        ? filters.status
        : undefined;

    const conditions = [
      filters.source ? eq(pipelineJob.sourceSite, filters.source) : undefined,
      validatedStatus
        ? buildCatalogStatusCondition(validatedStatus)
        : undefined,
    ].filter(Boolean);

    const rows = await db
      .select({
        sourceUrl: pipelineJob.sourceUrl,
        sourceSite: pipelineJob.sourceSite,
        rawTitle: pipelineJob.rawTitle,
        normalizedArtist: pipelineJob.normalizedArtist,
      })
      .from(pipelineJob)
      .leftJoin(sheet, eq(pipelineJob.outputSheetId, sheet.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(pipelineJob.createdAt))
      .limit(filters.limit);

    return rows;
  }

  async function getStats(): Promise<StatsSummary> {
    const [jobsSummary] = await db
      .select({
        totalJobs: sql<number>`count(*)`,
        published: sql<number>`count(*) filter (where ${pipelineJob.status} = 'published' and coalesce(${sheet.isPublished}, false) = true and coalesce(${sheet.needsReview}, false) = false)`,
        rejected: sql<number>`count(*) filter (where ${pipelineJob.status} = 'rejected')`,
        failed: sql<number>`count(*) filter (where ${pipelineJob.status} = 'failed')`,
        averageQualityScore: sql<number>`coalesce(avg(${pipelineJob.qualityScore}), 0)`,
      })
      .from(pipelineJob)
      .leftJoin(sheet, eq(pipelineJob.outputSheetId, sheet.id));

    const [reviewSummary] = await db
      .select({ reviewQueue: sql<number>`count(*)` })
      .from(sheet)
      .where(eq(sheet.needsReview, true));

    const rejectionRows = await db
      .select({
        reason: pipelineJob.rejectionReason,
        count: sql<number>`count(*)`,
      })
      .from(pipelineJob)
      .where(sql`${pipelineJob.rejectionReason} is not null`)
      .groupBy(pipelineJob.rejectionReason)
      .orderBy(desc(sql<number>`count(*)`));

    return {
      totalJobs: Number(jobsSummary?.totalJobs ?? 0),
      published: Number(jobsSummary?.published ?? 0),
      reviewQueue: Number(reviewSummary?.reviewQueue ?? 0),
      rejected: Number(jobsSummary?.rejected ?? 0),
      failed: Number(jobsSummary?.failed ?? 0),
      averageQualityScore: Number(
        Number(jobsSummary?.averageQualityScore ?? 0).toFixed(6),
      ),
      reasons: Object.fromEntries(
        rejectionRows.map((row) => [
          row.reason ?? "unknown",
          Number(row.count),
        ]),
      ),
    };
  }

  async function seedReferenceData(): Promise<SeedSummary> {
    const difficultySeed = [
      {
        slug: "beginner",
        label: "Beginner",
        level: 1,
        colorHex: "#34D399",
        description: "Foundational songs and simple patterns.",
      },
      {
        slug: "intermediate",
        label: "Intermediate",
        level: 2,
        colorHex: "#F59E0B",
        description: "Balanced challenge with moderate jumps and chords.",
      },
      {
        slug: "advanced",
        label: "Advanced",
        level: 3,
        colorHex: "#F97316",
        description: "Fast passages, wider jumps, and denser timing.",
      },
      {
        slug: "expert",
        label: "Expert",
        level: 4,
        colorHex: "#EF4444",
        description: "High-density arrangements for practiced players.",
      },
    ] as const;
    const genreSeed = [
      {
        slug: "soundtrack",
        name: "Soundtrack",
        description: "Film, game, and orchestral themes.",
        displayOrder: 1,
      },
      {
        slug: "anime",
        name: "Anime",
        description: "Anime openings, endings, and themes.",
        displayOrder: 2,
      },
      {
        slug: "classical",
        name: "Classical",
        description: "Piano, orchestral, and chamber repertoire.",
        displayOrder: 3,
      },
    ] as const;

    for (const item of difficultySeed) {
      await db
        .insert(difficulty)
        .values(item)
        .onConflictDoUpdate({
          target: difficulty.slug,
          set: {
            label: item.label,
            level: item.level,
            colorHex: item.colorHex,
            description: item.description,
          },
        });
    }

    for (const item of genreSeed) {
      await db
        .insert(genre)
        .values(item)
        .onConflictDoUpdate({
          target: genre.slug,
          set: {
            name: item.name,
            description: item.description,
            displayOrder: item.displayOrder,
          },
        });
    }

    return {
      difficulties: difficultySeed.length,
      genres: genreSeed.length,
    };
  }

  async function getCatalogSourceUrlsByStatus(
    status: string,
  ): Promise<string[]> {
    if (!isCatalogStatusFilter(status)) {
      return [];
    }

    const rows = await db
      .select({ sourceUrl: pipelineJob.sourceUrl })
      .from(pipelineJob)
      .leftJoin(sheet, eq(pipelineJob.outputSheetId, sheet.id))
      .where(buildCatalogStatusCondition(status))
      .orderBy(desc(pipelineJob.createdAt));

    return rows.map((row) => row.sourceUrl);
  }

  async function close(): Promise<void> {
    if (!ownsDbClient) {
      return;
    }

    await db.$client.end({ timeout: 5 });
  }

  return {
    db,
    genres: genreRows.map(mapGenreRecord),
    difficulties: difficultyRows.map(mapDifficultyRecord),
    getExistingArtistNames,
    findArtistByNormalizedName,
    createArtist,
    findFingerprintByKey,
    getJobBySourceUrl,
    saveJobStatus,
    insertSheet,
    updateFingerprint,
    revalidatePaths,
    getSheetForAiEnrichment,
    updateSheetAiMetadata,
    listJobs,
    getStats,
    seedReferenceData,
    getCatalogSourceUrlsByStatus,
    close,
  };
}
