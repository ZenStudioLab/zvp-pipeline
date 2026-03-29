import type {
  ConfidenceBand,
  MetadataNormalizationInput,
  NormalizedMetadata,
} from './types.js';

const UNKNOWN_ARTIST = 'Unknown Artist';
const GENERIC_TITLE_PATTERNS = [/^track\s*\d+$/i, /^untitled$/i, /^unknown$/i];
const TITLE_NOISE_PATTERNS = [
  /\((?:[^)]*(?:piano\s+version|tutorial|cover|arr\.?|arrangement|easy|intermediate|advanced|beginner)[^)]*)\)/gi,
  /\[(?:[^\]]*(?:synthesia|tutorial|easy|intermediate|advanced|beginner)[^\]]*)\]/gi,
  /(?:^|\s)[-–]\s*(?:v(?:ersion)?\s*\d+|ver\.?\s*\d+|revised|arrangement|tutorial)$/gi,
  /(?:^|\s)(?:easy|intermediate|advanced|beginner)\s*$/gi,
];
const ARTIST_SPLIT_PATTERNS = [/(?:\s+(?:feat\.?|ft\.?|featuring|with)\s+.+)$/i];

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toLocaleUpperCase() + token.slice(1).toLocaleLowerCase())
    .join(' ');
}

function stripDiacritics(value: string): string {
  return value.normalize('NFD').replace(/\p{M}+/gu, '');
}

function normalizeComparisonKey(value: string): string {
  return stripDiacritics(value)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  if (left.length === 0) {
    return right.length;
  }

  if (right.length === 0) {
    return left.length;
  }

  const previous = new Array<number>(right.length + 1);
  const current = new Array<number>(right.length + 1);

  for (let column = 0; column <= right.length; column += 1) {
    previous[column] = column;
  }

  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row;

    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + cost,
      );
    }

    for (let column = 0; column <= right.length; column += 1) {
      previous[column] = current[column];
    }
  }

  return previous[right.length];
}

function similarity(left: string, right: string): number {
  if (!left && !right) {
    return 1;
  }

  const longestLength = Math.max(left.length, right.length, 1);
  return 1 - levenshteinDistance(left, right) / longestLength;
}

function cleanTitle(rawTitle: string): { value: string; noiseCount: number; wasGeneric: boolean } {
  let value = rawTitle.normalize('NFC').trim();
  let noiseCount = 0;

  for (const pattern of TITLE_NOISE_PATTERNS) {
    value = value.replace(pattern, (match) => {
      if (match.trim().length > 0) {
        noiseCount += 1;
      }
      return ' ';
    });
  }

  value = value.replace(/\s+/g, ' ').replace(/[\s-–]+$/g, '').trim();
  value = toTitleCase(value || 'Untitled');

  return {
    value,
    noiseCount,
    wasGeneric: GENERIC_TITLE_PATTERNS.some((pattern) => pattern.test(value)),
  };
}

function cleanArtist(rawArtist: string): { value: string; noiseCount: number; wasMissing: boolean } {
  let value = rawArtist.normalize('NFC').trim();
  let noiseCount = 0;

  for (const pattern of ARTIST_SPLIT_PATTERNS) {
    const nextValue = value.replace(pattern, '');
    if (nextValue !== value) {
      noiseCount += 1;
      value = nextValue;
    }
  }

  value = value.replace(/\s+/g, ' ').trim();

  if (!value) {
    return {
      value: UNKNOWN_ARTIST,
      noiseCount,
      wasMissing: true,
    };
  }

  return {
    value: toTitleCase(value),
    noiseCount,
    wasMissing: false,
  };
}

function resolveArtistCandidate(candidate: string, existingArtistNames: string[] | undefined): string {
  if (!existingArtistNames || existingArtistNames.length === 0) {
    return candidate;
  }

  const normalizedCandidate = normalizeComparisonKey(candidate);
  let bestMatch = candidate;
  let bestScore = 0;

  for (const existingArtistName of existingArtistNames) {
    const candidateScore = similarity(normalizedCandidate, normalizeComparisonKey(existingArtistName));
    if (candidateScore > bestScore) {
      bestScore = candidateScore;
      bestMatch = existingArtistName;
    }
  }

  return bestScore >= 0.85 ? bestMatch : candidate;
}

function getConfidenceBand(score: number): ConfidenceBand {
  if (score >= 0.8) {
    return 'high';
  }

  if (score >= 0.5) {
    return 'medium';
  }

  return 'low';
}

export function normalizeMetadata(input: MetadataNormalizationInput): NormalizedMetadata {
  const cleanedTitle = cleanTitle(input.rawTitle);
  const cleanedArtist = cleanArtist(input.rawArtist);
  const artist = resolveArtistCandidate(cleanedArtist.value, input.existingArtistNames);
  const normalizedTitle = normalizeComparisonKey(cleanedTitle.value);
  const normalizedArtist = normalizeComparisonKey(artist);

  let confidenceScore = 0.95;
  confidenceScore -= cleanedTitle.noiseCount * 0.1;
  confidenceScore -= cleanedArtist.noiseCount * 0.08;

  if (cleanedArtist.wasMissing) {
    confidenceScore -= 0.45;
  }

  if (cleanedTitle.wasGeneric) {
    confidenceScore -= 0.15;
  }

  const boundedScore = clamp01(confidenceScore);

  return {
    title: cleanedTitle.value,
    artist,
    normalizedTitle,
    normalizedArtist,
    normalizedKey: `${normalizedArtist}-${normalizedTitle}`,
    confidenceScore: boundedScore,
    confidenceBand: getConfidenceBand(boundedScore),
  };
}

export { getConfidenceBand };