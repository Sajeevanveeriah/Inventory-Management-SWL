import { describe, expect, it } from 'vitest';
import { runComparison, type ComparisonRow } from './compare';
import { deriveTaxConvention } from './conventions';
import { extractS8Records, extractSupplierRecords } from './records';
import type { ParsedTable } from './table';

function table(headers: string[], rows: string[][]): ParsedTable {
  return {
    fileName: 'fixture.csv',
    fileType: 'csv',
    byteSize: 1,
    sha256: 'x',
    sheetNames: ['CSV data'],
    selectedSheet: 'CSV data',
    headers,
    rows,
    warnings: [],
  };
}

const SUPPLIER_MAPPING = {
  supplierCode: 0,
  supplierDescription: 1,
  supplierCost: 2,
};
const S8_MAPPING = {
  itemNumber: 0,
  itemDescription: 1,
  existingCost: 2,
  existingSellPrice: 3,
  priceIncludesTaxes: 4,
};

function run(supplierRows: string[][], s8Rows: string[][], aliases = new Map<string, string>()) {
  const sup = extractSupplierRecords(
    table(['Code', 'Description', 'Cost'], supplierRows),
    SUPPLIER_MAPPING,
  );
  const s8 = extractS8Records(
    table(
      ['Item', 'Description', 'Cost', 'Sell', 'Price Includes Taxes'],
      s8Rows.map((row) => (row.length > 4 ? row : [...row, 'No'])),
    ),
    S8_MAPPING,
  );
  return runComparison(sup, s8, aliases, {
    markupPercent: '30',
    costBasis: 'excluding-gst',
    costBasisConfirmed: true,
    newItemConvention: deriveTaxConvention(s8),
  });
}

function byId(rows: ComparisonRow[], code: string): ComparisonRow {
  const found = rows.find(
    (r) => r.supplier?.code === code || (r.supplier === null && r.s8?.itemNumber === code),
  );
  if (found === undefined) throw new Error(`row ${code} not found`);
  return found;
}

describe('runComparison - statuses', () => {
  it('classifies unchanged when cost matches exactly', () => {
    const result = run(
      [['A-1', 'Fictional Widget', '12.50']],
      [['A-1', 'Fictional Widget', '12.50', '16.25']],
    );
    const row = byId(result.rows, 'A-1');
    expect(row.status).toBe('unchanged');
    expect(row.matchMethod).toBe('exact-code');
    expect(row.proposedSell).toBe('16.25');
    expect(row.costDelta).toBe('0.00');
  });

  it('classifies price-changed with proposed 30% markup price', () => {
    const result = run(
      [['A-1', 'Fictional Widget', '100.00']],
      [['A-1', 'Fictional Widget', '90.00', '117.00']],
    );
    const row = byId(result.rows, 'A-1');
    expect(row.status).toBe('price-changed');
    expect(row.proposedSell).toBe('130.00');
    expect(row.costDelta).toBe('10.00');
  });

  it('matches case-insensitively with trimming, preserving leading zeroes', () => {
    const result = run(
      [[' 00123 ', 'Fictional Bolt', '7.25']],
      [['00123', 'Fictional Bolt', '6.80', '8.84']],
    );
    const row = byId(result.rows, '00123');
    expect(row.status).toBe('price-changed');
    expect(row.supplier?.code).toBe('00123');
    expect(row.supplier?.codeNorm).toBe('00123');
  });

  it('does NOT match when identifiers differ only by leading zeroes', () => {
    const result = run(
      [['123', 'Completely Different Fictional Thing', '7.25']],
      [['00123', 'Unrelated Fictional Item', '6.80', '8.84']],
    );
    expect(byId(result.rows, '123').status).toBe('new-item');
    expect(byId(result.rows, '00123').status).toBe('missing-from-supplier');
  });

  it('classifies new items and keeps them requiring approval', () => {
    const result = run(
      [['NEW-1', 'Fictional Novel Gadget', '10.00']],
      [['OLD-1', 'Fictional Old Part', '5.00', '6.50']],
    );
    const row = byId(result.rows, 'NEW-1');
    expect(row.status).toBe('new-item');
    expect(row.proposedSell).toBe('13.00');
  });

  it('flags ServiceM8 items missing from supplier without deleting', () => {
    const result = run(
      [['A-1', 'Fictional Widget', '1.00']],
      [
        ['A-1', 'Fictional Widget', '1.00', '1.30'],
        ['GONE-1', 'Fictional Retired Part', '2.00', '2.60'],
      ],
    );
    const row = byId(result.rows, 'GONE-1');
    expect(row.status).toBe('missing-from-supplier');
    expect(result.totals.missingFromSupplier).toBe(1);
  });

  it('blocks duplicate supplier identifiers as ambiguous', () => {
    const result = run(
      [
        ['DUP-1', 'Fictional Pair A', '9.40'],
        ['DUP-1', 'Fictional Pair B', '8.90'],
      ],
      [['DUP-1', 'Fictional Pair', '9.00', '11.70']],
    );
    const dupRows = result.rows.filter((r) => r.supplier?.code === 'DUP-1');
    expect(dupRows).toHaveLength(2);
    for (const r of dupRows) expect(r.status).toBe('ambiguous');
    expect(result.totals.duplicates).toBeGreaterThanOrEqual(2);
    // The ServiceM8 item was never matched, so it is reported missing.
    expect(byId(result.rows, 'DUP-1')).toBeDefined();
  });

  it('blocks duplicate ServiceM8 item numbers as ambiguous', () => {
    const result = run(
      [['D-2', 'Fictional Thing', '5.00']],
      [
        ['D-2', 'Fictional Thing', '5.00', '6.50'],
        ['D-2', 'Fictional Thing Copy', '4.00', '5.20'],
      ],
    );
    expect(byId(result.rows, 'D-2').status).toBe('ambiguous');
    const s8Rows = result.rows.filter((r) => r.supplier === null);
    expect(s8Rows).toHaveLength(2);
    for (const r of s8Rows) expect(r.status).toBe('ambiguous');
  });

  it('blocks near-identical descriptions with a new code as ambiguous', () => {
    const result = run(
      [['NEW-CODE', 'Fictionville Euro Cylinder 70mm Nickel', '24.60']],
      [['OLD-CODE', 'Fictionville Euro Cylinder 70mm Nickel', '23.00', '29.90']],
    );
    const row = byId(result.rows, 'NEW-CODE');
    expect(row.status).toBe('ambiguous');
    expect(row.suggestions.length).toBeGreaterThan(0);
    expect(row.suggestions[0]?.itemNumber).toBe('OLD-CODE');
  });

  it('marks missing and malformed costs invalid with exact errors', () => {
    const result = run(
      [
        ['V-1', 'Fictional No Cost', ''],
        ['V-2', 'Fictional Bad Cost', 'about $4'],
        ['', 'Fictional No Code', '5.00'],
      ],
      [['X-1', 'Fictional Anchor', '1.00', '1.30']],
    );
    expect(byId(result.rows, 'V-1').status).toBe('invalid');
    expect(byId(result.rows, 'V-2').status).toBe('invalid');
    const noCode = result.rows.find((r) => r.supplier?.description === 'Fictional No Code');
    expect(noCode?.status).toBe('invalid');
    expect(result.totals.invalid).toBe(3);
  });
});

describe('runComparison - aliases', () => {
  it('matches through an approved alias and reports the method', () => {
    const aliases = new Map([['ALIAS-11', 'FIC-011']]);
    const result = run(
      [['ALIAS-11', 'Fictional Rim Lock', '33.00']],
      [['FIC-011', 'Fictional Rim Lock', '30.00', '39.00']],
      aliases,
    );
    const row = byId(result.rows, 'ALIAS-11');
    expect(row.status).toBe('price-changed');
    expect(row.matchMethod).toBe('alias');
    expect(result.totals.aliasMatches).toBe(1);
  });

  it('exact code match takes precedence over an alias', () => {
    const aliases = new Map([['A-1', 'B-1']]);
    const result = run(
      [['A-1', 'Fictional Widget', '1.00']],
      [
        ['A-1', 'Fictional Widget', '1.00', '1.30'],
        ['B-1', 'Fictional Other', '2.00', '2.60'],
      ],
      aliases,
    );
    expect(byId(result.rows, 'A-1').matchMethod).toBe('exact-code');
  });

  it('blocks an exact code and an alias that resolve to the same ServiceM8 item', () => {
    const aliases = new Map([['ALIAS-X', 'TARGET-X']]);
    const result = run(
      [
        ['TARGET-X', 'Fictional exact owner', '10.00'],
        ['ALIAS-X', 'Fictional alias owner', '11.00'],
      ],
      [['TARGET-X', 'Fictional canonical item', '9.00', '11.70']],
      aliases,
    );

    expect(byId(result.rows, 'TARGET-X').status).toBe('ambiguous');
    expect(byId(result.rows, 'ALIAS-X').status).toBe('ambiguous');
    expect(result.totals.exactMatches).toBe(0);
    expect(result.totals.aliasMatches).toBe(0);
    expect(result.totals.blocked).toBe(2);
    expect(
      result.rows.some(
        (candidate) => candidate.supplier === null && candidate.s8?.itemNumber === 'TARGET-X',
      ),
    ).toBe(false);
  });

  it('blocks two aliases that resolve to one ServiceM8 item', () => {
    const aliases = new Map([
      ['ALIAS-A', 'TARGET-Y'],
      ['ALIAS-B', 'TARGET-Y'],
    ]);
    const result = run(
      [
        ['ALIAS-A', 'Fictional alias A', '10.00'],
        ['ALIAS-B', 'Fictional alias B', '12.00'],
      ],
      [['TARGET-Y', 'Fictional canonical item', '9.00', '11.70']],
      aliases,
    );

    expect(byId(result.rows, 'ALIAS-A').status).toBe('ambiguous');
    expect(byId(result.rows, 'ALIAS-B').status).toBe('ambiguous');
    expect(result.totals.aliasMatches).toBe(0);
    expect(result.totals.duplicates).toBeGreaterThanOrEqual(2);
  });

  it('warns when an alias points at an item not in the file', () => {
    const aliases = new Map([['A-9', 'MISSING-TARGET']]);
    const result = run(
      [['A-9', 'Fictional Orphan', '4.00']],
      [['Z-1', 'Fictional Unrelated', '1.00', '1.30']],
      aliases,
    );
    const row = byId(result.rows, 'A-9');
    expect(row.status).toBe('new-item');
    expect(row.messages.some((m) => m.message.includes('not present'))).toBe(true);
  });
});

describe('runComparison - totals', () => {
  it('produces internally consistent totals', () => {
    const result = run(
      [
        ['A-1', 'Fictional Widget Alpha', '12.50'],
        ['A-2', 'Fictional Widget Beta', '48.00'],
        ['A-3', 'Fictional Widget Gamma', ''],
        ['NEW-1', 'Fictional Fresh Gadget', '10.00'],
      ],
      [
        ['A-1', 'Fictional Widget Alpha', '12.50', '16.25'],
        ['A-2', 'Fictional Widget Beta', '45.00', '58.50'],
        ['GONE-1', 'Fictional Departed Part', '2.00', '2.60'],
      ],
    );
    const t = result.totals;
    expect(t.supplierRecords).toBe(4);
    expect(t.s8Records).toBe(3);
    expect(t.unchanged).toBe(1);
    expect(t.priceChanged).toBe(1);
    expect(t.newItems).toBe(1);
    expect(t.invalid).toBe(1);
    expect(t.missingFromSupplier).toBe(1);
    expect(t.blocked).toBe(t.ambiguous + t.invalid);
    expect(t.exactMatches).toBe(2);
  });
});

describe('runComparison - price-driven change detection', () => {
  it('treats a row as changed when the PRICE is wrong, even if cost is identical', () => {
    // ServiceM8 records the same cost, but the selling price sits below the
    // markup floor. Comparing cost against cost would call this unchanged and
    // the item would keep being sold too cheaply.
    const result = run(
      [['A-1', 'Fictional Widget', '100.00']],
      [['A-1', 'Fictional Widget', '100.00', '110.00', 'No']],
    );
    const row = byId(result.rows, 'A-1');
    expect(row.status).toBe('price-changed');
    expect(row.costDelta).toBe('0.00');
    expect(row.proposedSell).toBe('130.00');
    expect(row.priceDelta).toBe('20.00');
  });

  it('treats a row as unchanged only when the price already equals the proposal', () => {
    const result = run(
      [['A-1', 'Fictional Widget', '100.00']],
      [['A-1', 'Fictional Widget', '0', '130.00', 'No']],
    );
    expect(byId(result.rows, 'A-1').status).toBe('unchanged');
  });

  it("respects each ServiceM8 row's own GST basis", () => {
    const result = run(
      [
        ['EX-1', 'Fictional Ex', '100.00'],
        ['INC-1', 'Fictional Inc', '100.00'],
      ],
      [
        ['EX-1', 'Fictional Ex', '0', '1.00', 'No'],
        ['INC-1', 'Fictional Inc', '0', '1.00', 'Yes'],
      ],
    );
    expect(byId(result.rows, 'EX-1').proposedSell).toBe('130.00');
    expect(byId(result.rows, 'EX-1').targetBasis).toBe('excluding-gst');
    // The same cost, but this row stores GST-inclusive prices.
    expect(byId(result.rows, 'INC-1').proposedSell).toBe('143.00');
    expect(byId(result.rows, 'INC-1').targetBasis).toBe('including-gst');
  });

  it('blocks a row whose tax basis cannot be read rather than assuming one', () => {
    const result = run(
      [['A-1', 'Fictional Widget', '100.00']],
      [['A-1', 'Fictional Widget', '0', '110.00', 'perhaps']],
    );
    const row = byId(result.rows, 'A-1');
    expect(row.status).toBe('invalid');
    expect(row.proposedSell).toBeNull();
  });

  it('does not block a row merely because ServiceM8 records no purchase cost', () => {
    const result = run(
      [['A-1', 'Fictional Widget', '100.00']],
      [['A-1', 'Fictional Widget', '0', '110.00', 'No']],
    );
    const row = byId(result.rows, 'A-1');
    expect(row.status).toBe('price-changed');
    expect(row.messages.some((m) => m.message.includes('records no purchase cost'))).toBe(true);
  });
});

describe('runComparison - duplicate supplier rows', () => {
  it('folds duplicates that agree on cost into one proposal', () => {
    const result = run(
      [
        ['DUP-1', 'Fictional Pair (Padlocks)', '9.40'],
        ['DUP-1', 'Fictional Pair (Security)', '9.40'],
        ['DUP-1', 'Fictional Pair (Clearance)', '9.40'],
      ],
      [['DUP-1', 'Fictional Pair', '0', '11.70', 'No']],
    );
    const rows = result.rows.filter((r) => r.supplier?.code === 'DUP-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('price-changed');
    expect(rows[0]?.proposedSell).toBe('12.22');
    expect(rows[0]?.duplicateSourceRows).toEqual([3, 4]);
    expect(result.totals.duplicatesCollapsed).toBe(2);
    expect(rows[0]?.messages.some((m) => m.message.includes('folded into this one'))).toBe(true);
  });

  it('still blocks duplicates that disagree on cost', () => {
    const result = run(
      [
        ['DUP-2', 'Fictional Pair A', '9.40'],
        ['DUP-2', 'Fictional Pair B', '8.90'],
      ],
      [['DUP-2', 'Fictional Pair', '0', '11.70', 'No']],
    );
    const rows = result.rows.filter((r) => r.supplier?.code === 'DUP-2');
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.status).toBe('ambiguous');
    expect(result.totals.duplicatesCollapsed).toBe(0);
  });
});

describe('runComparison - real-world data hazards', () => {
  it('explains a price-on-application item rather than reporting a parse failure', () => {
    const result = run(
      [['POA-1', 'Fictional Restricted Key', 'P.O.A.']],
      [['OTHER', 'Fictional Other', '0', '1.00', 'No']],
    );
    const row = byId(result.rows, 'POA-1');
    expect(row.status).toBe('invalid');
    expect(row.supplier?.priceOnApplication).toBe(true);
    expect(row.messages.some((m) => m.message.includes('price on application'))).toBe(true);
  });

  it('flags an identifier a spreadsheet destroyed into scientific notation', () => {
    const result = run(
      [['A-1', 'Fictional Widget', '1.00']],
      [['9.4E+12', 'Fictional Damaged', '0', '1.30', 'No']],
    );
    const row = byId(result.rows, '9.4E+12');
    expect(row.messages.some((m) => m.message.includes('scientific notation'))).toBe(true);
  });
});
