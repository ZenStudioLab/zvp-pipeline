import { PIPELINE_RERANK } from "../config.js";

const LANDING_PAGE_LOCALES = [
  "en",
  "en_US",
  "en_GB",
  "en_PH",
  "ar",
  "bn",
  "de",
  "es",
  "fr",
  "hi",
  "id",
  "ja",
  "ko",
  "mr",
  "pl",
  "pt_BR",
  "ru",
  "ta",
  "te",
  "th",
  "tr",
  "ur",
  "vi",
  "zh_CN",
  "zh_HK",
] as const;
const DEFAULT_LOCALE = "en";

type RerankScoringConfig = {
  threshold: number;
  qualityWeight: number;
  ratingWeight: number;
};

type RerankFingerprint = {
  normalizedKey: string;
  canonicalSheetId: string | null;
  versionCount: number;
};

type RerankSheetVersion = {
  id: string;
  slug: string;
  qualityScore: number | null;
  ratingScore: number | null;
  ratingCount: number;
  isCanonical: boolean;
};

type RerankRepository = {
  listFingerprintsForRerank(): Promise<RerankFingerprint[]>;
  listVersionsForFingerprint(
    normalizedKey: string,
  ): Promise<RerankSheetVersion[]>;
  swapCanonicalSheet(input: {
    normalizedKey: string;
    nextCanonicalSheetId: string;
    versionSheetIds: string[];
  }): Promise<void>;
  revalidatePaths(paths: string[]): Promise<void>;
};

type ComputeRerankScoreInput = {
  qualityScore: number | null;
  ratingScore: number | null;
  ratingCount: number;
};

export function computeRerankScore(
  input: ComputeRerankScoreInput,
  config: RerankScoringConfig = PIPELINE_RERANK,
): number {
  const qualityScore = input.qualityScore ?? 0;
  const ratingScore = input.ratingScore ?? 0;

  if (input.ratingCount < config.threshold) {
    return qualityScore;
  }

  return (
    qualityScore * config.qualityWeight + ratingScore * config.ratingWeight
  );
}

function buildRevalidationPaths(
  previousSlug: string,
  nextSlug: string,
): string[] {
  const localizedBasePaths = [
    `/catalog`,
    `/sheet/${previousSlug}`,
    `/sheet/${nextSlug}`,
  ];

  const localizedPaths = LANDING_PAGE_LOCALES.flatMap((locale) => {
    if (locale === DEFAULT_LOCALE) {
      return [];
    }

    return localizedBasePaths.map((path) => `/${locale}${path}`);
  });

  return Array.from(
    new Set([
      "/",
      "/catalog",
      `/sheet/${previousSlug}`,
      `/sheet/${nextSlug}`,
      ...localizedPaths,
    ]),
  );
}

function selectLeader(
  versions: RerankSheetVersion[],
  config: RerankScoringConfig,
): RerankSheetVersion {
  const currentCanonical = versions.find((version) => version.isCanonical);

  return versions.reduce((leader, candidate) => {
    const leaderScore = computeRerankScore(leader, config);
    const candidateScore = computeRerankScore(candidate, config);

    if (candidateScore > leaderScore) {
      return candidate;
    }

    if (candidateScore < leaderScore) {
      return leader;
    }

    if (currentCanonical && candidate.id === currentCanonical.id) {
      return candidate;
    }

    if (currentCanonical && leader.id === currentCanonical.id) {
      return leader;
    }

    const leaderQuality = leader.qualityScore ?? 0;
    const candidateQuality = candidate.qualityScore ?? 0;

    if (candidateQuality > leaderQuality) {
      return candidate;
    }

    return leader;
  }, versions[0]!);
}

export async function rerankCanonicalSheets(
  repository: RerankRepository,
  config: RerankScoringConfig = PIPELINE_RERANK,
): Promise<{ scannedFingerprints: number; swappedFingerprints: number }> {
  const fingerprints = await repository.listFingerprintsForRerank();
  let swappedFingerprints = 0;

  for (const fingerprint of fingerprints) {
    const versions = await repository.listVersionsForFingerprint(
      fingerprint.normalizedKey,
    );

    if (versions.length <= 1) {
      continue;
    }

    const previousCanonical =
      versions.find((version) => version.id === fingerprint.canonicalSheetId) ??
      versions.find((version) => version.isCanonical);
    if (!previousCanonical) {
      continue;
    }

    const leader = selectLeader(versions, config);
    if (leader.id === previousCanonical.id) {
      continue;
    }

    await repository.swapCanonicalSheet({
      normalizedKey: fingerprint.normalizedKey,
      nextCanonicalSheetId: leader.id,
      versionSheetIds: versions.map((version) => version.id),
    });

    await repository.revalidatePaths(
      buildRevalidationPaths(previousCanonical.slug, leader.slug),
    );
    swappedFingerprints += 1;
  }

  return {
    scannedFingerprints: fingerprints.length,
    swappedFingerprints,
  };
}

export function createRerankCanonicalJob(dependencies: {
  repository: RerankRepository;
  config?: RerankScoringConfig;
}) {
  return {
    run() {
      return rerankCanonicalSheets(
        dependencies.repository,
        dependencies.config ?? PIPELINE_RERANK,
      );
    },
  };
}
