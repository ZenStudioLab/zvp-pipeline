# import flow

## Purpose

The `import` command turns scraper output plus downloaded MIDI files into persistent source records that the rest of the pipeline can process.

## Inputs

- `scraper-export.json`
- local download directory containing `.mid` files
- storage/database environment
- optional CLI timing overrides

## Flow

```text
scraper-export.json
        │
        ▼
provider adapter
        │
        ▼
timestamp matcher  ◀── scanned local .mid files
        │
        ▼
asset uploader
        │
        ▼
catalog writer
        │
        ▼
import audit
```

## Key behaviors

### Provider normalization

- Provider-specific fields are normalized before catalog writing.
- Provider item IDs stay provider-qualified strings.
- Unsupported or malformed provider data becomes diagnostics instead of partial catalog rows.

### Matching

- Local files are associated by timestamps, not by `download_filename`.
- `download_filename` from the export is advisory only.
- Missing or invalid timestamps prevent automatic matching and enter diagnostics.

### Persistence

Successful matches can create or update:

- storage-backed original MIDI assets
- `work`
- `arrangement`
- `pipeline_job`
- `import_run` and `import_event`

## Common commands

```bash
node dist/cli.js import \
  --export-file ../Downloads/midi-scraper/scraper-export.json \
  --download-dir ../Downloads/midi-scraper

node dist/cli.js import \
  --export-file ../Downloads/midi-scraper/scraper-export.json \
  --download-dir ../Downloads/midi-scraper \
  --dry-run
```

Optional overrides:

- `--timing-x <seconds>`
- `--timing-y <seconds>`
- `--timing-z <seconds>`

## Outputs

- matched or unmatched import audit rows
- linked original MIDI assets
- normalized arrangements and works
- pending pipeline jobs for downstream processing

## Gotchas

- Matching confidence depends on timestamp quality and launch spacing.
- Unmatched scanned files should still appear in import audit for non-dry-run imports.
- Reused assets must still be linked to the imported arrangement.
- Use `--dry-run` when validating an export or timing configuration change.
