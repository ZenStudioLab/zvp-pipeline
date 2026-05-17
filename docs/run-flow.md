# run flow

## Purpose

The `run` flow processes source MIDI inputs through conversion and publishing logic, and reports lifecycle inventory before it selects work.

## Entry modes

| Mode | Input |
| --- | --- |
| `run` | catalog entries or a local MIDI file |
| `run --source-items` | queued `pipeline_job` rows backed by stored assets; prints inventory first and warns on stranded/stale rows |
| `run --source-items --force-generate --arrangement-id <id> --reason "..." [--publish]` | forced generation for an imported arrangement; defaults to review-first |
| `run --retry-failed` | requeue failed jobs for another processing attempt |
| `run --requeue-stranded` | requeue stranded jobs that need explicit operator action |

## Stage sequence

```text
normalize
   ↓
convert MIDI → VP
   ↓
score quality
   ↓
deduplicate
   ↓
enrich metadata
   ↓
publish / review / reject
   ↓
optional AI enrichment
```

## Outcomes

- **publish** — accepted and persisted
- **needs_review** — queued for manual review
- **reject** — discarded from publish path

## Common commands

```bash
node dist/cli.js run
node dist/cli.js run --dry-run
node dist/cli.js run --source-items
node dist/cli.js run --file ./tmp/example.mid
```

Useful flags:

- `--limit <n>`
- `--concurrency <n>`
- `--status <status>`
- `--skip-revalidation`
- `--force-generate`
- `--arrangement-id <id>`
- `--reason <text>`
- `--publish`

## Quality model

The processing path scores conversion quality, then combines that result with metadata confidence to decide publish, review, or reject.

See `src/config.ts` for the current thresholds.

## Gotchas

- `--dry-run` executes logic but skips DB writes.
- `--source-items` uses stored assets and existing pipeline jobs, not the scraper export; it reports queued/running/failed/rejected/published inventory before selection.
- `--source-items` warns when it finds stranded or stale jobs that need a retry/requeue command.
- `--retry-failed` is the operator path for failed jobs.
- `--requeue-stranded` is the operator path for stranded jobs.
- `--force-generate` bypasses the normal quality gate, requires a reason, and defaults to review-first unless `--publish` is explicit.
- `pipeline_job.state` is the durable lifecycle; `pipeline_job.phase` is transient execution progress.
- ISR revalidation depends on `SITE_URL` and `REVALIDATION_SECRET`.

## Canonical sheet model

Imported sheets follow a **two-axis difficulty model**:

| Axis | Values | Source |
|---|---|---|
| Source difficulty | `Beginner` / `Intermediate` / `Advanced` | MuseScore arrangement |
| Generated variant | `Novice` / `Apprentice` / `Adept` / `Master` / `Guru` | Zen conversion |

The canonical work-level sheet defaults to **`Intermediate + Adept`**. When that exact pair is absent, selection follows this order:

1. **Phase 1 — Adept exists somewhere**: walk `Intermediate → Beginner → Advanced`; pick the top-ranked arrangement in the first bucket that has an Adept variant. Return `(arrangementId, "Adept")`.
2. **Phase 2 — No Adept exists**: walk the same difficulty order; pick the top-ranked arrangement in the first non-empty bucket and derive its arrangement-level canonical variant (`Adept → Apprentice → Master → Novice → Guru`).

`updateWorkCanonicalSheet(workId)` runs after every sheet insert/update/delete and persists `work.canonical_sheet_id`. It emits a structured JSON log event (`canonical_sheet_selected` or `canonical_sheet_cleared`) that includes the resolution branch, arrangement, conversion level, and candidate count.

See `pipeline/docs/canonical-mapping.md` for the full algorithm reference.
