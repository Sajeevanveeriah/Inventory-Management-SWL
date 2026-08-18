import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));
const application =
  process.env.SWL_DESKTOP_BINARY ??
  path.join(repositoryRoot, 'src-tauri', 'target', 'release', 'swl-pricing-desktop.exe');

/**
 * Drives the production executable through the external official Tauri driver.
 * No WebDriver plugin, endpoint or permission is compiled into the application.
 */
export const config: WebdriverIO.Config = {
  runner: 'local',
  specs: ['./desktop-e2e/**/*.spec.ts'],
  maxInstances: 1,
  services: [
    [
      '@wdio/tauri-service',
      {
        appBinaryPath: application,
        driverProvider: 'external',
        autoInstallTauriDriver: false,
        autoDownloadEdgeDriver: false,
        captureBackendLogs: false,
        captureFrontendLogs: false,
        /**
         * WebView2 has to cold-start a release binary that step 30 of the
         * Windows workflow finished building minutes earlier, against a clean
         * disposable user-data directory, with freshly applied outbound-deny
         * firewall rules on that exact executable. Defender scans an unsigned
         * new binary on first execute, and WebView2 does its full first-run
         * initialisation, so the driver can wait a long time for the
         * DevToolsActivePort file the session depends on.
         *
         * At 60s that budget was routinely missed: the driver reported
         * "session not created: DevToolsActivePort file doesn't exist" at
         * exactly the timeout, and no test body ever ran.
         */
        startTimeout: 180_000,
      },
    ],
  ],
  capabilities: [
    {
      browserName: 'tauri',
      'tauri:options': { application },
    } as WebdriverIO.Capabilities,
  ],
  logLevel: 'info',
  bail: 0,
  waitforTimeout: 15_000,
  // Must stay above startTimeout, or the HTTP client aborts POST /session
  // before the driver has finished waiting and the real reason is lost.
  connectionRetryTimeout: 240_000,
  connectionRetryCount: 1,
  reporters: ['spec'],
  framework: 'jasmine',
  jasmineOpts: {
    defaultTimeoutInterval: 120_000,
    random: false,
  },
};
