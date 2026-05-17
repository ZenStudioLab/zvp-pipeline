import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli.js";
import type { CliDependencies } from "../../src/cli.js";

// Mock node:fs so we can control existsSync behavior without ESM spy restrictions
vi.mock("node:fs", () => {
  const actual = vi.importActual("node:fs") as Promise<typeof import("node:fs")>;
  return {
    existsSync: vi.fn(() => true),
    promises: {
      readFile: async () => JSON.stringify({ records: [] }),
      mkdtemp: async () => "/tmp/test-mock",
      rm: async () => undefined,
      stat: async () => ({ size: 1024, isFile: () => true, birthtime: new Date(), ctime: new Date(), mtime: new Date() }),
    },
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: async () => JSON.stringify({ records: [] }),
  mkdtemp: async () => "/tmp/test-mock",
  rm: async () => undefined,
  stat: async () => ({ size: 1024, isFile: () => true, birthtime: new Date(), ctime: new Date(), mtime: new Date() }),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => "/mock-home",
  };
});

// Mock runtime-repository so no real DB connection is needed
vi.mock("../../src/lib/runtime-repository.js", () => ({
  createPipelineRuntimeRepository: vi.fn(async () => ({
    db: {} as never,
    genres: [],
    difficulties: [],
    getExistingArtistNames: vi.fn(async () => []),
    findArtistByNormalizedName: vi.fn(async () => null),
    createArtist: vi.fn(async () => ({ id: "artist_1", slug: "artist-1", name: "Artist 1" })),
    findFingerprintByKey: vi.fn(async () => null),
    getJobBySourceUrl: vi.fn(async () => null),
    findSheetBySourceUrl: vi.fn(async () => null),
    saveJobStatus: vi.fn(async () => undefined),
    insertSheet: vi.fn(async () => ({ id: "sheet_1", slug: "sheet-1" })),
    promoteCanonicalFamily: vi.fn(async () => undefined),
    updateFingerprint: vi.fn(async () => undefined),
    revalidatePaths: vi.fn(async () => undefined),
    getSheetForAiEnrichment: vi.fn(async () => null),
    updateSheetAiMetadata: vi.fn(async () => undefined),
    listFingerprintsForRerank: vi.fn(async () => []),
    listVersionsForFingerprint: vi.fn(async () => []),
    swapCanonicalSheet: vi.fn(async () => undefined),
    listJobs: vi.fn(async () => []),
    getStats: vi.fn(async () => ({
      totalJobs: 0, published: 0, reviewQueue: 0, rejected: 0, failed: 0, averageQualityScore: 0, reasons: {},
    })),
    seedReferenceData: vi.fn(async () => ({ difficulties: 0, genres: 0 })),
    getCatalogSourceUrlsByStatus: vi.fn(async () => []),
    findAssetBySha256: vi.fn(async () => null),
    insertAsset: vi.fn(async () => ({ id: "asset_1" })),
    listJobsWithAssets: vi.fn(async () => []),
    close: vi.fn(async () => undefined),
  })),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockImportDeps(): CliDependencies {
  return {
    async importCommand() {
      return {
        filesScanned: 10,
        filesMatched: 7,
        filesUploaded: 5,
        rowsCreated: 5,
        dryRun: false,
        importRunId: "run_1",
      };
    },
    async runCommand() {
      return {
        entries: [],
        summary: {
          processed: 0, published: 0, needs_review: 0, dry_run: 0, rejected: 0, failed: 0,
          pending: 0, converting: 0, scoring: 0, dedup: 0,
          averageQualityScore: 0, autoPublishRate: 0, reasons: {}, qualityReasons: {},
        },
      };
    },
    async statsCommand() {
      return { totalJobs: 0, published: 0, reviewQueue: 0, rejected: 0, failed: 0, averageQualityScore: 0, reasons: {} };
    },
    async seedCommand() {
      return { difficulties: 0, genres: 0 };
    },
    async dispose() {},
    stdout: vi.fn(),
    stderr: vi.fn(),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("import command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("validates required options and forwards parsed arguments", async () => {
    const deps = createMockImportDeps();
    const importSpy = vi.spyOn(deps, "importCommand");

    const exitCode = await runCli(
      [
        "import",
        "--export-file=/tmp/test/export.json",
        "--download-dir=/tmp/test/downloads",
        "--timing-x=5",
        "--timing-y=15",
        "--timing-z=12",
        "--limit=20",
      ],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(importSpy).toHaveBeenCalledWith({
      exportFile: "/tmp/test/export.json",
      downloadDir: "/tmp/test/downloads",
      timingX: 5,
      timingY: 15,
      timingZ: 12,
      limit: 20,
      dryRun: false,
    });
  });

  it("accepts dry-run without requiring CLI timing overrides", async () => {
    const deps = createMockImportDeps();
    const importSpy = vi.spyOn(deps, "importCommand");

    const exitCode = await runCli(
      [
        "import",
        "--export-file=/tmp/test/export.json",
        "--download-dir=/tmp/test/downloads",
        "--dry-run",
      ],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(importSpy).toHaveBeenCalledWith({
      exportFile: "/tmp/test/export.json",
      downloadDir: "/tmp/test/downloads",
      timingX: undefined,
      timingY: undefined,
      timingZ: undefined,
      limit: undefined,
      dryRun: true,
    });
  });

  it("defaults import paths when export-file and download-dir are omitted", async () => {
    const deps = createMockImportDeps();
    const importSpy = vi.spyOn(deps, "importCommand");

    const exitCode = await runCli(["import", "--dry-run"], deps);

    expect(exitCode).toBe(0);
    expect(importSpy).toHaveBeenCalledWith({
      exportFile: "/mock-home/Downloads/midi-scraper/scraper-export.json",
      downloadDir: "/mock-home/Downloads/midi-scraper",
      timingX: undefined,
      timingY: undefined,
      timingZ: undefined,
      limit: undefined,
      dryRun: true,
    });
  });

  it("rejects invalid timing values", async () => {
    const deps = createMockImportDeps();
    const stderr = deps.stderr as ReturnType<typeof vi.fn>;

    const exitCode = await runCli(
      ["import", "--export-file=/tmp/export.json", "--download-dir=/tmp/dl", "--timing-x=0"],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("--timing-x"));
  });

  it("reports import stats on successful completion", async () => {
    const deps = createMockImportDeps();
    const stdout = deps.stdout as ReturnType<typeof vi.fn>;
    vi.spyOn(deps, "importCommand").mockResolvedValueOnce({
      filesScanned: 25,
      filesMatched: 18,
      filesUploaded: 15,
      rowsCreated: 15,
      dryRun: false,
      importRunId: "run_abc123",
    });

    const exitCode = await runCli(
      ["import", "--export-file=/tmp/export.json", "--download-dir=/tmp/downloads"],
      deps,
    );

    expect(exitCode).toBe(0);
    const output = stdout.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed).toMatchObject({
      filesScanned: 25,
      filesMatched: 18,
      filesUploaded: 15,
      rowsCreated: 15,
      dryRun: false,
      importRunId: "run_abc123",
    });
  });
});

describe("run --source-items", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("validates mutual exclusivity with --file", async () => {
    const deps = createMockImportDeps();
    const stderr = deps.stderr as ReturnType<typeof vi.fn>;

    const exitCode = await runCli(
      ["run", "--source-items", "--file=./test.mid"],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("--file cannot be combined with --source-items"),
    );
  });

  it("forwards source-items option to run command", async () => {
    const deps = createMockImportDeps();
    const runSpy = vi.spyOn(deps, "runCommand");

    const exitCode = await runCli(
      ["run", "--source-items", "--limit=5", "--dry-run"],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(runSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceItems: true,
        limit: 5,
        dryRun: true,
      }),
    );
  });

  it("produces output with sourceItemCount when command returns it", async () => {
    const deps = createMockImportDeps();
    const stdout = deps.stdout as ReturnType<typeof vi.fn>;

    vi.spyOn(deps, "runCommand").mockResolvedValueOnce({
      entries: [
        { status: "published", source_url: "https://musescore.com/score/1" },
      ],
      summary: {
        processed: 1, published: 1, needs_review: 0, dry_run: 0, rejected: 0, failed: 0,
        pending: 0, converting: 0, scoring: 0, dedup: 0,
        averageQualityScore: 0.85, autoPublishRate: 1, reasons: {}, qualityReasons: {},
      },
      sourceItemCount: 1,
    });

    const exitCode = await runCli(
      ["run", "--source-items", "--limit=10"],
      deps,
    );

    expect(exitCode).toBe(0);
    const output = stdout.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.sourceItemCount).toBe(1);
    expect(parsed.entries).toHaveLength(1);
  });

  it("forwards force-generation options to the run command", async () => {
    const deps = createMockImportDeps();
    const runSpy = vi.spyOn(deps, "runCommand");

    const exitCode = await runCli(
      [
        "run",
        "--source-items",
        "--force-generate",
        "--arrangement-id=arr_123",
        "--reason=operator override",
      ],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(runSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceItems: true,
        forceGenerate: true,
        arrangementId: "arr_123",
        reason: "operator override",
        publish: false,
      }),
    );
  });

  it("rejects blank force reasons", async () => {
    const deps = createMockImportDeps();
    const stderr = deps.stderr as ReturnType<typeof vi.fn>;

    const exitCode = await runCli(
      [
        "run",
        "--source-items",
        "--force-generate",
        "--arrangement-id=arr_123",
        "--reason=   ",
      ],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("--reason must be a non-empty string"));
  });
});
