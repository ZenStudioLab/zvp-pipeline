# pipeline/src/lib/

## Responsibility

- Runtime helpers coordinating I/O around stages: DB repository, job processing, stage runner, logging.

## Design

- `runtime-repository.ts`: wraps `@zen/db` with higher-level methods (stats, list jobs, insert sheet, ISR revalidation).
- `process-job.ts`: idempotent state machine that runs stages + publisher and persists transitions.
- `run-stages.ts`: pure orchestrator composing normalizer -> converter -> scorer -> dedup -> metadata enricher.
- `logger.ts`: structured in-memory logging + summarization.

## Flow

- `evaluatePipelineStages()` computes a preview; `processPipelineJob()` persists status transitions and publishes.
- Repository caches some lookups (genres/difficulties) and provides typed read/write methods.

## Integration

- Called from `cli.ts` and `worker.ts`; depends on `@zen/db`, `fetch` for ISR revalidate, and stage modules.
