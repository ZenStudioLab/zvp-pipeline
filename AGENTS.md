# AGENTS.md — pipeline

## Project Overview

`pipeline` is the MIDI-to-sheet processing pipeline for Zen Virtual Piano. It reads MIDI files catalogued by `midi-scraper`, converts them to VP (Virtual Piano) notation, scores and deduplicates them, then publishes approved sheets to the Supabase database. An async pg-boss worker handles post-publish AI enrichment (SEO metadata + practice tips) via GPT-4o-mini.

### Architecture

```
midi-scraper/catalog.json
        │
        ▼
  CLI (cli.ts)  ──►  pg-boss queue  ──►  Worker (worker.ts)
                                               │
                                    ┌──────────▼──────────┐
                                    │   process-job.ts     │
                                    │   run-stages.ts      │
                                    │  ┌───────────────┐   │
                                    │  │  normalizer   │   │
                                    │  │  converter    │   │
                                    │  │quality-scorer │   │
                                    │  │    dedup      │   │
                                    │  │metadata-enr.  │   │
                                    │  │  publisher    │   │
                                    │  └───────────────┘   │
                                    └──────────┬──────────┘
                                               │ (published)
                                    ┌──────────▼──────────┐
                                    │  AI enricher job     │
                                    │  (gpt-4o-mini)       │
                                    └─────────────────────┘
```

### Key Technologies

- **Runtime**: Node.js ESM, TypeScript
- **Job queue**: pg-boss (PostgreSQL-backed)
- **Database ORM**: Drizzle ORM → Supabase PostgreSQL (`@zen/db`)
- **MIDI conversion**: `@zen/midi-to-vp`, `@tonejs/midi`
- **AI enrichment**: OpenAI GPT-4o-mini
- **CLI**: Commander
- **Tests**: Vitest (unit + integration), v8 coverage

---

## Codebase Cartography

This workspace uses `codemap.md` files to document architecture.

### Cartography Glob

```
pipeline/
├── codemap.md                              — workspace root: pipeline overview
└── src/
    ├── codemap.md                          — run-stages, process-job entry
    ├── lib/codemap.md                     — shared pipeline utilities
    └── stages/codemap.md                  — pipeline stages (normalizer, converter, etc.)
```

### Using Codemaps

Run cartography to regenerate: `yarn codemap`

---

## Environment Setup

Copy `.env.example` to `.env` and fill in the values:

```
DATABASE_URL=postgresql://...     # Supabase pooler connection string
REVALIDATION_SECRET=...           # Shared secret for Next.js ISR revalidation
SITE_URL=https://zenpiano.art
OPENAI_API_KEY=sk-...
```

`DATABASE_URL` is required for any command that touches the database. `OPENAI_API_KEY` is only needed when running the AI enricher worker.

---

## Setup Commands

```bash
# From monorepo root — install all dependencies
yarn install

# Or from this directory
cd pipeline && yarn install
```

---

## Development Workflow

This package is a CLI + worker — there is no dev server. Build once or use type-check for validation:

```bash
# Type-check (no emit)
yarn type-check

# Compile to dist/
yarn build

# Run CLI (after build)
node dist/cli.js --help
```

After `yarn build`, the compiled entry point is at `dist/cli.js`.

---

## CLI Commands

```bash
# Run the pipeline against midi-scraper/catalog.json
node dist/cli.js run [options]

# Options:
#   --source <site>       Filter by source site (e.g. freemidi, bitmidi)
#   --limit <n>           Maximum number of entries to process (default: 100)
#   --file <path>         Process a single MIDI file directly
#   --dry-run             Run all stages but skip DB writes
#   --status <status>     Filter catalog entries by status
#   --concurrency <n>     Parallel workers (default: 5)

# Show pipeline stats from the database
node dist/cli.js stats

# Seed reference data (genres, difficulties) into the database
node dist/cli.js seed
```

The `run` command auto-discovers the workspace root by walking up from `cwd` until it finds `midi-scraper/catalog.json`.

---

## Pipeline Stages

| Stage             | File                          | Purpose                                                                    |
| ----------------- | ----------------------------- | -------------------------------------------------------------------------- |
| Normalizer        | `stages/normalizer.ts`        | Clean title/artist, fuzzy-match existing artists, assign confidence        |
| Converter         | `stages/converter.ts`         | Parse MIDI → VP notation via `@zen/midi-to-vp`                             |
| Quality Scorer    | `stages/quality-scorer.ts`    | Score conversion on rubric (in-range ratio, chord/note density, timing)    |
| Dedup             | `stages/dedup.ts`             | Fingerprint-based duplicate detection; decide create / promote / alternate |
| Metadata Enricher | `stages/metadata-enricher.ts` | Assign genre, difficulty, artist from DB                                   |
| Publisher         | `stages/publisher.ts`         | Insert sheet to DB; trigger Next.js ISR revalidation                       |
| AI Enricher       | `stages/ai-enricher.ts`       | Async: generate SEO title, description, practice tips                      |

### Quality Thresholds (`src/config.ts`)

| Score                         | Band    | Action                   |
| ----------------------------- | ------- | ------------------------ |
| ≥ 0.75 (with high confidence) | publish | Auto-published           |
| 0.50 – 0.74                   | review  | Queued for manual review |
| < 0.50                        | reject  | Discarded                |

---

## Testing Instructions

Tests live in `tests/unit/` and `tests/integration/`.

```bash
# Run all tests (from this directory)
yarn test

# Watch mode
yarn test:watch

# Coverage report (target: 80% branch coverage)
yarn test:coverage

# Focus on a specific test
yarn vitest run -t "test name pattern"

# Run a single test file
yarn vitest run tests/unit/normalizer.test.ts
```

Integration tests in `tests/integration/pipeline-flow.test.ts` orchestrate the full multi-stage flow with in-memory mocks — no live database required.

### Coverage

Coverage is collected via v8. Report outputs to `coverage/`. The project targets ≥ 80% branch coverage. Always add or update tests alongside code changes.

---

## Code Style

- **Language**: TypeScript ESM (`.ts` source, `.js` imports in compiled output)
- **Imports**: Use `import ... from './module.js'` (`.js` extension required for ESM compatibility)
- **Immutability**: Stage functions return new objects — do not mutate inputs
- **Functions over classes**: Stages are exported as pure functions or factory functions
- **Error handling**: Pipeline stages return typed result objects (`ok: true/false`) — no thrown exceptions in stage logic
- **Naming**: `camelCase` for functions/variables, `PascalCase` for types, `UPPER_SNAKE_CASE` for constants
- **File size**: Keep files focused; stages and their types are separated into `stages/types.ts`

---

## Build

```bash
yarn build        # Compiles src/ → dist/ using tsconfig.build.json
yarn type-check   # Type-check without emitting
```

Output directory: `dist/`  
Build config: `tsconfig.build.json` (extends `tsconfig.json`, excludes test files).

---

## Adding a New Stage

1. Create `src/stages/my-stage.ts` with a pure function that accepts typed input and returns typed output
2. Add input/output types to `src/stages/types.ts`
3. Integrate into `src/lib/run-stages.ts` or `src/lib/process-job.ts`
4. Add unit tests in `tests/unit/my-stage.test.ts`
5. Update integration test in `tests/integration/pipeline-flow.test.ts` if the stage participates in the main flow

---

## Troubleshooting

**`Unable to locate the workspace root`**  
Run CLI from within the monorepo, or from the `pipeline/` directory. The CLI walks up the directory tree looking for `midi-scraper/catalog.json`.

**`DATABASE_URL is required`**  
Ensure `.env` is present and loaded, or export `DATABASE_URL` in your shell before running.

**Catalog entries not processing**  
Check that `midi-scraper/catalog.json` has an `entries` array with `output_path` values pointing to existing `.mid` files.

**AI enricher skipping entries**  
The AI enricher enforces a per-call budget cap of $0.005 USD. If `estimatedCostUsd > BUDGET_CAP_USD`, it skips the enrichment and returns `status: 'skipped'` with `reason: 'budget_exceeded'`.

---

## Pull Request Guidelines

- Title format: `feat(pipeline): <description>` / `fix(pipeline): <description>`
- Run before committing: `yarn type-check && yarn test`
- Maintain ≥ 80% branch coverage
- Stage function signatures must accept a typed repository interface (not a concrete class) to keep unit tests injectable
