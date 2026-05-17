import { publishSheet } from "../stages/publisher.js";
import type { PipelineStatus } from "./logger.js";
import type {
  ArtistRecord,
  DifficultyRecord,
  FingerprintRecord,
  GenreRecord,
} from "../stages/types.js";
import type { DifficultyLevel } from "@zen/midi-to-vp";
import type { SourceDifficultyLabel } from "../stages/canonical-selector.js";
import { evaluatePipelineStages } from "./run-stages.js";

type PipelineJobRepository = {
  genres: GenreRecord[];
  difficulties: DifficultyRecord[];
  getJobBySourceUrl(
    sourceUrl: string,
  ): Promise<{
    status: string;
    state?: string | null;
    phase?: string | null;
    sheetId: string | null;
  } | null>;
  findSheetBySourceUrl?(
    sourceUrl: string,
  ): Promise<{ id: string; slug: string } | null>;
  saveJobStatus(event: {
    sourceUrl: string;
    status: PipelineStatus;
    state?: "queued" | "running" | "published" | "rejected" | "failed";
    phase?:
      | "normalize"
      | "convert"
      | "score"
      | "dedup"
      | "publish"
      | "canonical_refresh"
      | "revalidate"
      | null;
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
    stateReason?: string;
    stateContext?: Record<string, unknown> | null;
    phaseContext?: Record<string, unknown> | null;
    errorReason?: string;
    errorContext?: Record<string, unknown> | null;
    forcedAt?: Date | null;
    forceReason?: string | null;
    forceContext?: Record<string, unknown> | null;
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
  recordForcedGeneration?: (event: {
    id: string;
    forcedAt: Date;
    forceReason: string;
    forceContext: Record<string, unknown>;
    sheetId: string;
  }) => Promise<void>;
  updateWorkCanonicalSheet?: (workId: string) => Promise<void>;
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
  forceGeneration?: {
    jobId: string;
    forcedAt: Date;
    forceReason: string;
    forceContext: Record<string, unknown>;
    publish: boolean;
  };
  /** Import provenance — set for imported jobs; omitted for local/non-imported runs. */
  workId?: string | null;
  arrangementId?: string | null;
  sourceDifficultyLabel?: SourceDifficultyLabel | null;
  conversionLevel?: DifficultyLevel | null;
};

function toLifecycle(status: PipelineStatus): {
  state: "queued" | "running" | "published" | "rejected" | "failed";
  phase: "normalize" | "convert" | "score" | "dedup" | "publish" | null;
} {
  switch (status) {
    case "pending":
      return { state: "queued", phase: null };
    case "converting":
      return { state: "running", phase: "convert" };
    case "scoring":
      return { state: "running", phase: "score" };
    case "dedup":
      return { state: "running", phase: "dedup" };
    case "published":
      return { state: "published", phase: "publish" };
    case "rejected":
      return { state: "rejected", phase: null };
    case "failed":
      return { state: "failed", phase: null };
    case "needs_review":
    case "dry_run":
      return { state: "running", phase: null };
  }
}

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
  if (existingJob?.state === "published" && existingJob.sheetId && !input.forceGeneration) {
    return {
      idempotent: true,
      outcome: "published",
      sheetId: existingJob.sheetId,
      transitions: [],
    };
  }

  if (existingJob && existingJob.state !== "published" && !input.forceGeneration) {
    const existingSheet = await repository.findSheetBySourceUrl?.(input.sourceUrl);
    if (existingSheet) {
      await repository.saveJobStatus({
        sourceUrl: input.sourceUrl,
        sourceSite: input.sourceSite,
        rawTitle: input.rawTitle,
        status: "published",
        state: "published",
        phase: "publish",
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
    const lifecycle = toLifecycle(status);
    transitions.push(status);
    await repository.saveJobStatus({
      sourceUrl: input.sourceUrl,
      status,
      state: lifecycle.state,
      phase: lifecycle.phase,
      sourceSite: input.sourceSite,
      rawTitle: input.rawTitle,
      ...payload,
    });
  };

  if (!input.forceGeneration) {
    await pushStatus("pending");
  }

  const evaluation = await evaluatePipelineStages(
    {
      rawTitle: input.rawTitle,
      rawArtist: input.rawArtist,
      youtubeUrl: input.youtubeUrl,
      file: input.file,
    },
    repository,
  );

  if (!input.forceGeneration) {
    await pushStatus("converting", {
      normalizedTitle: evaluation.normalized.title,
      normalizedArtist: evaluation.normalized.artist,
      metadataConfidence: evaluation.normalized.confidenceBand,
    });
  }

  if (!evaluation.ok) {
    if (input.forceGeneration) {
      throw new Error(`force generation requires parseable MIDI: ${evaluation.rejectionReason}`);
    }

    if (!input.forceGeneration) {
      await pushStatus("rejected", {
        rejectionReason: evaluation.rejectionReason,
      });
    }
    return {
      idempotent: false,
      outcome: "rejected",
      sheetId: null,
      transitions,
    };
  }

  if (input.forceGeneration && evaluation.conversion.noteCount === 0) {
    throw new Error("force generation requires at least one note event");
  }

  if (!input.forceGeneration) {
    await pushStatus("scoring", {
      qualityScore: evaluation.qualityAssessment.score,
      rubricVersion: evaluation.qualityAssessment.rubricVersion,
      qualityReasons: evaluation.qualityAssessment.reasons,
    });
  }

  if (!input.forceGeneration) {
    await pushStatus("dedup");
  }

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
      dryRun: input.forceGeneration ? !input.forceGeneration.publish : input.dryRun,
      generationMode: input.forceGeneration ? "forced" : "standard",
      forcePublish: input.forceGeneration ? input.forceGeneration.publish : false,
      forcedAt: input.forceGeneration?.forcedAt ?? null,
      forceReason: input.forceGeneration?.forceReason ?? null,
      forceContext: input.forceGeneration?.forceContext ?? null,
      // Import provenance — undefined for local/non-imported runs; passed through for imported jobs.
      workId: input.workId,
      arrangementId: input.arrangementId,
      sourceDifficultyLabel: input.sourceDifficultyLabel,
      conversionLevel: input.conversionLevel,
    },
    repository,
  );

  if (!input.forceGeneration) {
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
  }

  // Refresh canonical sheet pointer when an imported work was successfully published.
  if (
    published.outcome !== "rejected" &&
    input.workId &&
    published.sheetId
  ) {
    await repository.updateWorkCanonicalSheet?.(input.workId);
  }

  if (input.forceGeneration && published.sheetId) {
    await repository.recordForcedGeneration?.({
      id: input.forceGeneration.jobId,
      forcedAt: input.forceGeneration.forcedAt,
      forceReason: input.forceGeneration.forceReason,
      forceContext: input.forceGeneration.forceContext,
      sheetId: published.sheetId,
    });
  }

  return {
    idempotent: false,
    outcome: published.outcome,
    sheetId: published.sheetId,
    transitions,
  };
}
