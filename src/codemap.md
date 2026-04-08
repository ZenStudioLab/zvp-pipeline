# pipeline/src/

## Responsibility

- Implementation for CLI commands, worker registration, stage orchestration, and env/config helpers.

## Design

- Entry points: `cli.ts` (Commander), `worker.ts` (pg-boss workers).
- Helpers: `lib/` (runtime repository, logger, stage runner, job processor), `env.ts`, `config.ts`.

## Flow

- CLI resolves workspace root -> loads catalog -> `evaluatePipelineStages()` for each entry -> pretty JSON output.
- Worker registers handlers for `pipeline.process` and `pipeline.ai-enrich` -> uses repository and stages.

## Integration

- Talks to PostgreSQL via `@zen/db`; to OpenAI for AI enrichment; and to Next.js revalidation endpoint.
