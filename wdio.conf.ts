const edgeDriverPort = Number(process.env.SWL_EDGEDRIVER_PORT ?? "4444");
const webViewDebugPort = Number(process.env.SWL_WEBVIEW_DEBUG_PORT ?? "9515");

/**
 * Drives the production executable through Microsoft Edge WebDriver attached
 * to the application's WebView2 remote-debugging loopback port.
 *
 * scripts/run-windows-desktop-e2e.ps1 launches the unmodified binary with
 * WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS supplying the debugging port (the
 * WebView2 loader appends that value to the application's own browser
 * arguments) and starts msedgedriver before WDIO connects. No WebDriver
 * plugin, endpoint or permission is compiled into the application.
 */
export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./desktop-e2e/**/*.spec.ts"],
  maxInstances: 1,
  hostname: "127.0.0.1",
  port: edgeDriverPort,
  path: "/",
  capabilities: [
    {
      browserName: "webview2",
      "ms:edgeOptions": {
        debuggerAddress: `127.0.0.1:${webViewDebugPort}`,
      },
    } as WebdriverIO.Capabilities,
  ],
  logLevel: "info",
  bail: 0,
  waitforTimeout: 15_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,
  reporters: ["spec"],
  framework: "jasmine",
  jasmineOpts: {
    defaultTimeoutInterval: 120_000,
    random: false,
  },
};
