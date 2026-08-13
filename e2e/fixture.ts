import { expect, test as base } from '@playwright/test';
import { cpSync, existsSync, rmSync } from 'node:fs';

const LIVE_DATA_DIRECTORY = process.env.SWL_LOCAL_TEST_LIVE_DATA_DIR;
const SEED_DATA_DIRECTORY = process.env.SWL_LOCAL_TEST_SEED_DATA_DIR;

function resetSyntheticServerData() {
  if (!LIVE_DATA_DIRECTORY || !SEED_DATA_DIRECTORY || !existsSync(SEED_DATA_DIRECTORY)) {
    throw new Error('The synthetic E2E seed snapshot is unavailable.');
  }
  rmSync(LIVE_DATA_DIRECTORY, { recursive: true, force: true });
  cpSync(SEED_DATA_DIRECTORY, LIVE_DATA_DIRECTORY, {
    recursive: true,
    errorOnExist: true,
  });
}

/**
 * Every browser test receives the same isolated fictional Node-store snapshot.
 * The production-shaped server reads its files for each operation, so this
 * reset prevents append-only approvals from one test changing another test.
 */
export const test = base.extend<{ resetSyntheticStore: void }>({
  resetSyntheticStore: [
    async ({ browserName }, use) => {
      if (browserName !== 'chromium') {
        throw new Error('The production E2E fixture requires Chromium-compatible Edge.');
      }
      resetSyntheticServerData();
      await use();
    },
    { auto: true },
  ],
});

export { expect };
export type { Page } from '@playwright/test';
