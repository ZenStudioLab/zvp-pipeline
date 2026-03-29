import { PIPELINE_THRESHOLDS } from '../config.js';
import type { DedupDecision, DedupInput, FingerprintRecord } from './types.js';

export type DedupRepository = {
  findFingerprintByKey(normalizedKey: string): Promise<FingerprintRecord | null>;
};

export async function planDedupDecision(input: DedupInput, repository: DedupRepository): Promise<DedupDecision> {
  const fingerprint = await repository.findFingerprintByKey(input.normalizedKey);

  if (!fingerprint) {
    return {
      action: 'create-fingerprint',
      isCanonical: true,
      canonicalSheetId: null,
      nextVersionCount: 1,
      fingerprint: {
        normalizedKey: input.normalizedKey,
        canonicalSheetId: null,
        versionCount: 1,
        shouldCreate: true,
        shouldPromoteCanonical: false,
      },
    };
  }

  const nextVersionCount = fingerprint.versionCount + 1;
  const canonicalQualityScore = fingerprint.canonicalQualityScore ?? 0;
  const qualityDelta = input.qualityScore - canonicalQualityScore;

  if (qualityDelta > PIPELINE_THRESHOLDS.dedupPromotionDelta) {
    return {
      action: 'promote-canonical',
      isCanonical: true,
      canonicalSheetId: fingerprint.canonicalSheetId,
      nextVersionCount,
      fingerprint: {
        normalizedKey: fingerprint.normalizedKey,
        canonicalSheetId: fingerprint.canonicalSheetId,
        versionCount: nextVersionCount,
        shouldCreate: false,
        shouldPromoteCanonical: true,
      },
    };
  }

  return {
    action: 'create-alternate',
    isCanonical: false,
    canonicalSheetId: fingerprint.canonicalSheetId,
    nextVersionCount,
    fingerprint: {
      normalizedKey: fingerprint.normalizedKey,
      canonicalSheetId: fingerprint.canonicalSheetId,
      versionCount: nextVersionCount,
      shouldCreate: false,
      shouldPromoteCanonical: false,
    },
  };
}