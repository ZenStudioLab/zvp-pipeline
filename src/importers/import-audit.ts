import { importEvent, importRun } from "@zen/db";
import type { ZenDatabase } from "@zen/db";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MatchConfidence = "high" | "medium" | "low";

export type MatchReasonPayload = {
  deltaSeconds?: number;
  candidateCount?: number;
  windowConfig?: Record<string, unknown>;
  [key: string]: unknown;
};

export type CreateImportRunConfig = {
  source?: string;
  downloadDir?: string | null;
  config?: Record<string, unknown>;
};

export type CreateImportRunResult = {
  id: string;
};

export type MatchResultInput = {
  arrangementId?: string | null;
  localFilePath: string;
  fileBirthtime?: Date | string | null;
  fileCtime?: Date | string | null;
  fileMtime?: Date | string | null;
  fileName: string;
  fileSha256?: string | null;
  matchMethod?: string | null;
  matchConfidence?: number | null;
  matchReason?: MatchReasonPayload | null;
  confidenceBand: MatchConfidence;
  structuralValidationFailed?: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function determineReviewStatus(
  confidenceBand: MatchConfidence,
  structuralValidationFailed?: boolean,
): "auto_accepted" | "needs_review" {
  if (structuralValidationFailed) {
    return "needs_review";
  }
  if (confidenceBand === "high") {
    return "auto_accepted";
  }
  return "needs_review";
}

function toDateOrNull(
  value: Date | string | null | undefined,
): Date | null {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value : new Date(value);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new import run session.
 *
 * Inserts an `import_run` row with status `running` and returns the
 * generated run ID so callers can associate subsequent events with it.
 */
export async function createImportRun(
  db: ZenDatabase,
  input: CreateImportRunConfig = {},
): Promise<CreateImportRunResult> {
  const [inserted] = await db
    .insert(importRun)
    .values({
      source: input.source ?? "midi-scraper-extension",
      downloadDir: input.downloadDir ?? null,
      status: "running",
      config: input.config ?? null,
    })
    .returning({ id: importRun.id });

  return { id: inserted.id };
}

/**
 * Update an import run's terminal status.
 *
 * Sets `status` to `"completed"` or `"failed"` and records `ended_at`.
 * Defaults `endedAt` to `new Date()` when omitted.
 */
export async function updateImportRun(
  db: ZenDatabase,
  runId: string,
  status: "completed" | "failed",
  endedAt?: Date,
): Promise<void> {
  await db
    .update(importRun)
    .set({
      status,
      endedAt: endedAt ?? new Date(),
    })
    .where(eq(importRun.id, runId));
}

/**
 * Record a file-to-record match attempt as an import event.
 *
 * Sets `reviewStatus` to `"auto_accepted"` when the confidence band is
 * `"high"` and structural validation passes, otherwise `"needs_review"`.
 */
export async function createImportEvent(
  db: ZenDatabase,
  runId: string,
  matchResult: MatchResultInput,
): Promise<void> {
  await db.insert(importEvent).values({
    importRunId: runId,
    arrangementId: matchResult.arrangementId ?? null,
    localFilePath: matchResult.localFilePath,
    fileBirthtime: toDateOrNull(matchResult.fileBirthtime),
    fileCtime: toDateOrNull(matchResult.fileCtime),
    fileMtime: toDateOrNull(matchResult.fileMtime),
    fileName: matchResult.fileName,
    fileSha256: matchResult.fileSha256 ?? null,
    matchMethod: matchResult.matchMethod ?? null,
    matchConfidence: matchResult.matchConfidence ?? null,
    matchReason: matchResult.matchReason ?? null,
    reviewStatus: determineReviewStatus(
      matchResult.confidenceBand,
      matchResult.structuralValidationFailed,
    ),
  });
}
