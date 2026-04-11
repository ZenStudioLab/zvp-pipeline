import { beforeEach, describe, expect, it, vi } from "vitest";

const bossStart = vi.fn(async () => undefined);
const bossStop = vi.fn(async () => undefined);
const bossCreateQueue = vi.fn(async () => undefined);
const bossSchedule = vi.fn(async () => undefined);
const bossWork = vi.fn(async () => undefined);
const bossSend = vi.fn(async () => "job_1");

const repositoryClose = vi.fn(async () => undefined);
const createPipelineRuntimeRepository = vi.fn(async () => ({
  close: repositoryClose,
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
});
