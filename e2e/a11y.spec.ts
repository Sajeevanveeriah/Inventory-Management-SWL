import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from './fixture';
import { installLiveSearchApiMock } from './support/liveSearch';

/** Automated WCAG 2.2 AA checks on every major screen and state. */

async function expectNoWcagViolations(page: Page, screen: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    results.violations.flatMap((violation) =>
      violation.nodes.map(
        (node) =>
          `${screen}: [${violation.impact ?? 'unknown'}] ${violation.id}: ${
            violation.help
          }; target ${node.target.join(' > ')}; ${node.failureSummary ?? 'no failure summary'}`,
      ),
    ),
  ).toEqual([]);
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
}

test('start screen has no WCAG A or AA accessibility violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /supplier price comparison/i })).toBeVisible();
  await expect(page.locator('.nav-close')).toBeHidden();
  await expectNoWcagViolations(page, 'start');
});

test('files screen, including a rejection error state', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start new comparison' }).click();
  await expectNoWcagViolations(page, 'files-empty');
  // Error state: unsupported file via the picker input.
  await page.locator('#file-input-supplier').setInputFiles({
    name: 'bad.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('x'),
  });
  await expect(page.getByRole('alert')).toBeVisible();
  await expectNoWcagViolations(page, 'files-error');
});

test('mapping, validation, review, checklist and export screens', async ({ page }) => {
  await demoToValidate(page);
  await expectNoWcagViolations(page, 'validate');

  await page.getByRole('button', { name: 'Map columns' }).click();
  await expectNoWcagViolations(page, 'mapping');

  await page.getByRole('button', { name: 'Confirm mapping and run comparison' }).click();
  await page.getByRole('button', { name: 'Review proposed changes' }).click();
  await expectNoWcagViolations(page, 'review');

  // Approve everything eligible so checklist and export are in ready states.
  for (const [tab, approved] of [
    [/^Price changed \(6\)$/, 6],
    [/^New items \(2\)$/, 2],
  ] as const) {
    await page.getByRole('button', { name: tab }).click();
    await page.getByRole('checkbox', { name: 'Select all visible rows' }).check();
    await page.getByRole('button', { name: /Approve selected/ }).click();
    await page.getByRole('button', { name: /Approve \d record\(s\)/ }).click();
    await expect(page.getByRole('status')).toContainText(
      `Approved and recorded ${approved} records.`,
    );
  }
  await page.getByRole('button', { name: 'Continue to pre-export checks' }).click();
  await expectNoWcagViolations(page, 'checklist');

  await page.getByRole('button', { name: 'Continue to export' }).click();
  await expectNoWcagViolations(page, 'export');
  await page.getByRole('button', { name: 'Generate all output files' }).click();
  await expect(page.getByRole('heading', { name: 'Generated files' })).toBeVisible();
  await expectNoWcagViolations(page, 'export-ready');
});

test('dialogs: settings, privacy and confirmation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open settings' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectNoWcagViolations(page, 'settings-dialog');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Privacy and data handling' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectNoWcagViolations(page, 'privacy-dialog');
  // Focus is inside the dialog and Escape closes it (focus management).
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('competitor search: empty, live results, no-results, provider failure; sources', async ({
  page,
}) => {
  await installLiveSearchApiMock(page);
  await page.goto('/#/competitors');
  await expect(page.getByRole('heading', { name: 'Competitor search' })).toBeVisible();
  await expectNoWcagViolations(page, 'competitor-search-empty');

  const searchBox = page.getByLabel(/Product name, part number/);
  await searchBox.fill('LW4570');
  await page.getByRole('button', { name: 'Search live prices' }).click();
  await page.getByRole('button', { name: 'Compare this exact product' }).click();
  await expect(page.getByRole('region', { name: 'Live search results' })).toBeVisible();
  await expectNoWcagViolations(page, 'competitor-search-live-results');

  await searchBox.fill('fixture-none');
  await page.getByRole('button', { name: 'Search live prices' }).click();
  await expect(page.getByText(/No usable product candidates found/)).toBeVisible();
  await expectNoWcagViolations(page, 'competitor-search-no-results');

  await searchBox.fill('fixture-error');
  await page.getByRole('button', { name: 'Search live prices' }).click();
  await expect(page.getByText('The search provider returned an error')).toBeVisible();
  await expectNoWcagViolations(page, 'competitor-search-provider-error');

  await page.getByRole('button', { name: 'Price sources' }).click();
  await expect(page.getByRole('heading', { name: 'Price sources' }).first()).toBeVisible();
  await expectNoWcagViolations(page, 'price-sources');
});

test('dashboard, catalogue search and approvals with demo data', async ({ page }) => {
  await demoToValidate(page);
  await page.getByRole('button', { name: 'Dashboard' }).click();
  await expectNoWcagViolations(page, 'dashboard');
  await page.getByRole('button', { name: 'Find a product' }).click();
  await page
    .getByLabel('Search products by item code, supplier SKU, barcode, brand or description')
    .fill('deadbolt');
  // Scan the visible destination state, not an intermediate opacity frame of
  // the purposeful result-entry transition.
  await expect(page.locator('.search-result-card').first()).toHaveCSS('opacity', '1');
  await expectNoWcagViolations(page, 'find-a-product');
  await page.getByRole('button', { name: 'Expansion catalogue' }).click();
  await expectNoWcagViolations(page, 'expansion-catalogue');
  await page.getByRole('button', { name: 'Approvals' }).click();
  await expectNoWcagViolations(page, 'approvals');
  await page.getByRole('button', { name: 'Approve', exact: true }).first().click();
  await expect(page.getByRole('dialog', { name: 'Confirm approval' })).toBeVisible();
  await expectNoWcagViolations(page, 'approval-confirmation');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Exceptions' }).click();
  await expectNoWcagViolations(page, 'exceptions');
});

test('products and suppliers and connect systems task pages', async ({ page }) => {
  await page.goto('/#/suppliers');
  await expect(
    page.getByRole('heading', { name: 'Products and suppliers', level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Catalogue products' })).toBeVisible();
  await expectNoWcagViolations(page, 'products-and-suppliers');

  await page.getByRole('button', { name: 'Connect systems' }).click();
  await expect(page.getByRole('heading', { name: 'Connect systems', level: 1 })).toBeFocused();
  await expect(
    page.getByText('External connections started from this page: none.', { exact: true }),
  ).toBeVisible();
  await expectNoWcagViolations(page, 'connect-systems');
});

test('dark theme keeps contrast on the review screen', async ({ page }) => {
  await demoToValidate(page);
  await page.getByRole('button', { name: 'Open settings' }).click();
  const settingsDialog = page.getByRole('dialog');
  await settingsDialog.getByRole('button', { name: 'Dark appearance' }).click();
  await settingsDialog.getByRole('button', { name: 'Close' }).click();
  await expect(settingsDialog).toBeHidden();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Review changes' }).click();
  await expectNoWcagViolations(page, 'review-dark');
});
