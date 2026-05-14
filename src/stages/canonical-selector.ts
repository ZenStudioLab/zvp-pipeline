/**
 * canonical-selector.ts
 *
 * Pure helpers for selecting the canonical imported sheet at both work level and
 * arrangement level, following the two-axis difficulty model:
 *
 *   - Source axis: MuseScore arrangement difficulty (Beginner / Intermediate / Advanced)
 *   - Generated axis: Zen variant level (Novice / Apprentice / Adept / Master / Guru)
 *
 * Canonical defaults:
 *   - Arrangement level: `Adept`; falls back by nearest enum distance toward higher difficulty.
 *   - Work level: `Intermediate + Adept`; falls back through Beginner + Adept, Advanced + Adept,
 *     then to the preferred source arrangement's arrangement-level canonical variant.
 *
 * Enum source-of-truth: `midi-to-vp/src/types.ts` DifficultyLevel
 */

import type { DifficultyLevel } from "@zen/midi-to-vp";

export type SourceDifficultyLabel = "Beginner" | "Intermediate" | "Advanced";

/**
 * Preferred source difficulty order for work-level canonical selection.
 * Accessibility-first: Intermediate is the most representative middle difficulty;
 * Beginner is preferred over Advanced when Intermediate is absent because it
 * reflects a broader accessible audience.
 */
const SOURCE_DIFFICULTY_PREFERENCE: readonly SourceDifficultyLabel[] = [
  "Intermediate",
  "Beginner",
  "Advanced",
] as const;

/**
 * Arrangement-level canonical fallback order.
 * Adept is the preferred canonical variant. Ties break toward higher difficulty:
 * Apprentice (d=1 above), then Master (d=1 below), then Novice (d=2 above), then Guru (d=2 below).
 */
const ARRANGEMENT_FALLBACK_ORDER: readonly DifficultyLevel[] = [
  "Adept",
  "Apprentice",
  "Master",
  "Novice",
  "Guru",
] as const;

const CANONICAL_ZEN_LEVEL: DifficultyLevel = "Adept";

/**
 * Select the canonical Zen conversion level for an arrangement from its available variant levels.
 *
 * Returns `Adept` if present; otherwise falls back by enum distance from Adept, breaking ties
 * toward the higher difficulty (Apprentice → Master → Novice → Guru).
 * Returns `null` if `availableLevels` is empty.
 */
export function selectArrangementCanonicalVariant(
  availableLevels: readonly DifficultyLevel[],
): DifficultyLevel | null {
  if (availableLevels.length === 0) return null;
  const levelSet = new Set(availableLevels);
  for (const level of ARRANGEMENT_FALLBACK_ORDER) {
    if (levelSet.has(level)) return level;
  }
  // Unreachable for valid DifficultyLevel inputs, but guards future enum extensions.
  return null;
}

/**
 * Fields used for canonical source-arrangement ranking inside a single difficulty bucket.
 * Missing metric values are treated as 0 per spec.
 */
export type ArrangementRankingInput = {
  arrangementId: string;
  sourceViewCount?: number | null;
  sourceRatingCount?: number | null;
  sourceRatingScore?: number | null;
  createdAt: Date;
};

/**
 * Sort arrangements within the same source difficulty bucket by the canonical
 * source-arrangement ranking order (all descending except created_at asc):
 *   source_view_count DESC, source_rating_count DESC, source_rating_score DESC,
 *   created_at ASC, arrangementId ASC (stable deterministic tiebreaker).
 *
 * Returns a new sorted array; does not mutate the input.
 */
export function rankArrangementsInBucket<T extends ArrangementRankingInput>(
  arrangements: readonly T[],
): T[] {
  return [...arrangements].sort((a, b) => {
    const viewA = a.sourceViewCount ?? 0;
    const viewB = b.sourceViewCount ?? 0;
    if (viewB !== viewA) return viewB - viewA;

    const ratingCountA = a.sourceRatingCount ?? 0;
    const ratingCountB = b.sourceRatingCount ?? 0;
    if (ratingCountB !== ratingCountA) return ratingCountB - ratingCountA;

    const ratingScoreA = a.sourceRatingScore ?? 0;
    const ratingScoreB = b.sourceRatingScore ?? 0;
    if (ratingScoreB !== ratingScoreA) return ratingScoreB - ratingScoreA;

    const timeA = a.createdAt.getTime();
    const timeB = b.createdAt.getTime();
    if (timeA !== timeB) return timeA - timeB;

    return a.arrangementId.localeCompare(b.arrangementId);
  });
}

/**
 * Input describing one imported arrangement and the Zen variant levels it has generated.
 */
export type WorkCanonicalInput = ArrangementRankingInput & {
  sourceDifficultyLabel: SourceDifficultyLabel;
  availableConversionLevels: readonly DifficultyLevel[];
};

/**
 * Select the canonical (arrangementId, conversionLevel) pair for a work from all
 * imported arrangements that have generated sheet variants.
 *
 * Algorithm (difficulty-bucket-first, then arrangement ranking):
 *
 * Phase 1 — `Adept` exists somewhere:
 *   For each source difficulty in order (Intermediate, Beginner, Advanced):
 *     Collect arrangements with that difficulty that include an `Adept` variant.
 *     If any exist, rank them by source metrics and return (topArrangement.id, "Adept").
 *
 * Phase 2 — No `Adept` exists anywhere:
 *   For each source difficulty in order:
 *     Collect arrangements with that difficulty (any variant available).
 *     Rank them by source metrics.
 *     Derive the arrangement-level canonical variant for the top arrangement.
 *     Return (top.id, derivedVariant).
 *
 * Returns `null` if the input set is empty or no arrangement has any variants.
 */
export function selectWorkCanonicalSheet(
  arrangements: readonly WorkCanonicalInput[],
): { arrangementId: string; conversionLevel: DifficultyLevel } | null {
  if (arrangements.length === 0) return null;

  // Phase 1: prefer source difficulty buckets that contain an Adept variant.
  for (const sourceDifficulty of SOURCE_DIFFICULTY_PREFERENCE) {
    const withAdept = arrangements.filter(
      (a) =>
        a.sourceDifficultyLabel === sourceDifficulty &&
        a.availableConversionLevels.includes(CANONICAL_ZEN_LEVEL),
    );
    if (withAdept.length > 0) {
      const ranked = rankArrangementsInBucket(withAdept);
      return {
        arrangementId: ranked[0].arrangementId,
        conversionLevel: CANONICAL_ZEN_LEVEL,
      };
    }
  }

  // Phase 2: no Adept exists anywhere; fall back to difficulty-bucket-first + arrangement canonical.
  for (const sourceDifficulty of SOURCE_DIFFICULTY_PREFERENCE) {
    const inBucket = arrangements.filter(
      (a) => a.sourceDifficultyLabel === sourceDifficulty,
    );
    if (inBucket.length > 0) {
      const ranked = rankArrangementsInBucket(inBucket);
      const top = ranked[0];
      const canonicalVariant = selectArrangementCanonicalVariant(
        top.availableConversionLevels,
      );
      if (canonicalVariant !== null) {
        return {
          arrangementId: top.arrangementId,
          conversionLevel: canonicalVariant,
        };
      }
    }
  }

  return null;
}
