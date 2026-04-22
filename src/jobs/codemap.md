# pipeline/src/jobs/

## Responsibility

- Standalone job modules for pipeline maintenance tasks (canonical reranking).
- Jobs are designed to be run on-demand or scheduled, separate from the main MIDI→sheet flow.

## Design

- Pure functions with injected repository dependencies for testability.
- Each job exports a `createXxxJob()` factory for dependency injection.

## Jobs

| Job              | File                  | Purpose                                                                                                                                         |
| ---------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical Rerank | `rerank-canonical.ts` | Re-evaluates canonical sheet for each fingerprint based on quality + rating scores; swaps if leader changed; triggers Next.js path revalidation |

## Flow (rerank-canonical)

1. `listFingerprintsForRerank()` → groups with multiple versions
2. For each fingerprint:
   - `listVersionsForFingerprint()` → all versions
   - `selectLeader()` → best score (quality + weighted rating)
   - If leader ≠ current canonical → `swapCanonicalSheet()`
   - `revalidatePaths()` → purge CDN cache for changed slugs (all locales)

## Integration

- Reads from PostgreSQL via repository interface.
- Triggers Next.js ISR revalidation via `/api/revalidate`.
