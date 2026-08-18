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
        startTimeout: 60_000,
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
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,
  reporters: ['spec'],
  framework: 'jasmine',
  jasmineOpts: {
    defaultTimeoutInterval: 120_000,
    random: false,
  },
};
