import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/** Tracks the last `import_run` values object passed to `.insert().values()`. */
let lastImportRunValues: Record<string, unknown> | undefined;

/** Tracks the last `import_event` values object passed to `.insert().values()`. */
let lastImportEventValues: Record<string, unknown> | undefined;

/** Tracks the last `import_run` update args (set payload + where id). */
let lastUpdateArgs:
  | { setPayload: Record<string, unknown>; whereId: string }
  | undefined;

/** Returned by `.insert().values().returning()` when configured. */
let nextReturningResult: Array<Record<string, unknown>> = [];

const mockInsertValuesReturning = vi.fn(
  () => nextReturningResult,
);
const mockInsertValues = vi.fn();
const mockInsert = vi.fn(() => ({
  values: mockInsertValues,
}));
const mockWhere = vi.fn();
const mockSet: any = vi.fn(() => ({ where: mockWhere }));
const mockUpdate = vi.fn(() => ({
  set: mockSet,
}));

const mockDb = {
  insert: mockInsert,
  update: mockUpdate,
};

vi.mock("@zen/db", () => ({
  importRun: { id: "import_run_id" },
  importEvent: { id: "import_event_id" },
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

async function loadModule() {
  return import("../../src/importers/import-audit.js");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("import audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastImportRunValues = undefined;
    lastImportEventValues = undefined;
    lastUpdateArgs = undefined;
    nextReturningResult = [];

    // Wire up `.insert(table).values(data).returning(cols)` chain
    mockInsertValues.mockImplementation(
      (values: Record<string, unknown>) => ({
        returning: mockInsertValuesReturning,
      }),
    );
    // Wire up `.insert(table).values(data)` chain (no returning)
    mockInsert.mockImplementation(() => ({
      values: mockInsertValues,
    }));

    // Wire up `.update(table).set(data).where(condition)` chain
    mockSet.mockImplementation((setPayload: Record<string, unknown>) => ({
      where: mockWhere,
    }));
    mockUpdate.mockImplementation(() => ({
      set: mockSet,
    }));
  });

  afterEach(() => {
    vi.resetModules();
  });

  // ---- createImportRun ----------------------------------------------------

  describe("createImportRun", () => {
    it("inserts an import_run row with status 'running' and returns the id", async () => {
      nextReturningResult = [{ id: "run-001" }];
      const { createImportRun } = await loadModule();

      const result = await createImportRun(mockDb as any, {
        source: "midi-scraper-extension",
        downloadDir: "/tmp/downloads",
        config: { limit: 50, timingWindow: 30 },
      });

      expect(result).toEqual({ id: "run-001" });
      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(mockInsertValues).toHaveBeenCalledWith({
        source: "midi-scraper-extension",
        downloadDir: "/tmp/downloads",
        status: "running",
        config: { limit: 50, timingWindow: 30 },
      });
      expect(mockInsertValuesReturning).toHaveBeenCalledWith({
        id: "import_run_id",
      });
    });

    it("defaults source to 'midi-scraper-extension' and downloadDir to null", async () => {
      nextReturningResult = [{ id: "run-002" }];
      const { createImportRun } = await loadModule();

      const result = await createImportRun(mockDb as any);

      expect(result).toEqual({ id: "run-002" });
      expect(mockInsertValues).toHaveBeenCalledWith({
        source: "midi-scraper-extension",
        downloadDir: null,
        status: "running",
        config: null,
      });
    });
  });

  // ---- updateImportRun ----------------------------------------------------

  describe("updateImportRun", () => {
    it("updates status to 'completed' and sets ended_at", async () => {
      const { updateImportRun } = await loadModule();
      const fixedDate = new Date("2025-01-15T10:00:00Z");

      await updateImportRun(
        mockDb as any,
        "run-001",
        "completed",
        fixedDate,
      );

      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(mockSet).toHaveBeenCalledWith({
        status: "completed",
        endedAt: fixedDate,
      });
      expect(mockWhere).toHaveBeenCalled();
    });

    it("updates status to 'failed' and defaults ended_at to now", async () => {
      const { updateImportRun } = await loadModule();
      const before = new Date();

      await updateImportRun(mockDb as any, "run-003", "failed");

      expect(mockUpdate).toHaveBeenCalledTimes(1);
      const setCall = (mockSet.mock.calls[0] as any)?.[0] as Record<string, unknown>;
      expect(setCall.status).toBe("failed");
      expect(setCall.endedAt).toBeInstanceOf(Date);
      expect((setCall.endedAt as Date).getTime()).toBeGreaterThanOrEqual(
        before.getTime(),
      );
    });
  });

  // ---- createImportEvent --------------------------------------------------

  describe("createImportEvent", () => {
    it("creates an import_event row with all match evidence", async () => {
      const { createImportEvent } = await loadModule();
      const birthtime = new Date("2024-12-01T08:00:00Z");
      const ctime = new Date("2024-12-01T08:00:00Z");
      const mtime = new Date("2024-12-05T14:30:00Z");

      await createImportEvent(mockDb as any, "run-001", {
        arrangementId: "arr-123",
        localFilePath: "/downloads/song.mid",
        fileBirthtime: birthtime,
        fileCtime: ctime,
        fileMtime: mtime,
        fileName: "song.mid",
        fileSha256:
          "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        matchMethod: "filename_exact",
        matchConfidence: 0.95,
        matchReason: {
          deltaSeconds: 1.2,
          candidateCount: 3,
          windowConfig: { threshold: 5 },
        },
        confidenceBand: "high",
      });

      expect(mockInsertValues).toHaveBeenCalledWith({
        importRunId: "run-001",
        arrangementId: "arr-123",
        localFilePath: "/downloads/song.mid",
        fileBirthtime: birthtime,
        fileCtime: ctime,
        fileMtime: mtime,
        fileName: "song.mid",
        fileSha256:
          "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        matchMethod: "filename_exact",
        matchConfidence: 0.95,
        matchReason: {
          deltaSeconds: 1.2,
          candidateCount: 3,
          windowConfig: { threshold: 5 },
        },
        reviewStatus: "auto_accepted",
      });
    });

    it("sets review_status to auto_accepted for high confidence matches", async () => {
      const { createImportEvent } = await loadModule();

      await createImportEvent(mockDb as any, "run-001", {
        localFilePath: "/test/song.mid",
        fileName: "song.mid",
        confidenceBand: "high",
      });

      const callArgs = mockInsertValues.mock
        .calls[0][0] as Record<string, unknown>;
      expect(callArgs.reviewStatus).toBe("auto_accepted");
    });

    it("sets review_status to needs_review for medium confidence matches", async () => {
      const { createImportEvent } = await loadModule();

      await createImportEvent(mockDb as any, "run-001", {
        localFilePath: "/test/song.mid",
        fileName: "song.mid",
        confidenceBand: "medium",
      });

      const callArgs = mockInsertValues.mock
        .calls[0][0] as Record<string, unknown>;
      expect(callArgs.reviewStatus).toBe("needs_review");
    });

    it("sets review_status to needs_review for low confidence matches", async () => {
      const { createImportEvent } = await loadModule();

      await createImportEvent(mockDb as any, "run-001", {
        localFilePath: "/test/song.mid",
        fileName: "song.mid",
        confidenceBand: "low",
      });

      const callArgs = mockInsertValues.mock
        .calls[0][0] as Record<string, unknown>;
      expect(callArgs.reviewStatus).toBe("needs_review");
    });

    it("sets review_status to needs_review when structural validation fails regardless of confidence", async () => {
      const { createImportEvent } = await loadModule();

      await createImportEvent(mockDb as any, "run-001", {
        localFilePath: "/test/song.mid",
        fileName: "song.mid",
        confidenceBand: "high",
        structuralValidationFailed: true,
      });

      const callArgs = mockInsertValues.mock
        .calls[0][0] as Record<string, unknown>;
      expect(callArgs.reviewStatus).toBe("needs_review");
    });

    it("coerces string date inputs to Date objects", async () => {
      const { createImportEvent } = await loadModule();

      await createImportEvent(mockDb as any, "run-001", {
        localFilePath: "/test/song.mid",
        fileName: "song.mid",
        fileBirthtime: "2024-12-01T08:00:00Z",
        fileCtime: "2024-12-01T08:00:00Z",
        confidenceBand: "high",
      });

      const callArgs = mockInsertValues.mock
        .calls[0][0] as Record<string, unknown>;
      expect(callArgs.fileBirthtime).toEqual(
        new Date("2024-12-01T08:00:00Z"),
      );
      expect(callArgs.fileCtime).toEqual(
        new Date("2024-12-01T08:00:00Z"),
      );
      expect(callArgs.fileMtime).toBeNull();
    });

    it("handles null/undefined optional fields gracefully", async () => {
      const { createImportEvent } = await loadModule();

      await createImportEvent(mockDb as any, "run-001", {
        localFilePath: "/test/song.mid",
        fileName: "song.mid",
        confidenceBand: "high",
      });

      const callArgs = mockInsertValues.mock
        .calls[0][0] as Record<string, unknown>;
      expect(callArgs.arrangementId).toBeNull();
      expect(callArgs.fileSha256).toBeNull();
      expect(callArgs.matchMethod).toBeNull();
      expect(callArgs.matchConfidence).toBeNull();
      expect(callArgs.matchReason).toBeNull();
      expect(callArgs.fileBirthtime).toBeNull();
      expect(callArgs.fileCtime).toBeNull();
      expect(callArgs.fileMtime).toBeNull();
    });
  });
});
