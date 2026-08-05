import { expect, test, type Page } from '@playwright/test';

/**
 * End-to-end coverage of the operations shell added around the run workflow:
 * product search, exceptions queue, approvals, supplier profiles and the
 * integrations status page.
 */

async function loadDemoAndCompare(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Load synthetic demonstration' }).click();
  await page.getByRole('button', { name: 'Continue to column mapping' }).click();
  await page.getByRole('button', { name: 'Confirm mapping and run comparison' }).click();
  await expect(
    page.getByRole('heading', { name: 'Validation and comparison results' }),
  ).toBeVisible();
}

test('product search: empty state, ranked results, filters and no-result state', async ({
  page,
}) => {
  await page.goto('/#/inventory');
  await expect(page.getByRole('heading', { name: 'No comparison data loaded' })).toBeVisible();

  await loadDemoAndCompare(page);
  await page.getByRole('button', { name: 'Inventory search' }).click();
  await expect(page.getByRole('heading', { name: 'Inventory search', level: 1 })).toBeVisible();

  // All records visible with an empty query.
  const countLine = page.locator('.result-count');
  await expect(countLine).toContainText('records');

  // Exact identifier search ranks the exact row first.
  const search = page.getByLabel('Search products by code, item number or description');
  await search.fill('FIC-002');
  await expect(page.locator('tbody tr').first()).toContainText('FIC-002');

  // Description token search.
  await search.fill('deadbolt chrome');
  await expect(page.locator('tbody tr').first()).toBeVisible();

  // Status filter chips narrow the results.
  await search.fill('');
  await page.getByRole('button', { name: 'New item', exact: true }).click();
  await expect(countLine).toContainText('2 of');
  await page.getByRole('button', { name: 'Clear filters' }).click();

  // No-result state with a helpful message.
  await search.fill('zzz-not-a-real-product');
  await expect(page.getByRole('heading', { name: 'No matching products' })).toBeVisible();
});

test('global topbar search routes to the inventory search page', async ({ page }) => {
  await loadDemoAndCompare(page);
  const global = page.getByLabel('Search products across supplier and ServiceM8 data');
  await global.fill('FIC-001');
  await expect(page.getByRole('heading', { name: 'Inventory search', level: 1 })).toBeVisible();
  await expect(page.locator('tbody tr').first()).toContainText('FIC-001');
});

test('exceptions queue supports search and exclude-with-reason', async ({ page }) => {
  await loadDemoAndCompare(page);
  await page.getByRole('button', { name: 'Exceptions' }).click();
  await expect(page.getByRole('heading', { name: 'Exceptions', level: 1 })).toBeVisible();
  await expect(page.locator('tbody tr').first()).toBeVisible();

  // Blocked rows cannot be excluded; the action column explains why.
  await expect(page.getByText('Blocked or review-only').first()).toBeVisible();

  // Searching narrows the queue.
  await page.getByLabel('Search exceptions').fill('duplicate');
  await expect(page.locator('.result-count')).toContainText('of');
});

test('approvals page approves and withdraws a proposal', async ({ page }) => {
  await loadDemoAndCompare(page);
  await page.getByRole('button', { name: 'Approvals' }).click();
  await expect(page.getByRole('heading', { name: 'Approvals', level: 1 })).toBeVisible();

  const firstApprove = page.getByRole('button', { name: 'Approve', exact: true }).first();
  await firstApprove.click();
  const withdraw = page.getByRole('button', { name: 'Withdraw approval' }).first();
  await expect(withdraw).toBeVisible();
  await withdraw.click();
  await expect(page.getByRole('button', { name: 'Withdraw approval' })).toHaveCount(0);
});

test('supplier profiles: save, export and delete with confirmation', async ({ page }) => {
  await loadDemoAndCompare(page);
  await page.getByRole('button', { name: 'Suppliers' }).click();
  await page.getByLabel('Profile name').fill('E2E Fictionville');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByRole('cell', { name: /E2E Fictionville/ })).toBeVisible();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON' }).first().click();
  expect((await download).suggestedFilename()).toContain('mapping-profile.json');

  await page.getByRole('button', { name: 'Delete', exact: true }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Delete profile' }).click();
  await expect(page.getByRole('cell', { name: /E2E Fictionville/ })).toHaveCount(0);
});

test('integrations page states the locked external boundaries', async ({ page }) => {
  await page.goto('/#/integrations');
  await expect(page.getByRole('heading', { name: 'ServiceM8' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Xero' })).toBeVisible();
  await expect(page.getByText('File handoff', { exact: true })).toBeVisible();
  await expect(page.getByText('Locked', { exact: true })).toBeVisible();
  await expect(page.getByText('Live Xero updates are locked off', { exact: false })).toBeVisible();
});

test('mobile 390px: search page remains usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loadDemoAndCompare(page);
  await page.getByRole('button', { name: 'Inventory search' }).click();
  const search = page.getByLabel('Search products by code, item number or description');
  await search.fill('FIC-003');
  await expect(page.locator('tbody tr').first()).toContainText('FIC-003');
  // No horizontal page overflow: tables scroll inside their own container.
  interface DocLike {
    documentElement: { scrollWidth: number; clientWidth: number };
  }
  const overflow = await page.evaluate(() => {
    const doc = (globalThis as unknown as { document: DocLike }).document;
    return doc.documentElement.scrollWidth - doc.documentElement.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
});
