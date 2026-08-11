import { defineConfig } from "@playwright/test";

/**
 * E2E tests run the production web bundle with deterministic local operational
 * data. Competitor-search tests intercept only the external API boundary with
 * test-owned responses; production modules never import that test helper.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  // Browser cases mutate an append-only synthetic Node store. One worker plus
  // the automatic seed-snapshot fixture provides deterministic isolation.
  fullyParallel: false,
  workers: 1,
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
