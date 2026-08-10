/**
 * Client side of the live competitor search. The browser only ever calls its
 * own origin (`/api/...`); the server performs the outbound provider search.
 * Every server state is kept distinct so the UI can render provider failure,
 * timeout, quota exhaustion and empty results as four different screens, plus
 * not-configured and server-unreachable.
 */
export type LiveSearchState =
  | "ok"
  | "empty"
  | "not_configured"
  | "offline"
  | "timeout"
  | "provider_error"
  | "quota_exhausted"
  | "rate_limited"
  | "invalid_query"
  | "server_unreachable";

export interface LiveSearchResult {
  title: string;
  priceCents: number;
  priceAud: string;
  currency: "AUD";
  gstBasis: "inc-gst" | "ex-gst" | "unknown";
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
  queryKind: "identifier" | "barcode" | "free-text" | "empty";
  provider: string;
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
  } | null;
}

export interface LiveHealth {
  ok: boolean;
  provider: string;
  liveSearchConfigured: boolean;
  fixtureMode: boolean;
  paidCallsEnabled?: boolean;
  costCeilingAud?: string;
  costCeilingCents?: number;
  costPerCallCents?: number;
  spentCents?: number;
  schemaVersion?: number;
}

/** Integer cents to a fixed 2-decimal string without floating point. */
export function centsToAud(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.trunc(abs / 100);
  const rem = abs % 100;
  return `${cents < 0 ? "-" : ""}${whole}.${String(rem).padStart(2, "0")}`;
}
