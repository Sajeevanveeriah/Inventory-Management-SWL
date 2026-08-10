// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  SERVICEM8_COLUMNS,
  encodeCsvField,
  encodeCsvRow,
  encodeServiceM8Csv,
  formatIncludesTaxes,
  isScientificNotation,
  matchServiceM8Layout,
  parseIncludesTaxes,
} from '../src/core/servicem8Format';

/**
 * A synthetic document written in exactly the dialect a genuine ServiceM8
 * Materials & Services export uses: no BOM, CRLF on every line including the
 * last, and quoting only where a field contains a comma, a double quote or a
 * line break. It carries each hazard the real export contains — an embedded
 * comma, an embedded quote pair, an embedded newline, an empty trailing field
 * and a barcode already destroyed into scientific notation.
 */
const GENUINE_SHAPE_CSV =
  'Item Number,Name,Purchase Cost,Quantity In Stock,Price,Price Includes Taxes,Tax Rate,Item is Inventoried,Barcode\r\n' +
  'FIC-001,Plain name,0,0,16.25,No,GST on Income,No,\r\n' +
  '"FIC,002","Name, with comma",12.5,0,58.5,Yes,,No,9.34368E+12\r\n' +
  'FIC-003,"Name with ""quotes"" inside",0,0,2.73,Yes,GST on Income,No,\r\n' +
  'FIC-004,"Name with\r\nembedded newline",0,0,0,No,GST on Income,No,\r\n';

/** The same document, parsed. Mirrors what the application's parser yields. */
const GENUINE_SHAPE_ROWS = [
  [...SERVICEM8_COLUMNS],
  ['FIC-001', 'Plain name', '0', '0', '16.25', 'No', 'GST on Income', 'No', ''],
  [
    'FIC,002',
    'Name, with comma',
    '12.5',
    '0',
    '58.5',
    'Yes',
    '',
    'No',
    '9.34368E+12',
  ],
  ['FIC-003', 'Name with "quotes" inside', '0', '0', '2.73', 'Yes', 'GST on Income', 'No', ''],
  ['FIC-004', 'Name with\r\nembedded newline', '0', '0', '0', 'No', 'GST on Income', 'No', ''],
];

describe('ServiceM8 CSV dialect', () => {
  it('reproduces a genuine-shaped export byte for byte', () => {
    const [headers, ...rows] = GENUINE_SHAPE_ROWS;
    const encoded = encodeServiceM8Csv(headers as string[], rows);
    expect(encoded).toBe(GENUINE_SHAPE_CSV);
    // Byte-level equality, not just string equality.
    expect(new TextEncoder().encode(encoded)).toEqual(
      new TextEncoder().encode(GENUINE_SHAPE_CSV),
    );
  });

  it('terminates every line with CRLF, including the last, and emits no BOM', () => {
    const encoded = encodeServiceM8Csv(['A', 'B'], [['1', '2']]);
    expect(encoded).toBe('A,B\r\n1,2\r\n');
    expect(encoded.startsWith('﻿')).toBe(false);
    expect(encoded.endsWith('\r\n')).toBe(true);
  });

  it('quotes a field only when it must', () => {
    expect(encodeCsvField('plain')).toBe('plain');
    expect(encodeCsvField('')).toBe('');
    expect(encodeCsvField('  spaced  ')).toBe('  spaced  ');
    expect(encodeCsvField('$12.50')).toBe('$12.50');
    expect(encodeCsvField('a,b')).toBe('"a,b"');
    expect(encodeCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(encodeCsvField('line\nbreak')).toBe('"line\nbreak"');
    expect(encodeCsvField('carriage\rreturn')).toBe('"carriage\rreturn"');
  });

  it('joins fields without introducing whitespace', () => {
    expect(encodeCsvRow(['a', '', 'c'])).toBe('a,,c');
  });
});

describe('matchServiceM8Layout', () => {
  it('recognises the canonical contract exactly', () => {
    const layout = matchServiceM8Layout([...SERVICEM8_COLUMNS]);
    expect(layout.exact).toBe(true);
    expect(layout.complete).toBe(true);
    expect(layout.usable).toBe(true);
    expect(layout.missing).toEqual([]);
    expect(layout.unrecognised).toEqual([]);
    expect(layout.indexes['Price']).toBe(4);
    expect(layout.indexes['Price Includes Taxes']).toBe(5);
  });

  it('resolves a reordered or re-cased header row without positional guessing', () => {
    const layout = matchServiceM8Layout([
      'Barcode',
      'item number',
      'NAME',
      '  Price  ',
      'Price Includes Taxes',
    ]);
    expect(layout.exact).toBe(false);
    expect(layout.usable).toBe(true);
    expect(layout.indexes['Item Number']).toBe(1);
    expect(layout.indexes['Name']).toBe(2);
    expect(layout.indexes['Price']).toBe(3);
    expect(layout.indexes['Barcode']).toBe(0);
    expect(layout.missing).toContain('Purchase Cost');
  });

  it('reports a file that is not a ServiceM8 export as unusable', () => {
    const layout = matchServiceM8Layout(['Product Code', 'Description', 'Item Price']);
    expect(layout.usable).toBe(false);
    expect(layout.missing).toContain('Item Number');
    expect(layout.unrecognised).toEqual(['Product Code', 'Description', 'Item Price']);
  });

  it('keeps additional columns as unrecognised rather than dropping them silently', () => {
    const layout = matchServiceM8Layout([...SERVICEM8_COLUMNS, 'Supplier Notes']);
    expect(layout.complete).toBe(true);
    expect(layout.exact).toBe(false);
    expect(layout.unrecognised).toEqual(['Supplier Notes']);
  });
});

describe('value conventions', () => {
  it('reads the tax basis and reports unrecognised text instead of guessing', () => {
    expect(parseIncludesTaxes('Yes')).toEqual({ includesTaxes: true, recognised: true });
    expect(parseIncludesTaxes('no')).toEqual({ includesTaxes: false, recognised: true });
    expect(parseIncludesTaxes('')).toEqual({ includesTaxes: false, recognised: false });
    expect(parseIncludesTaxes('maybe')).toEqual({ includesTaxes: false, recognised: false });
  });

  it('writes the tax basis in ServiceM8 spelling', () => {
    expect(formatIncludesTaxes(true)).toBe('Yes');
    expect(formatIncludesTaxes(false)).toBe('No');
  });

  it('detects identifiers a spreadsheet has destroyed', () => {
    expect(isScientificNotation('9.34368E+12')).toBe(true);
    expect(isScientificNotation('9.4E+12')).toBe(true);
    expect(isScientificNotation('1e5')).toBe(true);
    expect(isScientificNotation('9311847775176')).toBe(false);
    expect(isScientificNotation('FIC-001')).toBe(false);
    expect(isScientificNotation('')).toBe(false);
    // A description that merely mentions a code is not scientific notation.
    expect(isScientificNotation('E12 key blank')).toBe(false);
  });
});
