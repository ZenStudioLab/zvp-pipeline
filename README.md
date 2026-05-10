# pipeline

Ingestion and publishing workspace for Zen Virtual Piano.

## Purpose

`pipeline` has two first-class flows:

| Flow | Purpose |
| --- | --- |
| `import` | Ingest `scraper-export.json` plus downloaded `.mid` files into storage assets, works, arrangements, pipeline jobs, and import audit rows |
| `run` / `run --source-items` | Process source MIDI inputs through conversion, scoring, deduplication, enrichment, and publish/review/reject outcomes |

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

### Import scraped arrangements

```bash
node dist/cli.js import \
  --export-file ../Downloads/midi-scraper/scraper-export.json \
  --download-dir ../Downloads/midi-scraper
```

Optional overrides:

- `--dry-run`
- `--timing-x <seconds>`
- `--timing-y <seconds>`
- `--timing-z <seconds>`

See [docs/import-flow.md](docs/import-flow.md).

### Process pipeline jobs or files

```bash
node dist/cli.js run --source-items
node dist/cli.js run --dry-run
node dist/cli.js run --file ./tmp/example.mid
```

See [docs/run-flow.md](docs/run-flow.md).

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
