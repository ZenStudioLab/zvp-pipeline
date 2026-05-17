// ---------------------------------------------------------------------------
// Slugify helper
// ---------------------------------------------------------------------------

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function toOptionalDate(value: string | null): Date | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toRequiredDate(value: string, fieldName: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid timestamp for ${fieldName}: ${value}`);
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkRecord = {
  id: string;
  slug: string;
  canonicalTitle: string;
  canonicalArtistName: string | null;
};

export type ArrangementRecord = {
  id: string;
  provider: string;
  providerItemId: string;
  sourceViewCount: number | null;
  sourceLikeCount: number | null;
  sourceCommentCount: number | null;
  sourceRatingScore: number | null;
  sourceRatingCount: number | null;
};

export type UpsertWorkDep = {
  findByCanonicalTitleAndArtist: (
    title: string,
    artist: string,
  ) => Promise<WorkRecord | null>;
  findBySlug: (slug: string) => Promise<{ id: string } | null>;
  insertWork: (input: {
    slug: string;
    canonicalTitle: string;
    canonicalArtistName: string | null;
    artistUrl: string | null;
    songUrl: string | null;
  }) => Promise<{ id: string }>;
};

export type UpsertArrangementDep = {
  findByProviderItem: (
    provider: string,
    providerItemId: string,
  ) => Promise<ArrangementRecord | null>;
  insertArrangement: (input: {
    workId: string;
    provider: string;
    providerItemId: string;
    sourceUrl: string;
    canonicalUrl: string | null;
    sourceTitle: string | null;
    sourceArtistName: string | null;
    uploaderName: string | null;
    uploaderUrl: string | null;
    sourceDifficultyLabel: string | null;
    sourceDifficultyRank: number | null;
    durationSecondsSource: number | null;
    bpmSource: number | null;
    sourceViewCount: number | null;
    sourceLikeCount: number | null;
    sourceCommentCount: number | null;
    sourceRatingScore: number | null;
    sourceRatingCount: number | null;
    sourcePages: string | null;
    sourceMeasures: string | null;
    sourceKey: string | null;
    sourceParts: string | null;
    sourceCredits: string | null;
    sourceUploadedAt: Date | null;
    sourceUpdatedAt: Date | null;
    sourceLicenseLabel: string | null;
    sourceLicenseUrl: string | null;
    sourcePrivacy: string | null;
    sourceTags: string[] | null;
    sourceRelatedVersions: unknown;
    rawMetadata: Record<string, unknown>;
    scrapedAt: Date;
  }) => Promise<{ id: string }>;
  updateArrangement: (
    id: string,
    input: {
      sourceViewCount: number | null;
      sourceLikeCount: number | null;
      sourceCommentCount: number | null;
      sourceRatingScore: number | null;
      sourceRatingCount: number | null;
      rawMetadata: Record<string, unknown>;
      scrapedAt: Date;
    },
  ) => Promise<void>;
};

export type EnqueuePipelineJobDep = {
  findBySourceKey: (
    sourceKey: string,
  ) => Promise<{ id: string; status: string; state?: string | null; phase?: string | null } | null>;
  insertPipelineJob: (input: {
    sourceKey: string;
    sourceUrl: string;
    sourceSite: string;
    rawTitle: string | null;
    sourceItemId: string;
    inputAssetId: string;
    status: "pending";
    state: "queued";
    phase: null;
  }) => Promise<{ id: string }>;
  updatePipelineJob: (
    id: string,
    input: {
      status: string;
      state?: string;
      phase?: string | null;
      lastError: string | null;
      stateReason?: string;
      stateContext?: Record<string, unknown> | null;
    },
  ) => Promise<void>;
};

export type MuseScoreExport = {
  provider: string;
  provider_item_id: string;
  source_site: string;
  source_url: string;
  canonical_url: string | null;
  title: string;
  artist: string;
  artist_url: string | null;
  song_url: string | null;
  uploader_name: string | null;
  uploader_url: string | null;
  difficulty_label: string | null;
  difficulty_rank: number | null;
  duration_seconds: number | null;
  bpm: number | null;
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  rating_score: number | null;
  rating_count: number | null;
  pages: string | null;
  measures: string | null;
  key: string | null;
  parts: string | null;
  credits: string | null;
  uploaded_at: string | null;
  updated_at: string | null;
  license_label: string | null;
  license_url: string | null;
  privacy: string | null;
  tags: string[] | null;
  related_versions: unknown;
  raw_metadata: Record<string, unknown>;
  scraped_at: string;
};

export type CatalogWriterResult = {
  workSlug: string;
  arrangementId: string;
  arrangementNew: boolean;
  pipelineJobId: string;
  pipelineJobNew: boolean;
};

// ---------------------------------------------------------------------------
// Catalog writer
// ---------------------------------------------------------------------------

export async function writeCatalog(
  input: MuseScoreExport,
  deps: {
    work: UpsertWorkDep;
    arrangement: UpsertArrangementDep;
    pipelineJob: EnqueuePipelineJobDep;
    sheetAssetId: string;
  },
): Promise<CatalogWriterResult> {
  // --- Upsert work ---
  const existingWork = await deps.work.findByCanonicalTitleAndArtist(
    input.title,
    input.artist,
  );

  let workId: string;
  let workSlug: string;

  if (existingWork) {
    workId = existingWork.id;
    workSlug = existingWork.slug;
  } else {
    // Generate slug with collision deduplication
    const baseSlug = slugify(input.title);
    let slug = baseSlug;
    let suffix = 2;

    while (await deps.work.findBySlug(slug)) {
      slug = `${baseSlug}-${suffix}`;
      suffix++;
    }

    const inserted = await deps.work.insertWork({
      slug,
      canonicalTitle: input.title,
      canonicalArtistName: input.artist,
      artistUrl: input.artist_url,
      songUrl: input.song_url,
    });

    workId = inserted.id;
    workSlug = slug;
  }

  // --- Upsert arrangement ---
  const provider = input.provider;
  const providerItemId = input.provider_item_id;

  const existingArrangement = await deps.arrangement.findByProviderItem(
    provider,
    providerItemId,
  );

  let arrangementId: string;
  let arrangementNew: boolean;

  if (existingArrangement) {
    // Update mutable fields
    await deps.arrangement.updateArrangement(existingArrangement.id, {
      sourceViewCount: input.view_count,
      sourceLikeCount: input.like_count,
      sourceCommentCount: input.comment_count,
      sourceRatingScore: input.rating_score,
      sourceRatingCount: input.rating_count,
      rawMetadata: input.raw_metadata,
      scrapedAt: toRequiredDate(input.scraped_at, "scraped_at"),
    });

    arrangementId = existingArrangement.id;
    arrangementNew = false;
  } else {
    const inserted = await deps.arrangement.insertArrangement({
      workId,
      provider,
      providerItemId,
      sourceUrl: input.source_url,
      canonicalUrl: input.canonical_url,
      sourceTitle: input.title,
      sourceArtistName: input.artist,
      uploaderName: input.uploader_name,
      uploaderUrl: input.uploader_url,
      sourceDifficultyLabel: input.difficulty_label,
      sourceDifficultyRank: input.difficulty_rank,
      durationSecondsSource: input.duration_seconds,
      bpmSource: input.bpm,
      sourceViewCount: input.view_count,
      sourceLikeCount: input.like_count,
      sourceCommentCount: input.comment_count,
      sourceRatingScore: input.rating_score,
      sourceRatingCount: input.rating_count,
      sourcePages: input.pages,
      sourceMeasures: input.measures,
      sourceKey: input.key,
      sourceParts: input.parts,
      sourceCredits: input.credits,
      sourceUploadedAt: toOptionalDate(input.uploaded_at),
      sourceUpdatedAt: toOptionalDate(input.updated_at),
      sourceLicenseLabel: input.license_label,
      sourceLicenseUrl: input.license_url,
      sourcePrivacy: input.privacy,
      sourceTags: input.tags,
      sourceRelatedVersions: input.related_versions,
      rawMetadata: input.raw_metadata,
      scrapedAt: toRequiredDate(input.scraped_at, "scraped_at"),
    });

    arrangementId = inserted.id;
    arrangementNew = true;
  }

  // --- Enqueue pipeline_job ---
  const sourceKey = providerItemId; // "musescore:<score_id>"
  const existingJob = await deps.pipelineJob.findBySourceKey(sourceKey);

  let pipelineJobId: string;
  let pipelineJobNew: boolean;

  if (existingJob) {
    pipelineJobId = existingJob.id;
    pipelineJobNew = false;

    // Retry failed jobs
    if (existingJob.status === "failed") {
      await deps.pipelineJob.updatePipelineJob(existingJob.id, {
        status: "pending",
        state: "queued",
        phase: null,
        lastError: null,
      });
    }
  } else {
    const inserted = await deps.pipelineJob.insertPipelineJob({
      sourceKey,
      sourceUrl: input.source_url,
      sourceSite: input.source_site,
      rawTitle: input.title,
      sourceItemId: arrangementId,
      inputAssetId: deps.sheetAssetId,
      status: "pending",
      state: "queued",
      phase: null,
    });

    pipelineJobId = inserted.id;
    pipelineJobNew = true;
  }

  return {
    workSlug,
    arrangementId,
    arrangementNew,
    pipelineJobId,
    pipelineJobNew,
  };
}
