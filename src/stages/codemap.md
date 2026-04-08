# pipeline/src/stages/

## Responsibility

- Pure functions that implement each pipeline stage plus publishing logic and AI enrichment.

## Design

- Normalizer: cleans title/artist, produces normalized keys + confidence band.
- Converter: wraps `@zen/midi-to-vp` to produce VP notation + quality signals.
- Quality scorer: thresholds in `config.ts`, precedence rules floor "warning" cases.
- Dedup: fingerprint lookup + canonical promotion logic.
- Metadata enricher: genre/difficulty heuristics; artist lookup/create; slug/thumb.
- Publisher: decides `published/needs_review/rejected`, persists, updates fingerprint, triggers ISR.
- AI enricher: budgeted OpenAI call producing SEO/tips, with strict JSON parsing.

## Flow

- `evaluatePipelineStages()` runs normalizer -> converter -> scorer -> dedup -> enricher; failure short-circuits.
- `publishSheet()` persists and revalidates routes; outcome depends on score+confidence.

## Integration

- Stages consume repository interfaces defined in `types.ts` and `lib/*`; no direct DB access inside stages.
