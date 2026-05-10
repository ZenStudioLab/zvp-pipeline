# pipeline architecture

## Purpose

`pipeline` is the ingestion and publishing workspace for Zen Virtual Piano. It has two first-class flows that meet in the same downstream processing system.

```text
                  ┌──────────────────────────┐
                  │  scraper-export.json     │
                  │  + downloaded .mid files │
                  └────────────┬─────────────┘
                               │
                               ▼
                        import command
                               │
          provider adapter → timestamp matcher → asset upload
                               │
                               ▼
               work + arrangement + pipeline_job + import audit
                               │
                               ▼
                        run --source-items
                               │
         normalize → convert → score → dedup → enrich → publish
                               │
                               ▼
                        optional AI enrichment
```

## Primary entrypoints

| Entry | Role |
| --- | --- |
| `src/cli.ts` | User-facing commands for `import`, `run`, `stats`, and `seed` |
| `src/importers/*` | Import flow logic: adapter selection, matching, catalog write, asset upload, audit |
| `src/lib/process-job.ts` | Job-level orchestration for processing sources |
| `src/lib/run-stages.ts` | Ordered execution of processing stages |
| `src/worker.ts` | Background workers for `pipeline.process` and AI enrichment |

## Architectural split

### 1. Import flow

The import flow prepares source records for the rest of the system.

Responsibilities:

- consume `scraper-export.json`
- normalize provider-specific records through adapters
- match local files by timestamps, not exported filenames
- upload or reuse original MIDI assets
- upsert work and arrangement rows
- create or reuse `pipeline_job` rows
- record diagnostics and audit events

### 2. Run flow

The run flow evaluates MIDI inputs and decides whether they should publish, queue for review, or reject.

Responsibilities:

- normalize titles and artists
- convert MIDI to VP notation
- score quality
- deduplicate against existing sheets
- enrich metadata
- publish accepted results
- optionally trigger AI enrichment

## Important invariants

- Provider item identity is provider-qualified and string-based, e.g. `musescore:4383881`.
- `scraper-export.json` is the active import contract for the importer path.
- `download_filename` is advisory only; timestamp matching is canonical.
- Timing semantics are:
  - `x` click-to-download delay
  - `y` inter-variant delay
  - `z` inter-work delay

## Source of truth docs

- [import-flow.md](import-flow.md)
- [run-flow.md](run-flow.md)
- [adr/README.md](adr/README.md)
