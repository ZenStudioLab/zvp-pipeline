# pipeline

MIDI-to-sheet processing pipeline for **Zen Virtual Piano**. Converts raw MIDI files catalogued by `midi-scraper` into scored, deduplicated, and optionally AI-enriched piano sheets published to the Supabase database.

---

## How it works

Each MIDI file goes through a sequence of stages:

1. **Normalize** — Clean song title and artist name, fuzzy-match existing artists, assign metadata confidence
2. **Convert** — Parse MIDI bytes → VP notation via `@zen/midi-to-vp`
3. **Score** — Evaluate conversion quality on a weighted rubric (in-range ratio, chord density, note density, timing consistency)
4. **Dedup** — Fingerprint-based duplicate detection; determine whether to create a new canonical sheet, promote an alternate, or skip
5. **Enrich** — Assign genre, difficulty, and resolved artist from the database
6. **Publish** — Insert the sheet record and trigger Next.js ISR cache revalidation
7. **AI Enrich** *(async)* — Background pg-boss job: generate SEO title, meta description, and 3 practice tips via GPT-4o-mini

A sheet is auto-published when its quality score is **≥ 0.75** with **high metadata confidence**. Scores between 0.50–0.74 are flagged for manual review. Below 0.50 is rejected.

---

## Quick start

### 1. Install dependencies

From the monorepo root:

```bash
yarn install
```

### 2. Configure environment

Copy [`.env.example`](.env.example) to `.env`:

```bash
cp .env.example .env
```

Edit `.env`:

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | Supabase PostgreSQL pooler connection string |
| `REVALIDATION_SECRET` | ISR only | Shared bearer token for Next.js ISR revalidation (see below) |
| `SITE_URL` | ISR only | Base URL of the landing page (see below) |
| `OPENAI_API_KEY` | optional | OpenAI key for GPT-4o-mini enrichment (see below) |

#### `REVALIDATION_SECRET`

After a sheet is published, the pipeline calls `POST {SITE_URL}/api/revalidate` with an `Authorization: Bearer <secret>` header to tell Next.js to purge and regenerate the static pages for that sheet, its artist, its genre, `/catalog`, and `/`. The landing page reads the same `REVALIDATION_SECRET` env var and rejects requests that don't match. **Both sides must share the same value** — set it in `landing-page/.env.local` (local dev) or in Vercel environment variables (production). See the Route Handler at [landing-page/src/app/api/revalidate/route.ts](../landing-page/src/app/api/revalidate/route.ts) and the full ISR setup in [specs/001-sheet-page-pipeline/quickstart.md](../specs/001-sheet-page-pipeline/quickstart.md).

If either `SITE_URL` or `REVALIDATION_SECRET` is missing, the `revalidatePaths` call is silently skipped — sheets are still published to the database, but the Next.js cache won't be purged until the next full deploy or a manual revalidation.

#### `SITE_URL`

The base URL the pipeline uses when calling the ISR revalidation endpoint above (e.g. `https://zenpiano.art` → calls `https://zenpiano.art/api/revalidate`). For local development point it at the running Next.js dev server: `http://localhost:3000`.

#### `OPENAI_API_KEY`

**Optional.** Only needed when the pg-boss AI enrichment worker is running. If the key is absent or empty, the `OpenAI` client will still be constructed but every enrichment call will return a provider error and the job will be marked `skipped` with `reason: 'provider_error'`. Published sheets are unaffected — they will simply have no SEO title, meta description, or auto-generated tips until the key is provided and the enrichment job is re-queued.

### 3. Build

```bash
yarn build
```

Compiled output lands in `dist/`.

### 4. Seed reference data

Run once after pointing the pipeline at a fresh database:

```bash
node dist/cli.js seed
```

---

## CLI usage

```
node dist/cli.js <command> [options]
```

### `run` — process MIDI files

```bash
# Process up to 100 entries from midi-scraper/catalog.json
node dist/cli.js run

# Dry-run: run all stages, skip DB writes
node dist/cli.js run --dry-run

# Process only entries from a specific source site
node dist/cli.js run --source freemidi

# Limit to 20 entries with 3 parallel workers
node dist/cli.js run --limit 20 --concurrency 3

# Process a single local MIDI file
node dist/cli.js run --file path/to/song.mid
```

| Option | Default | Description |
|--------|---------|-------------|
| `--source <site>` | — | Filter by source site (`freemidi`, `bitmidi`, etc.) |
| `--limit <n>` | `100` | Maximum entries to process |
| `--file <path>` | — | Process a single MIDI file instead of the catalog |
| `--dry-run` | `false` | Skip all database writes |
| `--status <status>` | — | Filter catalog entries by their current status |
| `--concurrency <n>` | `5` | Number of parallel workers |

### `stats` — pipeline statistics

```bash
node dist/cli.js stats
```

Prints total jobs, counts by status (published / review / rejected / failed), average quality score, and a breakdown of rejection reasons.

### `seed` — seed reference data

```bash
node dist/cli.js seed
```

Inserts default genres and difficulty levels into the database. Safe to re-run (idempotent upsert).

---

## Running tests

```bash
# All tests
yarn test

# Watch mode (re-runs on file change)
yarn test:watch

# Coverage report (outputs to coverage/)
yarn test:coverage

# A specific test file
yarn vitest run tests/unit/normalizer.test.ts

# A specific test by name
yarn vitest run -t "normalizer"
```

Target: **≥ 80% branch coverage**.

---

## Project structure

```
pipeline/
├── src/
│   ├── cli.ts                   # Commander CLI entry point
│   ├── worker.ts                # pg-boss worker setup
│   ├── config.ts                # Quality thresholds and rubric weights
│   └── lib/
│       ├── logger.ts            # Typed pipeline status logger
│       ├── process-job.ts       # Single-job orchestration
│       ├── run-stages.ts        # Converter/scorer/dedup/enricher runner
│       └── runtime-repository.ts# Drizzle ORM data access layer
│   └── stages/
│       ├── types.ts             # Shared TypeScript types
│       ├── normalizer.ts        # Title/artist normalization
│       ├── converter.ts         # MIDI → VP conversion
│       ├── quality-scorer.ts    # Weighted quality rubric
│       ├── dedup.ts             # Fingerprint deduplication
│       ├── metadata-enricher.ts # Genre/difficulty/artist resolution
│       ├── publisher.ts         # DB insert + ISR revalidation
│       └── ai-enricher.ts       # GPT-4o-mini SEO + tips
├── tests/
│   ├── unit/                    # Stage-level unit tests
│   └── integration/             # Full-flow integration tests (no live DB)
├── .env.example
├── package.json
├── tsconfig.json
├── tsconfig.build.json
└── vitest.config.ts
```

---

## Quality rubric

The quality score is a weighted sum of four signals, all normalized to [0, 1]:

| Signal | Weight | Description |
|--------|--------|-------------|
| `inRangeRatio` | 35% | Fraction of notes within the standard piano keyboard range |
| `chordDensity` | 25% | Proportion of notes that are part of chords |
| `noteDensity` | 20% | Notes-per-second normalised against an ideal range |
| `timingConsistency` | 20% | Low timing jitter → higher score |

Thresholds (configurable in `src/config.ts`):

- **Publish**: score ≥ 0.75 and metadata confidence ≥ 0.8
- **Review**: score ≥ 0.50
- **Reject**: score < 0.50

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `@zen/midi-to-vp` | MIDI → VP notation conversion (monorepo package) |
| `@zen/db` | Drizzle ORM schema + DB client (monorepo package) |
| `@tonejs/midi` | MIDI file parsing |
| `pg-boss` | PostgreSQL-backed job queue |
| `drizzle-orm` | SQL query builder |
| `openai` | GPT-4o-mini API client |
| `commander` | CLI argument parsing |
| `postgres` | PostgreSQL driver |
