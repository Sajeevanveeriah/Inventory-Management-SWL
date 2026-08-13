#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { clearTimeout as clearScheduledTimeout, setTimeout as scheduleTimeout } from 'node:timers';
import { fileURLToPath, URL } from 'node:url';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLAYWRIGHT_CLI = resolve(REPOSITORY_ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
const PROVIDER_ENVIRONMENT_KEYS = [
  'SERPAPI_KEY',
  'SWL_HTTP_FEED_BEARER_TOKEN',
  'SWL_PAID_CALLS_ENABLED',
  'SWL_PROVIDER_COST_CEILING_CENTS',
  'SWL_PROVIDER_COST_PER_CALL_CENTS',
  'SWL_SEARCH_PROVIDER',
];

function cleanEnvironment() {
  const environment = { ...process.env };
  for (const key of PROVIDER_ENVIRONMENT_KEYS) delete environment[key];
  for (const key of Object.keys(environment)) {
    if (key.startsWith('VITE_')) delete environment[key];
  }
  delete environment.NODE_OPTIONS;
  environment.SWL_LOCAL_TEST = '1';
  environment.VITE_BASE = '/';
  environment.VITE_STATIC_DEMO = 'false';
  return environment;
}

function browserPath() {
  if (process.platform !== 'win32') {
    throw new Error('Automated local acceptance currently requires Microsoft Edge on Windows.');
  }
  const candidates = [
    process.env.CHROMIUM_PATH,
    process.env['ProgramFiles(x86)']
      ? join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      : undefined,
    process.env.ProgramFiles
      ? join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      : undefined,
  ].filter(Boolean);
  const selected = [...new Set(candidates.map((candidate) => resolve(candidate)))].find(
    (candidate) => existsSync(candidate),
  );
  if (!selected) {
    throw new Error(
      'Microsoft Edge was not found under Program Files; this runner never downloads it.',
    );
  }
  const resolved = realpathSync(selected);
  const metadata = lstatSync(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('The selected browser is not a reviewed regular executable file.');
  }
  const attestedSha256 = process.env.SWL_VERIFIED_BROWSER_SHA256;
  if (attestedSha256 !== undefined) {
    if (!/^[0-9a-f]{64}$/u.test(attestedSha256)) {
      throw new Error('The supplied browser attestation is not a lowercase SHA-256 digest.');
    }
    const actualSha256 = createHash('sha256').update(readFileSync(resolved)).digest('hex');
    if (actualSha256 !== attestedSha256) {
      throw new Error('The selected browser does not match the verified workflow attestation.');
    }
    return resolved;
  }
  const verificationEnvironment = cleanEnvironment();
  verificationEnvironment.SWL_BROWSER_CANDIDATE = resolved;
  const verification = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$item=Get-Item -LiteralPath $env:SWL_BROWSER_CANDIDATE; $signature=Get-AuthenticodeSignature -LiteralPath $env:SWL_BROWSER_CANDIDATE; if($item.VersionInfo.ProductName -notlike '*Microsoft Edge*' -or $signature.Status -ne 'Valid'){exit 1}",
    ],
    { env: verificationEnvironment, stdio: 'ignore', windowsHide: true },
  );
  if (verification.error) {
    throw new Error('Microsoft Edge product and signature verification could not be started.');
  }
  if (verification.status !== 0) {
    throw new Error(
      'The installed Microsoft Edge executable failed product or signature verification.',
    );
  }
  return resolved;
}

function waitForClose(child, timeoutMilliseconds, label) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise, reject) => {
    const onClose = (code, signal) => {
      clearScheduledTimeout(timeout);
      resolvePromise({ code, signal });
    };
    const timeout = scheduleTimeout(() => {
      child.removeListener('close', onClose);
      reject(new Error(`${label} did not stop within ${timeoutMilliseconds} ms.`));
    }, timeoutMilliseconds);
    child.once('close', onClose);
  });
}

async function forceOwnedProcessTree(child, label) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (!Number.isInteger(child.pid)) throw new Error(`${label} has no owned process identifier.`);
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (result.error) throw result.error;
  } else {
    child.kill('SIGKILL');
  }
  await waitForClose(child, 5_000, `${label} after forced shutdown`);
}

async function stopOwnedProcess(child, label, gracefulShutdown = false) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    const closed = waitForClose(child, 10_000, label);
    if (gracefulShutdown && child.connected) child.send('shutdown');
    else child.kill('SIGTERM');
    await closed;
  } catch (gracefulError) {
    try {
      await forceOwnedProcessTree(child, label);
    } catch (forcedError) {
      throw new AggregateError(
        [gracefulError, forcedError],
        `${label} did not stop gracefully or through the owned process-tree fallback.`,
        { cause: forcedError },
      );
    }
  }
}

function startLauncher() {
  const child = spawn(process.execPath, ['scripts/local-test-platform.mjs', '--no-open'], {
    cwd: REPOSITORY_ROOT,
    env: cleanEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  child.stderr.on('data', (chunk) => process.stderr.write(String(chunk)));
  return child;
}

function waitForLauncherReady(child) {
  return new Promise((resolvePromise, reject) => {
    let output = '';
    const timeout = scheduleTimeout(
      () =>
        reject(new Error('The local fixture launcher did not become ready within 180 seconds.')),
      180_000,
    );
    const failBeforeReady = (code, signal) => {
      clearScheduledTimeout(timeout);
      reject(
        new Error(
          `The local fixture launcher exited before readiness (${signal ?? code ?? 'unknown'}).`,
        ),
      );
    };
    child.once('close', failBeforeReady);
    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      process.stdout.write(text);
      output += text;
      const match = output.match(/(?:^|\r?\n)LOCAL_TEST_READY (\{[^\r\n]+\})\r?\n/u);
      if (!match) return;
      try {
        const summary = JSON.parse(match[1]);
        if (
          typeof summary.url !== 'string' ||
          summary.fixtureMode !== true ||
          summary.paidCallsEnabled !== false ||
          summary.repositoryEnvironmentFilesLoaded !== false
        ) {
          throw new Error('The launcher readiness boundary is invalid.');
        }
        clearScheduledTimeout(timeout);
        child.removeListener('close', failBeforeReady);
        resolvePromise(summary);
      } catch (error) {
        clearScheduledTimeout(timeout);
        child.removeListener('close', failBeforeReady);
        reject(error);
      }
    });
  });
}

function runPlaywright(url, executablePath) {
  const suppliedArguments = process.argv.slice(2);
  const hasReporter = suppliedArguments.some(
    (argument) => argument === '--reporter' || argument.startsWith('--reporter='),
  );
  const args = [
    PLAYWRIGHT_CLI,
    'test',
    '--config',
    'playwright.local.config.ts',
    ...suppliedArguments,
    ...(hasReporter ? [] : ['--reporter=line']),
  ];
  return spawn(process.execPath, args, {
    cwd: REPOSITORY_ROOT,
    env: {
      ...cleanEnvironment(),
      CHROMIUM_PATH: executablePath,
      SWL_LOCAL_TEST_URL: url,
    },
    stdio: 'inherit',
    windowsHide: true,
  });
}

async function main() {
  if (!existsSync(PLAYWRIGHT_CLI)) {
    throw new Error(
      'Locked Playwright dependencies are missing. Run npm ci once before local E2E; this runner never installs dependencies.',
    );
  }
  const executablePath = browserPath();
  let launcher;
  let playwright;
  let interrupted = false;
  let operationError;
  const shutdownErrors = [];
  const requestShutdown = () => {
    interrupted = true;
    playwright?.kill('SIGTERM');
    if (launcher?.connected) launcher.send('shutdown');
    else launcher?.kill('SIGTERM');
  };
  process.once('SIGINT', requestShutdown);
  process.once('SIGTERM', requestShutdown);
  try {
    launcher = startLauncher();
    const ready = await waitForLauncherReady(launcher);
    console.log(`Driving local fixture test at ${ready.url}`);
    console.log(`Browser: ${executablePath}`);
    playwright = runPlaywright(ready.url, executablePath);
    const result = await waitForClose(playwright, 15 * 60_000, 'Playwright');
    if (interrupted) process.exitCode = 130;
    else if (result.code !== 0) process.exitCode = result.code ?? 1;
  } catch (error) {
    operationError = error;
  } finally {
    try {
      await stopOwnedProcess(playwright, 'Playwright');
    } catch (error) {
      shutdownErrors.push(error);
    }
    try {
      await stopOwnedProcess(launcher, 'Local fixture launcher', true);
    } catch (error) {
      shutdownErrors.push(error);
    }
  }
  if (operationError || shutdownErrors.length > 0) {
    throw new AggregateError(
      [operationError, ...shutdownErrors].filter(Boolean),
      'The local E2E run or one of its owned processes failed.',
    );
  }
}

main().catch((error) => {
  const details =
    error instanceof AggregateError
      ? error.errors
          .filter(Boolean)
          .map((cause) => (cause instanceof Error ? cause.message : String(cause)))
          .join(' | ')
      : error instanceof Error
        ? error.message
        : String(error);
  console.error(`Local E2E platform failed: ${details}`);
  process.exitCode = 1;
});
