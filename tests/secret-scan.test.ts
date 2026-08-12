import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scanner = join(repositoryRoot, 'scripts', 'check-secrets.mjs');
const temporaryDirectories: string[] = [];

function temporaryRepository(): string {
  const directory = mkdtempSync(join(tmpdir(), 'swl-secret-scan-'));
  temporaryDirectories.push(directory);
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  return directory;
}

function commitFixture(directory: string): void {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=SWL Test',
      '-c',
      'user.email=swl-test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ],
    { cwd: directory },
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('secret scanner placeholder handling', () => {
  it('accepts explicit replace-with placeholders in a tracked example file', () => {
    const directory = temporaryRepository();
    writeFileSync(
      join(directory, '.env.example'),
      'SERPAPI_KEY=replace_with_serpapi_key\n' +
        'EBAY_CLIENT_SECRET=replace_with_ebay_client_secret\n',
    );
    execFileSync('git', ['add', '.env.example'], { cwd: directory });

    const output = execFileSync(process.execPath, [scanner, '--scope=current'], {
      cwd: directory,
      encoding: 'utf8',
    });

    expect(output).toContain('Secret scan passed for current');
  }, 30_000);

  it.each(['SERPAPI_KEY', 'SERPER_API_KEY', 'EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET'])(
    'rejects an unquoted %s value without displaying it',
    (credentialName) => {
      const directory = temporaryRepository();
      const syntheticValue = `synthetic${credentialName.replaceAll('_', '')}Value123456`;
      writeFileSync(join(directory, '.env.example'), `${credentialName}=${syntheticValue}\n`);
      execFileSync('git', ['add', '.env.example'], { cwd: directory });

      const result = spawnSync(process.execPath, [scanner, '--scope=current'], {
        cwd: directory,
        encoding: 'utf8',
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('matches assigned provider credential');
      expect(result.stderr).not.toContain(syntheticValue);
    },
    30_000,
  );

  it('rejects a real credential after an approved placeholder without displaying it', () => {
    const directory = temporaryRepository();
    const syntheticValue = 'syntheticCredentialValue123456789';
    writeFileSync(
      join(directory, '.env.example'),
      `SERPAPI_KEY=replace_with_serpapi_key\nSERPAPI_KEY=${syntheticValue}\n`,
    );
    execFileSync('git', ['add', '.env.example'], { cwd: directory });

    const result = spawnSync(process.execPath, [scanner, '--scope=current'], {
      cwd: directory,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('matches assigned provider credential');
    expect(result.stderr).not.toContain(syntheticValue);
  }, 30_000);

  it.each(['example', 'fixture', 'dummy'])(
    'does not treat a real credential containing %s as a placeholder',
    (placeholderWord) => {
      const directory = temporaryRepository();
      const syntheticValue = `synthetic${placeholderWord}CredentialValue123456`;
      writeFileSync(join(directory, '.env.example'), `SERPER_API_KEY=${syntheticValue}\n`);
      execFileSync('git', ['add', '.env.example'], { cwd: directory });

      const result = spawnSync(process.execPath, [scanner, '--scope=current'], {
        cwd: directory,
        encoding: 'utf8',
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('matches assigned provider credential');
      expect(result.stderr).not.toContain(syntheticValue);
    },
    30_000,
  );

  it('accepts an explicitly synthetic credential fixture only in test source', () => {
    const directory = temporaryRepository();
    writeFileSync(
      join(directory, 'credential.test.ts'),
      "export const environment = { SERPER_API_KEY: 'fixture-serper-key' };\n",
    );
    execFileSync('git', ['add', 'credential.test.ts'], { cwd: directory });

    const output = execFileSync(process.execPath, [scanner, '--scope=current'], {
      cwd: directory,
      encoding: 'utf8',
    });

    expect(output).toContain('Secret scan passed for current');
  }, 30_000);

  it('rejects a fixture-prefixed credential outside test source', () => {
    const directory = temporaryRepository();
    const syntheticValue = 'fixture-credential-that-must-still-fail';
    writeFileSync(join(directory, '.env.example'), `SERPER_API_KEY=${syntheticValue}\n`);
    execFileSync('git', ['add', '.env.example'], { cwd: directory });

    const result = spawnSync(process.execPath, [scanner, '--scope=current'], {
      cwd: directory,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('matches assigned provider credential');
    expect(result.stderr).not.toContain(syntheticValue);
  }, 30_000);

  it('can exclude the owner-retained private environment file without weakening example-file scanning', () => {
    const directory = temporaryRepository();
    const privateValue = 'syntheticPrivateToken123456';
    writeFileSync(join(directory, '.env'), `SERPAPI_KEY=${privateValue}\n`);
    writeFileSync(join(directory, '.env.example'), 'SERPAPI_KEY=replace_with_serpapi_key\n');
    execFileSync('git', ['add', '.env', '.env.example'], { cwd: directory });

    const output = execFileSync(
      process.execPath,
      [scanner, '--scope=current', '--exclude-private-env'],
      { cwd: directory, encoding: 'utf8' },
    );

    expect(output).toContain('Secret scan passed for current');
    expect(output).not.toContain(privateValue);
  }, 30_000);

  it('scans the proposed index and accepts a staged private-file deletion', () => {
    const directory = temporaryRepository();
    const syntheticValue = 'syntheticPrivateToken123456';
    writeFileSync(join(directory, '.env'), `SERPAPI_KEY=${syntheticValue}\n`);
    execFileSync('git', ['add', '.env'], { cwd: directory });
    commitFixture(directory);
    rmSync(join(directory, '.env'));
    execFileSync('git', ['add', '--update', '--', '.env'], { cwd: directory });

    const output = execFileSync(process.execPath, [scanner, '--scope=current'], {
      cwd: directory,
      encoding: 'utf8',
    });

    expect(output).toContain('Secret scan passed for current');
    expect(output).not.toContain(syntheticValue);
  }, 30_000);

  it('rejects a staged secret even when the worktree replacement is safe', () => {
    const directory = temporaryRepository();
    const stagedValue = 'syntheticStagedCredentialValue123456';
    writeFileSync(join(directory, '.env.example'), `SERPAPI_KEY=${stagedValue}\n`);
    execFileSync('git', ['add', '.env.example'], { cwd: directory });
    writeFileSync(join(directory, '.env.example'), 'SERPAPI_KEY=replace_with_serpapi_key\n');

    const result = spawnSync(process.execPath, [scanner, '--scope=current'], {
      cwd: directory,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('matches assigned provider credential');
    expect(result.stderr).not.toContain(stagedValue);
  }, 30_000);

  it('accepts a staged safe blob even when the worktree contains an unstaged secret', () => {
    const directory = temporaryRepository();
    const unstagedValue = 'syntheticUnstagedCredentialValue123456';
    writeFileSync(join(directory, '.env.example'), 'SERPAPI_KEY=replace_with_serpapi_key\n');
    execFileSync('git', ['add', '.env.example'], { cwd: directory });
    writeFileSync(join(directory, '.env.example'), `SERPAPI_KEY=${unstagedValue}\n`);

    const output = execFileSync(process.execPath, [scanner, '--scope=current'], {
      cwd: directory,
      encoding: 'utf8',
    });

    expect(output).toContain('Secret scan passed for current');
    expect(output).not.toContain(unstagedValue);
  }, 30_000);

  it('applies production placeholder policy when one historical blob has test and production paths', () => {
    const directory = temporaryRepository();
    const sharedContent = "export const SERPER_API_KEY = 'fixture_shared_credential_value';\n";
    mkdirSync(join(directory, 'e2e'));
    mkdirSync(join(directory, 'src'));
    writeFileSync(join(directory, 'e2e', 'shared.ts'), sharedContent);
    writeFileSync(join(directory, 'src', 'shared.ts'), sharedContent);
    execFileSync('git', ['add', 'e2e/shared.ts', 'src/shared.ts'], { cwd: directory });
    commitFixture(directory);

    const result = spawnSync(process.execPath, [scanner, '--scope=history'], {
      cwd: directory,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/shared.ts');
    expect(result.stderr).toContain('matches assigned provider credential');
    expect(result.stderr).not.toContain('fixture_shared_credential_value');
  }, 30_000);

  it('does not disclose a detected historical credential on stderr', () => {
    const directory = temporaryRepository();
    const historicalValue = 'syntheticHistoricalCredentialValue123456';
    writeFileSync(join(directory, '.env.example'), `SERPAPI_KEY=${historicalValue}\n`);
    execFileSync('git', ['add', '.env.example'], { cwd: directory });
    commitFixture(directory);

    const result = spawnSync(process.execPath, [scanner, '--scope=history'], {
      cwd: directory,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('matches assigned provider credential');
    expect(result.stderr).not.toContain(historicalValue);
  }, 30_000);
});
