import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Minimal Supabase Storage client interface for dependency injection.
 */
export type StorageClient = {
  upload(
    bucket: string,
    objectPath: string,
    body: ArrayBuffer | ArrayBufferView | Blob | string,
    options?: { contentType?: string },
  ): Promise<{ data: { path: string } | null; error: Error | null }>;
  getPublicUrl(bucket: string, objectPath: string): { data: { publicUrl: string } };
};

export type SheetAssetRecord = {
  id: string;
  publicUrl: string | null;
};

export type FindAssetBySha256 = (
  sha256: string,
) => Promise<SheetAssetRecord | null>;

export type InsertAssetInput = {
  arrangementId: string | null;
  assetType: "original_midi";
  storageProvider: string;
  bucket: string;
  objectPath: string;
  publicUrl: string | null;
  mimeType: string;
  byteSize: bigint;
  sha256: string;
};

export type InsertAsset = (
  input: InsertAssetInput,
) => Promise<{ id: string }>;

export type UploadAssetInput = {
  filePath: string;
  arrangementId?: string | null;
};

export type UploadAssetResult = {
  assetId: string;
  publicUrl: string | null;
  sha256: string;
  byteSize: number;
  reused: boolean;
};

export async function uploadAsset(
  input: UploadAssetInput,
  deps: {
    storage: StorageClient;
    findAssetBySha256: FindAssetBySha256;
    insertAsset: InsertAsset;
    bucket: string;
  },
): Promise<UploadAssetResult> {
  const fileBuffer = await readFile(input.filePath);
  const sha256 = createHash("sha256").update(fileBuffer).digest("hex");

  // Check for duplicate by SHA256
  const existing = await deps.findAssetBySha256(sha256);
  if (existing) {
    return {
      assetId: existing.id,
      publicUrl: existing.publicUrl,
      sha256,
      byteSize: fileBuffer.length,
      reused: true,
    };
  }

  // Build storage path: midi/{year}/{month}/{sha256[:8]}-{filename}
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const filename = path.basename(input.filePath);
  const objectPath = `midi/${year}/${month}/${sha256.slice(0, 8)}-${filename}`;

  const fileStats = await stat(input.filePath);

  // Upload to Supabase Storage
  const uploadResult = await deps.storage.upload(deps.bucket, objectPath, fileBuffer, {
    contentType: "audio/midi",
  });

  if (uploadResult.error) {
    throw new Error(
      `Failed to upload asset to storage: ${uploadResult.error.message}`,
    );
  }

  // Get public URL
  const { data: urlData } = deps.storage.getPublicUrl(deps.bucket, objectPath);

  // Insert sheet_asset row
  const inserted = await deps.insertAsset({
    arrangementId: input.arrangementId ?? null,
    assetType: "original_midi",
    storageProvider: "supabase",
    bucket: deps.bucket,
    objectPath,
    publicUrl: urlData.publicUrl,
    mimeType: "audio/midi",
    byteSize: BigInt(fileStats.size),
    sha256,
  });

  return {
    assetId: inserted.id,
    publicUrl: urlData.publicUrl,
    sha256,
    byteSize: fileStats.size,
    reused: false,
  };
}
