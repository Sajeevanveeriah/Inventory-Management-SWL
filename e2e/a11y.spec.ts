import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from './fixture';

/** Automated WCAG 2.2 AA checks on every major screen and state. */

async function expectNoAccessibilityViolations(page: Page, screen: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const inScope = results.violations;
  expect(
    inScope.flatMap((violation) =>
      violation.nodes.map(
        (node) =>
          `${screen}: [${violation.impact}] ${violation.id}: ${
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

test('start screen has no accessibility violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /supplier price comparison/i })).toBeVisible();
  await expect(page.locator('.nav-close')).toBeHidden();
  await expectNoAccessibilityViolations(page, 'start');
});

test('files screen, including a rejection error state', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start new comparison' }).click();
  await expectNoAccessibilityViolations(page, 'files-empty');
  // Error state: unsupported file via the picker input.
  await page.locator('#file-input-supplier').setInputFiles({
    name: 'bad.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('x'),
  });
  await expect(page.getByRole('alert')).toBeVisible();
  await expectNoAccessibilityViolations(page, 'files-error');
});

test('mapping, validation, review, checklist and export screens', async ({ page }) => {
  await demoToValidate(page);
  await expectNoAccessibilityViolations(page, 'validate');

  await page.getByRole('button', { name: 'Map columns' }).click();
  await expectNoAccessibilityViolations(page, 'mapping');

  await page.getByRole('button', { name: 'Confirm mapping and run comparison' }).click();
  await page.getByRole('button', { name: 'Review proposed changes' }).click();
  await expectNoAccessibilityViolations(page, 'review');

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
  await expectNoAccessibilityViolations(page, 'checklist');

  await page.getByRole('button', { name: 'Continue to export' }).click();
  await expectNoAccessibilityViolations(page, 'export');
  await page.getByRole('button', { name: 'Generate all output files' }).click();
  await expect(page.getByRole('heading', { name: 'Generated files' })).toBeVisible();
  await expectNoAccessibilityViolations(page, 'export-ready');
});

test('dialogs: settings, privacy and confirmation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open settings' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectNoAccessibilityViolations(page, 'settings-dialog');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Privacy and data handling' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectNoAccessibilityViolations(page, 'privacy-dialog');
  // Focus is inside the dialog and Escape closes it (focus management).
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('competitor search: empty, fixture results, no-results, provider failure; sources', async ({
  page,
}) => {
  await page.goto('/#/competitors');
  await expect(page.getByRole('heading', { name: 'Competitor search', exact: true })).toBeVisible();
  await expectNoAccessibilityViolations(page, 'competitor-search-empty');

  const searchBox = page.getByLabel(/Product name, part number/);
  await searchBox.fill('LW4570');
  await page.getByRole('button', { name: 'Run fixture search' }).click();
  await expect(page.getByRole('region', { name: 'Fixture search results' })).toBeVisible();
  await expectNoAccessibilityViolations(page, 'competitor-search-fixture-results');

  await searchBox.fill('fixture-none');
  await page.getByRole('button', { name: 'Run fixture search' }).click();
  await expect(page.getByText(/No fixture prices found/)).toBeVisible();
  await expectNoAccessibilityViolations(page, 'competitor-search-no-results');

  await searchBox.fill('fixture-error');
  await page.getByRole('button', { name: 'Run fixture search' }).click();
  await expect(page.getByText('The search provider returned an error')).toBeVisible();
  await expectNoAccessibilityViolations(page, 'competitor-search-provider-error');

  await page.getByRole('button', { name: 'Source registry' }).click();
  await expect(page.getByRole('heading', { name: 'Source registry' }).first()).toBeVisible();
  await expectNoAccessibilityViolations(page, 'source-registry');
});

test('dashboard, catalogue search and approvals with demo data', async ({ page }) => {
  await demoToValidate(page);
  await page.getByRole('button', { name: 'Dashboard' }).click();
  await expectNoAccessibilityViolations(page, 'dashboard');
  await page.getByRole('button', { name: 'Inventory search' }).click();
  await page.getByLabel('Search products by code, item number or description').fill('deadbolt');
  await expectNoAccessibilityViolations(page, 'inventory-search');
  await page.getByRole('button', { name: 'Expansion catalogue' }).click();
  await expectNoAccessibilityViolations(page, 'expansion-catalogue');
  await page.getByRole('button', { name: 'Approvals' }).click();
  await expectNoAccessibilityViolations(page, 'approvals');
  await page.getByRole('button', { name: 'Exceptions' }).click();
  await expectNoAccessibilityViolations(page, 'exceptions');
});

test('dark theme keeps contrast on the review screen', async ({ page }) => {
  await demoToValidate(page);
  await page.getByRole('button', { name: 'Open settings' }).click();
  const settingsDialog = page.getByRole('dialog');
  await settingsDialog.getByRole('button', { name: 'Dark appearance' }).click();
  // The dialog deliberately ignores Escape while an appearance save is in
  // flight, so wait for the save to land before dismissing it.
  await expect(settingsDialog.getByRole('button', { name: 'Dark appearance' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(settingsDialog.getByRole('button', { name: 'Close' })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Review changes' }).click();
  await expectNoAccessibilityViolations(page, 'review-dark');
});
