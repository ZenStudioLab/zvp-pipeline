# pipeline

Ingestion and publishing workspace for Zen Virtual Piano.

## Purpose

`pipeline` has two first-class flows:

| Flow | Purpose |
| --- | --- |
| `import` | Ingest `scraper-export.json` plus downloaded `.mid` files into storage assets, works, arrangements, pipeline jobs, and import audit rows |
| `run` / `run --source-items` | Process source MIDI inputs through conversion, scoring, deduplication, enrichment, and publish/review/reject outcomes; `pipeline_job.state` is durable, `pipeline_job.phase` is transient, and `run --source-items` reports queued/running/failed/rejected/published inventory plus stranded/stale warnings |
| `run --source-items --force-generate --arrangement-id <id> --reason "..." [--publish]` | Force a sheet generation from an imported source item with review-first default output |

## Quick start

Run these from `pipeline/` unless noted otherwise.

```bash
yarn install
cp .env.example .env
yarn build
yarn type-check
yarn test
```

Seed reference data when targeting a fresh database:

```bash
node dist/cli.js seed
```

## Common commands

### Hard reset the local Supabase database and rerun the full flow

Use this when you want to recreate the local database from migrations, reseed it,
and run the pipeline end to end again.

1. From `supabase/`, make sure the local stack is running, then reset the local database:

```bash
supabase start
supabase db reset
```

This reapplies every migration in `supabase/migrations/`, reloads `supabase/seed.sql`,
and recreates the local storage bucket expected by the import flow.

2. From `pipeline/`, confirm the workspace is pointed at the local stack.

- Use `pipeline/.env` for local pipeline runs.
- The local database is typically `postgresql://postgres:postgres@127.0.0.1:54330/postgres`.

3. Rebuild and reseed pipeline reference data:

```bash
yarn build
node dist/cli.js seed
```

4. Rerun the import flow with your current scraper export and downloaded MIDI files:

```bash
node dist/cli.js import
```

Optional import overrides:

- `--export-file <path>`
- `--download-dir <path>`
- `--dry-run`
- `--timing-x <seconds>`
- `--timing-y <seconds>`
- `--timing-z <seconds>`
- `--matching-window <seconds>`

5. Rerun the processing flow:

```bash
node dist/cli.js run --source-items
```

Useful recovery variants after a reset/import cycle:

```bash
node dist/cli.js run --retry-failed
node dist/cli.js run --requeue-stranded
node dist/cli.js run --source-items --force-generate --arrangement-id <id> --reason "..."
```

6. Validate the rebuilt state:

```bash
node dist/cli.js stats
```

If the reset fails, inspect the newest migration in `supabase/migrations/` first.

### Import scraped arrangements

```bash
node dist/cli.js import
```

Optional overrides:

- `--export-file <path>`
- `--download-dir <path>`
- `--dry-run`
- `--timing-x <seconds>`
- `--timing-y <seconds>`
- `--timing-z <seconds>`
- `--matching-window <seconds>`

Defaults:

- `--download-dir` → `~/Downloads/midi-scraper`
- `--export-file` → `scraper-export.json` inside that directory

See [docs/import-flow.md](docs/import-flow.md).

### Process pipeline jobs or files

```bash
node dist/cli.js run --source-items
node dist/cli.js run --dry-run
node dist/cli.js run --file ./tmp/example.mid
```

See [docs/run-flow.md](docs/run-flow.md).

### Recover or force source-item runs

```bash
node dist/cli.js run --retry-failed
node dist/cli.js run --requeue-stranded
node dist/cli.js run --source-items --force-generate --arrangement-id <id> --reason "..."
```

### Support commands

```bash
node dist/cli.js stats
node dist/cli.js seed
```

For full flag details, use:

```bash
node dist/cli.js --help
node dist/cli.js import --help
node dist/cli.js run --help
```

## Documentation

- [docs/architecture.md](docs/architecture.md) — workspace architecture and system map
- [docs/import-flow.md](docs/import-flow.md) — scraper export import path
- [docs/run-flow.md](docs/run-flow.md) — conversion/scoring/publish path
- [docs/adr/README.md](docs/adr/README.md) — architecture decision records

## Validation

```bash
yarn build
yarn type-check
yarn test
```
