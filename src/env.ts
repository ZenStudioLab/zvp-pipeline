import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type LoadPipelineEnvFileOptions = {
  moduleUrl?: string;
  fileExists?: (filePath: string) => boolean;
  env?: NodeJS.ProcessEnv;
  readEnvFile?: (filePath: string) => string;
};

function normalizeEnvValue(rawValue: string): string {
  const trimmed = rawValue.trim();

  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function stripInlineComment(rawValue: string): string {
  let activeQuote: '"' | "'" | null = null;

  for (let index = 0; index < rawValue.length; index += 1) {
    const character = rawValue[index];

    if (character === '"' || character === "'") {
      if (activeQuote === character) {
        activeQuote = null;
      } else if (activeQuote === null) {
        activeQuote = character;
      }

      continue;
    }

    if (character === '#' && activeQuote === null) {
      const previousCharacter = index > 0 ? rawValue[index - 1] : '';

      if (index === 0 || /\s/u.test(previousCharacter)) {
        return rawValue.slice(0, index).trimEnd();
      }
    }
  }

  return rawValue;
}

function parseDotEnv(rawContents: string): Array<[string, string]> {
  return rawContents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .flatMap((line) => {
      const normalizedLine = line.startsWith('export ') ? line.slice(7).trim() : line;
      const separatorIndex = normalizedLine.indexOf('=');

      if (separatorIndex <= 0) {
        return [];
      }

      const key = normalizedLine.slice(0, separatorIndex).trim();
      const value = normalizeEnvValue(stripInlineComment(normalizedLine.slice(separatorIndex + 1)));

      if (!key) {
        return [];
      }

      return [[key, value] as [string, string]];
    });
}

function resolvePipelinePackageRoot(moduleUrl: string): string {
  const modulePath = fileURLToPath(moduleUrl);
  return path.resolve(path.dirname(modulePath), '..');
}

export function loadPipelineEnvFile(options: LoadPipelineEnvFileOptions = {}): string | null {
  const envPath = path.join(resolvePipelinePackageRoot(options.moduleUrl ?? import.meta.url), '.env');
  const fileExists = options.fileExists ?? existsSync;
  const env = options.env ?? process.env;
  const readEnvFile = options.readEnvFile ?? ((filePath: string) => readFileSync(filePath, 'utf8'));

  if (!fileExists(envPath)) {
    return null;
  }

  for (const [key, value] of parseDotEnv(readEnvFile(envPath))) {
    if (env[key] === undefined) {
      env[key] = value;
    }
  }

  return envPath;
}