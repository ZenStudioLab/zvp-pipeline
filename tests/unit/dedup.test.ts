import { describe, expect, it } from 'vitest';

import { planDedupDecision } from '../../src/stages/dedup';

describe('planDedupDecision', () => {
  it('creates a new fingerprint plan for unseen songs', async () => {
    const decision = await planDedupDecision(
      {
        normalizedKey: 'yiruma-river flows in you',
        qualityScore: 0.81,
      },
      {
        findFingerprintByKey: async () => null,
      },
    );

    expect(decision.action).toBe('create-fingerprint');
    expect(decision.isCanonical).toBe(true);
    expect(decision.nextVersionCount).toBe(1);
    expect(decision.fingerprint.normalizedKey).toBe('yiruma-river flows in you');
  });

  it('promotes a new canonical version when the quality delta exceeds the configured threshold', async () => {
    const decision = await planDedupDecision(
      {
        normalizedKey: 'hans zimmer-interstellar',
        qualityScore: 0.9,
      },
      {
        findFingerprintByKey: async () => ({
          id: 'fp_1',
          normalizedKey: 'hans zimmer-interstellar',
          canonicalSheetId: 'sheet_old',
          canonicalQualityScore: 0.82,
          versionCount: 1,
        }),
      },
    );

    expect(decision.action).toBe('promote-canonical');
    expect(decision.isCanonical).toBe(true);
    expect(decision.canonicalSheetId).toBe('sheet_old');
    expect(decision.nextVersionCount).toBe(2);
  });

  it('creates an alternate sheet when the new quality score is within the dedup delta', async () => {
    const decision = await planDedupDecision(
      {
        normalizedKey: 'joe hisaishi-one summers day',
        qualityScore: 0.84,
      },
      {
        findFingerprintByKey: async () => ({
          id: 'fp_2',
          normalizedKey: 'joe hisaishi-one summers day',
          canonicalSheetId: 'sheet_canonical',
          canonicalQualityScore: 0.8,
          versionCount: 3,
        }),
      },
    );

    expect(decision.action).toBe('create-alternate');
    expect(decision.isCanonical).toBe(false);
    expect(decision.canonicalSheetId).toBe('sheet_canonical');
    expect(decision.nextVersionCount).toBe(4);
  });
});