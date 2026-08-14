// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * No source file may be excluded by .gitignore.
 *
 * This repository deliberately ignores anything whose name looks like business
 * data, including `*servicem8*`. Those patterns match FILE NAMES, not file
 * purposes, so a legitimate source module implementing the ServiceM8 contract
 * was silently dropped by `git add -A` - no warning locally, and CI failed on a
 * module that existed on the developer's disk. This test turns that class of
 * silent omission into a failing test in the normal verify run.
 */

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE_DIRECTORIES = ['src', 'tests', 'e2e', 'desktop-e2e', 'scripts', 'server', 'docs'];

function gitAvailable(): boolean {
  return (
    spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: repositoryRoot,
    }).status === 0
  );
}

function collect(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(join(repositoryRoot, directory))) {
    const relativePath = join(directory, entry);
    const absolute = join(repositoryRoot, relativePath);
    if (statSync(absolute).isDirectory()) collect(relativePath, found);
    else found.push(relativePath.split('\\').join('/'));
  }
  return found;
}

describe('source files are not excluded from version control', () => {
  it.skipIf(!gitAvailable())('has no ignored file under any source directory', () => {
    const sourceFiles = SOURCE_DIRECTORIES.flatMap((directory) => collect(directory));
    expect(sourceFiles.length).toBeGreaterThan(100);

    // `git check-ignore` prints the paths it WOULD ignore and exits 1 when none
    // match, so an empty result is the passing case.
    const result = spawnSync('git', ['check-ignore', '--stdin'], {
      cwd: repositoryRoot,
      input: sourceFiles.join('\n'),
      encoding: 'utf8',
    });
    const ignored = (result.stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');

    expect(ignored).toEqual([]);
  });

  it.skipIf(!gitAvailable())('still excludes files that look like business data', () => {
    // The protection this repository depends on must remain in force: the
    // exceptions above re-admit code, never exports.
    const businessData = [
      '20260810ReportMaterialServiceM8.csv',
      'servicem8-export.xlsx',
      'data/ServiceM8-materials.csv',
      'supplier-export-2026.csv',
      'pricelist.xlsx',
      '.env',
    ];
    for (const path of businessData) {
      const result = spawnSync('git', ['check-ignore', '--no-index', '-q', path], {
        cwd: repositoryRoot,
      });
      expect(result.status, `${path} must stay ignored`).toBe(0);
    }
  });

  it.skipIf(!gitAvailable())('tracks every file the application imports at build time', () => {
    const tracked = new Set(
      execFileSync('git', ['ls-files'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
      })
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== ''),
    );
    const untracked = collect('src')
      .map((path) => relative('.', path).split('\\').join('/'))
      .filter((path) => !tracked.has(path));

    expect(untracked).toEqual([]);
  });
});
