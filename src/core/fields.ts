import type { FileRole } from './table';

/** Conceptual target fields the operator maps source columns onto. */
export type SupplierFieldKey =
  'supplierCode' | 'supplierDescription' | 'supplierCost' | 'supplierBarcode';
export type S8FieldKey =
  | 'itemNumber'
  | 'itemDescription'
  | 'existingCost'
  | 'existingSellPrice'
  | 'priceIncludesTaxes'
  | 'taxRate'
  | 'quantityInStock'
  | 'itemIsInventoried'
  | 'barcode';
export type FieldKey = SupplierFieldKey | S8FieldKey;

export interface FieldDefinition {
  key: FieldKey;
  role: FileRole;
  label: string;
  required: boolean;
  help: string;
  /** Header-name patterns used only to SUGGEST a mapping; never auto-applied. */
  suggestPatterns: RegExp[];
}

export const SUPPLIER_FIELDS: FieldDefinition[] = [
  {
    key: 'supplierCode',
    role: 'supplier',
    label: 'Supplier item code',
    required: true,
    help: 'The supplier’s unique product identifier. Used for exact matching.',
    suggestPatterns: [/\b(item|product|part|stock)?[\s_-]*(code|sku|number|no\.?|id)\b/i],
  },
  {
    key: 'supplierDescription',
    role: 'supplier',
    label: 'Supplier description',
    required: true,
    help: 'The supplier’s product name or description. Used only for review and similarity suggestions.',
    suggestPatterns: [/\b(description|desc|name|title|product)\b/i],
  },
  {
    key: 'supplierCost',
    role: 'supplier',
    label: 'Supplier cost',
    required: true,
    help: 'Your buy price from the supplier. The markup is applied to this value, converted to exclude GST first if the supplier quotes tax-inclusive prices.',
    suggestPatterns: [/\b(item\s*price|cost|buy|trade|net|wholesale)\b/i],
  },
  {
    key: 'supplierBarcode',
    role: 'supplier',
    label: 'Supplier barcode',
    required: false,
    help: 'The supplier’s barcode (EAN/UPC). Carried through to new ServiceM8 items and used for secondary match suggestions. Never used for automatic matching on its own.',
    suggestPatterns: [/\b(barcode|ean|upc|gtin)\b/i],
  },
];

export const SERVICEM8_FIELDS: FieldDefinition[] = [
  {
    key: 'itemNumber',
    role: 'servicem8',
    label: 'Item Number',
    required: true,
    help: 'The ServiceM8 material identifier. Matched against the supplier item code and used as the import key.',
    suggestPatterns: [/^item\s*number$/i, /\b(item)?[\s_-]*(number|no\.?|code|sku|id)\b/i],
  },
  {
    key: 'itemDescription',
    role: 'servicem8',
    label: 'Name',
    required: true,
    help: 'The ServiceM8 item name.',
    suggestPatterns: [/^name$/i, /\b(description|desc|name|title)\b/i],
  },
  {
    key: 'existingSellPrice',
    role: 'servicem8',
    label: 'Price',
    required: true,
    help: 'The selling price currently recorded in ServiceM8. This is the value the run compares against and replaces.',
    suggestPatterns: [/^price$/i, /\b(sell|sale|retail|charge)\b/i],
  },
  {
    key: 'priceIncludesTaxes',
    role: 'servicem8',
    label: 'Price Includes Taxes',
    required: true,
    help: 'Whether the ServiceM8 price for this row is GST-inclusive. This decides whether GST is added to the marked-up cost, so it is mandatory: guessing it would move every affected price by the GST rate.',
    suggestPatterns: [/^price\s*includes\s*tax(es)?$/i, /\b(includes?[\s_-]*tax|tax[\s_-]*incl)/i],
  },
  {
    key: 'existingCost',
    role: 'servicem8',
    label: 'Purchase Cost',
    required: false,
    help: 'The cost currently recorded in ServiceM8. Often zero in real exports, so it is optional and is never the sole basis for detecting a change.',
    suggestPatterns: [/^purchase\s*cost$/i, /\b(cost|buy)\b/i],
  },
  {
    key: 'taxRate',
    role: 'servicem8',
    label: 'Tax Rate',
    required: false,
    help: 'The ServiceM8 tax rate label, e.g. “GST on Income”. Preserved verbatim on existing items and defaulted on new items.',
    suggestPatterns: [/^tax\s*rate$/i],
  },
  {
    key: 'quantityInStock',
    role: 'servicem8',
    label: 'Quantity In Stock',
    required: false,
    help: 'Stock quantity. This application never changes stock levels; the value is preserved verbatim.',
    suggestPatterns: [/^quantity\s*in\s*stock$/i, /\b(qty|quantity)\b/i],
  },
  {
    key: 'itemIsInventoried',
    role: 'servicem8',
    label: 'Item is Inventoried',
    required: false,
    help: 'Whether ServiceM8 tracks stock for the item. Preserved verbatim on existing items and defaulted on new items.',
    suggestPatterns: [/^item\s*is\s*inventoried$/i, /\binventoried\b/i],
  },
  {
    key: 'barcode',
    role: 'servicem8',
    label: 'Barcode',
    required: false,
    help: 'The ServiceM8 barcode. Frequently damaged by spreadsheet round-tripping into scientific notation, which the run detects and reports rather than matching on.',
    suggestPatterns: [/^barcode$/i, /\b(ean|upc|gtin)\b/i],
  },
];

export function fieldsForRole(role: FileRole): FieldDefinition[] {
  return role === 'supplier' ? SUPPLIER_FIELDS : SERVICEM8_FIELDS;
}
