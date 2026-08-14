/**
 * Client side of the live competitor search. The browser only ever calls its
 * own origin (`/api/...`); the server performs the outbound provider search.
 * Every server state is kept distinct so the UI can render provider failure,
 * timeout, quota exhaustion and empty results as four different screens, plus
 * not-configured and server-unreachable.
 */
export type LiveSearchState =
  | 'ok'
  | 'empty'
  | 'selection_required'
  | 'selection_expired'
  | 'no_comparable_offers'
  | 'not_configured'
  | 'offline'
  | 'timeout'
  | 'provider_error'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'search_in_progress'
  | 'invalid_query'
  | 'server_unreachable';

export type ProductCondition = 'new' | 'used' | 'unknown';

export interface LiveProductCandidate {
  /** Opaque SerpAPI token used only to retrieve the selected product's stores. */
  token: string;
  title: string;
  brand: string | null;
  productId: string | null;
  /** Google product-cluster URL. This is not a merchant source URL. */
  productUrl: string;
  displayedPrice: string | null;
  priceCents: number | null;
  multipleSources: boolean;
  packSize: string | null;
  condition: ProductCondition;
  position: number;
}

export type LivePriceBasis = 'provider_total' | 'item_plus_shipping' | 'not_comparable';

export interface LiveSearchResult {
  /** Immutable query and selected product provenance for attached evidence. */
  searchQuery?: string | null;
  selectedProductTitle?: string | null;
  selectedProductBrand?: string | null;
  selectedProductId?: string | null;
  title: string;
  /** Backwards-compatible item price. Never use this alone as delivered total. */
  priceCents: number;
  priceAud: string;
  itemPriceCents: number;
  itemPriceAud: string;
  shippingCents: number | null;
  shippingAud: string | null;
  estimatedTaxCents: number | null;
  estimatedTaxAud: string | null;
  totalPriceCents: number | null;
  totalPriceAud: string | null;
  comparisonPriceCents: number | null;
  comparisonPriceAud: string | null;
  priceBasis: LivePriceBasis;
  originalPriceText: string;
  currencyBasis: 'explicit-aud' | 'inferred-au-localisation';
  currency: 'AUD';
  gstBasis: 'inc-gst' | 'ex-gst' | 'unknown';
  packSize: string | null;
  condition: ProductCondition;
  availability: 'in-stock' | 'out-of-stock' | 'unknown';
  financing: boolean;
  comparisonEligible: boolean;
  exclusionReasons: string[];
  seller: string;
  sourceDomain: string;
  url: string;
  retrievedAt: string;
}

export interface LiveSearchBand {
  lowest: string;
  median: string;
  highest: string;
  lowestCents: number;
  medianCents: number;
  highestCents: number;
  pricedResults: number;
}

export interface LiveSearchOutcome {
  state: LiveSearchState;
  query: string;
  queryKind: 'identifier' | 'barcode' | 'free-text' | 'empty';
  provider: string;
  candidates: LiveProductCandidate[];
  selectedProduct?: {
    title: string;
    brand: string | null;
    productId: string | null;
  } | null;
  results: LiveSearchResult[];
  band: LiveSearchBand | null;
  retrievedAt?: string | null;
  cached?: boolean | null;
  detail?: string | null;
  coverage?: {
    providerQueried: string;
    sourcesWithPrice: number;
    sourceDomains: string[];
    pricedResults: number;
    providerCandidates: number;
    parsedOffers: number;
    comparableOffers: number;
    excludedOffers: number;
  } | null;
}

export interface LiveHealth {
  ok: boolean;
  provider: string;
  liveSearchConfigured: boolean;
  fixtureMode: boolean;
  requiresPaidCall?: boolean;
  paidCallsEnabled?: boolean;
  costCeilingAud?: string;
  costCeilingCents?: number;
  costPerCallCents?: number;
  spentCents?: number;
  paidPolicyState?: 'fixture' | 'disabled' | 'invalid' | 'enabled' | 'exhausted';
  schemaVersion?: number;
}

/** Integer cents to a fixed 2-decimal string without floating point. */
export function centsToAud(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.trunc(abs / 100);
  const rem = abs % 100;
  return `${cents < 0 ? '-' : ''}${whole}.${String(rem).padStart(2, '0')}`;
}
