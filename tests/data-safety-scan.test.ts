import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scanner = join(repositoryRoot, 'scripts', 'check-no-business-data.mjs');
const temporaryDirectories: string[] = [];

function temporaryRepository(): string {
  const directory = mkdtempSync(join(tmpdir(), 'swl-data-safety-scan-'));
  temporaryDirectories.push(directory);
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('data-safety scanner private environment handling', () => {
  it('rejects a tracked private environment file by default', () => {
    const directory = temporaryRepository();
    writeFileSync(join(directory, '.env'), 'PRIVATE_VALUE=synthetic\n');
    execFileSync('git', ['add', '.env', '--force'], { cwd: directory });

    const result = spawnSync(process.execPath, [scanner], {
      cwd: directory,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('.env: filename looks like environment file');
    expect(result.stderr).not.toContain('synthetic');
  });

  it('can exclude only the owner-retained private environment paths', () => {
    const directory = temporaryRepository();
    writeFileSync(join(directory, '.env'), 'PRIVATE_VALUE=synthetic\n');
    writeFileSync(join(directory, 'safe-source.ts'), 'export const safe = true;\n');
    execFileSync('git', ['add', '.env', 'safe-source.ts', '--force'], {
      cwd: directory,
    });

    const output = execFileSync(process.execPath, [scanner, '--exclude-private-env'], {
      cwd: directory,
      encoding: 'utf8',
    });

    expect(output).toContain('Data-safety check passed');
    expect(output).not.toContain('synthetic');
  });

  it('still rejects other suspicious paths when private env is excluded', () => {
    const directory = temporaryRepository();
    writeFileSync(join(directory, '.env'), 'PRIVATE_VALUE=synthetic\n');
    writeFileSync(join(directory, 'supplier-export.csv'), 'sku,price\n');
    execFileSync('git', ['add', '.env', 'supplier-export.csv', '--force'], { cwd: directory });

    const result = spawnSync(process.execPath, [scanner, '--exclude-private-env'], {
      cwd: directory,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('supplier-export.csv');
    expect(result.stderr).not.toContain('synthetic');
  });
});
