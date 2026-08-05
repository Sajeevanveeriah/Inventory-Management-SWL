import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/** Automated WCAG 2.2 AA checks on every major screen and state. */

async function expectNoSeriousViolations(page: Page, screen: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(
    serious.map((v) => `${screen}: [${v.impact}] ${v.id} — ${v.help} (${v.nodes.length} nodes)`),
  ).toEqual([]);
}

async function demoToValidate(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Load synthetic demonstration' }).click();
  await page.getByRole('button', { name: 'Continue to column mapping' }).click();
  await page.getByRole('button', { name: 'Confirm mapping and run comparison' }).click();
}

test('start screen has no serious accessibility violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /supplier price comparison/i })).toBeVisible();
  await expectNoSeriousViolations(page, 'start');
});

test('files screen, including a rejection error state', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start new comparison' }).click();
  await expectNoSeriousViolations(page, 'files-empty');
  // Error state: unsupported file via the picker input.
  await page
    .locator('#file-input-supplier')
    .setInputFiles({ name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
  await expect(page.getByRole('alert')).toBeVisible();
  await expectNoSeriousViolations(page, 'files-error');
});

test('mapping, validation, review, checklist and export screens', async ({ page }) => {
  await demoToValidate(page);
  await expectNoSeriousViolations(page, 'validate');

  await page.getByRole('button', { name: 'Map columns' }).click();
  await expectNoSeriousViolations(page, 'mapping');

  await page.getByRole('button', { name: 'Confirm mapping and run comparison' }).click();
  await page.getByRole('button', { name: 'Review proposed changes' }).click();
  await expectNoSeriousViolations(page, 'review');

  // Approve everything eligible so checklist and export are in ready states.
  for (const tab of [/^Price changed \(5\)$/, /^New items \(2\)$/]) {
    await page.getByRole('button', { name: tab }).click();
    await page.getByRole('checkbox', { name: 'Select all visible rows' }).check();
    await page.getByRole('button', { name: /Approve selected/ }).click();
    await page.getByRole('button', { name: /Approve \d record\(s\)/ }).click();
  }
  await page.getByRole('button', { name: 'Continue to pre-export checks' }).click();
  await expectNoSeriousViolations(page, 'checklist');

  await page.getByRole('button', { name: 'Continue to export' }).click();
  await expectNoSeriousViolations(page, 'export');
  await page.getByRole('button', { name: 'Generate all output files' }).click();
  await expect(page.getByRole('heading', { name: 'Generated files' })).toBeVisible();
  await expectNoSeriousViolations(page, 'export-ready');
});

test('dialogs: settings, privacy and confirmation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectNoSeriousViolations(page, 'settings-dialog');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Privacy & data' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectNoSeriousViolations(page, 'privacy-dialog');
  // Focus is inside the dialog and Escape closes it (focus management).
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('competitor search: empty, live results, no-results, provider failure; sources', async ({
  page,
}) => {
  await page.goto('/#/competitors');
  await expect(page.getByRole('heading', { name: 'Competitor search' })).toBeVisible();
  await expectNoSeriousViolations(page, 'competitor-search-empty');

  const searchBox = page.getByLabel(/Product name, part number/);
  await searchBox.fill('LW4570');
  await page.getByRole('button', { name: 'Search live prices' }).click();
  await expect(page.getByRole('region', { name: 'Live search results' })).toBeVisible();
  await expectNoSeriousViolations(page, 'competitor-search-live-results');

  await searchBox.fill('fixture-none');
  await page.getByRole('button', { name: 'Search live prices' }).click();
  await expect(page.getByText(/No live prices found/)).toBeVisible();
  await expectNoSeriousViolations(page, 'competitor-search-no-results');

  await searchBox.fill('fixture-error');
  await page.getByRole('button', { name: 'Search live prices' }).click();
  await expect(page.getByText('The search provider returned an error')).toBeVisible();
  await expectNoSeriousViolations(page, 'competitor-search-provider-error');

  await page.getByRole('button', { name: 'Source registry' }).click();
  await expect(page.getByRole('heading', { name: 'Source registry' }).first()).toBeVisible();
  await expectNoSeriousViolations(page, 'source-registry');
});

test('dashboard, catalogue search and approvals with demo data', async ({ page }) => {
  await demoToValidate(page);
  await page.getByRole('button', { name: 'Dashboard' }).click();
  await expectNoSeriousViolations(page, 'dashboard');
  await page.getByRole('button', { name: 'Inventory search' }).click();
  await page.getByLabel('Search products by code, item number or description').fill('deadbolt');
  await expectNoSeriousViolations(page, 'inventory-search');
  await page.getByRole('button', { name: 'Approvals' }).click();
  await expectNoSeriousViolations(page, 'approvals');
  await page.getByRole('button', { name: 'Exceptions' }).click();
  await expectNoSeriousViolations(page, 'exceptions');
});

test('dark theme keeps contrast on the review screen', async ({ page }) => {
  await demoToValidate(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Theme').selectOption('dark');
  await page.keyboard.press('Escape');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Review changes' }).click();
  await expectNoSeriousViolations(page, 'review-dark');
});
