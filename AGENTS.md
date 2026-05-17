# AGENTS.md — pipeline

Workspace-local operating notes for `pipeline/`. Follow the repo root `AGENTS.md` first, then this file.

## Scope

This workspace owns two linked but distinct paths:

1. **Import flow** — `scraper-export.json` + downloaded MIDI files → assets, works, arrangements, pipeline jobs, import audit
2. **Run flow** — source MIDI inputs / queued jobs → convert, score, deduplicate, enrich, publish

Do not assume this workspace is only catalog-driven or only freemidi-oriented.

## Read order

Before editing:

1. `pipeline/README.md`
2. `pipeline/codemap.md`
3. `pipeline/docs/architecture.md`
4. `pipeline/docs/import-flow.md` for importer work
5. `pipeline/docs/run-flow.md` for conversion/publish work

For deeper code context, read the nearest codemap under:

- `pipeline/src/codemap.md`
- `pipeline/src/lib/codemap.md`
- `pipeline/src/stages/codemap.md`
- `pipeline/src/jobs/codemap.md`

## Key directories

- `src/importers/` — import adapters, matching, asset upload, audit, catalog write
- `src/stages/` — conversion, scoring, dedup, metadata, publisher
- `src/lib/` — orchestration, repository, runtime helpers
- `tests/unit/`, `tests/integration/` — importer and processing coverage
- `docs/` — detailed workflow docs; keep entry docs lean

## Common commands

```bash
yarn build
yarn type-check
yarn test
node dist/cli.js import --help
node dist/cli.js run --help
```

## Guardrails

- Preserve provider-qualified IDs such as `musescore:4383881` on the import path.
- Treat `scraper-export.json` as the import contract unless the task explicitly changes that contract.
- `download_filename` is advisory; timestamp matching is canonical.
- Import timing semantics are: `x` click-to-download, `y` inter-variant, `z` inter-work.
- Keep `README.md` and `AGENTS.md` lean; move detailed behavior docs into `pipeline/docs/`.
- Update tests when importer or processing behavior changes.
