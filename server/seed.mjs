import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store/store.mjs';
import { minimumSellPriceCents } from './lib/moneyCents.mjs';

/**
 * Seed realistic (fictional) sample data so every surface can be inspected
 * populated: catalogue items, approvals, an append-only price history spread
 * over the past year, competitor reference prices and the source registry.
 * Deterministic: same output every run (dates are relative to "now" at whole
 * month steps; values come from a fixed table, not randomness).
 *
 * Usage: node server/seed.mjs [--data-dir path]
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
const dirFlag = args.indexOf('--data-dir');
const dataDir = dirFlag >= 0 ? args[dirFlag + 1] : (process.env.SWL_DATA_DIR ?? join(HERE, 'data'));

const ITEMS = [
  ['LW4570', 'Lockwood 4570 keyed deadlatch, satin chrome', 9500, [9000, 9200, 9200, 9500]],
  ['LW001-1', 'Lockwood 001 deadlatch, brass', 8200, [7800, 8000, 8200, 8200]],
  ['AB9053', 'ABUS 9053 Granit padlock 53 mm', 6400, [6000, 6200, 6400, 6400]],
  ['KC4-60', 'Kaba C4 euro cylinder 60 mm nickel', 4400, [4200, 4200, 4300, 4400]],
  ['GN500-B', 'Gainsborough G-Node 500 entrance set, black', 12800, [12000, 12400, 12600, 12800]],
  ['WH-HINGE-100', 'Whitco 100 mm security hinge, stainless', 950, [900, 900, 950, 950]],
  ['LW3572', 'Lockwood 3572 mortice lock body', 15600, [14800, 15200, 15600, 15600]],
  ['TES-KEY-LW4', 'Silca LW4 key blank, brass (box of 50)', 3900, [3600, 3700, 3800, 3900]],
  ['CAM-CL001', 'Camec CL001 caravan lock, white', 2850, [2700, 2700, 2800, 2850]],
  ['PAD-BRASS-40', 'Generic brass padlock 40 mm (pack of 6)', 2100, [1900, 2000, 2000, 2100]],
  ['DL-DIGI-01', 'Fictionville digital deadbolt, satin', 18900, [17900, 18400, 18900, 18900]],
  ['STRIKE-P-01', 'Heavy duty strike plate, zinc', 650, [600, 600, 650, 650]],
];

const store = createStore(dataDir);
const now = new Date();
const monthsAgo = (n) => {
  const d = new Date(now);
  d.setMonth(d.getMonth() - n);
  return d.toISOString();
};

let versions = 0;
for (const [sku, description, currentCostCents, costSteps] of ITEMS) {
  store.putItem({
    id: sku,
    sku,
    description,
    costCents: currentCostCents,
    sellPriceCents: minimumSellPriceCents(currentCostCents),
  });
  costSteps.forEach((costCents, step) => {
    const sellPriceCents = minimumSellPriceCents(costCents);
    const approval = store.appendApproval({
      itemId: sku,
      approvedBy: 'Seed script (fictional operator)',
      proposedSellCents: sellPriceCents,
      reason: `Seeded supplier cost update ${step + 1} of ${costSteps.length}`,
    });
    // Spread history across the past year for a meaningful time series.
    store.appendPriceVersion({
      itemId: sku,
      costCents,
      sellPriceCents,
      approvalId: approval.id,
      recordedAt: monthsAgo((costSteps.length - 1 - step) * 3),
    });
    versions += 1;
  });
}

store.appendReference({
  itemId: 'LW4570',
  observation: {
    title: 'Lockwood 4570 Keyed Deadlatch Satin Chrome',
    priceAud: '143.50',
    gstBasis: 'inc-gst',
    seller: 'Fictionville Security Supplies',
    sourceDomain: 'fictionville-security.example.com.au',
    url: 'https://fictionville-security.example.com.au/product/lockwood-4570',
    retrievedAt: monthsAgo(0),
  },
});

store.putSources([
  {
    id: 'live-provider',
    name: 'Licensed shopping search API (via this server)',
    accessMethod: 'live-api',
    note: 'Server-side, rate limited, cached, honest user agent. Requires SERPAPI_KEY.',
    enabled: true,
  },
  {
    id: 'manual',
    name: 'Manual operator entry',
    accessMethod: 'manual-entry',
    note: 'Fallback for anything the provider cannot reach.',
    enabled: true,
  },
]);

console.log(
  `Seeded ${ITEMS.length} catalogue items, ${versions} price versions with approvals, 1 competitor reference and the source registry into ${dataDir}`,
);
