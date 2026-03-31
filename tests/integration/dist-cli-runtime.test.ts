import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const pipelineRoot = path.resolve(import.meta.dirname, '../..');

function runYarnBuild(workingDirectory: string): void {
  execFileSync('yarn', ['build'], {
    cwd: workingDirectory,
    stdio: 'pipe',
  });
}

describe('built pipeline runtime', () => {
  it('loads under plain Node without resolving workspace TypeScript sources', () => {
    runYarnBuild(pipelineRoot);

    const runtimeModuleUrl = pathToFileURL(path.join(pipelineRoot, 'dist/lib/runtime-repository.js')).href;
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(runtimeModuleUrl)}); process.stdout.write('loaded');`,
      ],
      {
        cwd: pipelineRoot,
        encoding: 'utf8',
        stdio: 'pipe',
      },
    );

    expect(output).toBe('loaded');
  }, 20000);
});