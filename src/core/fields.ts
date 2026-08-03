import type { FileRole } from './table';

/** Conceptual target fields the operator maps source columns onto. */
export type SupplierFieldKey = 'supplierCode' | 'supplierDescription' | 'supplierCost';
export type S8FieldKey = 'itemNumber' | 'itemDescription' | 'existingCost' | 'existingSellPrice';
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
    help: 'Your buy price from the supplier, excluding any transformation. The 30% markup is applied to this value.',
    suggestPatterns: [/\b(cost|buy|trade|net|wholesale|price)\b/i],
  },
];

export const SERVICEM8_FIELDS: FieldDefinition[] = [
  {
    key: 'itemNumber',
    role: 'servicem8',
    label: 'ServiceM8 item number',
    required: true,
    help: 'The ServiceM8 material/service identifier. Matched against the supplier item code.',
    suggestPatterns: [/\b(item)?[\s_-]*(number|no\.?|code|sku|id)\b/i],
  },
  {
    key: 'itemDescription',
    role: 'servicem8',
    label: 'ServiceM8 description',
    required: true,
    help: 'The ServiceM8 item name or description.',
    suggestPatterns: [/\b(description|desc|name|title|item)\b/i],
  },
  {
    key: 'existingCost',
    role: 'servicem8',
    label: 'Existing cost',
    required: true,
    help: 'The cost currently recorded in ServiceM8. Compared against the supplier cost.',
    suggestPatterns: [/\b(cost|buy)\b/i],
  },
  {
    key: 'existingSellPrice',
    role: 'servicem8',
    label: 'Existing selling price',
    required: false,
    help: 'The selling price currently recorded in ServiceM8, shown for before/after comparison.',
    suggestPatterns: [/\b(sell|sale|retail|charge|price)\b/i],
  },
];

export function fieldsForRole(role: FileRole): FieldDefinition[] {
  return role === 'supplier' ? SUPPLIER_FIELDS : SERVICEM8_FIELDS;
}
