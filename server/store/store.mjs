import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { centsToAmount, minimumSellPriceCents } from '../lib/moneyCents.mjs';

/**
 * File-backed persistence for the small Node service. Chosen deliberately:
 * the deployment shape is one SPA plus one small server on one machine, so a
 * JSON/JSONL directory store is the smallest fit. History files are JSONL and
 * APPEND-ONLY: this module exposes no update or delete for them.
 *
 * Persisted: catalogue items, price history (append-only versions), approval
 * records (who and when), competitor reference prices, source registry state.
 * Secrets are never persisted here; keys live only in the environment.
 */

export class FloorViolationError extends Error {
  constructor(sellCents, floorCents) {
    super(
      `Sell price ${centsToAmount(sellCents)} is below the floor ${centsToAmount(floorCents)} (cost x 1.30). Refused.`,
    );
    this.name = 'FloorViolationError';
  }
}
export class MissingApprovalError extends Error {
  constructor() {
    super('A published price version requires an existing approval record. Refused.');
    this.name = 'MissingApprovalError';
  }
}
export class MissingCatalogueItemError extends Error {
  constructor(itemId) {
    super(`Catalogue item ${itemId} does not exist. Reference refused.`);
    this.name = 'MissingCatalogueItemError';
  }
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

export function createStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const paths = {
    items: join(dataDir, 'catalogue-items.json'),
    history: join(dataDir, 'price-history.jsonl'),
    approvals: join(dataDir, 'approvals.jsonl'),
    references: join(dataDir, 'competitor-references.jsonl'),
    sources: join(dataDir, 'source-registry.json'),
  };

  return {
    dataDir,

    listItems() {
      return readJson(paths.items, []);
    },
    getItem(id) {
      return this.listItems().find((item) => item.id === id) ?? null;
    },
    /** Create or replace a catalogue item. Amounts are integer cents. */
    putItem(item) {
      const items = this.listItems().filter((existing) => existing.id !== item.id);
      const stored = { ...item, updatedAt: new Date().toISOString() };
      items.push(stored);
      items.sort((a, b) => a.id.localeCompare(b.id));
      writeFileSync(paths.items, JSON.stringify(items, null, 2));
      return stored;
    },

    listApprovals() {
      return readJsonl(paths.approvals);
    },
    /** Record who approved what, and when. Append-only. */
    appendApproval({ itemId, approvedBy, proposedSellCents, reason }) {
      const record = {
        id: randomUUID(),
        itemId,
        approvedBy,
        proposedSellCents,
        reason: reason ?? '',
        approvedAt: new Date().toISOString(),
      };
      appendFileSync(paths.approvals, `${JSON.stringify(record)}\n`);
      return record;
    },

    listPriceHistory(itemId) {
      const all = readJsonl(paths.history);
      return itemId ? all.filter((v) => v.itemId === itemId) : all;
    },
    /**
     * Append a published price version. The ONLY write path for prices:
     *  - refuses without an existing approval record (approvalId);
     *  - refuses a sell price below the item's floor (cost x 1.30).
     */
    appendPriceVersion({ itemId, costCents, sellPriceCents, approvalId, recordedAt }) {
      const approval = this.listApprovals().find((a) => a.id === approvalId);
      if (!approval || approval.itemId !== itemId) throw new MissingApprovalError();
      const floor = minimumSellPriceCents(costCents);
      if (sellPriceCents < floor) throw new FloorViolationError(sellPriceCents, floor);
      const version = {
        id: randomUUID(),
        itemId,
        costCents,
        sellPriceCents,
        cost: centsToAmount(costCents),
        sellPrice: centsToAmount(sellPriceCents),
        approvalId,
        recordedAt: recordedAt ?? new Date().toISOString(),
      };
      appendFileSync(paths.history, `${JSON.stringify(version)}\n`);
      const item = this.getItem(itemId);
      if (item) this.putItem({ ...item, costCents, sellPriceCents });
      return version;
    },

    listReferences(itemId) {
      const all = readJsonl(paths.references);
      return itemId ? all.filter((ref) => ref.itemId === itemId) : all;
    },
    /**
     * Attach a competitor price to an item as REFERENCE ONLY. This function
     * deliberately never touches catalogue-items.json or price-history.jsonl,
     * so it is provably incapable of altering a cost or sell price.
     */
    appendReference({ itemId, observation }) {
      if (!this.getItem(itemId)) throw new MissingCatalogueItemError(itemId);
      const record = {
        id: randomUUID(),
        itemId,
        observation,
        attachedAt: new Date().toISOString(),
      };
      appendFileSync(paths.references, `${JSON.stringify(record)}\n`);
      return record;
    },

    getSources(fallback = []) {
      return readJson(paths.sources, fallback);
    },
    putSources(sources) {
      writeFileSync(paths.sources, JSON.stringify(sources, null, 2));
      return sources;
    },
  };
}
