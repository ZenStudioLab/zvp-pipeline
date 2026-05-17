import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PIPELINE_CONCURRENCY,
  PIPELINE_AI_ENRICH_QUEUE,
  PIPELINE_PROCESS_QUEUE,
  PIPELINE_RERANK_CANONICAL_CRON,
  PIPELINE_RERANK_CANONICAL_QUEUE,
  registerPipelineWorkers,
} from "../../src/worker.js";

function createBossMock() {
  const registrations: Array<{
    name: string;
    options: { localConcurrency: number };
    handler: (jobs: Array<{ data: any }>) => Promise<void>;
  }> = [];
  const createQueue = vi.fn(async () => undefined);
  const schedule = vi.fn(async () => undefined);
  const work = vi.fn(
    async (
      name: string,
      options: { localConcurrency: number },
      handler: (jobs: Array<{ data: any }>) => Promise<void>,
    ) => {
      registrations.push({ name, options, handler });
      return `${name}-worker`;
    },
  );
  const send = vi.fn(async () => "job_1");

  return {
    boss: {
      createQueue,
      schedule,
      work,
      send,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    },
    registrations,
    createQueue,
    schedule,
    send,
  };
}

describe("registerPipelineWorkers", () => {
  it("registers process and AI workers with configurable concurrency", async () => {
    const { boss, registrations, createQueue, schedule } = createBossMock();
    const processJob = vi.fn(async () => ({
      idempotent: false,
      outcome: "published" as const,
      sheetId: "sheet_1",
      transitions: [],
    }));

    await registerPipelineWorkers({
      boss: boss as never,
      repository: {} as never,
      aiEnricher: {
        enrich: vi.fn(async () => ({ status: "updated" })),
      } as never,
      processJob,
      concurrency: 7,
    });

    expect(createQueue).toHaveBeenNthCalledWith(1, PIPELINE_PROCESS_QUEUE);
    expect(createQueue).toHaveBeenNthCalledWith(2, PIPELINE_AI_ENRICH_QUEUE);
    expect(createQueue).toHaveBeenNthCalledWith(
      3,
      PIPELINE_RERANK_CANONICAL_QUEUE,
    );
    expect(schedule).toHaveBeenCalledWith(
      PIPELINE_RERANK_CANONICAL_QUEUE,
      PIPELINE_RERANK_CANONICAL_CRON,
    );
    expect(registrations.map((registration) => registration.name)).toEqual([
      PIPELINE_PROCESS_QUEUE,
      PIPELINE_AI_ENRICH_QUEUE,
      PIPELINE_RERANK_CANONICAL_QUEUE,
    ]);
    expect(
      registrations.map(
        (registration) => registration.options.localConcurrency,
      ),
    ).toEqual([7, 7, 1]);
  });

  it("enqueues AI enrichment only for published non-dry-run results", async () => {
    const { boss, registrations, send } = createBossMock();
    const processJob = vi.fn(async () => ({
      idempotent: false,
      outcome: "published" as const,
      sheetId: "sheet_9",
      transitions: [],
    }));

    await registerPipelineWorkers({
      boss: boss as never,
      repository: {} as never,
      aiEnricher: {
        enrich: vi.fn(async () => ({ status: "updated" })),
      } as never,
      processJob,
      concurrency: DEFAULT_PIPELINE_CONCURRENCY,
    });

    const processRegistration = registrations.find(
      (registration) => registration.name === PIPELINE_PROCESS_QUEUE,
    );
    await processRegistration?.handler([
      {
        data: {
          sourceUrl: "https://example.com/interstellar.mid",
          sourceSite: "freemidi",
          rawTitle: "Interstellar",
          rawArtist: "Hans Zimmer",
          tips: ["Start slowly"],
          file: new Uint8Array([1, 2, 3]),
          dryRun: false,
        },
      },
    ]);

    expect(processJob).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceUrl: "https://example.com/interstellar.mid",
        tips: ["Start slowly"],
      }),
      expect.anything(),
    );
    expect(send).toHaveBeenCalledWith(
      PIPELINE_AI_ENRICH_QUEUE,
      { sheetId: "sheet_9" },
      expect.objectContaining({
        retryLimit: 3,
        retryBackoff: true,
        singletonKey: "sheet_9",
      }),
    );
  });

  it("does not enqueue AI enrichment for dry runs", async () => {
    const { boss, registrations, send } = createBossMock();
    const processJob = vi.fn(async () => ({
      idempotent: false,
      outcome: "published" as const,
      sheetId: "sheet_3",
      transitions: [],
    }));

    await registerPipelineWorkers({
      boss: boss as never,
      repository: {} as never,
      aiEnricher: {
        enrich: vi.fn(async () => ({ status: "updated" })),
      } as never,
      processJob,
    });

    const processRegistration = registrations.find(
      (registration) => registration.name === PIPELINE_PROCESS_QUEUE,
    );
    await processRegistration?.handler([
      {
        data: {
          sourceUrl: "https://example.com/test.mid",
          sourceSite: "freemidi",
          rawTitle: "Test",
          rawArtist: "Artist",
          file: new Uint8Array([1, 2, 3]),
          dryRun: true,
        },
      },
    ]);

    expect(send).not.toHaveBeenCalled();
  });

  it("persists failed job status before rethrowing worker errors", async () => {
    const { boss, registrations } = createBossMock();
    const saveJobStatus = vi.fn(async () => undefined);

    await registerPipelineWorkers({
      boss: boss as never,
      repository: { saveJobStatus } as never,
      aiEnricher: {
        enrich: vi.fn(async () => ({ status: "updated" })),
      } as never,
      processJob: vi.fn(async () => {
        throw new Error("revalidation failed");
      }) as never,
    });

    const processRegistration = registrations.find(
      (registration) => registration.name === PIPELINE_PROCESS_QUEUE,
    );

    await expect(
      processRegistration?.handler([
        {
          data: {
            sourceUrl: "https://example.com/failure.mid",
            sourceSite: "freemidi",
            rawTitle: "Failure Case",
            rawArtist: "Artist",
            file: new Uint8Array([1, 2, 3]),
            dryRun: false,
          },
        },
      ]) ?? Promise.resolve(),
    ).rejects.toThrow("revalidation failed");

    expect(saveJobStatus).toHaveBeenCalledWith({
      sourceUrl: "https://example.com/failure.mid",
      sourceSite: "freemidi",
      rawTitle: "Failure Case",
      status: "failed",
      state: "failed",
      phase: null,
      lastError: "revalidation failed",
      errorReason: "unexpected_exception",
      errorContext: expect.objectContaining({ message: "revalidation failed" }),
    });
  });
});
