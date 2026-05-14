import type {
  DifficultyLevel,
  QualitySignals as MidiQualitySignals,
  ScoringAssessment,
} from "@zen/midi-to-vp";
import type { SourceDifficultyLabel } from "./canonical-selector.js";

export type ConfidenceBand = "high" | "medium" | "low";

export type MetadataNormalizationInput = {
  rawTitle: string;
  rawArtist: string;
  existingArtistNames?: string[];
};

export type NormalizedMetadata = {
  title: string;
  artist: string;
  normalizedTitle: string;
  normalizedArtist: string;
  normalizedKey: string;
  confidenceScore: number;
  confidenceBand: ConfidenceBand;
};

export type QualityScoreBand = "publish" | "review" | "reject";

export type QualityAssessment = ScoringAssessment & {
  scoreBand: QualityScoreBand;
};

export type FingerprintRecord = {
  id?: string;
  normalizedKey: string;
  canonicalSheetId: string | null;
  canonicalQualityScore: number | null;
  versionCount: number;
};

export type DedupInput = {
  normalizedKey: string;
  qualityScore: number;
};

export type DedupAction =
  | "create-fingerprint"
  | "promote-canonical"
  | "create-alternate";

export type DedupDecision = {
  action: DedupAction;
  isCanonical: boolean;
  canonicalSheetId: string | null;
  nextVersionCount: number;
  fingerprint: {
    normalizedKey: string;
    canonicalSheetId: string | null;
    versionCount: number;
    shouldCreate: boolean;
    shouldPromoteCanonical: boolean;
  };
};

export type GenreRecord = {
  id: string;
  slug: string;
  name: string;
};

export type DifficultyRecord = {
  id: string;
  slug: string;
  label: string;
  level: number;
};

export type ArtistRecord = {
  id: string;
  slug: string;
  name: string;
};

export type MetadataEnrichmentInput = {
  title: string;
  artist: string;
  normalizedArtist: string;
  notesPerSecond: number;
  youtubeUrl?: string;
};

export type MetadataEnrichmentResult = {
  slug: string;
  thumbnailUrl: string;
  genre: GenreRecord;
  difficulty: DifficultyRecord;
  artist: ArtistRecord;
};

export type ConverterQualitySignals = MidiQualitySignals;

export type ConverterSuccess = {
  ok: true;
  sheetData: string;
  bpm: number;
  durationSeconds: number;
  noteCount: number;
  notesPerSecond: number;
  warnings: string[];
  qualitySignals: ConverterQualitySignals;
};

export type ConverterFailure = {
  ok: false;
  rejectionReason: "corrupted_midi" | "empty_midi" | "percussion_only";
  details?: Record<string, unknown>;
};

export type ConverterResult = ConverterSuccess | ConverterFailure;

export type PublisherInput = {
  title: string;
  slug: string;
  artist: ArtistRecord;
  genre: GenreRecord;
  difficulty: DifficultyRecord;
  thumbnailUrl: string;
  sheetData: string;
  bpm: number;
  durationSeconds: number;
  noteCount: number;
  notesPerSecond: number;
  qualityScore: number;
  confidenceScore: number;
  source: string;
  sourceUrl: string;
  tips?: string[];
  youtubeUrl?: string;
  isCanonical: boolean;
  canonicalSheetId: string | null;
  normalizedKey: string;
  nextVersionCount: number;
  dryRun: boolean;
  /** Import provenance — set for imported sheets only. */
  workId?: string | null;
  arrangementId?: string | null;
  sourceDifficultyLabel?: SourceDifficultyLabel | null;
  conversionLevel?: DifficultyLevel | null;
};

export type PublisherOutcome =
  | "published"
  | "needs_review"
  | "rejected"
  | "dry_run";

export type PublisherResult = {
  outcome: PublisherOutcome;
  sheetId: string | null;
  revalidatedPaths: string[];
};
