import OpenAI from 'openai';

const AI_ENRICHER_MODEL = 'gpt-4o-mini';
const MAX_OUTPUT_TOKENS = 220;
const BUDGET_CAP_USD = 0.005;
const ESTIMATED_INPUT_COST_PER_1K = 0.00015;
const ESTIMATED_OUTPUT_COST_PER_1K = 0.0006;

type OpenAiLike = {
  responses: {
    create(request: {
      model: string;
      instructions: string;
      input: string;
      max_output_tokens: number;
    }): Promise<{ output_text?: string }>;
  };
};

type AiSheetRecord = {
  sheetId: string;
  title: string;
  artistName: string;
  genreName: string;
  difficultyLabel: string;
  sheetData: string;
  qualityScore: number;
  tips: string[];
};

type AiEnricherRepository = {
  getSheetForAiEnrichment(sheetId: string): Promise<AiSheetRecord | null>;
  updateSheetAiMetadata(update: {
    sheetId: string;
    seoTitle: string;
    seoDescription: string;
    tips: string[];
  }): Promise<void>;
};

type AiEnricherDependencies = {
  openai?: OpenAiLike;
  repository: AiEnricherRepository;
  model?: string;
  maxOutputTokens?: number;
};

type AiEnrichmentResult = {
  status: 'updated' | 'skipped';
  reason?: 'sheet_not_found' | 'budget_exceeded' | 'provider_error' | 'invalid_response';
  estimatedCostUsd?: number;
};

type ParsedAiPayload = {
  seoTitle: string;
  seoDescription: string;
  tips: string[];
};

function buildPrompt(record: AiSheetRecord): string {
  const notationPreview = record.sheetData.slice(0, 800);
  return [
    'Return strict JSON with seoTitle, seoDescription, and tips.',
    'Requirements:',
    '- seoTitle: concise, includes Roblox Piano Sheet phrasing.',
    '- seoDescription: 1 sentence, useful, non-clickbait, max 160 chars.',
    '- tips: array of 3 short practice tips.',
    '- No markdown fences or commentary.',
    '',
    `Title: ${record.title}`,
    `Artist: ${record.artistName}`,
    `Genre: ${record.genreName}`,
    `Difficulty: ${record.difficultyLabel}`,
    `Quality score: ${record.qualityScore.toFixed(2)}`,
    `Notation preview: ${notationPreview}`,
  ].join('\n');
}

export function estimateAiEnrichmentCost(input: string, maxOutputTokens = MAX_OUTPUT_TOKENS): number {
  const estimatedInputTokens = Math.ceil(input.length / 4);
  const inputCost = (estimatedInputTokens / 1000) * ESTIMATED_INPUT_COST_PER_1K;
  const outputCost = (maxOutputTokens / 1000) * ESTIMATED_OUTPUT_COST_PER_1K;
  return Number((inputCost + outputCost).toFixed(6));
}

function parseAiPayload(outputText: string | undefined, options: { requireTips: boolean }): ParsedAiPayload | null {
  if (!outputText) {
    return null;
  }

  try {
    const parsed = JSON.parse(outputText) as Record<string, unknown>;
    const seoTitle = typeof parsed.seoTitle === 'string' ? parsed.seoTitle.trim() : '';
    const seoDescription = typeof parsed.seoDescription === 'string' ? parsed.seoDescription.trim() : '';
    const tips = Array.isArray(parsed.tips)
      ? parsed.tips.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean).slice(0, 3)
      : [];

    if (!seoTitle || !seoDescription || (options.requireTips && tips.length === 0)) {
      return null;
    }

    return {
      seoTitle,
      seoDescription,
      tips,
    };
  } catch {
    return null;
  }
}

export function createAiEnricher(dependencies: AiEnricherDependencies) {
  const openai = dependencies.openai ?? new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = dependencies.model ?? AI_ENRICHER_MODEL;
  const maxOutputTokens = dependencies.maxOutputTokens ?? MAX_OUTPUT_TOKENS;

  return {
    async enrich(input: { sheetId: string }): Promise<AiEnrichmentResult> {
      const record = await dependencies.repository.getSheetForAiEnrichment(input.sheetId);
      if (!record) {
        return {
          status: 'skipped',
          reason: 'sheet_not_found',
        };
      }

      const prompt = buildPrompt(record);
      const estimatedCostUsd = estimateAiEnrichmentCost(prompt, maxOutputTokens);
      if (estimatedCostUsd > BUDGET_CAP_USD) {
        return {
          status: 'skipped',
          reason: 'budget_exceeded',
          estimatedCostUsd,
        };
      }

      try {
        const response = await openai.responses.create({
          model,
          instructions: 'You generate SEO metadata for a piano sheet catalog. Respond with valid JSON only.',
          input: prompt,
          max_output_tokens: maxOutputTokens,
        });

        const parsed = parseAiPayload(response.output_text, {
          requireTips: record.tips.length === 0,
        });
        if (!parsed) {
          return {
            status: 'skipped',
            reason: 'invalid_response',
            estimatedCostUsd,
          };
        }

        await dependencies.repository.updateSheetAiMetadata({
          sheetId: record.sheetId,
          seoTitle: parsed.seoTitle,
          seoDescription: parsed.seoDescription,
          tips: record.tips.length > 0 ? record.tips : parsed.tips,
        });

        return {
          status: 'updated',
          estimatedCostUsd,
        };
      } catch {
        return {
          status: 'skipped',
          reason: 'provider_error',
          estimatedCostUsd,
        };
      }
    },
  };
}