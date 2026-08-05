// @vitest-environment node
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStore, FloorViolationError, MissingApprovalError } from '../server/store/store.mjs';
import {
  centsToAmount,
  minimumSellPriceCents,
  parseAmountToCents,
} from '../server/lib/moneyCents.mjs';

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'swl-store-'));
  return { dir, store: createStore(dir) };
}

function seedItem(store: ReturnType<typeof createStore>, id = 'LW4570') {
  return store.putItem({
    id,
    sku: id,
    description: 'Lockwood 4570 keyed deadlatch',
    costCents: 10000,
    sellPriceCents: 13000,
  });
}

describe('server money path (integer minor units, no floats)', () => {
  it('minimumSellPrice(100.00) is exactly 130.00 AUD, plus edge values', () => {
    expect(centsToAmount(minimumSellPriceCents(parseAmountToCents('100')!))).toBe('130.00');
    expect(centsToAmount(minimumSellPriceCents(parseAmountToCents('0')!))).toBe('0.00');
    expect(centsToAmount(minimumSellPriceCents(parseAmountToCents('0.01')!))).toBe('0.01');
    expect(centsToAmount(minimumSellPriceCents(parseAmountToCents('9.99')!))).toBe('12.99');
    expect(centsToAmount(minimumSellPriceCents(parseAmountToCents('123456789.99')!))).toBe(
      '160493826.99',
    );
  });

  it('uses no floating point arithmetic in the server money modules', () => {
    for (const file of ['server/lib/moneyCents.mjs', 'server/store/store.mjs']) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/parseFloat|Number\.EPSILON|toPrecision/);
      expect(source).not.toMatch(/[\s(][\d.]+\s*\*\s*1\.3/);
      expect(source).not.toMatch(/\/\s*100(?!n)/); // only BigInt division by 100n
    }
  });
});

describe('publication guards', () => {
  it('refuses any published price below the item floor', () => {
    const { store } = tempStore();
    seedItem(store);
    const approval = store.appendApproval({
      itemId: 'LW4570',
      approvedBy: 'Test operator',
      proposedSellCents: 12999,
    });
    expect(() =>
      store.appendPriceVersion({
        itemId: 'LW4570',
        costCents: 10000,
        sellPriceCents: 12999,
        approvalId: approval.id,
      }),
    ).toThrow(FloorViolationError);
    expect(store.listPriceHistory('LW4570')).toHaveLength(0);
  });

  it('refuses to publish without an approval record (asserted, not assumed)', () => {
    const { store } = tempStore();
    seedItem(store);
    expect(() =>
      store.appendPriceVersion({
        itemId: 'LW4570',
        costCents: 10000,
        sellPriceCents: 13000,
        approvalId: 'no-such-approval',
      }),
    ).toThrow(MissingApprovalError);
    expect(store.listPriceHistory()).toHaveLength(0);
  });

  it('records who approved and when on the publish path', () => {
    const { store } = tempStore();
    seedItem(store);
    const approval = store.appendApproval({
      itemId: 'LW4570',
      approvedBy: 'Test operator',
      proposedSellCents: 13500,
    });
    expect(approval.approvedBy).toBe('Test operator');
    expect(approval.approvedAt).toBeTruthy();
    const version = store.appendPriceVersion({
      itemId: 'LW4570',
      costCents: 10000,
      sellPriceCents: 13500,
      approvalId: approval.id,
    });
    expect(version.approvalId).toBe(approval.id);
  });
});

describe('competitor references are provably inert', () => {
  it('attaching a reference leaves the catalogue item byte-identical', () => {
    const { dir, store } = tempStore();
    seedItem(store);
    const itemsPath = join(dir, 'catalogue-items.json');
    const before = readFileSync(itemsPath);
    store.appendReference({
      itemId: 'LW4570',
      observation: {
        title: 'Lockwood 4570 Deadlatch',
        priceAud: '95.00', // deliberately below cost: still must change nothing
        gstBasis: 'inc-gst',
        sourceDomain: 'fictionville-security.example.com.au',
        url: 'https://fictionville-security.example.com.au/x',
        retrievedAt: new Date().toISOString(),
      },
    });
    const after = readFileSync(itemsPath);
    expect(Buffer.compare(before, after)).toBe(0); // byte-identical
    expect(store.listPriceHistory('LW4570')).toHaveLength(0);
    expect(store.listReferences('LW4570')).toHaveLength(1);
  });
});

describe('price history persists across an application restart', () => {
  it('writes with one store instance, "restarts" by creating a new instance on the same directory, and reads back', () => {
    const { dir, store } = tempStore();
    seedItem(store);
    const approval = store.appendApproval({
      itemId: 'LW4570',
      approvedBy: 'Test operator',
      proposedSellCents: 13000,
    });
    store.appendPriceVersion({
      itemId: 'LW4570',
      costCents: 10000,
      sellPriceCents: 13000,
      approvalId: approval.id,
    });

    // Restart: a brand-new store instance with no shared in-memory state.
    const reopened = createStore(dir);
    const history = reopened.listPriceHistory('LW4570');
    expect(history).toHaveLength(1);
    expect(history[0].sellPrice).toBe('130.00');
    expect(history[0].approvalId).toBe(approval.id);
    expect(reopened.getItem('LW4570')?.sellPriceCents).toBe(13000);
    expect(reopened.listApprovals()).toHaveLength(1);
  });

  it('history is append-only: the store exposes no update or delete for versions', () => {
    const { store } = tempStore();
    const historyMethods = Object.keys(store).filter((k) => /history|version/i.test(k));
    expect(historyMethods.sort()).toEqual(['appendPriceVersion', 'listPriceHistory']);
  });
});
