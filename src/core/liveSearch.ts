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
  | 'not_configured'
  | 'timeout'
  | 'provider_error'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'invalid_query'
  | 'server_unreachable';

export interface LiveSearchResult {
  title: string;
  priceCents: number;
  priceAud: string;
  currency: 'AUD';
  gstBasis: 'inc-gst' | 'ex-gst' | 'unknown';
  packSize: string | null;
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
  results: LiveSearchResult[];
  band: LiveSearchBand | null;
  retrievedAt?: string;
  cached?: boolean;
  detail?: string;
  coverage?: {
    providerQueried: string;
    sourcesWithPrice: number;
    sourceDomains: string[];
    pricedResults: number;
  };
}

export interface LiveHealth {
  ok: boolean;
  provider: string;
  liveSearchConfigured: boolean;
  fixtureMode: boolean;
}

/** Integer cents to a fixed 2-decimal string without floating point. */
export function centsToAud(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.trunc(abs / 100);
  const rem = abs % 100;
  return `${cents < 0 ? '-' : ''}${whole}.${String(rem).padStart(2, '0')}`;
}

export async function fetchLiveSearch(query: string): Promise<LiveSearchOutcome> {
  try {
    const response = await fetch(`/api/competitor-search?q=${encodeURIComponent(query)}`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as LiveSearchOutcome;
  } catch (error) {
    return {
      state: 'server_unreachable',
      query,
      queryKind: 'free-text',
      provider: 'unknown',
      results: [],
      band: null,
      detail: `The application server could not be reached (${String(
        error instanceof Error ? error.message : error,
      )}). Start it with: npm run server`,
    };
  }
}

export async function fetchLiveHealth(): Promise<LiveHealth | null> {
  try {
    const response = await fetch('/api/health', { headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    return (await response.json()) as LiveHealth;
  } catch {
    return null;
  }
}

/** Persist an attach-as-reference on the server. Reference information only. */
export async function postReference(
  itemId: string,
  observation: LiveSearchResult,
): Promise<boolean> {
  try {
    const response = await fetch('/api/references', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemId, observation }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export interface PriceHistoryVersion {
  id: string;
  itemId: string;
  cost: string;
  sellPrice: string;
  costCents: number;
  sellPriceCents: number;
  approvalId: string;
  recordedAt: string;
}

export async function fetchPriceHistory(): Promise<PriceHistoryVersion[]> {
  try {
    const response = await fetch('/api/price-history', {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return [];
    return (await response.json()) as PriceHistoryVersion[];
  } catch {
    return [];
  }
}
