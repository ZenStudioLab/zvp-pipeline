---
title: "ADR-0001: Document pipeline as a dual-flow workspace"
status: "Accepted"
date: "2026-05-10"
authors: "OpenCode agent"
tags: ["architecture", "documentation", "pipeline"]
supersedes: ""
superseded_by: ""
---

# ADR-0001: Document pipeline as a dual-flow workspace

## Status

Accepted

## Context

The `pipeline` workspace documentation had become skewed toward the older catalog-driven processing story. `README.md`, `AGENTS.md`, and `codemap.md` mainly described `run` against `midi-scraper/catalog.json`, while the workspace now also contains a first-class `import` flow built around `scraper-export.json`, provider adapters, timestamp matching, asset upload, arrangement/catalog writes, and import audit.

This created two problems:

- new contributors and agents received an outdated mental model
- entry docs were long but still omitted the newer import architecture

## Decision

Document `pipeline` as a dual-flow workspace with lean entry docs and detailed workflow docs under `pipeline/docs/`.

Specifically:

- `pipeline/README.md` becomes a short operator-facing map
- `pipeline/AGENTS.md` becomes a short workspace operating contract for agents
- detailed workflow explanations live in `pipeline/docs/`
- the workspace architecture explicitly distinguishes `import` from `run`

## Consequences

### Positive

- **POS-001**: New contributors and agents get an accurate, current mental model of both primary flows.
- **POS-002**: `README.md` and `AGENTS.md` stay lean instead of becoming catch-all manuals.
- **POS-003**: Detailed import and run behavior can evolve without bloating entry docs.

### Negative

- **NEG-001**: Documentation is split across more files, so links and read order must stay clear.
- **NEG-002**: The docs set now requires maintenance discipline to avoid duplication.
- **NEG-003**: Some readers may expect full CLI option tables in README and will need to follow links instead.

## Alternatives Considered

### Keep expanding the existing README and AGENTS files

- **ALT-001**: **Description**: Fold the import flow into the existing long-form entry docs.
- **ALT-002**: **Rejection Reason**: This would preserve stale structure, increase duplication, and make entry docs less scannable.

### Rewrite README only and leave AGENTS mostly unchanged

- **ALT-003**: **Description**: Fix the human-facing doc while keeping the existing agent doc structure.
- **ALT-004**: **Rejection Reason**: Agents would still inherit an outdated catalog-first mental model.

## Implementation Notes

- **IMP-001**: Keep `README.md` focused on purpose, common commands, and links.
- **IMP-002**: Keep `AGENTS.md` focused on read order, guardrails, and validation commands.
- **IMP-003**: Put architecture and workflow depth in `pipeline/docs/architecture.md`, `import-flow.md`, and `run-flow.md`.

## References

- **REF-001**: `pipeline/README.md`
- **REF-002**: `pipeline/AGENTS.md`
- **REF-003**: `pipeline/codemap.md`
