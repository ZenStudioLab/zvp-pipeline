# pipeline/

## Responsibility

- MIDI->VP ingestion pipeline: CLI to evaluate files, pg-boss workers to publish sheets, and an async AI enricher for SEO/tips.

## Design

- TypeScript ESM; commands in `src/cli.ts`, workers in `src/worker.ts`.
- Stage architecture in `src/stages/*` (normalizer, converter, scorer, dedup, enricher, publisher).
- DB access via `@zen/db` wrapped by `src/lib/runtime-repository.ts`.
- Config/thresholds in `src/config.ts`; `.env` loader in `src/env.ts`.

## Flow

- CLI `run` loads catalog, evaluates stages, logs outcome; optionally persists via `process-job`.
- Worker consumes `pipeline.process` queue -> runs `processPipelineJob` -> if published, enqueues AI enrichment.
- AI worker fetches sheet, calls OpenAI (gpt-4o-mini) within a small budget, updates SEO metadata/tips.

## Integration

- Depends on `@zen/midi-to-vp`, `@zen/db`, `pg-boss`, `openai`.
- Revalidates Next.js routes via `siteUrl`/`REVALIDATION_SECRET` when publishing.
