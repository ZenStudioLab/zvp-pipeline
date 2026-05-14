# Canonical Sheet Mapping

## Overview

The canonical sheet model resolves which single imported sheet is the default
("canonical") representation of a work or arrangement on all discovery surfaces
(catalog, search, sitemap, recommendations, bare work-share).

## Two-axis difficulty model

Imported sheets carry two independent difficulty fields:

| Field | Values | Source |
|---|---|---|
| `source_difficulty_label` | `Beginner` / `Intermediate` / `Advanced` | MuseScore arrangement difficulty |
| `conversion_level` | `Novice` / `Apprentice` / `Adept` / `Master` / `Guru` | Zen conversion level |

These axes are independent. An `Intermediate` source arrangement may have been
converted to `Novice`, `Adept`, or any other level.

## Canonical defaults

| Scope | Default | Fallback |
|---|---|---|
| Work level | `Intermediate + Adept` | See Phase 1 / Phase 2 below |
| Arrangement level | `Adept` | `Apprentice → Master → Novice → Guru` |

## Work-level selection algorithm

Implemented in `pipeline/src/stages/canonical-selector.ts`:
`selectWorkCanonicalSheet(arrangements)`.

### Phase 1 — Adept exists somewhere

Walk source-difficulty buckets in order: `Intermediate → Beginner → Advanced`.

For each bucket:
- Collect arrangements whose `availableConversionLevels` includes `Adept`.
- If any exist, rank them by source metrics (see [Arrangement ranking](#arrangement-ranking)).
- Return `{ arrangementId: top.arrangementId, conversionLevel: "Adept" }`.

### Phase 2 — No Adept exists anywhere

Walk the same difficulty order.

For each bucket:
- Collect all arrangements in the bucket (any variants).
- Rank them by source metrics.
- Derive the arrangement-level canonical for the top arrangement.
- Return `{ arrangementId: top.arrangementId, conversionLevel: derivedCanonical }`.

Returns `null` if the input set is empty or no eligible candidates exist.

## Arrangement-level canonical variant

Implemented as `selectArrangementCanonicalVariant(availableLevels)`.

Fallback order: `Adept → Apprentice → Master → Novice → Guru`.

Returns the first level in that order that is present in `availableLevels`.
Returns `null` if `availableLevels` is empty.

## Arrangement ranking

Within a difficulty bucket, arrangements are ranked by (all descending, except
`created_at` which is ascending):

1. `source_view_count DESC`
2. `source_rating_count DESC`
3. `source_rating_score DESC`
4. `created_at ASC`
5. `arrangement_id ASC` (deterministic tiebreaker)

Missing metric values are treated as `0`.

## Persistence

`updateWorkCanonicalSheet(workId)` in `pipeline/src/lib/runtime-repository.ts`:

1. Queries all arrangement-linked sheets for the work that have full provenance
   (`arrangement_id`, `conversion_level`, `source_difficulty_label` all non-null).
2. Builds `WorkCanonicalInput[]` per arrangement.
3. Calls `selectWorkCanonicalSheet` to get the winning `(arrangementId, conversionLevel)` pair.
4. Resolves the winning sheet id from the in-memory accumulator.
5. Updates `work.canonical_sheet_id`.

Must be called after any imported sheet create / update / delete for the work.

## Observability

`updateWorkCanonicalSheet` emits a structured JSON event to stdout:

```json
// Selection succeeded
{
  "event": "canonical_sheet_selected",
  "workId": "...",
  "branch": "phase1_adept" | "phase2_fallback",
  "arrangementId": "...",
  "conversionLevel": "Adept",
  "candidateCount": 3,
  "winnerSheetId": "..."
}

// No eligible sheet — canonical_sheet_id cleared
{
  "event": "canonical_sheet_cleared",
  "workId": "...",
  "candidateCount": 0,
  "reason": "no_eligible_canonical_sheet"
}
```

`branch` values:

| Value | Meaning |
|---|---|
| `phase1_adept` | An Adept variant existed; winner is `(topArrangement, "Adept")` |
| `phase2_fallback` | No Adept existed; winner is `(topArrangement, derivedVariant)` |

## Discovery and retrieval surfaces

| Surface | Filter applied |
|---|---|
| Catalog / search / sitemap / recommendations | `sheet.id = work.canonical_sheet_id` |
| `/sheets/:slug` (direct slug lookup) | No canonical filter — any published variant slug resolves |
| `/sheets/arrangement/:id` | Returns all published variants for the arrangement |

Non-canonical variants remain accessible by direct slug (explicit variant share)
or via the arrangement enumeration endpoint.
