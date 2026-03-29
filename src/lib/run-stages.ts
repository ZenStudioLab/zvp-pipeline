import { convertMidiSource } from '../stages/converter.js';
import { planDedupDecision } from '../stages/dedup.js';
import { enrichSheetMetadata } from '../stages/metadata-enricher.js';
import { normalizeMetadata } from '../stages/normalizer.js';
import { scoreConversionQuality } from '../stages/quality-scorer.js';
import type {
  ArtistRecord,
  DedupDecision,
  DifficultyRecord,
  GenreRecord,
  MetadataEnrichmentResult,
  NormalizedMetadata,
  QualityAssessment,
} from '../stages/types.js';

export type StageEvaluationRepository = {
  genres: GenreRecord[];
  difficulties: DifficultyRecord[];
  getExistingArtistNames(): Promise<string[]>;
  findArtistByNormalizedName(normalizedName: string): Promise<ArtistRecord | null>;
  createArtist(input: { name: string; slug: string; normalizedName: string }): Promise<ArtistRecord>;
  findFingerprintByKey(normalizedKey: string): Promise<{
    normalizedKey: string;
    canonicalSheetId: string | null;
    canonicalQualityScore: number | null;
    versionCount: number;
  } | null>;
};

export type StageEvaluationInput = {
  rawTitle: string;
  rawArtist: string;
  youtubeUrl?: string;
  file: Uint8Array | Buffer;
};

type StageEvaluationOptions = {
  allowArtistCreation?: boolean;
};

export type FailedStageEvaluation = {
  ok: false;
  normalized: NormalizedMetadata;
  rejectionReason: 'corrupted_midi' | 'empty_midi' | 'percussion_only';
};

export type SuccessfulStageEvaluation = {
  ok: true;
  normalized: NormalizedMetadata;
  conversion: {
    sheetData: string;
    bpm: number;
    durationSeconds: number;
    noteCount: number;
    notesPerSecond: number;
  };
  qualityAssessment: QualityAssessment;
  dedupDecision: DedupDecision;
  enrichment: MetadataEnrichmentResult;
};

export async function evaluatePipelineStages(
  input: StageEvaluationInput,
  repository: StageEvaluationRepository,
  options: StageEvaluationOptions = {},
): Promise<FailedStageEvaluation | SuccessfulStageEvaluation> {
  const normalized = normalizeMetadata({
    rawTitle: input.rawTitle,
    rawArtist: input.rawArtist,
    existingArtistNames: await repository.getExistingArtistNames(),
  });

  const conversion = convertMidiSource({ file: input.file });
  if (!conversion.ok) {
    return {
      ok: false,
      normalized,
      rejectionReason: conversion.rejectionReason,
    };
  }

  const qualityAssessment = scoreConversionQuality(conversion.qualitySignals);
  const dedupDecision = await planDedupDecision(
    {
      normalizedKey: normalized.normalizedKey,
      qualityScore: qualityAssessment.score,
    },
    repository,
  );
  const enrichment = await enrichSheetMetadata(
    {
      title: normalized.title,
      artist: normalized.artist,
      normalizedArtist: normalized.normalizedArtist,
      notesPerSecond: conversion.notesPerSecond,
      youtubeUrl: input.youtubeUrl,
    },
    repository,
    options,
  );

  return {
    ok: true,
    normalized,
    conversion: {
      sheetData: conversion.sheetData,
      bpm: conversion.bpm,
      durationSeconds: conversion.durationSeconds,
      noteCount: conversion.noteCount,
      notesPerSecond: conversion.notesPerSecond,
    },
    qualityAssessment,
    dedupDecision,
    enrichment,
  };
}