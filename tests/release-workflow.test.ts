import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Windows draft-release workflow detector', () => {
  it('passes the reviewed manual-only workflow and rejects unsafe release triggers', () => {
    const accepted = spawnSync(process.execPath, ['scripts/check-windows-release-workflow.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain('manual-only draft, 8 exact assets');

    const directory = mkdtempSync(join(tmpdir(), 'swl-release-workflow-test-'));
    temporaryDirectories.push(directory);
    const defectivePath = join(directory, 'windows-desktop.yml');
    const reviewed = readFileSync('.github/workflows/windows-desktop.yml', 'utf8');
    writeFileSync(defectivePath, reviewed.replace('--draft --verify-tag', '--verify-tag'), 'utf8');

    const rejected = spawnSync(process.execPath, ['scripts/check-windows-release-workflow.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, SWL_RELEASE_WORKFLOW_PATH: defectivePath },
    });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain(
      'Release workflow is missing required structure: --draft --verify-tag',
    );

    writeFileSync(
      defectivePath,
      reviewed.replace(
        '  workflow_dispatch:',
        "  push:\n    tags: ['v1.2.3']\n  workflow_dispatch:",
      ),
      'utf8',
    );
    const tagTriggered = spawnSync(
      process.execPath,
      ['scripts/check-windows-release-workflow.mjs'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, SWL_RELEASE_WORKFLOW_PATH: defectivePath },
      },
    );
    expect(tagTriggered.status).not.toBe(0);
    expect(tagTriggered.stderr).toContain('Tag pushes must not create or mutate a GitHub Release.');
  });
});
