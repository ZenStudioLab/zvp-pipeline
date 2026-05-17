import type { ImportExportRecord, ImportExportVariant } from './types.js';

export type ProviderId = 'musescore';

export type ProviderItemId = {
  provider: string;
  itemId: string;
};

export type ImportDiagnosticCode =
  | 'unsupported-provider'
  | 'malformed-provider'
  | 'missing-timestamp';

export type ImportDiagnostic = {
  code: ImportDiagnosticCode;
  message: string;
  workOrder: number;
  scoreId: string | null;
  scoreUrl: string | null;
};

export type RawScraperRecord = Record<string, unknown> & {
  variants?: Array<Record<string, unknown>>;
};

export type NormalizedImportVariant = ImportExportVariant & {
  provider: ProviderId;
  provider_item_id: string;
  source_site: string;
  source_url: string;
  canonical_url: string | null;
  title: string;
  artist: string;
  artist_url: string | null;
  song_url: string | null;
  uploader_name: string | null;
  uploader_url: string | null;
  difficulty_rank: number | null;
  duration_seconds: number | null;
  bpm: number | null;
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  rating_score: number | null;
  rating_count: number | null;
  pages: string | null;
  measures: string | null;
  key: string | null;
  parts: string | null;
  credits: string | null;
  uploaded_at: string | null;
  updated_at: string | null;
  license_label: string | null;
  license_url: string | null;
  privacy: string | null;
  tags: string[] | null;
  related_versions: unknown;
  raw_metadata: {
    raw_record: Record<string, unknown>;
    raw_variant: Record<string, unknown>;
  };
  scraped_at: string;
};

export type NormalizedImportRecord = ImportExportRecord & {
  artist_name: string;
  artist_url: string | null;
  song_url: string | null;
  variants: NormalizedImportVariant[];
};

export type AdaptScraperExportResult = {
  records: NormalizedImportRecord[];
  diagnostics: ImportDiagnostic[];
};

export type ProviderAdapter = {
  provider: ProviderId;
  adaptVariant(
    record: RawScraperRecord,
    variant: Record<string, unknown>,
    workOrder: number,
  ): NormalizedImportVariant | ImportDiagnostic;
};

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const normalized = value.replace(/,/g, '').trim();
    if (normalized.length === 0) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseDurationSeconds(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parts = value.split(':').map((part) => Number(part));
  if (parts.length !== 2 && parts.length !== 3) return null;
  if (parts.some((part) => !Number.isInteger(part) || part < 0)) return null;
  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return seconds < 60 ? minutes * 60 + seconds : null;
  }
  const [hours, minutes, seconds] = parts;
  return minutes < 60 && seconds < 60 ? hours * 3600 + minutes * 60 + seconds : null;
}

function parseDateOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function difficultyRank(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const label = value.toLowerCase().trim();
  if (['beginner', 'easy', 'beginning'].includes(label)) return 1;
  if (['intermediate', 'medium'].includes(label)) return 2;
  if (['advanced', 'hard', 'expert', 'very advanced'].includes(label)) return 3;
  return null;
}

function sourceDifficultyLabel(value: unknown): string {
  if (typeof value !== 'string') return '';
  const label = value.toLowerCase().trim();
  if (['beginner', 'easy', 'beginning'].includes(label)) return 'Beginner';
  if (['intermediate', 'medium'].includes(label)) return 'Intermediate';
  if (['advanced', 'hard', 'expert', 'very advanced'].includes(label)) return 'Advanced';
  return value.trim();
}

function stringArrayOrNull(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.map(String);
}

function hostProvider(scoreUrl: string | null): ProviderId | 'unsupported' | null {
  if (!scoreUrl) return null;
  try {
    const hostname = new URL(scoreUrl).hostname.toLowerCase().replace(/^www\./, '');
    return hostname === 'musescore.com' || hostname.endsWith('.musescore.com')
      ? 'musescore'
      : 'unsupported';
  } catch {
    return null;
  }
}

export function parseProviderItemId(value: string): ProviderItemId {
  const match = /^([a-z][a-z0-9_-]*):(.+)$/i.exec(value.trim());
  if (!match || match[2].trim().length === 0) {
    throw new Error(`Malformed provider item id: ${value}`);
  }
  return { provider: match[1].toLowerCase(), itemId: match[2] };
}

function resolveProviderIdentity(
  variant: Record<string, unknown>,
): { provider: ProviderId; providerItemId: string } | ImportDiagnostic {
  const scoreId = stringOrNull(variant.score_id);
  const scoreUrl = stringOrNull(variant.score_url);
  const providerFromUrl = hostProvider(scoreUrl);

  if (scoreId?.includes(':')) {
    let parsed: ProviderItemId;
    try {
      parsed = parseProviderItemId(scoreId);
    } catch {
      return diagnostic('malformed-provider', 'Malformed provider-qualified score_id.', 0, scoreId, scoreUrl);
    }

    if (parsed.provider !== 'musescore') {
      return diagnostic('unsupported-provider', `Unsupported provider: ${parsed.provider}.`, 0, scoreId, scoreUrl);
    }

    if (providerFromUrl && providerFromUrl !== parsed.provider) {
      return diagnostic('malformed-provider', 'Provider-qualified score_id conflicts with score_url host.', 0, scoreId, scoreUrl);
    }

    return { provider: 'musescore', providerItemId: scoreId };
  }

  if (scoreId && providerFromUrl === 'musescore') {
    return { provider: 'musescore', providerItemId: `musescore:${scoreId}` };
  }

  if (!scoreId && providerFromUrl === 'musescore') {
    return diagnostic('malformed-provider', 'MuseScore variant is missing score_id.', 0, scoreId, scoreUrl);
  }

  return diagnostic('malformed-provider', 'Unable to resolve provider from score_id or score_url.', 0, scoreId, scoreUrl);
}

function diagnostic(
  code: ImportDiagnosticCode,
  message: string,
  workOrder: number,
  scoreId: string | null,
  scoreUrl: string | null,
): ImportDiagnostic {
  return { code, message, workOrder, scoreId, scoreUrl };
}

function isImportDiagnostic(
  value: ImportDiagnostic | NormalizedImportVariant,
): value is ImportDiagnostic {
  return typeof (value as ImportDiagnostic).message === 'string'
    && typeof (value as ImportDiagnostic).code === 'string';
}

export function resolveProviderAdapter(providerItemId: string): ProviderAdapter {
  const parsed = parseProviderItemId(providerItemId);
  if (parsed.provider !== 'musescore') {
    throw new Error(`Unsupported provider: ${parsed.provider}`);
  }
  return museScoreProviderAdapter;
}

export const museScoreProviderAdapter: ProviderAdapter = {
  provider: 'musescore',
  adaptVariant(record, variant, workOrder) {
    const identity = resolveProviderIdentity(variant);
    if ('code' in identity) {
      return { ...identity, workOrder };
    }

    const downloadStartedAt = parseDateOrNull(variant.download_started_at);
    if (!downloadStartedAt) {
      return diagnostic(
        'missing-timestamp',
        'Variant is missing a valid download_started_at timestamp.',
        workOrder,
        stringOrNull(variant.score_id),
        stringOrNull(variant.score_url),
      );
    }

    const title = stringValue(record.canonical_title);
    const artist = stringValue(record.artist_name);
    const sourceUrl = stringValue(variant.score_url);
    const rawRecord = { ...record };
    delete rawRecord.variants;

    return {
      difficulty_label: sourceDifficultyLabel(variant.difficulty_label),
      download_filename: stringOrNull(variant.download_filename),
      download_started_at: downloadStartedAt,
      score_id: identity.providerItemId,
      score_url: sourceUrl,
      provider: identity.provider,
      provider_item_id: identity.providerItemId,
      source_site: 'musescore',
      source_url: sourceUrl,
      canonical_url: sourceUrl || null,
      title,
      artist,
      artist_url: stringOrNull(record.artist_url),
      song_url: stringOrNull(record.song_url),
      uploader_name: stringOrNull(variant.uploader_name),
      uploader_url: stringOrNull(variant.uploader_url),
      difficulty_rank: difficultyRank(variant.difficulty_label),
      duration_seconds: parseDurationSeconds(variant.duration_hint),
      bpm: numberOrNull(variant.bpm_hint ?? variant.bpm),
      view_count: numberOrNull(variant.views),
      like_count: numberOrNull(variant.hearts),
      comment_count: numberOrNull(variant.comments),
      rating_score: numberOrNull(variant.rating),
      rating_count: numberOrNull(variant.rating_count),
      pages: stringOrNull(variant.pages),
      measures: stringOrNull(variant.measures),
      key: stringOrNull(variant.key),
      parts: stringOrNull(variant.parts),
      credits: stringOrNull(variant.credits),
      uploaded_at: parseDateOrNull(variant.uploaded),
      updated_at: parseDateOrNull(variant.updated),
      license_label: stringOrNull(variant.license_label),
      license_url: stringOrNull(variant.license_url),
      privacy: stringOrNull(variant.privacy),
      tags: stringArrayOrNull(variant.tags),
      related_versions: variant.related_versions ?? null,
      raw_metadata: {
        raw_record: rawRecord,
        raw_variant: { ...variant },
      },
      scraped_at: downloadStartedAt,
    };
  },
};

export function adaptScraperExportRecords(
  records: RawScraperRecord[],
): AdaptScraperExportResult {
  const normalizedRecords: NormalizedImportRecord[] = [];
  const diagnostics: ImportDiagnostic[] = [];

  records.forEach((record, index) => {
    const workOrder = Number(record.work_order ?? index + 1);
    const normalized: NormalizedImportRecord = {
      work_order: workOrder,
      canonical_title: stringValue(record.canonical_title),
      artist_name: stringValue(record.artist_name),
      artist_url: stringOrNull(record.artist_url),
      song_url: stringOrNull(record.song_url),
      variants: [],
    };

    for (const variant of record.variants ?? []) {
      const adapter = museScoreProviderAdapter;
      const adapted = adapter.adaptVariant(record, variant, workOrder);
      if (isImportDiagnostic(adapted)) {
        diagnostics.push(adapted);
      } else {
        normalized.variants.push(adapted);
      }
    }

    normalizedRecords.push(normalized);
  });

  return { records: normalizedRecords, diagnostics };
}
