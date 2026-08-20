import type { HttpResponse, HttpTransport } from './contracts';

export interface XeroItem {
  readonly itemId: string;
  readonly code: string;
  readonly name?: string;
  readonly description?: string;
  readonly purchaseDescription?: string;
  readonly purchaseUnitPrice?: number;
  readonly salesUnitPrice?: number;
}

export interface XeroItemsReader {
  listItems(): Promise<readonly XeroItem[]>;
}

const ITEMS_PATH = '/api.xro/2.0/Items';
const XERO_ENVELOPE_FIELDS = new Set(['Id', 'Status', 'ProviderName', 'DateTimeUTC', 'Items']);
const XERO_ITEM_FIELDS = new Set([
  'ItemID',
  'Code',
  'Name',
  'Description',
  'PurchaseDescription',
  'UpdatedDateUTC',
  'IsSold',
  'IsPurchased',
  'InventoryAssetAccountCode',
  'TotalCostPool',
  'QuantityOnHand',
  'IsTrackedAsInventory',
  'SalesDetails',
  'PurchaseDetails',
  'COGSAccountCode',
  'Status',
]);
const XERO_DETAIL_FIELDS = new Set(['UnitPrice', 'AccountCode', 'TaxType', 'COGSAccountCode']);
const RESPONSE_FIELDS = new Set(['status', 'body', 'headers', 'uncertain']);
const XERO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PROVIDER_AMOUNT = 1_000_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertFields(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
) {
  const unexpected = Object.keys(record).find((field) => !allowed.has(field));
  if (unexpected) throw new Error(label + ' contains unexpected field ' + unexpected + '.');
}

function assertTransportResponse(value: unknown): asserts value is HttpResponse<unknown> {
  if (!isRecord(value)) throw new Error('Xero Items transport response must be an object.');
  assertFields(value, RESPONSE_FIELDS, 'Xero Items transport response');
  if (
    !Number.isInteger(value.status) ||
    (value.status as number) < 100 ||
    (value.status as number) > 599
  ) {
    throw new Error('Xero Items transport returned an invalid HTTP status.');
  }
  if (value.uncertain !== undefined && typeof value.uncertain !== 'boolean') {
    throw new Error('Xero Items transport response has an invalid uncertainty flag.');
  }
  if (value.headers !== undefined) {
    if (!isRecord(value.headers) || Object.keys(value.headers).length > 100) {
      throw new Error('Xero Items transport response has invalid headers.');
    }
    for (const [name, header] of Object.entries(value.headers)) {
      if (
        name.length === 0 ||
        name.length > 100 ||
        (header !== undefined && (typeof header !== 'string' || header.length > 4_000))
      ) {
        throw new Error('Xero Items transport response has an invalid header.');
      }
    }
  }
}

function optionalText(value: unknown, field: string, maximum = 4_000): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > maximum) {
    throw new Error('Xero ' + field + ' must be bounded text.');
  }
  return value;
}

function detailPrice(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('Xero ' + field + ' must be an object.');
  assertFields(value, XERO_DETAIL_FIELDS, 'Xero ' + field);
  const price = value.UnitPrice;
  if (
    price !== undefined &&
    (typeof price !== 'number' ||
      !Number.isFinite(price) ||
      price < 0 ||
      price > MAX_PROVIDER_AMOUNT)
  ) {
    throw new Error('Xero ' + field + ' UnitPrice is outside the supported range.');
  }
  for (const textField of ['AccountCode', 'TaxType', 'COGSAccountCode']) {
    optionalText(value[textField], field + '.' + textField, 100);
  }
  return price as number | undefined;
}

function parseItemsEnvelope(body: unknown): readonly XeroItem[] {
  if (!isRecord(body)) throw new Error('Xero Items response must be an object.');
  assertFields(body, XERO_ENVELOPE_FIELDS, 'Xero Items response');
  for (const envelopeField of ['Id', 'Status', 'ProviderName', 'DateTimeUTC']) {
    optionalText(body[envelopeField], 'response.' + envelopeField, 255);
  }
  if (!Array.isArray(body.Items))
    throw new Error('Xero Items response must contain an Items array.');
  const ids = new Set<string>();
  const codes = new Set<string>();
  return body.Items.map((value, index) => {
    if (!isRecord(value)) throw new Error('Xero item ' + index + ' must be an object.');
    assertFields(value, XERO_ITEM_FIELDS, 'Xero item ' + index);
    if (typeof value.ItemID !== 'string' || !XERO_ID.test(value.ItemID)) {
      throw new Error('Xero item ' + index + ' has an invalid ItemID.');
    }
    if (typeof value.Code !== 'string' || value.Code.trim() === '' || value.Code.length > 30) {
      throw new Error('Xero item ' + index + ' has an invalid Code.');
    }
    if (ids.has(value.ItemID) || codes.has(value.Code)) {
      throw new Error('Xero Items response contains a duplicate ItemID or Code.');
    }
    ids.add(value.ItemID);
    codes.add(value.Code);
    for (const numericField of ['TotalCostPool', 'QuantityOnHand']) {
      const number = value[numericField];
      if (
        number !== undefined &&
        (typeof number !== 'number' ||
          !Number.isFinite(number) ||
          number < 0 ||
          number > MAX_PROVIDER_AMOUNT)
      ) {
        throw new Error('Xero item ' + index + ' has an invalid ' + numericField + '.');
      }
    }
    for (const booleanField of ['IsSold', 'IsPurchased', 'IsTrackedAsInventory']) {
      const boolean = value[booleanField];
      if (boolean !== undefined && typeof boolean !== 'boolean') {
        throw new Error('Xero item ' + index + ' has an invalid ' + booleanField + '.');
      }
    }
    const name = optionalText(value.Name, 'Name', 255);
    const description = optionalText(value.Description, 'Description');
    const purchaseDescription = optionalText(value.PurchaseDescription, 'PurchaseDescription');
    for (const textField of [
      'UpdatedDateUTC',
      'InventoryAssetAccountCode',
      'COGSAccountCode',
      'Status',
    ]) {
      optionalText(value[textField], textField, 255);
    }
    const purchaseUnitPrice = detailPrice(value.PurchaseDetails, 'PurchaseDetails');
    const salesUnitPrice = detailPrice(value.SalesDetails, 'SalesDetails');
    return {
      itemId: value.ItemID,
      code: value.Code,
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(purchaseDescription !== undefined ? { purchaseDescription } : {}),
      ...(purchaseUnitPrice !== undefined ? { purchaseUnitPrice } : {}),
      ...(salesUnitPrice !== undefined ? { salesUnitPrice } : {}),
    };
  });
}

export function assertXeroReadMethod(method: string): asserts method is 'GET' {
  if (method !== 'GET') {
    throw new Error('Xero Items integration is read-only; only GET is permitted.');
  }
}

/**
 * Read-only Xero Items port. The fixed operation intentionally exposes no
 * arbitrary request method or path and rejects any non-GET boundary request.
 */
export function createXeroItemsReader(transport: HttpTransport): XeroItemsReader {
  const sendRead = async <T>(method: string, path: string): Promise<HttpResponse<T>> => {
    assertXeroReadMethod(method);
    return transport<T>({ method: 'GET', path });
  };

  return {
    async listItems() {
      const response = await sendRead<unknown>('GET', ITEMS_PATH);
      assertTransportResponse(response);
      if (response.status < 200 || response.status >= 300) {
        throw new Error('Xero Items read failed with HTTP ' + response.status + '.');
      }
      return parseItemsEnvelope(response.body);
    },
  };
}
