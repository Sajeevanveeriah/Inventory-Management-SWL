import { test, expect, type Page } from './fixture';
import fs from 'node:fs';
import { navigateFromCompactMenu } from './support/navigation';
import { installLiveSearchApiMock } from './support/liveSearch';

/**
 * Captures representative screenshots of every major screen and state into
 * ./screenshots (gitignored). Used for the mandatory visual inspection pass.
 */

const DIR = 'screenshots';
test.beforeAll(() => {
  fs.mkdirSync(DIR, { recursive: true });
});

async function settleVisualState(page: Page) {
  // Reset scroll so sticky chrome is not stitched mid-page in full-page shots.
  await page.evaluate('window.scrollTo(0, 0)');
  await page.locator('.side-nav nav').evaluateAll((elements) => {
    for (const element of elements) element.scrollTop = 0;
  });
  await page.evaluate(async () => {
    const runtime = globalThis as unknown as {
      document: { getAnimations: () => Array<{ finish: () => void }> };
      requestAnimationFrame: (callback: () => void) => number;
    };
    for (const animation of runtime.document.getAnimations()) {
      try {
        animation.finish();
      } catch {
        // A non-finishable browser animation does not block the next paint.
      }
    }
    await new Promise<void>((resolve) => {
      runtime.requestAnimationFrame(() => runtime.requestAnimationFrame(resolve));
    });
  });
}

async function shot(page: Page, name: string) {
  await settleVisualState(page);
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: true });
}

async function viewportShot(page: Page, name: string) {
  await settleVisualState(page);
  await page.screenshot({ path: `${DIR}/${name}.png` });
}

async function demoToValidate(page: Page) {
  await page.goto('/');
  // Declare the supplier's GST basis before anything else: export stays blocked
  // until it is set, because the markup must be applied to a GST-exclusive cost.
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('radio', { name: /supplier costs exclude gst/i }).check();
  await page.getByRole('button', { name: 'Apply changes…' }).click();
  await page.getByRole('button', { name: 'Confirm and apply' }).click();
  await page.getByRole('button', { name: 'Load synthetic demonstration' }).click();
  await page.getByRole('button', { name: 'Continue to column mapping' }).click();
  await page.getByRole('button', { name: 'Confirm mapping and run comparison' }).click();
  await expect(
    page.getByRole('heading', { name: 'Validation and comparison results' }),
  ).toBeVisible();
}

async function approveAllEligible(page: Page) {
  for (const tab of [/^Price changed \(6\)$/, /^New items \(2\)$/] as const) {
    await page.getByRole('button', { name: tab }).click();
    await page.getByRole('checkbox', { name: 'Select all visible rows' }).check();
    await page.getByRole('button', { name: /Approve selected/ }).click();
    await page.getByRole('button', { name: /Approve \d record\(s\)/ }).click();
  }
}

test.describe('desktop 1440px light', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('start and files states', async ({ page }) => {
    await page.goto('/');
    await shot(page, '01-start-desktop');
    await page.getByRole('button', { name: 'Start new comparison' }).click();
    await shot(page, '02-files-empty');
    await page.locator('#file-input-supplier').setInputFiles({
      name: 'bad.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('x'),
    });
    await expect(page.getByRole('alert')).toBeVisible();
    await shot(page, '03-files-error');
    await page.goto('/');
    await page.getByRole('button', { name: 'Load synthetic demonstration' }).click();
    await expect(page.getByText('DEMO-fictionville-supplier-price-list.csv')).toBeVisible();
    await shot(page, '04-files-loaded');
  });

  test('mapping states', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Load synthetic demonstration' }).click();
    await page.getByRole('button', { name: 'Continue to column mapping' }).click();
    await shot(page, '05-mapping-suggested');
    await page.getByLabel('Supplier cost').selectOption('');
    await expect(page.getByRole('alert').first()).toBeVisible();
    await shot(page, '06-mapping-error');
  });

  test('validate, review, checklist, export states', async ({ page }) => {
    await demoToValidate(page);
    await shot(page, '07-validate-pipeline');

    await page.getByRole('button', { name: 'Review proposed changes' }).click();
    await page.getByRole('cell', { name: 'FIC-002', exact: true }).click();
    await shot(page, '08-review-all-detail');

    await page.getByRole('button', { name: /^Ambiguous \(3\)$/ }).click();
    await page.getByRole('cell', { name: 'FIC-006', exact: true }).click();
    await shot(page, '09-review-ambiguous');

    await page.getByRole('button', { name: /^Invalid \(3\)$/ }).click();
    await page.getByRole('cell', { name: 'FIC-007', exact: true }).click();
    await shot(page, '10-review-invalid');

    await page.getByRole('button', { name: 'Continue to pre-export checks' }).click();
    await shot(page, '11-checklist-blocked');

    await page.getByRole('button', { name: 'Back to review' }).click();
    await approveAllEligible(page);
    await page.getByRole('button', { name: 'Continue to pre-export checks' }).click();
    await shot(page, '12-checklist-passing');

    await page.getByRole('button', { name: 'Continue to export' }).click();
    await shot(page, '13-export-ready');
    await page.getByRole('button', { name: 'Generate all output files' }).click();
    await expect(page.getByRole('heading', { name: 'Generated files' })).toBeVisible();
    await shot(page, '14-export-generated');
  });

  test('dialogs and dark theme', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Open settings' }).click();
    await shot(page, '15-settings-dialog');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Privacy and data handling' }).click();
    await shot(page, '16-privacy-dialog');
    await page.keyboard.press('Escape');

    await demoToValidate(page);
    await page.getByRole('button', { name: 'Open settings' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Dark appearance' }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Review changes' }).click();
    await page.getByRole('cell', { name: 'FIC-002', exact: true }).click();
    await shot(page, '17-review-dark');
  });
});

test.describe('laptop 1024px', () => {
  test.use({ viewport: { width: 1024, height: 768 } });
  test('review at 1024px', async ({ page }) => {
    await demoToValidate(page);
    await page.getByRole('button', { name: 'Review proposed changes' }).click();
    await shot(page, '18-review-1024');
  });
});

test.describe('tablet 768px', () => {
  test.use({ viewport: { width: 768, height: 1024 } });
  test('validate at 768px', async ({ page }) => {
    await demoToValidate(page);
    await shot(page, '19-validate-768');
  });
});

test.describe('mobile 390px', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('start and file status on mobile', async ({ page }) => {
    await page.goto('/');
    await shot(page, '20-start-mobile');
    await page.getByRole('button', { name: 'Load synthetic demonstration' }).click();
    await expect(page.getByText('DEMO-fictionville-supplier-price-list.csv')).toBeVisible();
    await shot(page, '21-files-mobile');
  });
});

test('current-build configuration recovery state', async ({ page }) => {
  await page.addInitScript(() => {
    const browserGlobal = globalThis as unknown as { indexedDB: object };
    Object.defineProperty(browserGlobal.indexedDB, 'open', {
      configurable: true,
      value() {
        throw new Error('Test-owned storage failure');
      },
    });
  });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Stored configuration unavailable', level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('operational workflow is blocked');
  await shot(page, '21a-configuration-recovery');
});

test.describe('operations shell', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('dashboard, search, exceptions, approvals, integrations', async ({ page }) => {
    await page.goto('/#/dashboard');
    await shot(page, '22-dashboard-empty');
    await demoToValidate(page);
    await page.getByRole('button', { name: 'Dashboard' }).click();
    await shot(page, '23-dashboard-loaded');
    await page.getByRole('button', { name: 'Inventory search' }).click();
    await page.getByLabel('Search products by code, item number or description').fill('deadbolt');
    await shot(page, '24-search-results');
    await page.getByRole('button', { name: 'Exceptions' }).click();
    await shot(page, '25-exceptions');
    await page.getByRole('button', { name: 'Approvals' }).click();
    await shot(page, '26-approvals');
    await page.getByRole('button', { name: 'Approve', exact: true }).first().click();
    await expect(page.getByRole('dialog', { name: 'Confirm approval' })).toBeVisible();
    await viewportShot(page, '26a-approval-confirmation');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Integrations' }).click();
    await shot(page, '27-integrations');
    await page.getByRole('button', { name: 'Suppliers' }).click();
    await shot(page, '28-suppliers');
  });

  test('competitor search: all five live states and source registry', async ({ page }) => {
    await installLiveSearchApiMock(page);
    await page.goto('/#/competitors');
    await shot(page, '30-competitor-search-empty');

    const searchBox = page.getByLabel(/Product name, part number/);
    // The test-owned API interceptor delays this case long enough to capture
    // the loading state. Production code has no matching query convention.
    await searchBox.fill(`fixture-slow deadlatch ${Date.now()}`);
    await page.getByRole('button', { name: 'Search live prices' }).click();
    await expect(page.getByText(/Searching live sources/)).toBeVisible();
    await shot(page, '31-competitor-search-loading');

    await searchBox.fill('LW4570');
    await page.getByRole('button', { name: 'Search live prices' }).click();
    await page.getByRole('button', { name: 'Compare this exact product' }).click();
    await expect(page.getByRole('region', { name: 'Live search results' })).toBeVisible();
    await shot(page, '32-competitor-search-results');

    await searchBox.fill('fixture-none');
    await page.getByRole('button', { name: 'Search live prices' }).click();
    await expect(page.getByText(/No usable product candidates found/)).toBeVisible();
    await shot(page, '33-competitor-search-no-results');

    await searchBox.fill('fixture-error');
    await page.getByRole('button', { name: 'Search live prices' }).click();
    await expect(page.getByText('The search provider returned an error')).toBeVisible();
    await shot(page, '34-competitor-search-provider-unavailable');

    await searchBox.fill('fixture-quota');
    await page.getByRole('button', { name: 'Search live prices' }).click();
    await expect(page.getByText('Approved search allowance is exhausted')).toBeVisible();
    await shot(page, '35-competitor-search-quota');

    await page.getByRole('button', { name: 'Source registry' }).click();
    await expect(page.getByRole('heading', { name: 'Source registry' }).first()).toBeVisible();
    await shot(page, '36-source-registry');
  });

  test('competitor search and source registry on mobile 390px', async ({ page }) => {
    await installLiveSearchApiMock(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/competitors');
    await shot(page, '37-competitor-search-mobile-empty');
    const searchBox = page.getByLabel(/Product name, part number/);
    await searchBox.fill('LW4570');
    await page.getByRole('button', { name: 'Search live prices' }).click();
    await page.getByRole('button', { name: 'Compare this exact product' }).click();
    await expect(page.getByRole('region', { name: 'Live search results' })).toBeVisible();
    await shot(page, '38-competitor-search-mobile-results');
    await navigateFromCompactMenu(page, 'Source registry');
    await expect(page.getByRole('heading', { name: 'Source registry' }).first()).toBeVisible();
    await shot(page, '39-source-registry-mobile');
  });

  test('dark competitor results at desktop and mobile widths', async ({ page }) => {
    await installLiveSearchApiMock(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/#/competitors');
    await page.getByRole('button', { name: 'Open settings' }).click();
    const settings = page.getByRole('dialog');
    await settings.getByRole('button', { name: 'Dark appearance' }).click();
    await settings.getByRole('button', { name: 'Close' }).click();
    const searchBox = page.getByLabel(/Product name, part number/);
    await searchBox.fill('LW4570');
    await page.getByRole('button', { name: 'Search live prices' }).click();
    await page.getByRole('button', { name: 'Compare this exact product' }).click();
    await expect(page.getByRole('region', { name: 'Live search results' })).toBeVisible();
    await shot(page, '43-competitor-search-results-dark-1440');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.side-nav')).toBeHidden();
    const documentWidth = await page.evaluate(() => {
      const runtime = globalThis as unknown as {
        document: { documentElement: { clientWidth: number; scrollWidth: number } };
      };
      return {
        clientWidth: runtime.document.documentElement.clientWidth,
        scrollWidth: runtime.document.documentElement.scrollWidth,
      };
    });
    expect(documentWidth.scrollWidth).toBeLessThanOrEqual(documentWidth.clientWidth + 1);
    await shot(page, '44-competitor-search-results-dark-390');
  });

  test('dashboard and approvals on mobile 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/dashboard');
    await shot(page, '40-dashboard-mobile-empty');
    await demoToValidate(page);
    await navigateFromCompactMenu(page, 'Dashboard');
    await shot(page, '41-dashboard-mobile-loaded');
    await navigateFromCompactMenu(page, 'Approvals');
    await shot(page, '42-approvals-mobile');
    await page.getByRole('button', { name: 'Approve', exact: true }).first().click();
    await expect(page.getByRole('dialog', { name: 'Confirm approval' })).toBeVisible();
    await viewportShot(page, '42a-approval-confirmation-mobile');
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  test('search on mobile 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await demoToValidate(page);
    await navigateFromCompactMenu(page, 'Inventory search');
    await page.getByLabel('Search products by code, item number or description').fill('deadbolt');
    await shot(page, '29-search-mobile');
  });
});

/**
 * Full surface tour: every routed surface at 1440 px and 390 px, in light and
 * dark theme, for the mandatory visual inspection pass.
 */
test.describe('surface tour, light and dark, 1440px and 390px', () => {
  const SURFACES = [
    ['#/dashboard', 'dashboard'],
    ['#/new-run', 'new-run'],
    ['#/runs', 'runs'],
    ['#/inventory', 'inventory'],
    ['#/expansion', 'expansion'],
    ['#/suppliers', 'suppliers'],
    ['#/mapping-profiles', 'mapping-profiles'],
    ['#/pricing-rules', 'pricing-rules'],
    ['#/competitors', 'competitors'],
    ['#/sources', 'sources'],
    ['#/exceptions', 'exceptions'],
    ['#/approvals', 'approvals'],
    ['#/exports', 'exports'],
    ['#/integrations', 'integrations'],
    ['#/audit', 'audit'],
    ['#/settings', 'settings'],
    ['#/help', 'help'],
  ] as const;

  for (const theme of ['light', 'dark'] as const) {
    for (const [width, widthName] of [
      [1440, '1440'],
      [390, '390'],
    ] as const) {
      test(`all surfaces ${theme} ${widthName}px`, async ({ page }) => {
        await page.setViewportSize({
          width,
          height: width === 390 ? 844 : 900,
        });
        await page.goto('/#/dashboard');
        if (theme === 'dark') {
          await page.getByRole('button', { name: 'Open settings' }).click();
          const settings = page.getByRole('dialog');
          await settings.getByRole('button', { name: 'Dark appearance' }).click();
          await settings.getByRole('button', { name: 'Close' }).click();
          await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        }
        for (const [route, name] of SURFACES) {
          await page.goto(`/${route}`);
          await expect(page.locator('.page-head h1')).toBeVisible();
          await shot(page, `tour-${name}-${theme}-${widthName}`);
        }
      });
    }
  }
});
