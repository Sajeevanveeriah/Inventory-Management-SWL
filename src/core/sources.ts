import Big from "big.js";
import {
  normaliseObservationEx,
  type CompetitorObservation,
} from "./competitors";

/**
 * Competitor / supplier source registry.
 *
 * Every source records honestly how it is accessed. Live competitor search is
 * performed through the active platform's licensed shopping-search adapter
 * (rate limited, honest user agent; the server-backed web adapter may cache)
 * — never by scraping retailer websites directly.
 * Manual entry remains available on every platform. Bulk evidence-file import
 * is not exposed in this release.
 * Sources that cannot be supported lawfully are disabled in this registry
 * rather than failing silently. See docs/COMPETITOR-EVIDENCE.md.
 */

export type SourceAccessMethod = "live-api" | "manual-entry" | "file-import";

export interface CompetitorSource {
  id: string;
  name: string;
  /** How evidence from this source reaches the application. */
  accessMethod: SourceAccessMethod;
  /** Why automated access is not performed for this source. */
  automatedAccessNote: string;
  enabled: boolean;
}

/** Fictional example sources following the repository's demo-data convention. */
export function defaultSources(): CompetitorSource[] {
  return [
    {
      id: "live-provider",
      name: "Licensed shopping search API (live)",
      accessMethod: "live-api",
      automatedAccessNote:
        "Performed through the application's licensed provider adapter (Australian region, AUD) and rate limited. The server-backed web adapter may cache; native search does not claim a cache. Retailer websites are never scraped directly.",
      enabled: true,
    },
    {
      id: "manual",
      name: "Manual operator entry",
      accessMethod: "manual-entry",
      automatedAccessNote:
        "Not applicable: prices are typed in by the operator with a source URL.",
      enabled: true,
    },
    {
      id: "fictionville-security",
      name: "Fictionville Security Supplies (example)",
      accessMethod: "manual-entry",
      automatedAccessNote:
        "Entered manually: no published product API; site terms disallow scraping.",
      enabled: true,
    },
    {
      id: "fictionville-hardware",
      name: "Fictionville Hardware Direct (example)",
      accessMethod: "manual-entry",
      automatedAccessNote:
        "Automated access not permitted: robots.txt disallows automated product queries.",
      enabled: true,
    },
    {
      id: "fictionville-auctions",
      name: "Fictionville Auctions (example)",
      accessMethod: "manual-entry",
      automatedAccessNote:
        "Disabled: listings mix used and bundled products; prices are not comparable evidence.",
      enabled: false,
    },
  ];
}

export function toggleSource(
  sources: CompetitorSource[],
  id: string,
): CompetitorSource[] {
  return sources.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s));
}

/** Normalise a free-text query: trim, lower-case, collapse whitespace. */
export function normaliseQuery(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Heuristic: part numbers / SKUs / barcodes are digit-bearing single tokens. */
export function looksLikePartNumber(query: string): boolean {
  const q = normaliseQuery(query);
  return q !== "" && !q.includes(" ") && /\d/.test(q);
}

export interface EvidenceSearchResult {
  observation: CompetitorObservation;
  sourceName: string;
  /** Normalised AUD ex-GST price including shipping, or null when GST basis is unknown. */
  normalisedEx: string | null;
}

export interface EvidenceSearchOutcome {
  results: EvidenceSearchResult[];
  /** Enabled sources that hold no matching evidence for this query. */
  sourcesWithoutResults: string[];
  /** Sources switched off in the registry, always disclosed. */
  disabledSources: string[];
  queryKind: "part-number" | "free-text" | "empty";
}

/**
 * Search stored competitor evidence with one query across every enabled
 * source. Matches SKU exactly-first, then substring across SKU, source name
 * and URL. Disabled sources never contribute results but are always listed.
 */
export function searchEvidence(
  observations: CompetitorObservation[],
  sources: CompetitorSource[],
  rawQuery: string,
): EvidenceSearchOutcome {
  const query = normaliseQuery(rawQuery);
  const enabled = sources.filter((s) => s.enabled);
  const disabledSources = sources.filter((s) => !s.enabled).map((s) => s.name);
  if (query === "") {
    return {
      results: [],
      sourcesWithoutResults: enabled.map((s) => s.name),
      disabledSources,
      queryKind: "empty",
    };
  }
  const enabledNames = new Set(enabled.map((s) => s.name));
  const matches = observations.filter((o) => {
    if (!enabledNames.has(o.sourceName)) return false;
    const hay = `${o.sku} ${o.sourceName} ${o.url ?? ""}`.toLowerCase();
    return o.sku.toLowerCase() === query || hay.includes(query);
  });
  const exactFirst = [...matches].sort((a, b) => {
    const ax = a.sku.toLowerCase() === query ? 0 : 1;
    const bx = b.sku.toLowerCase() === query ? 0 : 1;
    return ax - bx || a.sourceName.localeCompare(b.sourceName);
  });
  const results = exactFirst.map((observation) => ({
    observation,
    sourceName: observation.sourceName,
    normalisedEx: normaliseObservationEx(observation)?.toFixed(2) ?? null,
  }));
  const matchedSources = new Set(results.map((r) => r.sourceName));
  return {
    results,
    sourcesWithoutResults: enabled
      .map((s) => s.name)
      .filter((n) => !matchedSources.has(n)),
    disabledSources,
    queryKind: looksLikePartNumber(query) ? "part-number" : "free-text",
  };
}

export interface PriceBand {
  lowest: string;
  median: string;
  highest: string;
  /** Count of distinct sources with a normalisable price. */
  sourceCount: number;
  /** Count of priced results contributing to the band. */
  resultCount: number;
}

/** Lowest / median / highest of the normalised ex-GST prices, or null when none. */
export function priceBand(results: EvidenceSearchResult[]): PriceBand | null {
  const priced = results
    .filter((r) => r.normalisedEx !== null)
    .map((r) => ({
      value: new Big(r.normalisedEx as string),
      source: r.sourceName,
    }))
    .sort((a, b) => a.value.cmp(b.value));
  if (priced.length === 0) return null;
  const mid = Math.floor(priced.length / 2);
  const median =
    priced.length % 2 === 1
      ? (priced[mid] as { value: Big }).value
      : (priced[mid - 1] as { value: Big }).value
          .plus((priced[mid] as { value: Big }).value)
          .div(2)
          .round(2, Big.roundHalfUp);
  return {
    lowest: (priced[0] as { value: Big }).value.toFixed(2),
    highest: (priced[priced.length - 1] as { value: Big }).value.toFixed(2),
    median: median.toFixed(2),
    sourceCount: new Set(priced.map((p) => p.source)).size,
    resultCount: priced.length,
  };
}

/**
 * A competitor price attached to a catalogue item. Reference information
 * only: attaching one never writes to any cost or sell price.
 */
export interface AttachedReference {
  rowId: string;
  observation: CompetitorObservation;
  attachedAt: string;
}
