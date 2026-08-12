import { browser } from "@wdio/globals";

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
  /**
   * The attached WebView2 debug endpoint has been observed to report the
   * session's only top-level target as about:blank even though the native
   * window is live. Select the window handle serving the application origin
   * when one exists; otherwise drive the attached webview to the embedded
   * application origin directly and wait for the shell to mount. Boot
   * diagnostics print to stdout either way so a failure leaves its cause in
   * the step log.
   */
  before: async () => {
    const applicationOrigin = /^https?:\/\/tauri\.localhost/u;
    const consoleEntries: string[] = [];
    try {
      await browser.sessionSubscribe({ events: ["log.entryAdded"] });
      browser.on(
        "log.entryAdded",
        (entry: { level?: string; text?: string | null }) => {
          consoleEntries.push(`[${entry.level ?? "log"}] ${entry.text ?? ""}`);
        },
      );
    } catch {
      consoleEntries.push("[meta] console subscription unavailable");
    }

    const observedUrls: string[] = [];
    let onApplicationOrigin: boolean;
    try {
      await browser.waitUntil(
        async () => {
          observedUrls.length = 0;
          for (const handle of await browser.getWindowHandles()) {
            await browser.switchToWindow(handle);
            const url = await browser.getUrl();
            observedUrls.push(url);
            if (applicationOrigin.test(url)) {
              return true;
            }
          }
          return false;
        },
        { timeout: 15_000, interval: 500 },
      );
      onApplicationOrigin = true;
    } catch {
      onApplicationOrigin = false;
    }
    console.log(
      `[swl-acceptance] window URLs observed: ${JSON.stringify(observedUrls)}; onApplicationOrigin=${onApplicationOrigin}`,
    );

    if (!onApplicationOrigin) {
      // The embedded custom-protocol handler serves the compiled frontend for
      // this origin regardless of which side initiates the navigation. The
      // asset resolver maps the root path to index.html; an explicit
      // /index.html request returns "asset not found".
      await browser.url("http://tauri.localhost/");
    }

    type BootState = {
      href: string;
      readyState: string;
      theme: string | null;
      rootChildren: number;
      bodyPreview: string;
    };
    const snapshot = async (): Promise<BootState> =>
      (await browser.execute(() => {
        const runtime = globalThis as unknown as {
          location: { href: string };
          document: {
            readyState: string;
            documentElement: { dataset: { theme?: string } };
            getElementById: (
              id: string,
            ) => { childElementCount: number } | null;
            body: { innerText?: string } | null;
          };
        };
        return {
          href: runtime.location.href,
          readyState: runtime.document.readyState,
          theme: runtime.document.documentElement.dataset.theme ?? null,
          rootChildren:
            runtime.document.getElementById("root")?.childElementCount ?? -1,
          bodyPreview: (runtime.document.body?.innerText ?? "").slice(0, 300),
        };
      })) as unknown as BootState;

    try {
      await browser.waitUntil(
        async () => {
          const state = await snapshot();
          return state.rootChildren > 0 && state.theme !== null;
        },
        { timeout: 30_000, interval: 1_000 },
      );
    } catch (cause) {
      const finalState = await snapshot();
      console.log(
        `[swl-acceptance] boot snapshot: ${JSON.stringify(finalState)}`,
      );
      console.log(
        `[swl-acceptance] console entries: ${JSON.stringify(consoleEntries.slice(0, 50))}`,
      );
      throw new Error(
        `The application shell did not mount at the served origin; final state: ${JSON.stringify(finalState)}`,
        { cause },
      );
    }
    console.log(
      `[swl-acceptance] boot snapshot: ${JSON.stringify(await snapshot())}`,
    );
  },
};
