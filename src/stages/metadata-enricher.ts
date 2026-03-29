import type {
  ArtistRecord,
  DifficultyRecord,
  GenreRecord,
  MetadataEnrichmentInput,
  MetadataEnrichmentResult,
} from './types.js';

const DEFAULT_GENRE_KEYWORDS: Record<string, string[]> = {
  soundtrack: ['theme', 'ost', 'soundtrack', 'score'],
  anime: ['anime', 'opening', 'ending', 'op', 'ed'],
  classical: ['sonata', 'concerto', 'waltz', 'nocturne', 'symphony'],
};
const DEFAULT_THUMBNAIL_URL = 'https://zenpiano.art/images/placeholders/sheet-default.webp';

export type MetadataEnrichmentRepository = {
  genres: GenreRecord[];
  difficulties: DifficultyRecord[];
  findArtistByNormalizedName(normalizedName: string): Promise<ArtistRecord | null>;
  createArtist(input: { name: string; slug: string; normalizedName: string }): Promise<ArtistRecord>;
};

type MetadataEnrichmentOptions = {
  allowArtistCreation?: boolean;
};

function stripDiacritics(value: string): string {
  return value.normalize('NFD').replace(/\p{M}+/gu, '');
}

function slugify(value: string): string {
  return stripDiacritics(value)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function resolveThumbnailUrl(youtubeUrl?: string): string {
  if (!youtubeUrl) {
    return DEFAULT_THUMBNAIL_URL;
  }

  const match = youtubeUrl.match(/[?&]v=([^&]+)/) ?? youtubeUrl.match(/youtu\.be\/([^?&]+)/);
  if (!match?.[1]) {
    return DEFAULT_THUMBNAIL_URL;
  }

  return `https://img.youtube.com/vi/${match[1]}/hqdefault.jpg`;
}

function resolveGenre(genres: GenreRecord[], input: MetadataEnrichmentInput): GenreRecord {
  const haystack = `${input.title} ${input.artist}`.toLocaleLowerCase();

  for (const genre of genres) {
    const keywords = DEFAULT_GENRE_KEYWORDS[genre.slug] ?? [genre.name.toLocaleLowerCase()];
    if (keywords.some((keyword) => haystack.includes(keyword))) {
      return genre;
    }
  }

  return genres.find((genre) => genre.slug === 'classical') ?? genres[0];
}

function resolveDifficulty(difficulties: DifficultyRecord[], notesPerSecond: number): DifficultyRecord {
  const targetSlug = notesPerSecond <= 2 ? 'beginner' : notesPerSecond <= 4 ? 'intermediate' : notesPerSecond <= 6 ? 'advanced' : 'expert';
  return difficulties.find((difficulty) => difficulty.slug === targetSlug) ?? [...difficulties].sort((left, right) => left.level - right.level)[0];
}

async function resolveArtist(
  input: MetadataEnrichmentInput,
  repository: MetadataEnrichmentRepository,
  options: MetadataEnrichmentOptions,
): Promise<ArtistRecord> {
  const existingArtist = await repository.findArtistByNormalizedName(input.normalizedArtist);
  if (existingArtist) {
    return existingArtist;
  }

  if (options.allowArtistCreation === false) {
    return {
      id: 'preview_artist',
      slug: slugify(input.artist),
      name: input.artist,
    };
  }

  return repository.createArtist({
    name: input.artist,
    slug: slugify(input.artist),
    normalizedName: input.normalizedArtist,
  });
}

export async function enrichSheetMetadata(
  input: MetadataEnrichmentInput,
  repository: MetadataEnrichmentRepository,
  options: MetadataEnrichmentOptions = {},
): Promise<MetadataEnrichmentResult> {
  return {
    slug: slugify(`${input.title} ${input.artist}`),
    thumbnailUrl: resolveThumbnailUrl(input.youtubeUrl),
    genre: resolveGenre(repository.genres, input),
    difficulty: resolveDifficulty(repository.difficulties, input.notesPerSecond),
    artist: await resolveArtist(input, repository, options),
  };
}