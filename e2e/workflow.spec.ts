import { expect, test, type Page } from './fixture';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Full synthetic workflow against the production build, including:
 * network isolation, console hygiene, every status, blocked-approval checks,
 * export generation and structural verification of the generated workbooks.
 */

async function loadDemoAndCompare(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Load synthetic demonstration' }).click();
  await expect(page.getByText('DEMO-fictionville-supplier-price-list.csv')).toBeVisible();
  await expect(page.getByText('DEMO-fictionville-servicem8-export.csv')).toBeVisible();
  await page.getByRole('button', { name: 'Continue to column mapping' }).click();
  await page.getByRole('button', { name: 'Confirm mapping and run comparison' }).click();
  await expect(
    page.getByRole('heading', { name: 'Validation and comparison results' }),
  ).toBeVisible();
}

test('complete synthetic workflow: load, map, validate, review, export, verify, clear', async ({
  page,
}) => {
  const externalRequests: string[] = [];
  const consoleLines: string[] = [];
  page.on('request', (req) => {
    if (!req.url().startsWith('http://127.0.0.1:4173')) externalRequests.push(req.url());
  });
  page.on('console', (msg) => consoleLines.push(msg.text()));

  await loadDemoAndCompare(page);

  // The supplier's GST basis must be declared before anything can be exported:
  // the markup is applied to a GST-exclusive cost, so an unstated basis would
  // move every generated price by the whole GST rate.
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('radio', { name: /supplier costs exclude gst/i }).check();
  await page.getByRole('button', { name: 'Apply changes…' }).click();
  await page.getByRole('button', { name: 'Confirm and apply' }).click();
  await page.getByRole('button', { name: 'Map columns', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm mapping and run comparison' }).click();

  // --- validation pipeline totals ----------------------------------------
  const pipeline = page.getByRole('list', {
    name: 'Record counts by category',
  });
  const stat = (label: string) =>
    pipeline.locator('.stat', { hasText: label }).locator('.n').first();
  await expect(stat('Supplier records')).toHaveText('16');
  await expect(stat('ServiceM8 records')).toHaveText('10');
  await expect(stat('Changed prices')).toHaveText('6');
  await expect(stat('New items')).toHaveText('2');
  await expect(stat('Unchanged')).toHaveText('1');
  // FIC-900, FIC-060 (whose supplier twin FIC-006 was blocked as ambiguous)
  // and the ServiceM8 row whose identifier a spreadsheet destroyed.
  await expect(stat('Missing from supplier')).toHaveText('3');
  // FIC-006 plus both copies of the cost-conflicting duplicate FIC-009.
  await expect(stat('Ambiguous')).toHaveText('3');
  // Missing cost, unreadable currency text, and price on application.
  await expect(stat('Invalid')).toHaveText('3');
  await expect(stat('Blocked from import')).toHaveText('6');

  // --- review: blocked statuses cannot be approved ------------------------
  await page.getByRole('button', { name: 'Review proposed changes' }).click();
  await page.getByRole('button', { name: /^Invalid \(3\)$/ }).click();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  // Selecting blocked rows leaves bulk approval disabled.
  await page.getByRole('checkbox', { name: 'Select all visible rows' }).check();
  await expect(page.getByRole('button', { name: /Approve selected \(0\)/ })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Select all visible rows' }).uncheck();

  await page.getByRole('button', { name: /^Ambiguous \(3\)$/ }).click();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);

  // --- exclude one price change before the immutable approval boundary -----
  await page.getByRole('button', { name: /^Price changed \(6\)$/ }).click();
  await page.getByRole('checkbox', { name: 'Select FIC-012' }).check();
  await page.getByRole('button', { name: /Exclude selected \(1\)/ }).click();
  await page.getByLabel('Reason for exclusion').fill('Superseded fictional line');
  await page.getByRole('button', { name: 'Exclude', exact: true }).click();
  await expect(page.locator('.badge-excluded', { hasText: 'Excluded' })).toHaveCount(1);

  // Undo/redo round-trip keeps the exclusion before any durable publication.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.badge-excluded')).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.locator('.badge-excluded', { hasText: 'Excluded' })).toHaveCount(1);

  // --- approve the five remaining price changes ---------------------------
  await page.getByRole('checkbox', { name: 'Select all visible rows' }).check();
  await page.getByRole('button', { name: /Approve selected \(5\)/ }).click();
  await page.getByRole('button', { name: 'Approve 5 record(s)' }).click();
  await expect(page.locator('.badge-approved', { hasText: 'Approved' })).toHaveCount(5);

  // Detail panel shows the full derivation for a GST-EXCLUSIVE ServiceM8 row.
  await page.getByRole('cell', { name: 'FIC-002', exact: true }).click();
  await expect(page.locator('.formula-box')).toHaveText(
    '$48.00 × 1.3 (30% on cost) = $62.40 ex GST',
  );

  // ...and adds GST for a row whose ServiceM8 price is tax-inclusive.
  await page.getByRole('cell', { name: 'FIC-003', exact: true }).click();
  await expect(page.locator('.formula-box')).toHaveText(
    '$1.80 × 1.3 (30% on cost) = $2.34 ex GST; ' + '$2.34 × 1.1 (10% GST) = $2.57 incl GST',
  );
  await expect(page.getByLabel('Record details').getByText('Match method')).toBeVisible();

  // --- approve the two new items ------------------------------------------
  await page.getByRole('button', { name: /^New items \(2\)$/ }).click();
  await page.getByRole('checkbox', { name: 'Select all visible rows' }).check();
  await page.getByRole('button', { name: /Approve selected \(2\)/ }).click();
  await page.getByRole('button', { name: 'Approve 2 record(s)' }).click();

  // --- checklist ----------------------------------------------------------
  await page.getByRole('button', { name: 'Continue to pre-export checks' }).click();
  await expect(page.getByRole('heading', { name: 'Release checklist' })).toBeVisible();
  await expect(page.getByText('Approval count confirmed: 7')).toBeVisible();
  await expect(page.getByText('Exclusion count confirmed: 1')).toBeVisible();
  const exportButton = page.getByRole('button', { name: 'Continue to export' });
  await expect(exportButton).toBeEnabled();
  await exportButton.click();

  // --- export and structural verification ---------------------------------
  await page.getByRole('button', { name: 'Generate all output files' }).click();
  await expect(page.getByRole('heading', { name: 'Generated files' })).toBeVisible();
  const downloadButtons = page.getByRole('button', {
    name: 'Download',
    exact: true,
  });
  await expect(downloadButtons).toHaveCount(5);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swl-e2e-'));
  const saved: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const downloadPromise = page.waitForEvent('download');
    await downloadButtons.nth(i).click();
    const download = await downloadPromise;
    const target = path.join(dir, download.suggestedFilename());
    await download.saveAs(target);
    saved.push(target);
  }
  expect(saved.map((f) => path.basename(f))).toEqual([
    expect.stringMatching(/^\d{8}-.+_servicem8-import_run-[A-Z0-9]{6}\.csv$/),
    expect.stringMatching(/^\d{8}-.+_change-report_run-[A-Z0-9]{6}\.xlsx$/),
    expect.stringMatching(/^\d{8}-.+_exceptions_run-[A-Z0-9]{6}\.xlsx$/),
    expect.stringMatching(/^\d{8}-.+_servicem8-rollback_run-[A-Z0-9]{6}\.csv$/),
    expect.stringMatching(/^\d{8}-.+_audit-summary_run-[A-Z0-9]{6}\.txt$/),
  ]);

  // Re-read the generated ServiceM8 CSV and verify the format contract.
  const importCsv = fs.readFileSync(saved[0]!, 'utf8');
  const importLines = importCsv.split('\r\n');
  expect(importCsv.startsWith('\ufeff')).toBe(false);
  expect(importCsv.endsWith('\r\n')).toBe(true);
  expect(importLines[0]).toBe(
    'Item Number,Name,Purchase Cost,Quantity In Stock,Price,' +
      'Price Includes Taxes,Tax Rate,Item is Inventoried,Barcode',
  );
  const identifiers = importLines
    .slice(1)
    .filter((line) => line !== '')
    .map((line) => line.split(',')[0]);
  expect(identifiers).toHaveLength(7);
  expect(identifiers).toContain('00123'); // leading zeroes preserved
  expect(identifiers).toContain('FIC-002');
  expect(identifiers).toContain('FIC-004');
  expect(identifiers).not.toContain('FIC-012'); // excluded
  expect(identifiers).not.toContain('FIC-001'); // unchanged
  expect(identifiers).not.toContain('FIC-009'); // conflicting duplicate
  expect(identifiers).not.toContain('FIC-007'); // invalid
  expect(identifiers).not.toContain('FIC-900'); // missing: never deleted or added

  const audit = fs.readFileSync(saved[4]!, 'utf8');
  expect(audit).toContain('30% on supplier cost');
  expect(audit).toContain('Superseded fictional line');
  expect(audit).toContain('Round half up to 2 decimal places');

  // --- clear active workflow ----------------------------------------------
  await page.getByRole('button', { name: 'Privacy and data handling' }).click();
  await page.getByRole('button', { name: 'Clear active workflow' }).click();
  await expect(page.getByRole('button', { name: 'Load synthetic demonstration' })).toBeVisible();

  // --- privacy: zero external traffic, no business data in the console ----
  expect(externalRequests).toEqual([]);
  const leaked = consoleLines.filter((l) => /FIC-|Fictionville|62\.40|48\.00/.test(l));
  expect(leaked).toEqual([]);
});

test('settings change requires confirmation and re-prices the comparison', async ({ page }) => {
  await loadDemoAndCompare(page);
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByLabel('Markup percentage (on cost)').fill('40');
  await page.getByRole('button', { name: 'Apply changes…' }).click();
  await expect(page.getByText('Confirm business-rule change.')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm and apply' }).click();
  // Comparison was invalidated; re-run from mapping.
  await page.getByRole('button', { name: 'Map columns', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm mapping and run comparison' }).click();
  await page.getByRole('button', { name: 'Review proposed changes' }).click();
  await page.getByRole('cell', { name: 'FIC-002', exact: true }).click();
  await expect(page.locator('.formula-box')).toHaveText(
    '$48.00 × 1.4 (40% on cost) = $67.20 ex GST',
  );
});

test('keyboard-only: skip link, stepper and review table navigation', async ({ page }) => {
  // Skip link is the first focusable element on a fresh load.
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();

  await loadDemoAndCompare(page);
  await page.getByRole('button', { name: 'Review proposed changes' }).click();

  // Arrow keys move through table rows; Space selects; Enter opens details.
  const firstRow = page.locator('tbody tr[data-row-id]').first();
  await firstRow.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.detail-panel .card h3').first()).not.toHaveText('Record details');
  await page.keyboard.press('ArrowDown');
  const secondRow = page.locator('tbody tr[data-row-id]').nth(1);
  await expect(secondRow).toBeFocused();
  await page.keyboard.press(' ');
  await expect(secondRow.getByRole('checkbox')).toBeChecked();
});
