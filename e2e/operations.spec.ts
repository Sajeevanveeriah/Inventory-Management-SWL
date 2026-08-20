import { readFileSync } from 'node:fs';
import { expect, test, type Page } from './fixture';
import { navigateFromCompactMenu } from './support/navigation';

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

test('product search: ranked catalogue results, filters and no-result state', async ({ page }) => {
  await page.goto('/#/inventory');
  await expect(page.getByRole('heading', { name: 'Find a product', level: 1 })).toBeVisible();

  // The deterministic server seed supplies the persistent catalogue.
  const countLine = page.locator('.result-count');
  await expect(countLine).toHaveText('12 of 12 catalogue products');
  const results = page.getByRole('list', { name: 'Catalogue search results' });

  // Exact identifier search ranks the exact row first.
  const search = page.getByLabel(
    'Search products by item code, supplier SKU, barcode, brand or description',
  );
  await search.fill('LW4570');
  await expect(results.getByRole('listitem').first()).toContainText('LW4570');

  // Description token search.
  await search.fill('deadbolt chrome');
  await expect(results.getByRole('listitem').first()).toContainText('deadbolt');

  // Product-type filters are deterministic and recoverable.
  await search.fill('');
  await page.getByRole('button', { name: 'Service', exact: true }).click();
  await expect(countLine).toHaveText('0 of 12 catalogue products');
  await expect(page.getByRole('heading', { name: 'No matching products' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(countLine).toHaveText('12 of 12 catalogue products');

  // No-result state with a helpful message.
  await search.fill('zzz-not-a-real-product');
  await expect(page.getByRole('heading', { name: 'No matching products' })).toBeVisible();
});

test('global topbar search routes to the inventory search page', async ({ page }) => {
  await loadDemoAndCompare(page);
  const global = page.getByLabel('Search products across supplier and ServiceM8 data');
  await global.fill('LW4570');
  await expect(page.getByRole('heading', { name: 'Find a product', level: 1 })).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Catalogue search results' }).getByRole('listitem').first(),
  ).toContainText('LW4570');
});

test('expansion catalogue carries supplier categories out of scope and switches them on for review', async ({
  page,
}) => {
  await loadDemoAndCompare(page);
  await page.getByRole('button', { name: 'Expansion catalogue' }).click();
  await expect(page.getByRole('heading', { name: 'Expansion catalogue', level: 1 })).toBeVisible();
  await expect(page.getByText('0 automatic additions')).toBeVisible();
  const scope = page.getByRole('region', {
    name: 'Supplier category scope switches',
  });
  const electronic = scope.getByRole('row').filter({ hasText: 'Electronic' });
  await expect(electronic).toContainText('Out of scope');
  await electronic.getByRole('button', { name: 'Enable for review' }).click();
  await expect(electronic).toContainText('Enabled for later review');
  const catalogue = page.getByRole('region', { name: 'Expansion catalogue' });
  await expect(catalogue).toBeVisible();
  await page.getByLabel('Search future products').fill('FIC-004');
  await expect(catalogue.locator('tbody tr')).toHaveCount(1);
  await expect(catalogue.locator('tbody tr').first()).toContainText('Enabled - approval required');
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

test('approvals page refuses to record a proposal without resolved pricing provenance', async ({
  page,
}) => {
  await loadDemoAndCompare(page);
  await page.getByRole('button', { name: 'Approvals' }).click();
  await expect(page.getByRole('heading', { name: 'Approvals', level: 1 })).toBeVisible();

  const firstApprove = page.getByRole('button', { name: 'Approve', exact: true }).first();
  await firstApprove.click();
  await expect(page.getByRole('dialog', { name: 'Confirm approval' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm approval' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'One or more selected records are blocked or already recorded.',
  );
  await expect(page.getByText('Recorded, append-only')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Withdraw approval' })).toHaveCount(0);
});

test('mobile approvals expose their reason, decision and action without horizontal scrolling', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loadDemoAndCompare(page);
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Approvals' }).click();

  const proposals = page.getByRole('region', { name: 'Proposals' });
  await expect(proposals.locator('td[data-label="Reason"]').first()).toBeVisible();
  await expect(proposals.locator('td[data-label="Decision"]').first()).toBeVisible();
  const firstApprove = proposals.getByRole('button', { name: 'Approve', exact: true }).first();
  await expect(firstApprove).toBeVisible();
  await expect
    .poll(() =>
      proposals.evaluate((region) => ({
        clientWidth: region.clientWidth,
        scrollWidth: region.scrollWidth,
      })),
    )
    .toEqual(expect.objectContaining({ clientWidth: expect.any(Number) }));
  const widths = await proposals.evaluate((region) => ({
    clientWidth: region.clientWidth,
    scrollWidth: region.scrollWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth + 1);

  await firstApprove.click();
  await expect(page.getByRole('dialog', { name: 'Confirm approval' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm approval' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'One or more selected records are blocked or already recorded.',
  );
  await expect(page.getByText('Recorded, append-only')).toHaveCount(0);
});

test('saved import layouts direct editing back to the guarded run workflow', async ({ page }) => {
  await loadDemoAndCompare(page);
  await page.getByRole('button', { name: 'Saved import layouts' }).click();
  await expect(page.getByRole('heading', { name: 'Saved import layouts', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit in a run' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export JSON' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit in a run' }).click();
  await expect(page.getByRole('heading', { name: 'New run', level: 1 })).toBeVisible();
});

test('run metadata uses a canonical date prefix and real file hashes', async ({ page }) => {
  await loadDemoAndCompare(page);
  await page.getByRole('button', { name: 'Runs' }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download run metadata (JSON)' }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/^\d{8}-local-\d{8}T\d{6}-run-metadata\.json$/);
  const path = await download.path();
  expect(path).not.toBeNull();
  const metadata = JSON.parse(readFileSync(path!, 'utf8')) as {
    inputFilenames: string[];
    fileHashes: string[];
  };
  expect(metadata.inputFilenames).toHaveLength(2);
  expect(metadata.fileHashes).toHaveLength(2);
  expect(metadata.fileHashes.every((hash) => /^[a-f0-9]{64}$/.test(hash))).toBe(true);
});

test('integrations page states the locked external boundaries', async ({ page }) => {
  await page.goto('/#/integrations');
  await expect(page.getByRole('heading', { name: 'Connect systems', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ServiceM8' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Xero' })).toBeVisible();
  await expect(page.getByText('Read only', { exact: true })).toBeVisible();
  await expect(page.getByText('Approved writes only', { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      'The application cannot change Xero Items or choose an operation beyond this fixed read.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText('Quantity-on-hand, deletion and deactivation')).toBeVisible();
  await expect(
    page.getByText('External connections started from this page: none.', { exact: true }),
  ).toBeVisible();
});

test('task pages pass responsive, theme, motion, keyboard and runtime integrity checks', async ({
  page,
}) => {
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(`console: ${message.text()}`);
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto('/#/suppliers');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(
    page.getByRole('heading', { name: 'Products and suppliers', level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Catalogue products' })).toBeVisible();
  const reducedMotion = await page
    .locator('.card')
    .first()
    .evaluate((element) => {
      const runtime = globalThis as unknown as {
        getComputedStyle(node: unknown): { animationName: string; transitionDuration: string };
      };
      const style = runtime.getComputedStyle(element);
      return { animationName: style.animationName, transitionDuration: style.transitionDuration };
    });
  expect(reducedMotion).toEqual({ animationName: 'none', transitionDuration: '0s' });

  const integrationsButton = page.getByRole('button', { name: 'Connect systems' });
  await integrationsButton.focus();
  await expect(integrationsButton).toBeFocused();
  expect(await integrationsButton.evaluate((element) => element.matches(':focus-visible'))).toBe(
    true,
  );
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Connect systems', level: 1 })).toBeFocused();
  const systemFilter = page.locator('main').getByRole('combobox');
  await systemFilter.selectOption('xero');
  await expect(systemFilter).toHaveValue('xero');
  await systemFilter.selectOption('all');
  await expect(systemFilter).toHaveValue('all');

  await page.setViewportSize({ width: 390, height: 844 });
  await navigateFromCompactMenu(page, 'Products and suppliers');
  await expect(
    page.getByRole('heading', { name: 'Products and suppliers', level: 1 }),
  ).toBeFocused();
  const mobileOverflow = await page.evaluate(() => {
    const runtime = globalThis as unknown as {
      document: { documentElement: { scrollWidth: number; clientWidth: number } };
    };
    return (
      runtime.document.documentElement.scrollWidth - runtime.document.documentElement.clientWidth
    );
  });
  expect(mobileOverflow).toBeLessThanOrEqual(1);

  // A half-width viewport is the existing harness's 200 percent zoom equivalent.
  await page.setViewportSize({ width: 720, height: 450 });
  await page.goto('/#/integrations');
  const zoomHeading = page.getByRole('heading', { name: 'Connect systems', level: 1 });
  await expect(zoomHeading).toBeVisible();
  const zoomOverflow = await page.evaluate(() => {
    const runtime = globalThis as unknown as {
      document: { documentElement: { scrollWidth: number; clientWidth: number } };
    };
    return (
      runtime.document.documentElement.scrollWidth - runtime.document.documentElement.clientWidth
    );
  });
  expect(zoomOverflow).toBeLessThanOrEqual(1);

  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(runtimeErrors).toEqual([]);
});

test('mobile 390px: search page remains usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loadDemoAndCompare(page);
  await navigateFromCompactMenu(page, 'Find a product');
  const search = page.getByLabel(
    'Search products by item code, supplier SKU, barcode, brand or description',
  );
  await search.fill('LW4570');
  await expect(
    page.getByRole('list', { name: 'Catalogue search results' }).getByRole('listitem').first(),
  ).toContainText('LW4570');
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

test('appearance follows the system, persists an override and applies the optional tint', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/#/dashboard');
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-theme-preference', 'system');
  await expect(root).toHaveAttribute('data-theme', 'dark');

  await page.locator('.topbar').getByRole('button', { name: 'Light appearance' }).click();
  await expect(root).toHaveAttribute('data-theme-preference', 'light');
  await expect(root).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(root).toHaveAttribute('data-theme', 'light');

  await page.getByRole('button', { name: 'Open settings' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'System appearance' }).click();
  await expect(root).toHaveAttribute('data-theme-preference', 'system');
  await dialog.getByRole('button', { name: 'Blue tinted glass' }).click();
  await expect(root).toHaveAttribute('data-glass-tint', 'tinted');
  await dialog.getByRole('button', { name: 'Close' }).click();

  await page.emulateMedia({ colorScheme: 'light' });
  await expect(root).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(root).toHaveAttribute('data-theme-preference', 'system');
  await expect(root).toHaveAttribute('data-glass-tint', 'tinted');
});

test('operator navigation focuses the new route while global search keeps typing focus', async ({
  page,
}) => {
  await page.goto('/#/new-run');
  await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeFocused();

  const globalSearch = page.getByLabel('Search products across supplier and ServiceM8 data');
  await globalSearch.fill('FIC-001');
  await expect(page.getByRole('heading', { name: 'Find a product', level: 1 })).toBeVisible();
  await expect(globalSearch).toBeFocused();
});

test('mobile settings appearance is keyboard operable and the open menu makes content inert', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/dashboard');
  await expect(
    page.locator('.topbar').getByRole('button', { name: 'Light appearance' }),
  ).toBeHidden();
  await page.getByRole('button', { name: 'Open settings' }).click();
  const dialog = page.getByRole('dialog');
  const light = dialog.getByRole('button', { name: 'Light appearance' });
  await light.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await dialog.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.locator('.app-frame')).toHaveAttribute('inert', '');
  await expect(page.locator('.side-nav button[aria-current="page"]')).toBeFocused();

  const overflow = await page.evaluate(() => {
    const doc = (
      globalThis as unknown as {
        document: { documentElement: { scrollWidth: number; clientWidth: number } };
      }
    ).document;
    return doc.documentElement.scrollWidth - doc.documentElement.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
});

test('mobile dashboard keeps metrics compact and charts keyboard scrollable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loadDemoAndCompare(page);
  await navigateFromCompactMenu(page, 'Dashboard');

  const metricColumns = await page.locator('.metric-row').evaluate((element) => {
    const runtime = globalThis as unknown as {
      getComputedStyle(node: unknown): { gridTemplateColumns: string };
    };
    return runtime.getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length;
  });
  expect(metricColumns).toBe(2);

  const plot = page.getByRole('region', {
    name: 'Catalogue items by current sell price bracket chart plot',
  });
  await expect(plot).toBeVisible();
  const initial = await plot.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollLeft: element.scrollLeft,
    scrollWidth: element.scrollWidth,
  }));
  expect(initial.scrollWidth).toBeGreaterThan(initial.clientWidth);

  await plot.focus();
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(() => plot.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(initial.scrollLeft);

  const overflow = await page.evaluate(() => {
    const runtime = globalThis as unknown as {
      document: { documentElement: { scrollWidth: number; clientWidth: number } };
    };
    return (
      runtime.document.documentElement.scrollWidth - runtime.document.documentElement.clientWidth
    );
  });
  expect(overflow).toBeLessThanOrEqual(1);
});

test('desktop charts do not add keyboard stops when their plots fit', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadDemoAndCompare(page);
  await page.getByRole('button', { name: 'Dashboard' }).click();

  const plots = page.locator('.chart-plot');
  await expect(plots).toHaveCount(2);
  for (const plot of await plots.all()) {
    await expect(plot).toHaveAttribute('data-scrollable', 'false');
    await expect(plot).not.toHaveAttribute('tabindex');
    await expect(plot).not.toHaveAttribute('aria-describedby');
  }
  await expect(page.locator('.chart-scroll-hint')).toHaveCount(0);
});

test('200 percent zoom equivalent keeps settings inside the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 450 });
  await page.goto('/#/dashboard');
  await expect(
    page.locator('.topbar').getByRole('button', { name: 'System appearance' }),
  ).toHaveAttribute('title', 'System');
  await page.getByRole('button', { name: 'Open settings' }).click();
  const dialog = page.getByRole('dialog');
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(720);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(450);

  const overflow = await page.evaluate(() => {
    const doc = (
      globalThis as unknown as {
        document: { documentElement: { scrollWidth: number; clientWidth: number } };
      }
    ).document;
    return doc.documentElement.scrollWidth - doc.documentElement.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
});

test('reduced motion removes material entrance and colour transitions', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#/dashboard');
  await expect(page.locator('.metric-card').first()).toBeVisible();
  const motion = (await page.evaluate(`(() => {
    const style = getComputedStyle(document.querySelector('.metric-card'));
    return { animationName: style.animationName, transitionDuration: style.transitionDuration };
  })()`)) as { animationName: string; transitionDuration: string };
  expect(motion).toEqual({ animationName: 'none', transitionDuration: '0s' });
});
