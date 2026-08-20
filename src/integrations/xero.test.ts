import { describe, expect, it, vi } from 'vitest';
import { assertXeroReadMethod, createXeroItemsReader } from './xero';

describe('Xero Items reader', () => {
  it('exposes only the fixed read operation and sends GET', async () => {
    const transport = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        Items: [
          {
            ItemID: '11111111-1111-4111-8111-111111111111',
            Code: 'LOCK-1',
            PurchaseDetails: { UnitPrice: 20 },
          },
        ],
      },
    });
    const reader = createXeroItemsReader(transport);

    await expect(reader.listItems()).resolves.toEqual([
      {
        itemId: '11111111-1111-4111-8111-111111111111',
        code: 'LOCK-1',
        purchaseUnitPrice: 20,
      },
    ]);
    expect(Object.keys(reader)).toEqual(['listItems']);
    expect(transport).toHaveBeenCalledWith({ method: 'GET', path: '/api.xro/2.0/Items' });
  });

  it('does not expose a generic request escape hatch', () => {
    const reader = createXeroItemsReader(vi.fn());
    expect(reader).not.toHaveProperty('request');
    expect(reader).not.toHaveProperty('createItem');
    expect(reader).not.toHaveProperty('updateItem');
    expect(reader).not.toHaveProperty('deleteItem');
  });

  it('rejects a non-GET method at the boundary', () => {
    expect(() => assertXeroReadMethod('POST')).toThrow(/read-only/);
    expect(() => assertXeroReadMethod('DELETE')).toThrow(/read-only/);
    expect(() => assertXeroReadMethod('GET')).not.toThrow();
  });

  it.each([
    ['an array instead of an envelope', [], /must be an object/],
    ['an object instead of Items array', { Items: {} }, /Items array/],
    ['a missing identifier', { Items: [{ Code: 'LOCK-1' }] }, /invalid ItemID/],
    [
      'duplicate identifiers',
      {
        Items: [
          { ItemID: '11111111-1111-4111-8111-111111111111', Code: 'LOCK-1' },
          { ItemID: '11111111-1111-4111-8111-111111111111', Code: 'LOCK-2' },
        ],
      },
      /duplicate/,
    ],
    [
      'a non-finite amount',
      {
        Items: [
          {
            ItemID: '11111111-1111-4111-8111-111111111111',
            Code: 'LOCK-1',
            PurchaseDetails: { UnitPrice: Number.NaN },
          },
        ],
      },
      /outside the supported range/,
    ],
    [
      'an out-of-range quantity',
      {
        Items: [
          {
            ItemID: '11111111-1111-4111-8111-111111111111',
            Code: 'LOCK-1',
            QuantityOnHand: -1,
          },
        ],
      },
      /invalid QuantityOnHand/,
    ],
    [
      'an unexpected envelope field',
      { Items: [], Secret: 'unexpected' },
      /unexpected field Secret/,
    ],
    [
      'an unexpected item field',
      {
        Items: [
          {
            ItemID: '11111111-1111-4111-8111-111111111111',
            Code: 'LOCK-1',
            Unexpected: true,
          },
        ],
      },
      /unexpected field Unexpected/,
    ],
    [
      'a malformed allowed envelope field',
      { Items: [], ProviderName: { nested: true } },
      /response.ProviderName must be bounded text/,
    ],
    [
      'a malformed allowed item field',
      {
        Items: [
          {
            ItemID: '11111111-1111-4111-8111-111111111111',
            Code: 'LOCK-1',
            UpdatedDateUTC: { nested: true },
          },
        ],
      },
      /UpdatedDateUTC must be bounded text/,
    ],
  ])('rejects %s', async (_label, body, error) => {
    const reader = createXeroItemsReader(vi.fn().mockResolvedValue({ status: 200, body }));
    await expect(reader.listItems()).rejects.toThrow(error);
  });

  it.each([
    ['a non-object response', null, /must be an object/],
    ['an invalid status', { status: Number.NaN, body: { Items: [] } }, /invalid HTTP status/],
    [
      'an unexpected response field',
      { status: 200, body: { Items: [] }, debug: true },
      /unexpected field debug/,
    ],
    [
      'an invalid response header',
      { status: 200, body: { Items: [] }, headers: { trace: 42 } },
      /invalid header/,
    ],
  ])('rejects transport boundary case: %s', async (_label, response, error) => {
    const reader = createXeroItemsReader(vi.fn().mockResolvedValue(response));
    await expect(reader.listItems()).rejects.toThrow(error);
  });
});
