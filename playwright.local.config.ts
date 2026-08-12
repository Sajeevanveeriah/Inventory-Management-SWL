import { defineConfig } from '@playwright/test';

const executablePath = process.env.CHROMIUM_PATH;
const baseURL = process.env.SWL_LOCAL_TEST_URL;

if (!executablePath) {
  throw new Error('The local runner must supply its verified Microsoft Edge executable.');
}
if (!baseURL) {
  throw new Error('SWL_LOCAL_TEST_URL must be supplied by the local E2E runner.');
}

/**
 * Local no-install acceptance uses the fixture launcher owned by
 * scripts/run-local-e2e.mjs. Playwright does not manage the web server:
 * the runner owns readiness, dynamic ports, shutdown and disposable cleanup.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['line']],
  use: {
    baseURL,
    launchOptions: { executablePath },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
