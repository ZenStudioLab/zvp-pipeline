import { publishSheet } from "../stages/publisher.js";
import type { PipelineStatus } from "./logger.js";
import type {
  ArtistRecord,
  DifficultyRecord,
  FingerprintRecord,
  GenreRecord,
} from "../stages/types.js";
import { evaluatePipelineStages } from "./run-stages.js";

type PipelineJobRepository = {
  genres: GenreRecord[];
  difficulties: DifficultyRecord[];
  getJobBySourceUrl(
    sourceUrl: string,
  ): Promise<{ status: string; sheetId: string | null } | null>;
  findSheetBySourceUrl?(
    sourceUrl: string,
  ): Promise<{ id: string; slug: string } | null>;
  saveJobStatus(event: {
    sourceUrl: string;
    status: PipelineStatus;
    sheetId?: string | null;
    normalizedTitle?: string;
    normalizedArtist?: string;
    metadataConfidence?: "high" | "medium" | "low";
    qualityScore?: number;
    rubricVersion?: string;
    qualityReasons?: string[];
    rejectionReason?: string;
    sourceSite?: string;
    rawTitle?: string;
  }): Promise<void>;
  getExistingArtistNames(): Promise<string[]>;
  findArtistByNormalizedName(
    normalizedName: string,
  ): Promise<ArtistRecord | null>;
  createArtist(input: {
    name: string;
    slug: string;
    normalizedName: string;
  }): Promise<ArtistRecord>;
  findFingerprintByKey(
    normalizedKey: string,
  ): Promise<FingerprintRecord | null>;
  insertSheet: Parameters<typeof publishSheet>[1]["insertSheet"];
  promoteCanonicalFamily: Parameters<
    typeof publishSheet
  >[1]["promoteCanonicalFamily"];
  updateFingerprint: Parameters<typeof publishSheet>[1]["updateFingerprint"];
  revalidatePaths: Parameters<typeof publishSheet>[1]["revalidatePaths"];
};

type ProcessPipelineInput = {
  sourceUrl: string;
  sourceSite: string;
  rawTitle: string;
  rawArtist: string;
  tips?: string[];
  youtubeUrl?: string;
  file: Uint8Array | Buffer;
  dryRun: boolean;
};

export async function processPipelineJob(
  input: ProcessPipelineInput,
  repository: PipelineJobRepository,
): Promise<{
  idempotent: boolean;
  outcome: "published" | "needs_review" | "rejected" | "dry_run";
  sheetId: string | null;
  transitions: PipelineStatus[];
}> {
  const existingJob = await repository.getJobBySourceUrl(input.sourceUrl);
  if (existingJob?.status === "published" && existingJob.sheetId) {
    return {
      idempotent: true,
      outcome: "published",
      sheetId: existingJob.sheetId,
      transitions: [],
    };
  }

  if (existingJob && existingJob.status !== "published") {
    const existingSheet = await repository.findSheetBySourceUrl?.(input.sourceUrl);
    if (existingSheet) {
      await repository.saveJobStatus({
        sourceUrl: input.sourceUrl,
        sourceSite: input.sourceSite,
        rawTitle: input.rawTitle,
        status: "published",
        sheetId: existingSheet.id,
      });

      return {
        idempotent: true,
        outcome: "published",
        sheetId: existingSheet.id,
        transitions: ["published"],
      };
    }
  }

  const transitions: PipelineStatus[] = [];
  const pushStatus = async (
    status: PipelineStatus,
    payload: Omit<
      Parameters<PipelineJobRepository["saveJobStatus"]>[0],
      "sourceUrl" | "status"
    > = {},
  ) => {
    transitions.push(status);
    await repository.saveJobStatus({
      sourceUrl: input.sourceUrl,
      status,
      sourceSite: input.sourceSite,
      rawTitle: input.rawTitle,
      ...payload,
    });
  };

  await pushStatus("pending");

  const evaluation = await evaluatePipelineStages(
    {
      rawTitle: input.rawTitle,
      rawArtist: input.rawArtist,
      youtubeUrl: input.youtubeUrl,
      file: input.file,
    },
    repository,
  );

  await pushStatus("converting", {
    normalizedTitle: evaluation.normalized.title,
    normalizedArtist: evaluation.normalized.artist,
    metadataConfidence: evaluation.normalized.confidenceBand,
  });

  if (!evaluation.ok) {
    await pushStatus("rejected", {
      rejectionReason: evaluation.rejectionReason,
    });
    return {
      idempotent: false,
      outcome: "rejected",
      sheetId: null,
      transitions,
    };
  }

  await pushStatus("scoring", {
    qualityScore: evaluation.qualityAssessment.score,
    rubricVersion: evaluation.qualityAssessment.rubricVersion,
    qualityReasons: evaluation.qualityAssessment.reasons,
  });

  await pushStatus("dedup");

  const published = await publishSheet(
    {
      title: evaluation.normalized.title,
      slug: evaluation.enrichment.slug,
      artist: evaluation.enrichment.artist,
      genre: evaluation.enrichment.genre,
      difficulty: evaluation.enrichment.difficulty,
      thumbnailUrl: evaluation.enrichment.thumbnailUrl,
      sheetData: evaluation.conversion.sheetData,
      bpm: evaluation.conversion.bpm,
      durationSeconds: evaluation.conversion.durationSeconds,
      noteCount: evaluation.conversion.noteCount,
      notesPerSecond: evaluation.conversion.notesPerSecond,
      qualityScore: evaluation.qualityAssessment.score,
      confidenceScore: evaluation.normalized.confidenceScore,
      source: "pipeline",
      sourceUrl: input.sourceUrl,
      tips: input.tips,
      youtubeUrl: input.youtubeUrl,
      isCanonical: evaluation.dedupDecision.isCanonical,
      canonicalSheetId: evaluation.dedupDecision.canonicalSheetId,
      normalizedKey: evaluation.normalized.normalizedKey,
      nextVersionCount: evaluation.dedupDecision.nextVersionCount,
      dryRun: input.dryRun,
    },
    repository,
  );

  await pushStatus(
    published.outcome === "rejected" ? "rejected" : "published",
    {
      sheetId: published.sheetId,
      qualityScore: evaluation.qualityAssessment.score,
      rubricVersion: evaluation.qualityAssessment.rubricVersion,
      qualityReasons: evaluation.qualityAssessment.reasons,
      rejectionReason:
        published.outcome === "rejected" ? "low_quality" : undefined,
    },
  );

  return {
    idempotent: false,
    outcome: published.outcome,
    sheetId: published.sheetId,
    transitions,
  };
}
