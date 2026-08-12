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
   * The attached WebView2 debug endpoint can expose more than one top-level
   * target (for example an initial blank context) and the session may start
   * on the wrong one, where every application selector fails. Select the
   * window handle that serves the application origin before any spec runs.
   */
  before: async () => {
    const applicationOrigin = /^https?:\/\/tauri\.localhost/u;
    const observedUrls: string[] = [];
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
        { timeout: 30_000, interval: 500 },
      );
    } catch (cause) {
      throw new Error(
        `No WebView2 window served the application origin http://tauri.localhost; observed URLs: ${JSON.stringify(observedUrls)}`,
        { cause },
      );
    }
    console.log(
      `[swl-acceptance] window URLs observed: ${JSON.stringify(observedUrls)}`,
    );

    // Boot diagnostics: capture the application's own console output across a
    // reload, then print a DOM snapshot, so a frontend that fails to mount
    // leaves its error in the step log rather than only inside the artefact.
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
    await browser.execute(() => {
      (
        globalThis as unknown as { location: { reload: () => void } }
      ).location.reload();
    });
    await browser.pause(8_000);
    const bootSnapshot = await browser.execute(() => {
      const runtime = globalThis as unknown as {
        document: {
          readyState: string;
          documentElement: { dataset: { theme?: string } };
          getElementById: (id: string) => { childElementCount: number } | null;
          body: { innerText?: string } | null;
        };
      };
      return {
        readyState: runtime.document.readyState,
        theme: runtime.document.documentElement.dataset.theme ?? null,
        rootChildren:
          runtime.document.getElementById("root")?.childElementCount ?? -1,
        bodyPreview: (runtime.document.body?.innerText ?? "").slice(0, 400),
      };
    });
    console.log(
      `[swl-acceptance] boot snapshot: ${JSON.stringify(bootSnapshot)}`,
    );
    console.log(
      `[swl-acceptance] console entries: ${JSON.stringify(consoleEntries.slice(0, 50))}`,
    );
  },
};
