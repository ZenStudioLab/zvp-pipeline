import {
  arrangement,
  artist,
  createDbClient,
  difficulty,
  genre,
  pipelineJob,
  sheet,
  sheetAsset,
  songFingerprint,
  work,
  type ZenDatabase,
} from "@zen/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import type {
  ArtistRecord,
  DifficultyRecord,
  GenreRecord,
} from "../stages/types.js";
import type { DifficultyLevel } from "@zen/midi-to-vp";
import {
  selectWorkCanonicalSheet,
  type SourceDifficultyLabel,
  type WorkCanonicalInput,
} from "../stages/canonical-selector.js";

type PersistedPipelineStatus =
  | "pending"
  | "converting"
  | "scoring"
  | "dedup"
  | "published"
  | "rejected"
  | "failed";
type CatalogStatusFilter = PersistedPipelineStatus | "needs_review";

type PipelineState = "queued" | "running" | "published" | "rejected" | "failed";
type PipelinePhase =
  | "normalize"
  | "convert"
  | "score"
  | "dedup"
  | "publish"
  | "canonical_refresh"
  | "revalidate"
  | null;

type PipelineJobRecord = {
  id: string;
  status: PersistedPipelineStatus;
  state: PipelineState;
  phase: PipelinePhase;
  sheetId: string | null;
  processedAt: Date | null;
  stateStartedAt: Date | null;
  phaseStartedAt: Date | null;
};

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
  disableRevalidation?: boolean;
  allowMissingReferenceData?: boolean;
};

type SaveJobStatusEvent = {
  sourceUrl: string;
  status: PersistedPipelineStatus;
  state?: PipelineState;
  phase?: PipelinePhase;
  sheetId?: string | null;
  normalizedTitle?: string;
  normalizedArtist?: string;
  metadataConfidence?: "high" | "medium" | "low";
  qualityScore?: number;
  rubricVersion?: string;
  qualityReasons?: string[];
  rejectionReason?: string;
  lastError?: string;
  sourceSite?: string;
  rawTitle?: string;
  stateReason?: string;
  stateContext?: Record<string, unknown> | null;
  phaseContext?: Record<string, unknown> | null;
  errorReason?: string;
  errorContext?: Record<string, unknown> | null;
  forcedAt?: Date | null;
  forceReason?: string | null;
  forceContext?: Record<string, unknown> | null;
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

type SourceItemInventoryWarning = {
  kind: "stale_running" | "legacy_unfinished";
  sourceUrl: string;
  status: string;
  state: PipelineState;
  phase: PipelinePhase;
  processedAt: Date | null;
  phaseStartedAt: Date | null;
};

type SourceItemInventory = {
  queued: number;
  running: number;
  failed: number;
  rejected: number;
  published: number;
  stranded: number;
  stale: number;
  warnings: SourceItemInventoryWarning[];
};

type RecoveryResult = {
  requeued: number;
  sourceUrls: string[];
};

type ForcedSourceItem = {
  id: string;
  sourceUrl: string;
  sourceSite: string | null;
  rawTitle: string | null;
  workId: string | null;
  arrangementId: string | null;
  sourceDifficultyLabel: string | null;
  bucket: string;
  objectPath: string;
  state: PipelineState;
  phase: PipelinePhase;
  phaseStartedAt: Date | null;
};

const STALE_PHASE_THRESHOLD_MS = 15 * 60 * 1000;

const MISSING_REFERENCE_DATA_ERROR =
  "Pipeline reference data is missing. Run 'node dist/cli.js seed' to seed genres and difficulties before running the pipeline.";

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

function statusToState(status: PersistedPipelineStatus): PipelineState {
  if (status === "pending") {
    return "queued";
  }

  if (status === "published") {
    return "published";
  }

  if (status === "rejected") {
    return "rejected";
  }

  if (status === "failed") {
    return "failed";
  }

  return "running";
}

function statusToPhase(status: PersistedPipelineStatus): PipelinePhase {
  if (status === "converting") {
    return "convert";
  }

  if (status === "scoring") {
    return "score";
  }

  if (status === "dedup") {
    return "dedup";
  }

  if (status === "published") {
    return "publish";
  }

  return null;
}

function legacyStateReason(status: PersistedPipelineStatus): string | undefined {
  if (status === "pending") {
    return "legacy_pending";
  }

  if (status === "converting" || status === "scoring" || status === "dedup") {
    return `legacy_${status}`;
  }

  return undefined;
}

function isLegacyIntermediateStatus(status: string | null | undefined): boolean {
  return status === "converting" || status === "scoring" || status === "dedup";
}

function phaseFromLegacyStatus(status: string | null | undefined): PipelinePhase {
  if (status === "converting") {
    return "convert";
  }

  if (status === "scoring") {
    return "score";
  }

  if (status === "dedup") {
    return "dedup";
  }

  if (status === "published") {
    return "publish";
  }

  return null;
}

function isStrandedLegacyRow(row: {
  status: string;
  state?: string | null;
  phase?: string | null;
  processedAt?: Date | null;
}): boolean {
  return isLegacyIntermediateStatus(row.status) && row.processedAt === null;
}

function isStaleRunningJob(row: {
  state?: string | null;
  phaseStartedAt?: Date | null | undefined;
}, now = new Date()): boolean {
  return (
    row.state === "running" &&
    row.phaseStartedAt != null &&
    now.getTime() - row.phaseStartedAt.getTime() > STALE_PHASE_THRESHOLD_MS
  );
}

function mapInventoryState(status: string, state: PipelineState | null): PipelineState {
  if (state) {
    return state;
  }

  if (status === "pending") {
    return "queued";
  }

  if (status === "converting" || status === "scoring" || status === "dedup") {
    return "running";
  }

  if (status === "published") {
    return "published";
  }

  if (status === "rejected") {
    return "rejected";
  }

  return "failed";
}

function mapInventoryPhase(status: string, phase: PipelinePhase): PipelinePhase {
  return phase ?? phaseFromLegacyStatus(status);
}

function mapLegacyJobRow(record: {
  id: string;
  status: string;
  state: PipelineState | null;
  phase: PipelinePhase;
  sheetId: string | null;
  processedAt: Date | null;
  stateStartedAt: Date | null;
  phaseStartedAt: Date | null;
}): PipelineJobRecord {
  const status = record.status as PersistedPipelineStatus;
  const inferredState = record.state ?? statusToState(status);
  const inferredPhase = record.phase ?? phaseFromLegacyStatus(status);
  const legacyIntermediate =
    isLegacyIntermediateStatus(record.status) && record.processedAt === null;

  return {
    ...record,
    status,
    state: legacyIntermediate && inferredState === "queued" ? "running" : inferredState,
    phase: inferredPhase,
    processedAt: record.processedAt,
    stateStartedAt: record.stateStartedAt ?? null,
    phaseStartedAt: record.phaseStartedAt ?? null,
  };
}

function isTruthyEnvValue(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function isCatalogStatusFilter(value: string): value is CatalogStatusFilter {
  return (VALID_CATALOG_STATUS_FILTERS as readonly string[]).includes(value);
}

function buildCatalogStatusCondition(status: CatalogStatusFilter) {
  if (status === "needs_review") {
    return and(
      eq(pipelineJob.state, "published"),
      eq(sheet.needsReview, true),
    );
  }

  if (status === "published") {
    return and(
      eq(pipelineJob.state, "published"),
      eq(sheet.needsReview, false),
    );
  }

  if (status === "pending") {
    return and(
      eq(pipelineJob.state, "queued"),
      sql`(${pipelineJob.status} not in ('converting','scoring','dedup') or ${pipelineJob.processedAt} is not null)`,
    );
  }

  if (status === "converting" || status === "scoring" || status === "dedup") {
    const phase =
      status === "converting"
        ? "convert"
        : status === "scoring"
          ? "score"
          : "dedup";
    return and(eq(pipelineJob.state, "running"), eq(pipelineJob.phase, phase));
  }

  return eq(pipelineJob.state, status);
}

function buildSourceItemsStateCondition(status: string) {
  if (status === "pending") {
    return eq(pipelineJob.state, "queued");
  }

  if (status === "converting" || status === "scoring" || status === "dedup") {
    const phase =
      status === "converting"
        ? "convert"
        : status === "scoring"
          ? "score"
          : "dedup";
    return and(eq(pipelineJob.state, "running"), eq(pipelineJob.phase, phase));
  }

  if (status === "published" || status === "rejected" || status === "failed") {
    return eq(pipelineJob.state, status);
  }

  return undefined;
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
  const disableRevalidation =
    options.disableRevalidation ??
    isTruthyEnvValue(process.env.DISABLE_REVALIDATION);
  const allowMissingReferenceData =
    options.allowMissingReferenceData ?? false;

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

  if (
    !allowMissingReferenceData &&
    (genreRows.length === 0 || difficultyRows.length === 0)
  ) {
    if (ownsDbClient) {
      try {
        await db.$client.end({ timeout: 5 });
      } catch {
        // Preserve the missing reference data failure as the primary error.
      }
    }

    throw new Error(MISSING_REFERENCE_DATA_ERROR);
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
      .onConflictDoNothing({ target: artist.slug })
      .returning();

    if (inserted) {
      return mapArtistRecord(inserted);
    }

    const [existing] = await db
      .select()
      .from(artist)
      .where(eq(artist.slug, input.slug))
      .limit(1);

    if (existing) {
      return mapArtistRecord(existing);
    }

    throw new Error(`Failed to create artist for slug: ${input.slug}`);
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
  ): Promise<PipelineJobRecord | null> {
    const [record] = await db
      .select({
        id: pipelineJob.id,
        status: pipelineJob.status,
        state: pipelineJob.state,
        phase: pipelineJob.phase,
        sheetId: pipelineJob.outputSheetId,
        processedAt: pipelineJob.processedAt,
        stateStartedAt: pipelineJob.stateStartedAt,
        phaseStartedAt: pipelineJob.phaseStartedAt,
      })
      .from(pipelineJob)
      .where(eq(pipelineJob.sourceUrl, sourceUrl))
      .limit(1);

    return record ? mapLegacyJobRow(record as PipelineJobRecord) : null;
  }

  async function findSheetBySourceUrl(
    sourceUrl: string,
  ): Promise<{ id: string; slug: string } | null> {
    const [record] = await db
      .select({
        id: sheet.id,
        slug: sheet.slug,
      })
      .from(sheet)
      .where(eq(sheet.sourceUrl, sourceUrl))
      .limit(1);

    return record ?? null;
  }

  async function saveJobStatus(event: SaveJobStatusEvent): Promise<void> {
    const [existing] = await db
      .select({
        id: pipelineJob.id,
        attemptCount: pipelineJob.attemptCount,
        state: pipelineJob.state,
        phase: pipelineJob.phase,
        stateStartedAt: pipelineJob.stateStartedAt,
        phaseStartedAt: pipelineJob.phaseStartedAt,
      })
      .from(pipelineJob)
      .where(eq(pipelineJob.sourceUrl, event.sourceUrl))
      .limit(1);

    const state = event.state ?? statusToState(event.status);
    const phase = event.phase ?? statusToPhase(event.status);
    const stateReason = event.stateReason ?? legacyStateReason(event.status);
    const now = new Date();
    const isNewRow = !existing;
    const nextStateStartedAt = isNewRow || existing?.state !== state ? now : existing.stateStartedAt ?? now;
    const nextPhaseStartedAt = phase ? (isNewRow || existing?.phase !== phase ? now : existing?.phaseStartedAt ?? now) : null;

    const payload = {
      sourceUrl: event.sourceUrl,
      sourceSite: event.sourceSite,
      rawTitle: event.rawTitle,
      normalizedTitle: event.normalizedTitle,
      normalizedArtist: event.normalizedArtist,
      metadataConfidence: event.metadataConfidence,
      status: event.status,
      state,
      phase,
      stateReason,
      stateContext: event.stateContext ?? null,
      phaseContext: event.phaseContext ?? null,
      errorReason: event.errorReason,
      errorContext: event.errorContext ?? null,
      forcedAt: event.forcedAt ?? undefined,
      forceReason: event.forceReason,
      forceContext: event.forceContext ?? null,
      qualityScore: event.qualityScore,
      rubricVersion: event.rubricVersion,
      qualityReasons: event.qualityReasons ?? null,
      rejectionReason: event.rejectionReason,
      outputSheetId: event.sheetId,
      lastError: event.lastError,
      stateStartedAt: nextStateStartedAt,
      phaseStartedAt: nextPhaseStartedAt,
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

  async function recordForcedGeneration(event: {
    id: string;
    forcedAt: Date;
    forceReason: string;
    forceContext: Record<string, unknown>;
    sheetId: string;
  }): Promise<void> {
    await db
      .update(pipelineJob)
      .set({
        forcedAt: event.forcedAt,
        forceReason: event.forceReason,
        forceContext: event.forceContext,
        outputSheetId: event.sheetId,
      })
      .where(eq(pipelineJob.id, event.id));
  }

  async function getSourceItemForForceGeneration(filters: {
    arrangementId: string;
    source?: string;
  }): Promise<ForcedSourceItem | null> {
    const [row] = await db
      .select({
        id: pipelineJob.id,
        sourceUrl: pipelineJob.sourceUrl,
        sourceSite: pipelineJob.sourceSite,
        rawTitle: pipelineJob.rawTitle,
        workId: arrangement.workId,
        arrangementId: pipelineJob.sourceItemId,
        sourceDifficultyLabel: arrangement.sourceDifficultyLabel,
        bucket: sheetAsset.bucket,
        objectPath: sheetAsset.objectPath,
        state: pipelineJob.state,
        phase: pipelineJob.phase,
        phaseStartedAt: pipelineJob.phaseStartedAt,
      })
      .from(pipelineJob)
      .innerJoin(sheetAsset, eq(pipelineJob.inputAssetId, sheetAsset.id))
      .innerJoin(arrangement, eq(arrangement.id, pipelineJob.sourceItemId))
      .where(
        and(
          eq(pipelineJob.sourceItemId, filters.arrangementId),
          filters.source ? eq(pipelineJob.sourceSite, filters.source) : sql`true`,
        ),
      )
      .orderBy(desc(pipelineJob.createdAt))
      .limit(1);

    return row ?? null;
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
    workId?: string | null;
    arrangementId?: string | null;
    sourceDifficultyLabel?: SourceDifficultyLabel | null;
    conversionLevel?: DifficultyLevel | null;
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
        workId: input.workId ?? null,
        arrangementId: input.arrangementId ?? null,
        sourceDifficultyLabel: input.sourceDifficultyLabel ?? null,
        conversionLevel: input.conversionLevel ?? null,
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

  async function promoteCanonicalFamily(input: {
    previousCanonicalSheetId: string;
    nextCanonicalSheetId: string;
  }): Promise<void> {
    await db.transaction(async (tx) => {
      const updatedAt = new Date();

      await tx
        .update(sheet)
        .set({
          isCanonical: false,
          canonicalSheetId: input.nextCanonicalSheetId,
          updatedAt,
        })
        .where(
          sql`(${sheet.id} = ${input.previousCanonicalSheetId} or ${sheet.canonicalSheetId} = ${input.previousCanonicalSheetId})`,
        );

      await tx
        .update(sheet)
        .set({
          isCanonical: true,
          canonicalSheetId: null,
          updatedAt,
        })
        .where(eq(sheet.id, input.nextCanonicalSheetId));
    });
  }

  async function revalidatePaths(paths: string[]): Promise<void> {
    if (
      disableRevalidation ||
      !siteUrl ||
      !revalidationSecret ||
      paths.length === 0
    ) {
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

  async function listFingerprintsForRerank(): Promise<
    Array<{
      normalizedKey: string;
      canonicalSheetId: string | null;
      versionCount: number;
    }>
  > {
    const rows = await db
      .select({
        normalizedKey: songFingerprint.normalizedKey,
        canonicalSheetId: songFingerprint.canonicalSheetId,
        versionCount: songFingerprint.versionCount,
      })
      .from(songFingerprint)
      .where(sql`${songFingerprint.versionCount} > 1`)
      .orderBy(asc(songFingerprint.normalizedKey));

    return rows;
  }

  async function listVersionsForFingerprint(normalizedKey: string): Promise<
    Array<{
      id: string;
      slug: string;
      qualityScore: number | null;
      ratingScore: number | null;
      ratingCount: number;
      isCanonical: boolean;
    }>
  > {
    const fingerprint = await findFingerprintByKey(normalizedKey);
    const canonicalSheetId = fingerprint?.canonicalSheetId;

    if (!canonicalSheetId) {
      return [];
    }

    const rows = await db
      .select({
        id: sheet.id,
        slug: sheet.slug,
        qualityScore: sheet.qualityScore,
        ratingScore: sheet.ratingScore,
        ratingCount: sheet.ratingCount,
        isCanonical: sheet.isCanonical,
      })
      .from(sheet)
      .where(
        and(
          eq(sheet.isPublished, true),
          sql`(${sheet.id} = ${canonicalSheetId} or ${sheet.canonicalSheetId} = ${canonicalSheetId})`,
        ),
      )
      .orderBy(desc(sheet.qualityScore), asc(sheet.createdAt));

    return rows;
  }

  async function swapCanonicalSheet(input: {
    normalizedKey: string;
    nextCanonicalSheetId: string;
    versionSheetIds: string[];
  }): Promise<void> {
    if (input.versionSheetIds.length === 0) {
      return;
    }

    await db.transaction(async (tx) => {
      const updatedAt = new Date();

      await tx
        .update(sheet)
        .set({
          isCanonical: false,
          canonicalSheetId: input.nextCanonicalSheetId,
          updatedAt,
        })
        .where(inArray(sheet.id, input.versionSheetIds));

      await tx
        .update(sheet)
        .set({
          isCanonical: true,
          canonicalSheetId: null,
          updatedAt,
        })
        .where(eq(sheet.id, input.nextCanonicalSheetId));

      await tx
        .update(songFingerprint)
        .set({
          canonicalSheetId: input.nextCanonicalSheetId,
          updatedAt,
        })
        .where(eq(songFingerprint.normalizedKey, input.normalizedKey));
    });
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
        published: sql<number>`count(*) filter (where ${pipelineJob.state} = 'published' and coalesce(${sheet.isPublished}, false) = true and coalesce(${sheet.needsReview}, false) = false)`,
        rejected: sql<number>`count(*) filter (where ${pipelineJob.state} = 'rejected')`,
        failed: sql<number>`count(*) filter (where ${pipelineJob.state} = 'failed')`,
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

  async function findAssetBySha256(
    sha256: string,
  ): Promise<{ id: string; publicUrl: string | null } | null> {
    const [record] = await db
      .select({ id: sheetAsset.id, publicUrl: sheetAsset.publicUrl })
      .from(sheetAsset)
      .where(eq(sheetAsset.sha256, sha256))
      .limit(1);
    return record ?? null;
  }

  async function insertAssetRecord(input: {
    arrangementId: string | null;
    assetType: "original_midi";
    storageProvider: string;
    bucket: string;
    objectPath: string;
    publicUrl: string | null;
    mimeType: string;
    byteSize: bigint;
    sha256: string;
  }): Promise<{ id: string }> {
    const [inserted] = await db
      .insert(sheetAsset)
      .values({
        arrangementId: input.arrangementId,
        assetType: input.assetType,
        storageProvider: input.storageProvider,
        bucket: input.bucket,
        objectPath: input.objectPath,
        publicUrl: input.publicUrl,
        mimeType: input.mimeType,
        byteSize: input.byteSize,
        sha256: input.sha256,
      })
      .returning({ id: sheetAsset.id });
    return inserted;
  }

  async function listJobsWithAssets(filters: {
    source?: string;
    status?: string;
    limit: number;
  }): Promise<
    Array<{
      sourceUrl: string;
      sourceSite: string | null;
      rawTitle: string | null;
      arrangementId: string | null;
      workId: string | null;
      sourceDifficultyLabel: string | null;
      bucket: string;
      objectPath: string;
      storageProvider: string | null;
    }>
  > {
    const conditions = [
      filters.source ? eq(pipelineJob.sourceSite, filters.source) : undefined,
      filters.status ? buildSourceItemsStateCondition(filters.status) : undefined,
    ].filter(Boolean);

    const rows = await db
      .select({
        sourceUrl: pipelineJob.sourceUrl,
        sourceSite: pipelineJob.sourceSite,
        rawTitle: pipelineJob.rawTitle,
        status: pipelineJob.status,
        state: pipelineJob.state,
        phase: pipelineJob.phase,
        processedAt: pipelineJob.processedAt,
        arrangementId: pipelineJob.sourceItemId,
        workId: arrangement.workId,
        sourceDifficultyLabel: arrangement.sourceDifficultyLabel,
        bucket: sheetAsset.bucket,
        objectPath: sheetAsset.objectPath,
        storageProvider: sheetAsset.storageProvider,
      })
      .from(pipelineJob)
      .innerJoin(sheetAsset, eq(pipelineJob.inputAssetId, sheetAsset.id))
      .leftJoin(arrangement, eq(arrangement.id, pipelineJob.sourceItemId))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(pipelineJob.createdAt))
      .limit(filters.limit);

    return rows.filter((row) => !isStrandedLegacyRow(row));
  }

  async function getSourceItemInventory(filters: {
    source?: string;
  } = {}): Promise<SourceItemInventory> {
    const rows = await db
      .select({
        sourceUrl: pipelineJob.sourceUrl,
        status: pipelineJob.status,
        state: pipelineJob.state,
        phase: pipelineJob.phase,
        processedAt: pipelineJob.processedAt,
        phaseStartedAt: pipelineJob.phaseStartedAt,
      })
      .from(pipelineJob)
      .where(filters.source ? eq(pipelineJob.sourceSite, filters.source) : undefined);

    const now = new Date();
    const inventory: SourceItemInventory = {
      queued: 0,
      running: 0,
      failed: 0,
      rejected: 0,
      published: 0,
      stranded: 0,
      stale: 0,
      warnings: [],
    };

    for (const row of rows) {
      const state = mapInventoryState(row.status, row.state);
      const phase = mapInventoryPhase(row.status, row.phase);
      const legacyStranded = isStrandedLegacyRow(row);
      const stale = isStaleRunningJob(row, now);

      if (legacyStranded) {
        inventory.stranded += 1;
        inventory.warnings.push({
          kind: "legacy_unfinished",
          sourceUrl: row.sourceUrl,
          status: row.status,
          state: "running",
          phase,
          processedAt: row.processedAt ?? null,
          phaseStartedAt: row.phaseStartedAt ?? null,
        });
        continue;
      }

      inventory[state] += 1;

      if (stale) {
        inventory.stranded += 1;
        inventory.stale += 1;
        inventory.warnings.push({
          kind: "stale_running",
          sourceUrl: row.sourceUrl,
          status: row.status,
          state,
          phase,
          processedAt: row.processedAt ?? null,
          phaseStartedAt: row.phaseStartedAt ?? null,
        });
      }
    }

    return inventory;
  }

  async function requeueFailedJobs(filters: { source?: string } = {}): Promise<RecoveryResult> {
    const rows = await db
      .select({
        id: pipelineJob.id,
        sourceUrl: pipelineJob.sourceUrl,
        status: pipelineJob.status,
        state: pipelineJob.state,
        phase: pipelineJob.phase,
        processedAt: pipelineJob.processedAt,
        phaseStartedAt: pipelineJob.phaseStartedAt,
      })
      .from(pipelineJob)
      .where(
        and(
          eq(pipelineJob.state, "failed"),
          filters.source ? eq(pipelineJob.sourceSite, filters.source) : sql`true`,
        ),
      );

    const now = new Date();
    const sourceUrls: string[] = [];

    for (const row of rows) {
      sourceUrls.push(row.sourceUrl);

      await db
        .update(pipelineJob)
        .set({
          status: "pending",
          state: "queued",
          phase: null,
          stateReason: "retry_failed",
          stateContext: { operatorAction: "retry_failed" },
          phaseContext: null,
          errorReason: null,
          errorContext: null,
          lastError: null,
          stateStartedAt: now,
          phaseStartedAt: null,
          processedAt: null,
        })
        .where(eq(pipelineJob.id, row.id));
    }

    return { requeued: rows.length, sourceUrls };
  }

  async function requeueStrandedJobs(filters: { source?: string } = {}): Promise<RecoveryResult> {
    const rows = await db
      .select({
        id: pipelineJob.id,
        sourceUrl: pipelineJob.sourceUrl,
        status: pipelineJob.status,
        state: pipelineJob.state,
        phase: pipelineJob.phase,
        processedAt: pipelineJob.processedAt,
        phaseStartedAt: pipelineJob.phaseStartedAt,
      })
      .from(pipelineJob)
      .where(
        filters.source ? eq(pipelineJob.sourceSite, filters.source) : undefined,
      );

    const now = new Date();
    const eligibleRows = rows.filter(
      (row) => isStaleRunningJob(row, now) || isStrandedLegacyRow(row),
    );

    for (const row of eligibleRows) {
      await db
        .update(pipelineJob)
        .set({
          status: "pending",
          state: "queued",
          phase: null,
          stateReason: "requeue_stranded",
          stateContext: { operatorAction: "requeue_stranded" },
          phaseContext: null,
          errorReason: null,
          errorContext: null,
          lastError: null,
          stateStartedAt: now,
          phaseStartedAt: null,
          processedAt: null,
        })
        .where(eq(pipelineJob.id, row.id));
    }

    return {
      requeued: eligibleRows.length,
      sourceUrls: eligibleRows.map((row) => row.sourceUrl),
    };
  }

  /**
   * Recompute and persist the work-level canonical imported sheet reference.
   *
   * Queries all arrangement-linked sheets for the work that have full provenance
   * (arrangement_id, conversion_level, and source_difficulty_label all non-null),
   * runs selectWorkCanonicalSheet, and updates work.canonical_sheet_id with the
   * winning sheet id (or clears it if no eligible canonical sheet exists).
   *
   * Must be called after any imported sheet create/update/delete for the work.
   */
  async function updateWorkCanonicalSheet(workId: string): Promise<void> {
    // Fetch all arrangement-linked sheets with ranking metadata from arrangement.
    const rows = await db
      .select({
        id: sheet.id,
        arrangementId: sheet.arrangementId,
        conversionLevel: sheet.conversionLevel,
        sourceDifficultyLabel: sheet.sourceDifficultyLabel,
        sourceViewCount: arrangement.sourceViewCount,
        sourceRatingCount: arrangement.sourceRatingCount,
        sourceRatingScore: arrangement.sourceRatingScore,
        arrangementCreatedAt: arrangement.createdAt,
      })
      .from(sheet)
      .innerJoin(arrangement, eq(arrangement.id, sheet.arrangementId))
      .where(
        and(
          eq(sheet.workId, workId),
          sql`${sheet.arrangementId} IS NOT NULL`,
          sql`${sheet.conversionLevel} IS NOT NULL`,
          sql`${sheet.sourceDifficultyLabel} IS NOT NULL`,
        ),
      );

    // Accumulate per-arrangement: collect available conversion levels and
    // a map of conversionLevel → sheetId so we can resolve the winner later.
    type Accumulator = WorkCanonicalInput & {
      sheetsByLevel: Map<string, string>;
    };

    const byArrangement = new Map<string, Accumulator>();

    for (const row of rows) {
      if (!row.arrangementId || !row.conversionLevel) continue;
      const label = row.sourceDifficultyLabel;
      if (
        label !== "Beginner" &&
        label !== "Intermediate" &&
        label !== "Advanced"
      )
        continue;

      const existing = byArrangement.get(row.arrangementId);
      if (existing) {
        (existing.availableConversionLevels as DifficultyLevel[]).push(
          row.conversionLevel as DifficultyLevel,
        );
        existing.sheetsByLevel.set(row.conversionLevel, row.id);
      } else {
        byArrangement.set(row.arrangementId, {
          arrangementId: row.arrangementId,
          sourceDifficultyLabel: label as SourceDifficultyLabel,
          sourceViewCount: row.sourceViewCount,
          sourceRatingCount: row.sourceRatingCount,
          sourceRatingScore: row.sourceRatingScore,
          createdAt: row.arrangementCreatedAt,
          availableConversionLevels: [row.conversionLevel as DifficultyLevel],
          sheetsByLevel: new Map([[row.conversionLevel, row.id]]),
        });
      }
    }

    const inputs: WorkCanonicalInput[] = [...byArrangement.values()];
    const winner = selectWorkCanonicalSheet(inputs);

    // No eligible canonical sheet — clear the persisted reference.
    if (!winner) {
      console.log(
        JSON.stringify({
          event: "canonical_sheet_cleared",
          workId,
          candidateCount: inputs.length,
          reason: "no_eligible_canonical_sheet",
        }),
      );
      await db
        .update(work)
        .set({ canonicalSheetId: null, updatedAt: new Date() })
        .where(eq(work.id, workId));
      return;
    }

    const winnerEntry = byArrangement.get(winner.arrangementId);
    const winnerSheetId = winnerEntry?.sheetsByLevel.get(winner.conversionLevel);
    if (!winnerSheetId) {
      // This branch means selectWorkCanonicalSheet returned a (arrangementId,
      // conversionLevel) pair that is not present in the in-memory accumulator
      // built from the same query.  That is only possible if the sheet rows
      // changed between our SELECT and this resolution step (concurrent write),
      // or if the selector has a bug.  Rather than silently leaving a stale
      // canonical_sheet_id, surface this as an explicit error so it is visible
      // in logs and can be retried or investigated.
      throw new Error(
        `updateWorkCanonicalSheet: winner (arrangementId=${winner.arrangementId}, ` +
          `conversionLevel=${winner.conversionLevel}) not found in accumulator ` +
          `for workId=${workId}. Possible concurrent-write race or selector inconsistency.`,
      );
    }

    // Infer which resolution branch was used:
    //   Phase 1 — an Adept variant existed; winner.conversionLevel is "Adept".
    //   Phase 2 — no Adept existed; conversionLevel is an arrangement-level fallback.
    const branch =
      winner.conversionLevel === "Adept" ? "phase1_adept" : "phase2_fallback";

    console.log(
      JSON.stringify({
        event: "canonical_sheet_selected",
        workId,
        branch,
        arrangementId: winner.arrangementId,
        conversionLevel: winner.conversionLevel,
        candidateCount: inputs.length,
        winnerSheetId,
      }),
    );

    await db
      .update(work)
      .set({ canonicalSheetId: winnerSheetId, updatedAt: new Date() })
      .where(eq(work.id, workId));
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
    findSheetBySourceUrl,
    saveJobStatus,
    insertSheet,
    promoteCanonicalFamily,
    updateFingerprint,
    revalidatePaths,
    getSourceItemForForceGeneration,
    getSheetForAiEnrichment,
    updateSheetAiMetadata,
    listFingerprintsForRerank,
    listVersionsForFingerprint,
    swapCanonicalSheet,
    listJobs,
    getStats,
    getSourceItemInventory,
    requeueFailedJobs,
    requeueStrandedJobs,
    seedReferenceData,
    getCatalogSourceUrlsByStatus,
    findAssetBySha256,
    insertAsset: insertAssetRecord,
    listJobsWithAssets,
    updateWorkCanonicalSheet,
    recordForcedGeneration,
    close,
  };
}
