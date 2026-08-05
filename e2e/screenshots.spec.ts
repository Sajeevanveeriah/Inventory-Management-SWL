import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';

/**
 * Captures representative screenshots of every major screen and state into
 * ./screenshots (gitignored). Used for the mandatory visual inspection pass.
 */

const DIR = 'screenshots';
test.beforeAll(() => {
  fs.mkdirSync(DIR, { recursive: true });
});

async function shot(page: Page, name: string) {
  // Reset scroll so sticky chrome is not stitched mid-page in full-page shots.
  await page.evaluate('window.scrollTo(0, 0)');
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: true });
}

async function demoToValidate(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Load synthetic demonstration' }).click();
  await page.getByRole('button', { name: 'Continue to column mapping' }).click();
  await page.getByRole('button', { name: 'Confirm mapping and run comparison' }).click();
  await expect(
    page.getByRole('heading', { name: 'Validation and comparison results' }),
  ).toBeVisible();
}

async function approveAllEligible(page: Page) {
  for (const tab of [/^Price changed \(5\)$/, /^New items \(2\)$/] as const) {
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
    await page
      .locator('#file-input-supplier')
      .setInputFiles({ name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
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

    await page.getByRole('button', { name: /^Invalid \(2\)$/ }).click();
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
    await page.getByRole('button', { name: 'Settings' }).click();
    await shot(page, '15-settings-dialog');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Privacy & data' }).click();
    await shot(page, '16-privacy-dialog');
    await page.keyboard.press('Escape');

    await demoToValidate(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByLabel('Theme').selectOption('dark');
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
    await page.getByRole('button', { name: 'Integrations' }).click();
    await shot(page, '27-integrations');
    await page.getByRole('button', { name: 'Suppliers' }).click();
    await shot(page, '28-suppliers');
  });

  test('competitor search states and source registry', async ({ page }) => {
    await page.goto('/#/competitors');
    await shot(page, '30-competitor-search-empty');
    await page.getByLabel('SKU or product').fill('LW4570');
    await page.getByLabel('Observed price (AUD)').fill('143.00');
    await page.getByLabel('Source URL').fill('https://example.invalid/lw4570');
    await page.getByRole('button', { name: 'Store observation' }).click();
    await expect(page.getByRole('heading', { name: /Price band/ })).toBeVisible();
    await shot(page, '31-competitor-search-results');
    await page.getByLabel('Search all sources').fill('no-such-product-zzz');
    await expect(page.getByText('No stored evidence matches this search')).toBeVisible();
    await shot(page, '32-competitor-search-no-results');
    await page.getByRole('button', { name: 'Source registry' }).click();
    await expect(page.getByRole('heading', { name: 'Source registry' }).first()).toBeVisible();
    await shot(page, '33-source-registry');
  });

  test('competitor search and source registry on mobile 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/competitors');
    await shot(page, '34-competitor-search-mobile-empty');
    await page.getByLabel('SKU or product').fill('LW4570');
    await page.getByLabel('Observed price (AUD)').fill('143.00');
    await page.getByRole('button', { name: 'Store observation' }).click();
    await expect(page.getByRole('heading', { name: /Price band/ })).toBeVisible();
    await shot(page, '35-competitor-search-mobile-results');
    await page.getByRole('button', { name: 'Source registry' }).click();
    await expect(page.getByRole('heading', { name: 'Source registry' }).first()).toBeVisible();
    await shot(page, '36-source-registry-mobile');
  });

  test('dashboard and approvals on mobile 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/dashboard');
    await shot(page, '37-dashboard-mobile-empty');
    await demoToValidate(page);
    await page.getByRole('button', { name: 'Dashboard' }).click();
    await shot(page, '38-dashboard-mobile-loaded');
    await page.getByRole('button', { name: 'Approvals' }).click();
    await shot(page, '39-approvals-mobile');
  });

  test('search on mobile 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await demoToValidate(page);
    await page.getByRole('button', { name: 'Inventory search' }).click();
    await page.getByLabel('Search products by code, item number or description').fill('deadbolt');
    await shot(page, '29-search-mobile');
  });
});
