import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/cli.js';

function createDependencies() {
  const stdout = vi.fn();
  const stderr = vi.fn();
  const runCommand = vi.fn(async () => ({ summary: { processed: 1 } }));
  const statsCommand = vi.fn(async () => ({
    totalJobs: 12,
    published: 8,
    reviewQueue: 2,
    rejected: 1,
    failed: 1,
    averageQualityScore: 0.78,
    reasons: { low_quality: 1 },
  }));
  const seedCommand = vi.fn(async () => ({ difficulties: 4, genres: 3 }));

  return {
    deps: {
      runCommand,
      statsCommand,
      seedCommand,
      stdout,
      stderr,
    },
    runCommand,
    statsCommand,
    seedCommand,
    stdout,
    stderr,
  };
}

describe('runCli', () => {
  it('dispatches the run command with parsed options', async () => {
    const { deps, runCommand } = createDependencies();

    const exitCode = await runCli(['run', '--file=./test.mid', '--dry-run', '--concurrency=3'], deps);

    expect(exitCode).toBe(0);
    expect(runCommand).toHaveBeenCalledWith({
      source: undefined,
      limit: 100,
      file: './test.mid',
      dryRun: true,
      status: undefined,
      concurrency: 3,
    });
  });

  it('rejects conflicting file and source flags', async () => {
    const { deps, stderr } = createDependencies();

    const exitCode = await runCli(['run', '--file=./test.mid', '--source=freemidi'], deps);

    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith('--file cannot be combined with --source.');
  });

  it('prints formatted stats output', async () => {
    const { deps, stdout } = createDependencies();

    const exitCode = await runCli(['stats'], deps);

    expect(exitCode).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('Pipeline Stats'));
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('Total jobs:        12'));
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('Avg quality score: 0.78'));
  });

  it('dispatches the seed command', async () => {
    const { deps, seedCommand, stdout } = createDependencies();

    const exitCode = await runCli(['seed'], deps);

    expect(exitCode).toBe(0);
    expect(seedCommand).toHaveBeenCalledTimes(1);
    expect(stdout).toHaveBeenCalledWith('Seeded 4 difficulties and 3 genres.');
  });
});