import PgBoss from "pg-boss";

import { loadPipelineEnvFile } from "./env.js";
import { createRerankCanonicalJob } from "./jobs/rerank-canonical.js";
import { createPipelineRuntimeRepository } from "./lib/runtime-repository.js";
import { processPipelineJob } from "./lib/process-job.js";
import { createAiEnricher } from "./stages/ai-enricher.js";

export const PIPELINE_PROCESS_QUEUE = "pipeline.process";
export const PIPELINE_AI_ENRICH_QUEUE = "pipeline.ai-enrich";
export const PIPELINE_RERANK_CANONICAL_QUEUE = "pipeline.rerank-canonical";
export const PIPELINE_RERANK_CANONICAL_CRON = "0 3 * * *";
export const DEFAULT_PIPELINE_CONCURRENCY = 5;

type BossJob<T> = {
  data: T;
};

type BossLike = {
  start(): Promise<void>;
  stop(options?: {
    graceful?: boolean;
    close?: boolean;
    timeout?: number;
  }): Promise<void>;
  createQueue(name: string): Promise<unknown>;
  work<T>(
    name: string,
    options: { localConcurrency: number },
    handler: (jobs: Array<BossJob<T>>) => Promise<void>,
  ): Promise<unknown>;
  schedule(name: string, cron: string, data?: unknown): Promise<unknown>;
  send(
    name: string,
    data: unknown,
    options?: {
      retryLimit?: number;
      retryBackoff?: boolean;
      singletonKey?: string;
    },
  ): Promise<string | null>;
};

export type PipelineProcessPayload = {
  sourceUrl: string;
  sourceSite: string;
  rawTitle: string;
  rawArtist: string;
  tips?: string[];
  youtubeUrl?: string;
  file: Uint8Array | Buffer;
  dryRun: boolean;
};

type RegisterWorkerDependencies = {
  boss: BossLike;
  repository: Awaited<ReturnType<typeof createPipelineRuntimeRepository>>;
  aiEnricher: ReturnType<typeof createAiEnricher>;
  processJob?: typeof processPipelineJob;
  rerankJob?: ReturnType<typeof createRerankCanonicalJob>;
  concurrency?: number;
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export async function registerPipelineWorkers(
  dependencies: RegisterWorkerDependencies,
): Promise<void> {
  const processJob = dependencies.processJob ?? processPipelineJob;
  const rerankJob =
    dependencies.rerankJob ??
    createRerankCanonicalJob({ repository: dependencies.repository });
  const concurrency = dependencies.concurrency ?? DEFAULT_PIPELINE_CONCURRENCY;

  await dependencies.boss.createQueue(PIPELINE_PROCESS_QUEUE);
  await dependencies.boss.createQueue(PIPELINE_AI_ENRICH_QUEUE);
  await dependencies.boss.createQueue(PIPELINE_RERANK_CANONICAL_QUEUE);
  await dependencies.boss.schedule(
    PIPELINE_RERANK_CANONICAL_QUEUE,
    PIPELINE_RERANK_CANONICAL_CRON,
  );

  await dependencies.boss.work<PipelineProcessPayload>(
    PIPELINE_PROCESS_QUEUE,
    { localConcurrency: concurrency },
    async (jobs) => {
      for (const job of jobs) {
        try {
          const result = await processJob(job.data, dependencies.repository);

          if (
            result.outcome === "published" &&
            result.sheetId &&
            !job.data.dryRun
          ) {
            await dependencies.boss.send(
              PIPELINE_AI_ENRICH_QUEUE,
              { sheetId: result.sheetId },
              {
                retryLimit: 3,
                retryBackoff: true,
                singletonKey: result.sheetId,
              },
            );
          }
        } catch (error) {
          await dependencies.repository.saveJobStatus({
            sourceUrl: job.data.sourceUrl,
            sourceSite: job.data.sourceSite,
            rawTitle: job.data.rawTitle,
            status: "failed",
            state: "failed",
            phase: null,
            lastError: getErrorMessage(error),
            errorReason: "unexpected_exception",
            errorContext:
              error instanceof Error
                ? { message: error.message, stack: error.stack ?? null }
                : { message: String(error) },
          });
          throw error;
        }
      }
    },
  );

  await dependencies.boss.work<{ sheetId: string }>(
    PIPELINE_AI_ENRICH_QUEUE,
    { localConcurrency: concurrency },
    async (jobs) => {
      for (const job of jobs) {
        await dependencies.aiEnricher.enrich({ sheetId: job.data.sheetId });
      }
    },
  );

  await dependencies.boss.work(
    PIPELINE_RERANK_CANONICAL_QUEUE,
    { localConcurrency: 1 },
    async () => {
      await rerankJob.run();
    },
  );
}

export async function createPipelineWorker(options: {
  databaseUrl?: string;
  siteUrl?: string;
  revalidationSecret?: string;
  concurrency?: number;
}) {
  if (!options.databaseUrl && !options.siteUrl && !options.revalidationSecret) {
    loadPipelineEnvFile();
  }
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to start the pipeline worker.");
  }

  const boss = new PgBoss(databaseUrl) as unknown as BossLike;
  await boss.start();

  let repository:
    | Awaited<ReturnType<typeof createPipelineRuntimeRepository>>
    | undefined;

  try {
    repository = await createPipelineRuntimeRepository({
      databaseUrl,
      siteUrl: options.siteUrl,
      revalidationSecret: options.revalidationSecret,
    });
    const aiEnricher = createAiEnricher({ repository });

    await registerPipelineWorkers({
      boss,
      repository,
      aiEnricher,
      concurrency: options.concurrency,
    });
  } catch (error) {
    try {
      await boss.stop({ graceful: true, close: true });
    } catch {
      // Preserve the bootstrap failure as the primary error.
    }

    try {
      await repository?.close();
    } catch {
      // Preserve the bootstrap failure as the primary error.
    }

    throw error;
  }

  return {
    boss,
    repository,
    enqueueRunJob(payload: PipelineProcessPayload) {
      return boss.send(PIPELINE_PROCESS_QUEUE, payload, {
        retryLimit: 3,
        retryBackoff: true,
        singletonKey: payload.sourceUrl,
      });
    },
    async stop() {
      let stopError: unknown;
      let closeError: unknown;

      try {
        await boss.stop({ graceful: true, close: true });
      } catch (error) {
        stopError = error;
      }

      try {
        await repository?.close();
      } catch (error) {
        closeError = error;
      }

      if (stopError) {
        throw stopError;
      }

      if (closeError) {
        throw closeError;
      }
    },
  };
}
