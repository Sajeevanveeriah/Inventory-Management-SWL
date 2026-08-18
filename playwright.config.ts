import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

/**
 * e2e/fixture.ts restores the synthetic seed snapshot before every browser
 * test, so the runner must publish the same directory pair that the Windows
 * no-install runner supplies. scripts/e2e-server.mjs reads the same variables,
 * which keeps the seeded directories and the fixture reset in one place.
 */
const liveDataDirectory = resolve('.e2e-data');
const seedDataDirectory = resolve('.e2e-seed-data');
process.env.SWL_LOCAL_TEST_LIVE_DATA_DIR = liveDataDirectory;
process.env.SWL_LOCAL_TEST_SEED_DATA_DIR = seedDataDirectory;

/**
 * E2E tests run the production web bundle with deterministic local operational
 * data. Competitor-search tests intercept only the external API boundary with
 * test-owned responses; production modules never import that test helper.
 */
export default defineConfig({
  testDir: './e2e',
  /**
   * The journey cases walk load → map → validate → review → approve →
   * checklist → export in one test, and the export step alone is allowed up to
   * 90s of CPU-bound workbook generation on a loaded runner. A 60s per-test cap
   * would cut in before that budget could ever be spent, reporting a test
   * timeout instead of the real reason.
   */
  timeout: 180_000,
  // Browser cases mutate an append-only synthetic Node store. One worker plus
  // the automatic seed-snapshot fixture provides deterministic isolation.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    launchOptions: {
      // Pre-installed browser in this environment; do not download.
      executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
    },
  },
  webServer: {
    command: 'npm run build && node scripts/e2e-server.mjs',
    env: {
      SWL_LOCAL_TEST_LIVE_DATA_DIR: liveDataDirectory,
      SWL_LOCAL_TEST_SEED_DATA_DIR: seedDataDirectory,
    },
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
