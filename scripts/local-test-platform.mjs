#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { clearTimeout as clearScheduledTimeout, setTimeout as scheduleTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOCAL_TEST_PREFIX = 'swl-local-test-';
const PROVIDER_ENVIRONMENT_KEYS = [
  'SERPAPI_KEY',
  'SWL_HTTP_FEED_BEARER_TOKEN',
  'SWL_PAID_CALLS_ENABLED',
  'SWL_PROVIDER_COST_CEILING_CENTS',
  'SWL_PROVIDER_COST_PER_CALL_CENTS',
  'SWL_SEARCH_PROVIDER',
];

function argumentValue(name) {
  const exact = process.argv.indexOf(name);
  if (exact >= 0) return process.argv[exact + 1];
  const prefix = `${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function hasArgument(name) {
  return process.argv.includes(name);
}

function assertPrerequisites() {
  const expectedNode = readFileSync(join(REPOSITORY_ROOT, '.nvmrc'), 'utf8').trim();
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  const supportedLocalRuntime =
    (major === 22 && (minor > 22 || (minor === 22 && patch >= 2))) || major === 24;
  if (!supportedLocalRuntime) {
    throw new Error(
      `Node.js ${expectedNode} or the supported Node 24 LTS runtime is required; this terminal is using ${process.versions.node}.`,
    );
  }
  if (process.versions.node !== expectedNode) {
    console.warn(
      `Local-test compatibility mode: using Node.js ${process.versions.node}; release verification still uses ${expectedNode}.`,
    );
  }
  for (const path of ['node_modules/typescript/bin/tsc', 'node_modules/vite/bin/vite.js']) {
    if (!existsSync(join(REPOSITORY_ROOT, path))) {
      throw new Error(
        'Locked development dependencies are missing. Run npm ci once before using the local test platform; this launcher never installs dependencies.',
      );
    }
  }
}

function scrubbedEnvironment() {
  const environment = { ...process.env };
  for (const key of PROVIDER_ENVIRONMENT_KEYS) delete environment[key];
  for (const key of Object.keys(environment)) {
    if (key.startsWith('VITE_')) delete environment[key];
  }
  delete environment.NODE_OPTIONS;
  delete environment.PORT;
  delete environment.SWL_DIST_DIR;
  return environment;
}

function fixtureEnvironment(dataDirectory) {
  const environment = scrubbedEnvironment();
  environment.SWL_DATA_DIR = dataDirectory;
  environment.SWL_PAID_CALLS_ENABLED = 'false';
  return environment;
}

function buildEnvironment() {
  const environment = fixtureEnvironment('');
  delete environment.SWL_DATA_DIR;
  environment.SWL_LOCAL_TEST = '1';
  environment.VITE_BASE = '/';
  environment.VITE_STATIC_DEMO = 'false';
  return environment;
}

function runChecked(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: REPOSITORY_ROOT,
      env: options.env ?? process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        reject(
          new Error(
            `${options.stage ?? command} failed${signal ? ` after ${signal}` : ` with exit code ${code ?? 'unknown'}`}.`,
          ),
        );
      }
    });
  });
}

function availablePort() {
  return new Promise((resolvePromise, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close();
        reject(new Error('A loopback test port could not be selected.'));
        return;
      }
      const port = address.port;
      probe.close((error) => (error ? reject(error) : resolvePromise(port)));
    });
  });
}

function startFixtureServer(port, dataDirectory) {
  const child = spawn(
    process.execPath,
    ['tests/support/fixture-server.mjs', '--port', String(port)],
    {
      cwd: REPOSITORY_ROOT,
      env: fixtureEnvironment(dataDirectory),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  child.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  return child;
}

async function waitForHealth(url, child, timeoutMilliseconds = 30_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`The fixture server exited before it became ready (${child.exitCode}).`);
    }
    try {
      const response = await globalThis.fetch(`${url}/api/health`, {
        signal: globalThis.AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const health = await response.json();
        if (
          health?.ok === true &&
          health?.provider === 'fixture' &&
          health?.fixtureMode === true &&
          health?.liveSearchConfigured === false &&
          health?.paidCallsEnabled === false
        ) {
          return health;
        }
        throw new Error('The local server did not report the required fixture-only boundary.');
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'The local server did not report the required fixture-only boundary.'
      ) {
        throw error;
      }
    }
    await delay(100);
  }
  throw new Error('The fixture server did not become ready within 30 seconds.');
}

function openBrowser(url) {
  const command =
    process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/d', '/c', 'start', '', url] : [url];
  const browser = spawn(command, args, {
    detached: true,
    env: scrubbedEnvironment(),
    stdio: 'ignore',
    windowsHide: true,
  });
  browser.unref();
}

function removeCreatedTemporaryDirectory(directory) {
  const temporaryRoot = realpathSync(tmpdir());
  const resolvedDirectory = resolve(directory);
  const metadata = lstatSync(resolvedDirectory);
  const realDirectory = realpathSync(resolvedDirectory);
  if (
    dirname(resolvedDirectory) !== temporaryRoot ||
    !basename(resolvedDirectory).startsWith(LOCAL_TEST_PREFIX) ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    realDirectory !== resolvedDirectory ||
    dirname(realDirectory) !== temporaryRoot
  ) {
    throw new Error('Temporary local-test cleanup refused an unexpected path.');
  }
  rmSync(resolvedDirectory, { recursive: true, force: true });
}

function waitForChildClose(child, timeoutMilliseconds, label) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const onClose = () => {
      clearScheduledTimeout(timeout);
      resolvePromise();
    };
    const timeout = scheduleTimeout(() => {
      child.removeListener('close', onClose);
      reject(new Error(`${label} did not stop within ${timeoutMilliseconds} ms.`));
    }, timeoutMilliseconds);
    child.once('close', onClose);
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    const closed = waitForChildClose(child, 5_000, 'The fixture server');
    child.kill('SIGTERM');
    await closed;
  } catch (gracefulError) {
    try {
      if (!Number.isInteger(child.pid)) {
        throw new Error('The fixture server has no owned process identifier.', {
          cause: gracefulError,
        });
      }
      if (process.platform === 'win32') {
        const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        if (result.error) throw result.error;
      } else {
        child.kill('SIGKILL');
      }
      await waitForChildClose(child, 5_000, 'The fixture server after forced shutdown');
    } catch (forcedError) {
      throw new AggregateError(
        [gracefulError, forcedError],
        'The fixture server did not stop gracefully or through the owned process-tree fallback.',
        { cause: forcedError },
      );
    }
  }
}

async function main() {
  assertPrerequisites();
  const autoStopText = argumentValue('--auto-stop-ms');
  const autoStopMilliseconds = autoStopText === undefined ? undefined : Number(autoStopText);
  if (
    autoStopMilliseconds !== undefined &&
    (!Number.isInteger(autoStopMilliseconds) || autoStopMilliseconds < 50)
  ) {
    throw new Error('--auto-stop-ms must be an integer of at least 50.');
  }

  let temporaryDirectory;
  let serverProcess;
  let intendedShutdown = false;
  let operationError;
  let shutdownError;
  let resolveShutdownRequest;
  let shutdownRequestedBeforeReady = false;
  const requestShutdown = () => {
    intendedShutdown = true;
    shutdownRequestedBeforeReady = true;
    resolveShutdownRequest?.();
  };
  const ipcShutdownListener = (message) => {
    if (message === 'shutdown') requestShutdown();
  };
  process.once('SIGINT', requestShutdown);
  process.once('SIGTERM', requestShutdown);
  process.on('message', ipcShutdownListener);
  try {
    if (!hasArgument('--no-build')) {
      console.log('Building the current source without loading repository environment files...');
      await runChecked(process.execPath, ['node_modules/typescript/bin/tsc', '-b'], {
        env: buildEnvironment(),
        stage: 'Current-source TypeScript build',
      });
      await runChecked(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {
        env: buildEnvironment(),
        stage: 'Current-source Vite production build',
      });
    }

    temporaryDirectory = mkdtempSync(join(realpathSync(tmpdir()), LOCAL_TEST_PREFIX));
    const dataDirectory = join(temporaryDirectory, 'data');
    const seedDataDirectory = join(temporaryDirectory, 'seed-data');
    console.log('Creating a fresh fictional test store...');
    await runChecked(process.execPath, ['server/seed.mjs', '--data-dir', seedDataDirectory], {
      env: fixtureEnvironment(seedDataDirectory),
      stage: 'Synthetic test-store seed',
    });
    cpSync(seedDataDirectory, dataDirectory, { recursive: true, errorOnExist: true });

    const port = await availablePort();
    const url = `http://127.0.0.1:${port}`;
    serverProcess = startFixtureServer(port, dataDirectory);
    const health = await waitForHealth(url, serverProcess);
    const forwardedSensitiveKeys = PROVIDER_ENVIRONMENT_KEYS.filter(
      (key) => key !== 'SWL_SEARCH_PROVIDER' && key !== 'SWL_PAID_CALLS_ENABLED',
    ).filter((key) => Object.hasOwn(fixtureEnvironment(dataDirectory), key));
    const summary = {
      url,
      dataDirectory: temporaryDirectory,
      liveDataDirectory: dataDirectory,
      seedDataDirectory,
      provider: health.provider,
      fixtureMode: health.fixtureMode,
      paidCallsEnabled: health.paidCallsEnabled,
      repositoryEnvironmentFilesLoaded: false,
      forwardedSensitiveKeys,
    };

    console.log('');
    console.log('SWL LOCAL TEST READY');
    console.log(`URL: ${url}`);
    console.log('Mode: offline fictional fixture; paid provider calls are disabled.');
    console.log(
      'Data: disposable test directory; production and browser demonstration data are untouched.',
    );
    console.log(
      'Stop: press Ctrl+C in this window. The disposable test directory is then removed.',
    );
    console.log(`LOCAL_TEST_READY ${JSON.stringify(summary)}`);
    if (!hasArgument('--no-open')) openBrowser(url);

    const exited = new Promise((resolvePromise) =>
      serverProcess.once('close', (code, signal) => resolvePromise({ kind: 'exit', code, signal })),
    );
    const shutdownRequested = new Promise((resolvePromise) => {
      resolveShutdownRequest = () => resolvePromise({ kind: 'shutdown' });
      if (shutdownRequestedBeforeReady) resolveShutdownRequest();
    });
    if (autoStopMilliseconds !== undefined) {
      scheduleTimeout(requestShutdown, autoStopMilliseconds);
    }
    const outcome = await Promise.race([exited, shutdownRequested]);
    if (outcome.kind === 'shutdown') {
      await stopChild(serverProcess);
    } else if (!intendedShutdown && outcome.code !== 0) {
      throw new Error(
        `The fixture server stopped unexpectedly (${outcome.signal ?? outcome.code ?? 'unknown'}).`,
      );
    }
  } catch (error) {
    operationError = error;
  } finally {
    process.removeListener('SIGINT', requestShutdown);
    process.removeListener('SIGTERM', requestShutdown);
    process.removeListener('message', ipcShutdownListener);
    try {
      await stopChild(serverProcess);
    } catch (error) {
      shutdownError = error;
    }
    try {
      if (!shutdownError && temporaryDirectory && existsSync(temporaryDirectory)) {
        removeCreatedTemporaryDirectory(temporaryDirectory);
        console.log('Disposable local-test data removed.');
      }
    } finally {
      if (process.connected) process.disconnect();
    }
  }
  if (operationError && shutdownError) {
    throw new AggregateError(
      [operationError, shutdownError],
      'The local test failed and its fixture server did not stop cleanly.',
    );
  }
  if (operationError) throw operationError;
  if (shutdownError) throw shutdownError;
}

main().catch((error) => {
  console.error(
    `Local test platform failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
