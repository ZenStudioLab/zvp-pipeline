/**
 * Time-window matcher – associates scanned .mid files to export records
 * using download_started_at as the primary reference timestamp.
 *
 * @module importers/time-window-matcher
 */

import type { ScannedFile } from './download-scanner.js';
import type {
  TimingConfig,
  ImportExportRecord,
  ImportExportVariant,
  MatchResult,
  MatchConfidence,
  MatchMethod,
} from './types.js';

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_TIMING: TimingConfig = { x: 3, y: 0, z: 15 };
const HIGH_CONFIDENCE_WINDOW_SEC = 30;
const MEDIUM_CONFIDENCE_WINDOW_SEC = 60;
const SIZE_DIVERGENCE_RATIO = 5;

/** Difficulty progression order for structural validation. */
const DIFFICULTY_ORDER: Record<string, number> = {
  beginner: 1,
  easy: 1,
  beginning: 1,
  intermediate: 2,
  medium: 2,
  advanced: 3,
  hard: 3,
  expert: 3,
  'very advanced': 3,
};

// ── Internal types ───────────────────────────────────────────────────────────

interface VariantEntry {
  record: ImportExportRecord;
  variant: ImportExportVariant;
  startedAtMs: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeDifficulty(label: string): string {
  return label.toLowerCase().trim();
}

function difficultyLevel(label: string): number {
  return DIFFICULTY_ORDER[normalizeDifficulty(label)] ?? 99;
}

/** Check whether file sizes in a set diverge by more than 5×. */
function hasSizeDivergence(files: ScannedFile[]): boolean {
  if (files.length < 2) return false;
  const sizes = files.map((f) => f.byteSize).filter((s) => s > 0);
  if (sizes.length < 2) return false;
  const max = Math.max(...sizes);
  const min = Math.min(...sizes);
  return min > 0 && max / min > SIZE_DIVERGENCE_RATIO;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface MatchOutput {
  matches: MatchResult[];
  unmatchedFiles: ScannedFile[];
}

/**
 * Match scanned MIDI files to export records using download_started_at
 * as the primary reference timestamp.
 *
 * @param files       - MIDI files sorted by birthtime (from `scanDownloadDirectory`).
 * @param records     - Export records sorted by work_order.
 * @param timingConfig- Timing constants {x, y, z}.
 */
export function matchFilesToRecords(
  files: ScannedFile[],
  records: ImportExportRecord[],
  timingConfig: TimingConfig = DEFAULT_TIMING,
): MatchOutput {
  // ── 1. Flatten variants with record context ──────────────────────────
  const variantEntries: VariantEntry[] = [];

  for (const record of records) {
    for (const variant of record.variants) {
      if (variant.download_started_at === null) continue;

      const startedAtMs = new Date(variant.download_started_at).getTime();
      if (isNaN(startedAtMs)) continue;

      variantEntries.push({ record, variant, startedAtMs });
    }
  }

  // Sort by download_started_at (launch order)
  variantEntries.sort((a, b) => a.startedAtMs - b.startedAtMs);

  // ── 2. Greedy matching ──────────────────────────────────────────────
  const matchedFileIndices = new Set<number>();
  const matches: MatchResult[] = [];
  const workFileMap = new Map<number, ScannedFile[]>();

  for (const ve of variantEntries) {
    const candidates: Array<{ index: number; deltaSec: number }> = [];

    for (let i = 0; i < files.length; i++) {
      if (matchedFileIndices.has(i)) continue;
      const fileT = files[i].birthtime.getTime();
      const deltaSec = Math.abs(fileT - ve.startedAtMs) / 1000;
      candidates.push({ index: i, deltaSec });
    }

    if (candidates.length === 0) {
      // No files left to match – variant has no match
      continue;
    }

    // Pick the closest candidate
    candidates.sort((a, b) => a.deltaSec - b.deltaSec);
    const best = candidates[0];
    matchedFileIndices.add(best.index);
    const file = files[best.index];

    // Track files per work for size-divergence check
    const wf = workFileMap.get(ve.record.work_order) ?? [];
    wf.push(file);
    workFileMap.set(ve.record.work_order, wf);

    // Determine effective window: widen if siblings in same work diverge >5×
    const siblings = wf.filter((f) => f.absolutePath !== file.absolutePath);
    const widened = siblings.length > 0 && hasSizeDivergence([...siblings, file]);
    const highWindow = widened ? MEDIUM_CONFIDENCE_WINDOW_SEC : HIGH_CONFIDENCE_WINDOW_SEC;

    // Ambiguity: if a second candidate falls within the medium window, the match is not unique
    const secondBest = candidates[1];
    const ambiguous =
      secondBest !== undefined &&
      secondBest.deltaSec <= MEDIUM_CONFIDENCE_WINDOW_SEC;

    let confidence: MatchConfidence;
    let matchMethod: MatchMethod;
    let matchReason: string;
    let reviewStatus: 'needs_review' | undefined;

    if (best.deltaSec <= highWindow && !ambiguous) {
      confidence = 'high';
      matchMethod = 'time_window';
      matchReason = `1:1 match within ${Math.round(best.deltaSec * 10) / 10}s of download_started_at`;
    } else if (best.deltaSec <= MEDIUM_CONFIDENCE_WINDOW_SEC && !ambiguous) {
      confidence = 'medium';
      matchMethod = 'time_window';
      matchReason = `1:1 match within ${Math.round(best.deltaSec * 10) / 10}s (wider window)`;
    } else if (ambiguous) {
      confidence = 'low';
      matchMethod = 'order_only';
      matchReason = `${candidates.length} candidates within ${MEDIUM_CONFIDENCE_WINDOW_SEC}s window; used closest`;
      reviewStatus = 'needs_review';
    } else {
      confidence = 'low';
      matchMethod = 'time_window';
      matchReason = `Delta ${Math.round(best.deltaSec * 10) / 10}s exceeds ${MEDIUM_CONFIDENCE_WINDOW_SEC}s window`;
      reviewStatus = 'needs_review';
    }

    matches.push({
      file,
      workOrder: ve.record.work_order,
      canonicalTitle: ve.record.canonical_title,
      variant: ve.variant,
      confidence,
      matchMethod,
      matchReason,
      timeDeltaSeconds: Math.round(best.deltaSec * 10) / 10,
      reviewStatus,
    });
  }

  // ── 3. Structural validation ────────────────────────────────────────
  applyStructuralValidation(matches, workFileMap);

  // ── 4. Unmatched files ──────────────────────────────────────────────
  const unmatchedFiles = files.filter(
    (_, i) => !matchedFileIndices.has(i),
  );

  return { matches, unmatchedFiles };
}

// ── Structural validation ────────────────────────────────────────────────────

/**
 * Within each work, validate that file birthtime order follows the expected
 * difficulty progression (Beginner → Intermediate → Advanced).
 *
 * Correct order raises confidence by one level.
 * Incorrect order flags for review.
 */
function applyStructuralValidation(
  matches: MatchResult[],
  workFileMap: Map<number, ScannedFile[]>,
): void {
  // Group matches by work_order
  const workGroups = new Map<number, MatchResult[]>();
  for (const m of matches) {
    const group = workGroups.get(m.workOrder) ?? [];
    group.push(m);
    workGroups.set(m.workOrder, group);
  }

  for (const [, group] of workGroups) {
    if (group.length < 2) continue;

    // Sort by file birthtime (actual completion order)
    group.sort(
      (a, b) => a.file.birthtime.getTime() - b.file.birthtime.getTime(),
    );

    // Check difficulty progression: each subsequent variant should have
    // a >= difficulty level (non-decreasing, allowing equal for duplicates)
    let isCorrectOrder = true;
    for (let i = 1; i < group.length; i++) {
      const prevLevel = difficultyLevel(group[i - 1].variant.difficulty_label);
      const currLevel = difficultyLevel(group[i].variant.difficulty_label);
      if (currLevel < prevLevel) {
        isCorrectOrder = false;
        break;
      }
    }

    if (isCorrectOrder) {
      // Raise confidence by one level; keep the original matchMethod
      for (const m of group) {
        m.reviewStatus = undefined;
        if (m.confidence === 'low') {
          m.confidence = 'medium';
          m.matchReason = 'Difficulty progression validated; raised low→medium';
        } else if (m.confidence === 'medium') {
          m.confidence = 'high';
          m.matchReason = 'Difficulty progression validated; raised medium→high';
        }
      }
    } else {
      // Flag for review – append to existing matchReason
      for (const m of group) {
        m.reviewStatus = 'needs_review';
        m.matchReason = `Out-of-order difficulty progression within work ${m.workOrder}`;
      }
    }
  }

  // Check for file-size divergence per work (independent of ordering)
  for (const [workOrder, wf] of workFileMap) {
    if (hasSizeDivergence(wf)) {
      const workMatches = matches.filter((m) => m.workOrder === workOrder);
      for (const m of workMatches) {
        if (m.reviewStatus !== 'needs_review') {
          m.reviewStatus = 'needs_review';
          m.matchReason += '; file sizes diverge >5× within work';
        }
      }
    }
  }
}
