import { defineConfig } from "@playwright/test";

/**
 * E2E tests run against the PRODUCTION deployment shape: the bundled Node
 * server serving dist/ AND the /api routes on one origin, with the strict
 * Content Security Policy exactly as shipped. The fixture provider gives
 * deterministic live-search results offline, and the data directory is seeded
 * so populated surfaces (dashboard charts, price history) can be exercised.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    launchOptions: {
      // Pre-installed browser in this environment; do not download.
      executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
    },
  },
  webServer: {
    command: "npm run build && node scripts/e2e-server.mjs",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
