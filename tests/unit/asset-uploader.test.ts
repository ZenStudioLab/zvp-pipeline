import { describe, expect, it, vi } from "vitest";

import type {
  StorageClient,
  FindAssetBySha256,
  InsertAsset,
} from "../../src/importers/asset-uploader.js";
import { uploadAsset } from "../../src/importers/asset-uploader.js";

// Mock fs/promises so no real filesystem is needed
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () =>
    Buffer.from("fake-midi-content-for-testing"),
  ),
  stat: vi.fn(async () => ({
    size: 1024,
    isFile: () => true,
  })),
}));

function createStorageClient(
  overrides: Partial<StorageClient> = {},
): StorageClient {
  return {
    upload: vi.fn(async () => ({
      data: { path: "midi/2026/04/a1b2c3d4-test.mid" },
      error: null,
    })),
    getPublicUrl: vi.fn(() => ({
      data: {
        publicUrl:
          "https://storage.example.com/midi/2026/04/a1b2c3d4-test.mid",
      },
    })),
    ...overrides,
  };
}

describe("uploadAsset", () => {
  it("uploads a new MIDI file and returns asset metadata", async () => {
    const storage = createStorageClient();
    const findAssetBySha256: FindAssetBySha256 = vi.fn(async () => null);
    const insertAsset: InsertAsset = vi.fn(async () => ({ id: "asset_1" }));

    const result = await uploadAsset(
      { filePath: "./test-data/test.mid" },
      {
        storage,
        findAssetBySha256,
        insertAsset,
        bucket: "midi-files",
      },
    );

    expect(result.reused).toBe(false);
    expect(result.assetId).toBe("asset_1");
    expect(result.publicUrl).toBe(
      "https://storage.example.com/midi/2026/04/a1b2c3d4-test.mid",
    );
    expect(result.sha256).toBeTruthy();
    expect(result.byteSize).toBeGreaterThan(0);

    // Verify storage upload was called
    expect(storage.upload).toHaveBeenCalledTimes(1);
    const uploadCall = vi.mocked(storage.upload).mock.calls[0];
    expect(uploadCall[0]).toBe("midi-files");
    expect(uploadCall[1]).toMatch(
      /^midi\/\d{4}\/\d{2}\/[a-f0-9]{8}-test\.mid$/,
    );
    expect(uploadCall[2]).toBeInstanceOf(Buffer);

    // Verify DB insert was called
    expect(insertAsset).toHaveBeenCalledTimes(1);
    const insertCall = vi.mocked(insertAsset).mock.calls[0][0];
    expect(insertCall.assetType).toBe("original_midi");
    expect(insertCall.storageProvider).toBe("supabase");
    expect(insertCall.bucket).toBe("midi-files");
    expect(insertCall.mimeType).toBe("audio/midi");
    expect(insertCall.sha256).toBe(result.sha256);
  });

  it("skips upload when SHA256 already exists", async () => {
    const storage = createStorageClient();
    const findAssetBySha256: FindAssetBySha256 = vi.fn(async () => ({
      id: "existing_asset",
      publicUrl: "https://storage.example.com/midi/2025/01/existing.mid",
    }));
    const insertAsset: InsertAsset = vi.fn(async () => ({
      id: "never_called",
    }));

    const result = await uploadAsset(
      { filePath: "./test-data/test.mid" },
      {
        storage,
        findAssetBySha256,
        insertAsset,
        bucket: "midi-files",
      },
    );

    expect(result.reused).toBe(true);
    expect(result.assetId).toBe("existing_asset");
    expect(result.publicUrl).toBe(
      "https://storage.example.com/midi/2025/01/existing.mid",
    );
    expect(result.sha256).toBeTruthy();
    expect(result.byteSize).toBeGreaterThan(0);

    // Verify no upload or insert
    expect(storage.upload).not.toHaveBeenCalled();
    expect(insertAsset).not.toHaveBeenCalled();
  });

  it("throws when storage upload fails", async () => {
    const storage = createStorageClient({
      upload: vi.fn(async () => ({
        data: null,
        error: new Error("Bucket not found"),
      })),
    });
    const findAssetBySha256: FindAssetBySha256 = vi.fn(async () => null);
    const insertAsset: InsertAsset = vi.fn(async () => ({ id: "asset_1" }));

    await expect(
      uploadAsset(
        { filePath: "./test-data/test.mid" },
        {
          storage,
          findAssetBySha256,
          insertAsset,
          bucket: "midi-files",
        },
      ),
    ).rejects.toThrow("Failed to upload asset to storage: Bucket not found");
  });

  it("passes arrangementId through to the insert", async () => {
    const storage = createStorageClient();
    const findAssetBySha256: FindAssetBySha256 = vi.fn(async () => null);
    const insertAsset: InsertAsset = vi.fn(async () => ({ id: "asset_2" }));

    await uploadAsset(
      { filePath: "./test-data/test.mid", arrangementId: "arr_1" },
      {
        storage,
        findAssetBySha256,
        insertAsset,
        bucket: "midi-files",
      },
    );

    const insertCall = vi.mocked(insertAsset).mock.calls[0][0];
    expect(insertCall.arrangementId).toBe("arr_1");
  });
});
