import { $, $$, browser, expect } from "@wdio/globals";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const EVIDENCE_DIRECTORY = path.resolve(
  process.env.SWL_DESKTOP_EVIDENCE_DIR ?? "desktop-e2e-evidence",
);
const capturedScreenshots = new Set<string>();

const ROUTES = [
  "#/dashboard",
  "#/new-run",
  "#/runs",
  "#/inventory",
  "#/suppliers",
  "#/mapping-profiles",
  "#/pricing-rules",
  "#/competitors",
  "#/sources",
  "#/exceptions",
  "#/approvals",
  "#/exports",
  "#/integrations",
  "#/audit",
  "#/settings",
  "#/help",
] as const;

async function buttonWithText(text: string) {
  return $(`button=${text}`);
}

/** Icon-only chrome controls carry their name on aria-label, not as text. */
async function buttonWithLabel(label: string) {
  return $(`button[aria-label="${label}"]`);
}

async function navigate(hash: string) {
  await browser.execute((target) => {
    (
      globalThis as typeof globalThis & { location: { hash: string } }
    ).location.hash = target;
  }, hash);
  await browser.waitUntil(async () => (await browser.getUrl()).endsWith(hash));
}

async function capture(name: string) {
  await mkdir(EVIDENCE_DIRECTORY, { recursive: true });
  await browser.saveScreenshot(path.join(EVIDENCE_DIRECTORY, name));
  capturedScreenshots.add(name);
  await writeFile(
    path.join(EVIDENCE_DIRECTORY, "NATIVE-RENDER-SCOPE.json"),
    `${JSON.stringify(
      {
        scope:
          "Production-binary WebView render inside the native application on GitHub-hosted Windows Server 2025; not interactive Windows 10/11 scaling acceptance",
        runnerOS: process.env.RUNNER_OS ?? "local",
        runnerImage: process.env.ImageOS ?? "unknown",
        sourceCommit: process.env.SWL_SOURCE_SHA ?? "local",
        screenshots: [...capturedScreenshots].sort(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

describe("production SWL Windows desktop binary", () => {
  it("opens the native application shell and every retained route", async () => {
    await browser.setWindowSize(1366, 768);
    await navigate("#/dashboard");
    await expect($("html")).toHaveAttribute("data-theme", "light");
    await capture("dashboard-light-1366x768.png");

    await (await buttonWithLabel("Dark appearance")).click();
    await expect($("html")).toHaveAttribute("data-theme", "dark");
    await capture("dashboard-dark-1366x768.png");
    await (await buttonWithLabel("Light appearance")).click();
    await expect($("html")).toHaveAttribute("data-theme", "light");

    await browser.setWindowSize(1920, 1080);
    await capture("dashboard-light-1920x1080.png");

    await browser.setWindowSize(390, 600);
    const minimumSize = await browser.getWindowSize();
    expect(minimumSize.width).toBe(390);
    expect(minimumSize.height).toBe(600);
    await capture("dashboard-minimum-390x600.png");

    await browser.execute(() => {
      const runtime = globalThis as unknown as {
        document: { activeElement: { blur?: () => void } | null };
      };
      runtime.document.activeElement?.blur?.();
    });
    await browser.keys(["Tab"]);
    const focus = (await browser.execute(() => {
      const runtime = globalThis as unknown as {
        document: { activeElement: { tagName?: string } | null };
        getComputedStyle: (element: unknown) => {
          outlineStyle: string;
          outlineWidth: string;
        };
      };
      const element = runtime.document.activeElement;
      const style = element ? runtime.getComputedStyle(element) : null;
      return {
        tagName: element?.tagName ?? "",
        outlineStyle: style?.outlineStyle ?? "",
        outlineWidth: style?.outlineWidth ?? "",
      };
    })) as unknown as {
      tagName: string;
      outlineStyle: string;
      outlineWidth: string;
    };
    expect(focus.tagName).not.toBe("BODY");
    expect(focus.outlineStyle).not.toBe("none");
    expect(focus.outlineWidth).not.toBe("0px");
    await capture("keyboard-visible-focus-390x600.png");

    await browser.setWindowSize(1366, 768);
    await expect($("footer")).toHaveText(
      expect.stringContaining("Windows desktop"),
    );
    await expect($("body")).not.toHaveText(
      expect.stringContaining("Open this application in a browser"),
    );

    for (const route of ROUTES) {
      await navigate(route);
      await expect($("main h1")).toBeDisplayed();
    }
  });

  it("runs all seven workflow stages offline with synthetic data", async () => {
    await browser.setWindowSize(1366, 768);
    await navigate("#/new-run");
    // Declare the supplier's GST basis first: the release checklist blocks
    // export until it is confirmed, exactly as the web suite does.
    await (await buttonWithLabel("Open settings")).click();
    await (await $('input[value="prices-ex-gst"]')).click();
    await (await buttonWithText("Apply changes…")).click();
    await (await buttonWithText("Confirm and apply")).click();
    await browser.waitUntil(
      async () => !(await $("dialog").isExisting()),
    );
    await expect(
      $('nav[aria-label="Run workflow"] button[aria-current="step"]'),
    ).toHaveText(expect.stringContaining("Start"));
    await capture("workflow-01-start-1366x768.png");
    await (await buttonWithText("Load synthetic demonstration")).click();
    await expect($("body")).toHaveText(
      expect.stringContaining("DEMO-fictionville-supplier-price-list.csv"),
    );
    await capture("workflow-02-files-populated-1366x768.png");

    await (await buttonWithText("Continue to column mapping")).click();
    await expect(
      $('nav[aria-label="Run workflow"] button[aria-current="step"]'),
    ).toHaveText(expect.stringContaining("Map columns"));
    await capture("workflow-03-map-columns-1366x768.png");
    await (await buttonWithText("Confirm mapping and run comparison")).click();
    await expect($("h2=Validation and comparison results")).toBeDisplayed();
    await capture("workflow-04-validation-1366x768.png");

    await (await buttonWithText("Review proposed changes")).click();
    await expect(
      $('nav[aria-label="Run workflow"] button[aria-current="step"]'),
    ).toHaveText(expect.stringContaining("Review"));
    await capture("workflow-05-review-1366x768.png");

    const priceChanged = await buttonWithText("Price changed (6)");
    await priceChanged.click();
    await (await $('input[aria-label="Select all visible rows"]')).click();
    await (await buttonWithText("Approve selected (6)")).click();
    await (await buttonWithText("Approve 6 record(s)")).click();
    await browser.waitUntil(
      async () => (await $$(".badge-approved").length) === 6,
    );

    await (await buttonWithText("New items (2)")).click();
    await (await $('input[aria-label="Select all visible rows"]')).click();
    await (await buttonWithText("Approve selected (2)")).click();
    await (await buttonWithText("Approve 2 record(s)")).click();

    await (await buttonWithText("Continue to pre-export checks")).click();
    await expect($("h2=Release checklist")).toBeDisplayed();
    await capture("workflow-06-checklist-1366x768.png");
    await (await buttonWithText("Continue to export")).click();
    await capture("workflow-07-export-ready-1366x768.png");
    await (await buttonWithText("Generate all output files")).click();
    await expect($("h3=Generated files")).toBeDisplayed();
    await expect($$(".gate-list > li")).toBeElementsArrayOfSize(5);
    await expect($("body")).toHaveText(
      expect.stringContaining("Save to output folder"),
    );
    await capture("workflow-07-export-generated-1366x768.png");
    const unexpectedNetwork = await browser.execute(() =>
      performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter(
          (url) =>
            /^https?:/u.test(url) &&
            !/^http:\/\/(?:tauri|ipc)\.localhost/u.test(url),
        ),
    );
    expect(unexpectedNetwork).toEqual([]);
  });

  it("runs deterministic fixture searches across every provider state", async () => {
    await browser.setWindowSize(1366, 768);
    await navigate("#/competitors");
    const search = await $('input[placeholder*="Lockwood 4570"]');
    const submit = await buttonWithText("Run fixture search");

    await search.setValue("LW4570");
    await submit.click();
    await expect(
      $('div[role="region"][aria-label="Fixture search results"]'),
    ).toBeDisplayed();
    await capture("provider-fixture-results-1366x768.png");

    const captureState = async (
      query: string,
      heading: string,
      name: string,
    ) => {
      await search.setValue(query);
      await submit.click();
      await expect($(`h2*=${heading}`)).toBeDisplayed();
      await capture(`provider-${name}-1366x768.png`);
    };

    await captureState(
      "fixture:empty",
      "No fixture prices found",
      "fixture-empty",
    );
    await captureState(
      "fixture:offline",
      "The computer is offline",
      "fixture-offline",
    );
    await captureState(
      "fixture:timeout",
      "The search provider timed out",
      "fixture-timeout",
    );
    await captureState(
      "fixture:quota",
      "Approved search allowance is exhausted",
      "fixture-quota",
    );
    await captureState(
      "fixture:rate-limit",
      "Local rate limit reached",
      "fixture-rate-limit",
    );
    await captureState(
      "fixture:error",
      "The search provider returned an error",
      "fixture-error",
    );
  });

  it("creates, previews, confirms and restores a verified local backup", async () => {
    await browser.setWindowSize(1366, 768);
    await navigate("#/settings");
    const recovery = await $('section[aria-labelledby="recovery-title"]');
    await expect(recovery).toBeDisplayed();

    await (await recovery.$("button=Create verified backup")).click();
    await expect(recovery).toHaveText(
      expect.stringContaining("Verified backup created:"),
    );
    await capture("backup-created-1366x768.png");

    await (await recovery.$("button=Preview selected backup")).click();
    await expect(
      await recovery.$("strong=Verified restore preview"),
    ).toBeDisplayed();
    await expect(recovery).toHaveText(
      expect.stringContaining(
        "Restore preview verified. No live data has changed.",
      ),
    );
    const restore = await recovery.$("button=Restore selected backup");
    await expect(restore).toBeDisabled();
    await capture("restore-preview-1366x768.png");

    await (await recovery.$('input[type="checkbox"]')).click();
    await expect(restore).toBeEnabled();
    await capture("restore-confirmed-1366x768.png");
    const backupsBeforeRestore = await recovery.$$("option").length;
    await restore.click();
    // A successful restore reloads the verified configuration, which unmounts
    // and remounts this panel, so its transient status message is not
    // observable. The observable success signature is the remounted panel
    // listing exactly one additional backup: the pre-restore backup that only
    // a completed restore creates.
    await browser.waitUntil(async () => {
      const remounted = await $('section[aria-labelledby="recovery-title"]');
      if (!(await remounted.isDisplayed().catch(() => false))) return false;
      return (await remounted.$$("option").length) === backupsBeforeRestore + 1;
    });
    const remountedRecovery = await $(
      'section[aria-labelledby="recovery-title"]',
    );
    expect(
      await (await remountedRecovery.$("strong=Verified restore preview")).isExisting(),
    ).toBe(false);
    await capture("restore-completed-1366x768.png");
  });

  it("requires the exact second confirmation before erasing synthetic local data", async () => {
    await navigate("#/sources");
    const manualSourceBefore = await $("tr*=Manual operator entry");
    await (await manualSourceBefore.$("button=Disable")).click();
    await expect(manualSourceBefore).toHaveText(
      expect.stringContaining("disabled"),
    );

    await (await buttonWithLabel("Privacy and data handling")).click();
    await (await buttonWithText("Preview application data erasure…")).click();
    await expect($("#reset-scope-title")).toBeDisplayed();
    await capture("data-erasure-preview-1366x768.png");
    const erase = await buttonWithText("Create backup and erase exact scope");
    await expect(erase).toBeDisabled();
    const confirmation = await $('input[autocomplete="off"]');
    await confirmation.setValue("ERASE SWL LOCAL DATA");
    await expect(erase).toBeEnabled();
    await capture("data-erasure-typed-confirmation-1366x768.png");
    await erase.click();
    await navigate("#/dashboard");
    const historyCard = await $("button*=Price versions on record");
    await expect(await historyCard.$(".metric-value")).toHaveText("0");
    await navigate("#/sources");
    const manualSourceAfter = await $("tr*=Manual operator entry");
    await expect(manualSourceAfter).toHaveText(
      expect.stringContaining("enabled"),
    );
    await expect(await manualSourceAfter.$("button=Disable")).toBeDisplayed();
    await capture("data-erasure-completed-sources-reset-1366x768.png");

    // Keep erasure evidence separate, then deliberately repopulate this same
    // disposable profile through the production UI. The subsequent installer
    // lifecycle test must prove nonzero catalogue, approval and history data
    // survives install, force-close, uninstall and reinstall.
    await navigate("#/new-run");
    await (await buttonWithText("Load synthetic demonstration")).click();
    await (await buttonWithText("Continue to column mapping")).click();
    await (await buttonWithText("Confirm mapping and run comparison")).click();
    await (await buttonWithText("Review proposed changes")).click();
    await (await buttonWithText("Price changed (6)")).click();
    await (await $('input[aria-label="Select all visible rows"]')).click();
    await (await buttonWithText("Approve selected (6)")).click();
    await (await buttonWithText("Approve 6 record(s)")).click();
    await browser.waitUntil(
      async () => (await $$(".badge-approved").length) === 6,
    );
    await navigate("#/dashboard");
    const repopulatedHistory = await $("button*=Price versions on record");
    await expect(await repopulatedHistory.$(".metric-value")).toHaveText("6");
    await capture("data-erasure-repopulated-synthetic-history-1366x768.png");
  });
});
