/**
 * Supabase Storage client — lightweight implementation using the Storage REST API.
 *
 * Reads credentials from environment variables:
 *   SUPABASE_URL     — e.g. https://abc123.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY — service-role key for admin access
 *
 * @module lib/storage-client
 */

import type { StorageClient } from '../importers/asset-uploader.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a StorageClient from environment variables.
 *
 * The returned client uses the Supabase Storage REST API directly
 * (no @supabase/supabase-js dependency required).
 */
export function createStorageClientFromEnv(): StorageClient {
  const supabaseUrl = requireEnv('SUPABASE_URL').replace(/\/$/, '');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const storageBase = `${supabaseUrl}/storage/v1`;

  const authHeaders = {
    Authorization: `Bearer ${serviceRoleKey}`,
  };

  return {
    async upload(bucket, objectPath, body, options) {
      const url = `${storageBase}/object/${bucket}/${objectPath}`;
      const contentType = options?.contentType ?? 'application/octet-stream';

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            ...authHeaders,
            'Content-Type': contentType,
          },
          body: body as any,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'unknown error');
          return {
            data: null,
            error: new Error(`Storage upload failed (${response.status}): ${errorText}`),
          };
        }

        return { data: { path: objectPath }, error: null };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { data: null, error: new Error(`Storage upload network error: ${message}`) };
      }
    },

    getPublicUrl(bucket, objectPath) {
      return {
        data: {
          publicUrl: `${storageBase}/object/public/${bucket}/${objectPath}`,
        },
      };
    },
  };
}

/**
 * Download a file from Supabase Storage and return its contents as an ArrayBuffer.
 */
export async function downloadFromStorage(
  bucket: string,
  objectPath: string,
): Promise<ArrayBuffer> {
  const supabaseUrl = requireEnv('SUPABASE_URL').replace(/\/$/, '');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const url = `${supabaseUrl}/storage/v1/object/${bucket}/${objectPath}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to download from storage (${response.status}): ${response.statusText} — ${url}`,
    );
  }

  return response.arrayBuffer();
}
