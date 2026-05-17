import { beforeEach, describe, expect, it, vi } from "vitest";

const bossStart = vi.fn(async () => undefined);
const bossStop = vi.fn(async () => undefined);
const bossCreateQueue = vi.fn(async () => undefined);
const bossSchedule = vi.fn(async () => undefined);
const bossWork = vi.fn(async () => undefined);
const bossSend = vi.fn(async () => "job_1");

const repositoryClose = vi.fn(async () => undefined);
const repositorySaveJobStatus = vi.fn(async () => undefined);
const createPipelineRuntimeRepository = vi.fn(async () => ({
  close: repositoryClose,
  saveJobStatus: repositorySaveJobStatus,
}));
const createAiEnricher = vi.fn(() => ({
  enrich: vi.fn(async () => ({ status: "updated" })),
}));

vi.mock("pg-boss", () => ({
  default: vi.fn().mockImplementation(() => ({
    start: bossStart,
    stop: bossStop,
    createQueue: bossCreateQueue,
    schedule: bossSchedule,
    work: bossWork,
    send: bossSend,
  })),
}));

vi.mock("../../src/lib/runtime-repository.js", () => ({
  createPipelineRuntimeRepository,
}));

vi.mock("../../src/stages/ai-enricher.js", () => ({
  createAiEnricher,
}));

describe("createPipelineWorker lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    createPipelineRuntimeRepository.mockResolvedValue({
      close: repositoryClose,
      saveJobStatus: repositorySaveJobStatus,
    });
  });

  it("closes the repository when the worker stops", async () => {
    const { createPipelineWorker } = await import("../../src/worker.js");

    const worker = await createPipelineWorker({
      databaseUrl: "postgresql://example",
    });
    await worker.stop();

    expect(bossStop).toHaveBeenCalledWith({ graceful: true, close: true });
    expect(repositoryClose).toHaveBeenCalledTimes(1);
  });

  it("stops pg-boss when repository bootstrap fails", async () => {
    createPipelineRuntimeRepository.mockRejectedValueOnce(
      new Error("bootstrap failed"),
    );
    const { createPipelineWorker } = await import("../../src/worker.js");

    await expect(
      createPipelineWorker({ databaseUrl: "postgresql://example" }),
    ).rejects.toThrow("bootstrap failed");
    expect(bossStart).toHaveBeenCalledTimes(1);
    expect(bossStop).toHaveBeenCalledWith({ graceful: true, close: true });
  });

  it("preserves the boss shutdown error when repository close also fails", async () => {
    bossStop.mockRejectedValueOnce(new Error("boss stop failed"));
    repositoryClose.mockRejectedValueOnce(new Error("repository close failed"));

    const { createPipelineWorker } = await import("../../src/worker.js");

    const worker = await createPipelineWorker({
      databaseUrl: "postgresql://example",
    });

    await expect(worker.stop()).rejects.toThrow("boss stop failed");
    expect(repositoryClose).toHaveBeenCalledTimes(1);
  });

  it("persists unexpected run exceptions as failed jobs with error context", async () => {
    const processJob = vi.fn(async () => {
      throw new Error("boom");
    });

    bossWork.mockImplementation(async (...args: unknown[]) => {
      const handler = args[2] as (jobs: Array<{ data: unknown }>) => Promise<void>;
      await handler([
        {
          data: {
            sourceUrl: "https://example.com/job.mid",
            sourceSite: "freemidi",
            rawTitle: "Job",
            rawArtist: "Artist",
            file: new Uint8Array(0),
            dryRun: false,
          },
        },
      ]);
    });

    const { registerPipelineWorkers } = await import("../../src/worker.js");

    await expect(
      registerPipelineWorkers({
        boss: {
          start: bossStart,
          stop: bossStop,
          createQueue: bossCreateQueue,
          schedule: bossSchedule,
          work: bossWork,
          send: bossSend,
        },
        repository: {
          close: repositoryClose,
          saveJobStatus: repositorySaveJobStatus,
        } as never,
        aiEnricher: { enrich: vi.fn(async () => ({ status: "updated" as const })) },
        processJob,
        concurrency: 1,
      }),
    ).rejects.toThrow("boom");

    expect(repositorySaveJobStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        state: "failed",
        errorReason: "unexpected_exception",
        errorContext: expect.objectContaining({ message: "boom" }),
      }),
    );
  });
});
