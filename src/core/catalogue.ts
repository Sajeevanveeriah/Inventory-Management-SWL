export const CATALOGUE_ITEM_KINDS = ['physical-product', 'service', 'labour'] as const;
export type CatalogueItemKind = (typeof CATALOGUE_ITEM_KINDS)[number];
export type ItemKind = CatalogueItemKind;

export interface CatalogueDomainItem {
  id: string;
  name: string;
  kind: CatalogueItemKind;
  brandId?: string | null;
  sku?: string | null;
  markupOverridePercent?: string | null;
}

/** Search-only projection. It deliberately contains no supplier offer or price. */
export interface ProductSearchDocument {
  productId: string;
  kind: ItemKind;
  name: string;
  description: string;
  xeroItemCode: string | null;
  servicem8ItemNumber: string | null;
  supplierSkus: readonly string[];
  approvedAliases: readonly string[];
  barcodeGtin: string | null;
  brandName: string | null;
}

export interface ProductSearchMatch {
  productId: string;
  matchKind:
    | 'xero-item-code'
    | 'servicem8-item-number'
    | 'supplier-sku'
    | 'approved-alias'
    | 'barcode-gtin'
    | 'brand'
    | 'description-similarity';
  confidence: number;
  explanation: string;
}

export function isStockTrackedKind(kind: CatalogueItemKind): boolean {
  return kind === 'physical-product';
}

export function catalogueKindLabel(kind: CatalogueItemKind): string {
  switch (kind) {
    case 'physical-product':
      return 'Physical product';
    case 'service':
      return 'Service';
    case 'labour':
      return 'Labour';
  }
}

export type PriceEvidenceKind =
  'supplier-offer' | 'operator-selection' | 'supplier-import' | 'upstream-read';

export interface PriceProvenance {
  sourceSystem: string;
  sourceRecordId: string;
  evidenceKind: PriceEvidenceKind;
  observedAt: string;
  description: string;
}

const MAX_PROVENANCE_TEXT = 240;

/** Build bounded, display-safe provenance while retaining typed source facts. */
export function createPriceProvenance(input: PriceProvenance): PriceProvenance {
  return {
    sourceSystem: bounded(input.sourceSystem, 'sourceSystem'),
    sourceRecordId: bounded(input.sourceRecordId, 'sourceRecordId'),
    evidenceKind: input.evidenceKind,
    observedAt: input.observedAt,
    description: bounded(input.description, 'description'),
  };
}

function bounded(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${field} must not be blank`);
  if (trimmed.length > MAX_PROVENANCE_TEXT) {
    throw new Error(`${field} exceeds ${MAX_PROVENANCE_TEXT} characters`);
  }
  return trimmed;
}
