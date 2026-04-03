import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { loadPipelineEnvFile } from '../../src/env.js';

describe('loadPipelineEnvFile', () => {
  it('loads the package-local .env file resolved from the module path', () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'pipeline-env-'));
    const envPath = path.join(tempRoot, '.env');
    const env: NodeJS.ProcessEnv = {};

    writeFileSync(envPath, 'DATABASE_URL=postgresql://example\n', 'utf8');

    try {
      const loadedPath = loadPipelineEnvFile({
        env,
        moduleUrl: pathToFileURL(path.join(tempRoot, 'dist', 'cli.js')).href,
      });

      expect(loadedPath).toBe(envPath);
      expect(env.DATABASE_URL).toBe('postgresql://example');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('skips loading when the package-local .env file does not exist', () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'pipeline-env-'));
    const env: NodeJS.ProcessEnv = {};

    try {
      const loadedPath = loadPipelineEnvFile({
        env,
        moduleUrl: pathToFileURL(path.join(tempRoot, 'dist', 'cli.js')).href,
      });

      expect(loadedPath).toBeNull();
      expect(env).toEqual({});
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('preserves shell-provided values when the same key exists in .env', () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'pipeline-env-'));
    const envPath = path.join(tempRoot, '.env');
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: 'postgresql://from-shell',
    };

    writeFileSync(envPath, 'DATABASE_URL=postgresql://from-file\nSITE_URL=https://zenpiano.art\n', 'utf8');

    try {
      const loadedPath = loadPipelineEnvFile({
        env,
        moduleUrl: pathToFileURL(path.join(tempRoot, 'dist', 'cli.js')).href,
      });

      expect(loadedPath).toBe(envPath);
      expect(env.DATABASE_URL).toBe('postgresql://from-shell');
      expect(env.SITE_URL).toBe('https://zenpiano.art');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('strips inline comments from unquoted values while preserving quoted hashes', () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'pipeline-env-'));
    const envPath = path.join(tempRoot, '.env');
    const env: NodeJS.ProcessEnv = {};

    writeFileSync(
      envPath,
      [
        'DATABASE_URL=postgresql://example     # Supabase pooler connection string',
        'REVALIDATION_SECRET="secret # keep-this"',
      ].join('\n'),
      'utf8',
    );

    try {
      loadPipelineEnvFile({
        env,
        moduleUrl: pathToFileURL(path.join(tempRoot, 'dist', 'cli.js')).href,
      });

      expect(env.DATABASE_URL).toBe('postgresql://example');
      expect(env.REVALIDATION_SECRET).toBe('secret # keep-this');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});