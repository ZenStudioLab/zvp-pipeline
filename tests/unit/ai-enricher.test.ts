import { describe, expect, it, vi } from 'vitest';

import { createAiEnricher } from '../../src/stages/ai-enricher.js';

function createRepository(sheetData = '[tu]y--d', tips: string[] = []) {
  return {
    getSheetForAiEnrichment: vi.fn(async () => ({
      sheetId: 'sheet_1',
      title: 'Interstellar Main Theme',
      artistName: 'Hans Zimmer',
      genreName: 'Soundtrack',
      difficultyLabel: 'Advanced',
      sheetData,
      qualityScore: 0.88,
      tips,
    })),
    updateSheetAiMetadata: vi.fn(async () => undefined),
  };
}

describe('createAiEnricher', () => {
  it('updates sheet SEO fields from a successful model response', async () => {
    const repository = createRepository();
    const openai = {
      responses: {
        create: vi.fn(async () => ({
          output_text: JSON.stringify({
            seoTitle: 'Interstellar Main Theme - Roblox Piano Sheet',
            seoDescription: 'Play Interstellar by Hans Zimmer on Roblox Virtual Piano with a polished fanmade sheet.',
            tips: ['Start slowly', 'Keep a steady left hand pulse', 'Practice the jumps separately'],
          }),
        })),
      },
    };

    const enricher = createAiEnricher({ repository, openai });
    const result = await enricher.enrich({ sheetId: 'sheet_1' });

    expect(result).toEqual({
      status: 'updated',
      estimatedCostUsd: expect.any(Number),
    });
    expect(repository.updateSheetAiMetadata).toHaveBeenCalledWith({
      sheetId: 'sheet_1',
      seoTitle: 'Interstellar Main Theme - Roblox Piano Sheet',
      seoDescription: 'Play Interstellar by Hans Zimmer on Roblox Virtual Piano with a polished fanmade sheet.',
      tips: ['Start slowly', 'Keep a steady left hand pulse', 'Practice the jumps separately'],
    });
  });

  it('preserves scraped tips when they already exist on the sheet', async () => {
    const repository = createRepository('[tu]y--d', ['EaglesFan: Great arrangement.']);
    const openai = {
      responses: {
        create: vi.fn(async () => ({
          output_text: JSON.stringify({
            seoTitle: 'Hotel California - Roblox Piano Sheet',
            seoDescription: 'Play Hotel California on Roblox Virtual Piano with a fanmade sheet.',
            tips: ['Start slowly', 'Loop the chorus', 'Practice the jumps separately'],
          }),
        })),
      },
    };

    const enricher = createAiEnricher({ repository, openai });
    await enricher.enrich({ sheetId: 'sheet_1' });

    expect(repository.updateSheetAiMetadata).toHaveBeenCalledWith({
      sheetId: 'sheet_1',
      seoTitle: 'Hotel California - Roblox Piano Sheet',
      seoDescription: 'Play Hotel California on Roblox Virtual Piano with a fanmade sheet.',
      tips: ['EaglesFan: Great arrangement.'],
    });
  });

  it('accepts SEO-only AI responses when scraped tips already exist', async () => {
    const repository = createRepository('[tu]y--d', ['EaglesFan: Great arrangement.']);
    const openai = {
      responses: {
        create: vi.fn(async () => ({
          output_text: JSON.stringify({
            seoTitle: 'Hotel California - Roblox Piano Sheet',
            seoDescription: 'Play Hotel California on Roblox Virtual Piano with a fanmade sheet.',
            tips: [],
          }),
        })),
      },
    };

    const enricher = createAiEnricher({ repository, openai });
    const result = await enricher.enrich({ sheetId: 'sheet_1' });

    expect(result).toEqual({
      status: 'updated',
      estimatedCostUsd: expect.any(Number),
    });
    expect(repository.updateSheetAiMetadata).toHaveBeenCalledWith({
      sheetId: 'sheet_1',
      seoTitle: 'Hotel California - Roblox Piano Sheet',
      seoDescription: 'Play Hotel California on Roblox Virtual Piano with a fanmade sheet.',
      tips: ['EaglesFan: Great arrangement.'],
    });
  });

  it('returns a non-blocking skip when the model call fails', async () => {
    const repository = createRepository();
    const openai = {
      responses: {
        create: vi.fn(async () => {
          throw new Error('provider outage');
        }),
      },
    };

    const enricher = createAiEnricher({ repository, openai });
    const result = await enricher.enrich({ sheetId: 'sheet_1' });

    expect(result).toEqual({
      status: 'skipped',
      reason: 'provider_error',
      estimatedCostUsd: expect.any(Number),
    });
    expect(repository.updateSheetAiMetadata).not.toHaveBeenCalled();
  });

  it('skips the request when the estimated cost exceeds the budget cap', async () => {
    const repository = createRepository('x'.repeat(40000));
    const openai = {
      responses: {
        create: vi.fn(async () => ({ output_text: '{}' })),
      },
    };

    const enricher = createAiEnricher({
      repository,
      openai,
      maxOutputTokens: 9000,
    });
    const result = await enricher.enrich({ sheetId: 'sheet_1' });

    expect(result).toEqual({
      status: 'skipped',
      reason: 'budget_exceeded',
      estimatedCostUsd: expect.any(Number),
    });
    expect(openai.responses.create).not.toHaveBeenCalled();
  });
});