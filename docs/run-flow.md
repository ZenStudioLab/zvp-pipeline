# run flow

## Purpose

The `run` flow processes source MIDI inputs through conversion and publishing logic.

## Entry modes

| Mode | Input |
| --- | --- |
| `run` | catalog entries or a local MIDI file |
| `run --source-items` | pending `pipeline_job` rows backed by stored assets |

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

## Quality model

The processing path scores conversion quality, then combines that result with metadata confidence to decide publish, review, or reject.

See `src/config.ts` for the current thresholds.

## Gotchas

- `--dry-run` executes logic but skips DB writes.
- `--source-items` uses stored assets and existing pipeline jobs, not the scraper export.
- ISR revalidation depends on `SITE_URL` and `REVALIDATION_SECRET`.
