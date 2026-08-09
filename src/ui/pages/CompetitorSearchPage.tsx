import { useEffect, useMemo, useRef, useState } from "react";
import type { CompetitorObservation } from "../../core/competitors";
import {
  centsToAud,
  type LiveHealth,
  type LiveSearchOutcome,
  type LiveSearchResult,
  type LiveSearchState,
} from "../../core/liveSearch";
import { formatAmount, parseMoney } from "../../core/money";
import { priceBand, searchEvidence } from "../../core/sources";
import { useAppDispatch, useAppState } from "../../state/store";
import { useActions } from "../../state/useActions";
import { usePlatform } from "../../platform/context";
import type { CatalogueItem, ProviderStatus } from "../../platform/contracts";
import { EmptyState, Page } from "./PageChrome";

const MELBOURNE_TIME = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Melbourne",
  dateStyle: "medium",
  timeStyle: "short",
});

export function ProviderPaidCallsControl({
  status,
  onToggle,
}: {
  status: ProviderStatus | null;
  onToggle: (
    enabled: boolean,
    costCeilingCents?: number,
    costPerCallCents?: number,
  ) => void;
}) {
  const enabled = status?.paidCallsEnabled === true;
  const [ceilingInput, setCeilingInput] = useState("");
  const [perCallInput, setPerCallInput] = useState("");
  const ceiling = parsePositiveBudgetCents(ceilingInput);
  const perCall = parsePositiveBudgetCents(perCallInput);
  const validBudget =
    ceiling !== null &&
    perCall !== null &&
    perCall <= ceiling &&
    ceiling <= 1_000_000_000;
  const canEnable =
    status?.credentialConfigured === true &&
    status.lastValidatedAt !== null &&
    validBudget;

  return (
    <div>
      <div className="form-grid">
        <label>
          Total provider budget (AUD)
          <input
            inputMode="decimal"
            value={ceilingInput}
            disabled={enabled}
            placeholder="10.00"
            onChange={(event) => setCeilingInput(event.target.value)}
          />
        </label>
        <label>
          Reserved cost per call (AUD)
          <input
            inputMode="decimal"
            value={perCallInput}
            disabled={enabled}
            placeholder="0.05"
            onChange={(event) => setPerCallInput(event.target.value)}
          />
        </label>
      </div>
      <div className="btn-row">
        <button
          type="button"
          className={enabled ? "btn btn-danger" : "btn"}
          aria-pressed={enabled}
          disabled={!status || (!enabled && !canEnable)}
          onClick={() =>
            enabled
              ? onToggle(false)
              : onToggle(true, ceiling ?? undefined, perCall ?? undefined)
          }
        >
          {enabled
            ? "Disable paid provider calls"
            : "Enable paid provider calls within budget"}
        </button>
        <span className="hint" role="status">
          {enabled && status
            ? `AUD ${centsToAud(status.spentCents)} reserved of AUD ${status.costCeilingAud}; AUD ${centsToAud(status.costPerCallCents)} is reserved before each attempt.`
            : status?.credentialConfigured && status.lastValidatedAt === null
              ? "Validate the protected credential before enabling paid calls."
              : "Paid calls are disabled by default. Enter a positive ceiling and per-call reservation; calls stop before the ceiling can be exceeded."}
        </span>
      </div>
    </div>
  );
}

function parsePositiveBudgetCents(raw: string): number | null {
  const parsed = parseMoney(raw);
  if (!parsed.ok || parsed.amount === "0.00") return null;
  const [whole = "0", fraction = "00"] = parsed.amount.split(".");
  const cents = Number(whole) * 100 + Number(fraction);
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 1_000_000_000
    ? cents
    : null;
}

function retrievedLabel(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const ageHours = Math.max(
    0,
    Math.floor((Date.now() - at.getTime()) / 3600000),
  );
  const age =
    ageHours < 1
      ? "under 1 h ago"
      : ageHours < 48
        ? `${ageHours} h ago`
        : `${Math.floor(ageHours / 24)} d ago`;
  return `${MELBOURNE_TIME.format(at)} (${age})`;
}

const INTELLIGENCE_OFFERS = [
  {
    seller: "Fictionville Security",
    price: 14350,
    provider: "Fixture feed",
    state: "Eligible",
    note: "Exact MPN, new, each, GST and shipping known",
  },
  {
    seller: "Example Trade Locks",
    price: 14600,
    provider: "Fixture feed",
    state: "Eligible",
    note: "Exact GTIN, new, each, GST and shipping known",
  },
  {
    seller: "Fictionville Hardware",
    price: 14900,
    provider: "Fixture search",
    state: "Eligible",
    note: "Brand and MPN agree; probable match",
  },
  {
    seller: "Demo Wholesale",
    price: 26500,
    provider: "Fixture feed",
    state: "Excluded",
    note: "Pack of 2 is incompatible",
  },
  {
    seller: "Provider error fixture",
    price: null,
    provider: "Fixture error",
    state: "Provider failed",
    note: "Retryable upstream error retained in coverage",
  },
] as const;

export function IntelligenceWorkspace() {
  const [batchState, setBatchState] = useState<
    "ready" | "running" | "paused" | "cancelled"
  >("ready");
  const [reviewState, setReviewState] = useState<
    "pending" | "accepted" | "rejected"
  >("pending");
  return (
    <section className="ci-workspace" aria-labelledby="ci-title">
      <div className="ci-heading">
        <div>
          <span className="eyebrow">Fixture-backed review</span>
          <h2 id="ci-title">Competitor intelligence</h2>
        </div>
        <div className="ci-actions" aria-label="Batch controls">
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => setBatchState("running")}
          >
            {batchState === "paused"
              ? "Resume fixture preview"
              : "Analyse 6 fixture items"}
          </button>
          <button
            className="btn"
            type="button"
            disabled={batchState !== "running"}
            onClick={() => setBatchState("paused")}
          >
            Pause
          </button>
          <button
            className="btn"
            type="button"
            disabled={batchState === "ready" || batchState === "cancelled"}
            onClick={() => setBatchState("cancelled")}
          >
            Cancel
          </button>
        </div>
      </div>
      <div className="callout" role="note">
        <strong>Synthetic illustrative fixture.</strong> These controls preview
        deterministic UI states in this session only. They do not persist a
        batch, change the catalogue or apply a price.
      </div>
      <div
        className="ci-status-grid"
        aria-label="Provider and coverage summary"
      >
        <div>
          <strong>3</strong>
          <span>eligible sellers</span>
        </div>
        <div>
          <strong>2 / 3</strong>
          <span>providers healthy</span>
        </div>
        <div>
          <strong>AUD 0.00</strong>
          <span>worst-case paid cost</span>
        </div>
        <div>
          <strong>{batchState}</strong>
          <span>batch state</span>
        </div>
      </div>
      <div className="ci-plan" role="status">
        <strong>Preflight:</strong> 6 eligible items, 3 identifier stages, 8
        cache hits, at most 10 fixture calls, paid ceiling AUD 0.00. No price
        will be applied automatically.
      </div>
      <div className="ci-detail-grid">
        <article className="ci-panel">
          <div className="ci-panel-title">
            <div>
              <span className="eyebrow">LW4570SC - exact identity</span>
              <h3>Lockwood 4570 keyed deadlatch</h3>
            </div>
            <span className="pill pill-ok">Ready for review</span>
          </div>
          <div className="price-strip">
            <div>
              <span>Current</span>
              <strong>$159.00</strong>
            </div>
            <div>
              <span>Cost floor</span>
              <strong>$130.00</strong>
            </div>
            <div>
              <span>Lowest landed</span>
              <strong>$143.50</strong>
            </div>
            <div>
              <span>Suggested</span>
              <strong>$142.50</strong>
            </div>
          </div>
          <figure className="price-position" aria-labelledby="position-caption">
            <svg
              viewBox="0 0 700 140"
              role="img"
              aria-label="Price position from 125 to 165 Australian dollars. Floor 130, eligible offers 143.50, 146 and 149, suggestion 142.50, current 159."
            >
              <line x1="45" y1="82" x2="665" y2="82" className="axis" />
              {[130, 140, 150, 160].map((value) => (
                <g key={value}>
                  <line
                    x1={45 + (value - 125) * 15.5}
                    y1="76"
                    x2={45 + (value - 125) * 15.5}
                    y2="90"
                    className="tick"
                  />
                  <text
                    x={45 + (value - 125) * 15.5}
                    y="111"
                    textAnchor="middle"
                  >
                    ${value}
                  </text>
                </g>
              ))}
              <line
                x1="122.5"
                y1="35"
                x2="122.5"
                y2="82"
                className="marker floor"
              />
              <text x="122.5" y="25" textAnchor="middle">
                Floor $130
              </text>
              <line
                x1="316.25"
                y1="42"
                x2="316.25"
                y2="82"
                className="marker suggested"
              />
              <text x="316.25" y="32" textAnchor="middle">
                Suggested $142.50
              </text>
              {[143.5, 146, 149].map((value) => (
                <circle
                  key={value}
                  cx={45 + (value - 125) * 15.5}
                  cy="82"
                  r="7"
                  className="offer-dot"
                >
                  <title>Eligible offer ${value.toFixed(2)}</title>
                </circle>
              ))}
              <line
                x1="572"
                y1="48"
                x2="572"
                y2="82"
                className="marker current"
              />
              <text x="572" y="38" textAnchor="middle">
                Current $159
              </text>
            </svg>
            <figcaption id="position-caption">
              Price position in AUD per sellable unit, delivered and
              GST-inclusive. The table below is the complete text equivalent.
            </figcaption>
          </figure>
          <div
            className="table-scroll"
            role="region"
            aria-label="Price position text equivalent"
            tabIndex={0}
          >
            <table className="data-table compact">
              <thead>
                <tr>
                  <th>Evidence</th>
                  <th>Value</th>
                  <th>Formula or basis</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Cost floor</td>
                  <td>$130.00</td>
                  <td>$100.00 cost + 30% markup; 23.08% gross margin</td>
                </tr>
                <tr>
                  <td>Eligible offers</td>
                  <td>$143.50, $146.00, $149.00</td>
                  <td>AUD per unit, delivered, GST-inclusive</td>
                </tr>
                <tr>
                  <td>Aggressive / recommended</td>
                  <td>$142.50</td>
                  <td>
                    $143.50 - min($1.00, 1%); strict undercut and floor
                    rechecked
                  </td>
                </tr>
                <tr>
                  <td>Market / defensive</td>
                  <td>$145.00 / $145.00</td>
                  <td>Median $146.00 - $1.00</td>
                </tr>
                <tr>
                  <td>Current price</td>
                  <td>$159.00</td>
                  <td>Local catalogue value; never sent to providers</td>
                </tr>
              </tbody>
            </table>
          </div>
        </article>
        <aside className="ci-panel ci-review" aria-label="Review decision">
          <h3>Review decision</h3>
          <dl className="kv">
            <dt>Policy</dt>
            <dd>aud-undercut-v1</dd>
            <dt>Confidence</dt>
            <dd>High - 3 distinct sellers</dd>
            <dt>Freshness</dt>
            <dd>All evidence under 24 h</dd>
            <dt>Query</dt>
            <dd>MPN "LW4570SC"</dd>
            <dt>Terminal state</dt>
            <dd>{reviewState === "pending" ? "Recommended" : reviewState}</dd>
          </dl>
          <label>
            Reviewed price (AUD)
            <input inputMode="decimal" defaultValue="142.50" />
          </label>
          <div className="ci-review-actions">
            <button
              type="button"
              className="btn btn-primary"
              aria-pressed={reviewState === "accepted"}
              onClick={() => setReviewState("accepted")}
            >
              Preview accepted state
            </button>
            <button
              type="button"
              className="btn"
              aria-pressed={reviewState === "rejected"}
              onClick={() => setReviewState("rejected")}
            >
              Preview rejected state
            </button>
          </div>
          <p className="hint">
            This fixture changes only the visible preview state. Real
            publication requires an explicit approval in the seven-stage
            workflow and creates append-only history.
          </p>
        </aside>
      </div>
      <div
        className="table-scroll"
        role="region"
        aria-label="Comparable offer evidence"
        tabIndex={0}
      >
        <table className="data-table">
          <thead>
            <tr>
              <th>Seller</th>
              <th>Provider</th>
              <th>Landed price</th>
              <th>State</th>
              <th>Evidence or exclusion</th>
            </tr>
          </thead>
          <tbody>
            {INTELLIGENCE_OFFERS.map((offer) => (
              <tr key={offer.seller}>
                <td>{offer.seller}</td>
                <td>{offer.provider}</td>
                <td>
                  {offer.price == null
                    ? "Unknown"
                    : formatAmount(centsToAud(offer.price))}
                </td>
                <td>
                  <span
                    className={`pill ${offer.state === "Eligible" ? "pill-ok" : "pill-warn"}`}
                  >
                    {offer.state}
                  </span>
                </td>
                <td>{offer.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const GST_LABELS: Record<CompetitorObservation["gstBasis"], string> = {
  "inc-gst": "inc GST",
  "ex-gst": "ex GST",
  unknown: "GST unknown",
};

/** Distinct, visible copy for every non-result search state. Never one blank screen. */
type SearchStateCopy = {
  title: string;
  tone: "info" | "warn" | "error";
  detail: string;
};

function stateCopy(
  state: LiveSearchState,
  platformKind: "desktop" | "web",
): SearchStateCopy | undefined {
  const copy: Partial<Record<LiveSearchState, SearchStateCopy>> = {
    not_configured: {
      title: "Live search is not configured",
      tone: "warn",
      detail:
        platformKind === "desktop"
          ? "No provider credential is configured. Use the protected provider controls below. Manual entry works now."
          : "No provider is configured for the web demonstration service. Manual entry works now.",
    },
    offline: {
      title: "The computer is offline",
      tone: "warn",
      detail:
        "No network search was attempted successfully. Manual evidence and the full core workflow remain available.",
    },
    timeout: {
      title: "The search provider timed out",
      tone: "error",
      detail:
        "The provider did not answer in time. This is a provider-side delay, not an empty result. Try again shortly, or record the price manually below.",
    },
    provider_error: {
      title: "The search provider returned an error",
      tone: "error",
      detail:
        "The provider rejected or failed the request. This is a failure, not an empty result.",
    },
    quota_exhausted: {
      title: "Provider quota is exhausted",
      tone: "warn",
      detail:
        "The provider account has no searches left. No result could be retrieved. Top up the plan or wait for the quota window to reset.",
    },
    rate_limited: {
      title: "Local rate limit reached",
      tone: "warn",
      detail:
        "This application limits its own outbound searches. Wait about a minute and retry; cached results continue to work.",
    },
    server_unreachable: {
      title:
        platformKind === "desktop"
          ? "The native search service is not reachable"
          : "The web demonstration service is not reachable",
      tone: "error",
      detail:
        platformKind === "desktop"
          ? "The native search service did not respond. Manual entry and the core comparison workflow still work without it."
          : "The web demonstration service did not respond. Manual entry and the core comparison workflow still work without it.",
    },
    invalid_query: {
      title: "The search query is invalid",
      tone: "warn",
      detail:
        "Enter a bounded product identifier or short product description and try again.",
    },
  };
  return copy[state];
}

type SortKey = "price" | "seller" | "title";

function ResultsTable({
  results,
  attachEnabled,
  onAttach,
  onOpenSource,
}: {
  results: LiveSearchResult[];
  attachEnabled: boolean;
  onAttach: (result: LiveSearchResult) => void;
  onOpenSource: (url: string) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("price");
  const [ascending, setAscending] = useState(true);
  const sorted = useMemo(() => {
    const copy = [...results];
    copy.sort((a, b) => {
      const delta =
        sortKey === "price"
          ? a.priceCents - b.priceCents
          : sortKey === "seller"
            ? a.seller.localeCompare(b.seller)
            : a.title.localeCompare(b.title);
      return ascending ? delta : -delta;
    });
    return copy;
  }, [results, sortKey, ascending]);

  const header = (key: SortKey, label: string, numeric = false) => (
    <th
      scope="col"
      aria-sort={
        sortKey === key ? (ascending ? "ascending" : "descending") : "none"
      }
    >
      <button
        type="button"
        className={`th-sort${numeric ? " th-num" : ""}`}
        onClick={() => {
          if (sortKey === key) setAscending(!ascending);
          else {
            setSortKey(key);
            setAscending(true);
          }
        }}
      >
        {label}
        <span aria-hidden="true" className="sort-arrow">
          {sortKey === key ? (ascending ? "▴" : "▾") : ""}
        </span>
      </button>
    </th>
  );

  return (
    <div
      className="table-scroll"
      role="region"
      aria-label="Live search results"
      tabIndex={0}
    >
      <table className="data-table">
        <thead>
          <tr>
            {header("title", "Product")}
            {header("price", "Price (AUD)", true)}
            <th scope="col">GST</th>
            <th scope="col">Unit / pack</th>
            {header("seller", "Seller")}
            <th scope="col">Retrieved (Melbourne time)</th>
            <th scope="col">Link</th>
            <th scope="col">Attach</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((result) => (
            <tr key={`${result.url}-${result.priceCents}`}>
              <td data-label="Product">{result.title}</td>
              <td data-label="Price (AUD)" className="num">
                {formatAmount(result.priceAud)}
              </td>
              <td data-label="GST">
                <span
                  className={`pill ${result.gstBasis === "unknown" ? "pill-warn" : "pill-ok"}`}
                >
                  {GST_LABELS[result.gstBasis]}
                </span>
              </td>
              <td data-label="Unit / pack">
                {result.packSize ?? "not stated"}
              </td>
              <td data-label="Seller">
                {result.seller}
                <span className="hint-block">{result.sourceDomain}</span>
              </td>
              <td data-label="Retrieved">
                {retrievedLabel(result.retrievedAt)}
              </td>
              <td data-label="Link">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => onOpenSource(result.url)}
                >
                  Open source page
                </button>
              </td>
              <td data-label="Attach">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!attachEnabled}
                  onClick={() => onAttach(result)}
                >
                  Attach as reference
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Competitor product search: LIVE internet search for a typed-in product via
 * the active platform adapter and an optional provider, plus stored local
 * evidence and manual entry as the fallback. Five distinct visual states:
 * idle, loading, results, no results, provider unavailable.
 */
export function CompetitorsPage() {
  const platform = usePlatform();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const actions = useActions();
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState<LiveSearchOutcome | null>(null);
  // 'checking' means the platform probe is in flight; null means it was unavailable.
  const [health, setHealth] = useState<LiveHealth | null | "checking">(
    "checking",
  );
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(
    null,
  );
  const [catalogueItems, setCatalogueItems] = useState<CatalogueItem[] | null>(
    null,
  );
  const credentialInput = useRef<HTMLInputElement>(null);
  const [attachTarget, setAttachTarget] = useState("");
  const requestSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      platform.health(),
      platform.search.status(),
      platform.catalogue.list(),
    ]).then(([healthResult, status, catalogue]) => {
      if (!cancelled) {
        setHealth(healthResult.ok ? healthResult.value : null);
        setProviderStatus(status.ok ? status.value : null);
        setCatalogueItems(catalogue.ok ? catalogue.value : null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [platform]);

  const runSearch = async () => {
    const q = query.trim();
    if (q === "") return;
    const seq = ++requestSeq.current;
    setSubmitted(q);
    setLoading(true);
    const result = await platform.search.query(q);
    if (seq !== requestSeq.current) return;
    setOutcome(result);
    setLoading(false);
    actions.announce(
      result.state === "ok"
        ? `${result.results.length} live results for ${q}.`
        : `Live search state: ${result.state.replace(/_/g, " ")}.`,
    );
  };

  const attachItem = catalogueItems?.find(
    (item) =>
      item.id === attachTarget.trim() ||
      item.itemNumber === attachTarget.trim(),
  );
  const attachRow = (state.comparison?.rows ?? []).find(
    (row) =>
      row.s8?.itemNumber === attachItem?.itemNumber ||
      row.supplier?.code === attachItem?.itemNumber,
  );
  const attachEnabled = attachItem !== undefined;

  const attach = (result: LiveSearchResult) => {
    if (!attachItem) return;
    const itemId = attachItem.id;
    const observation: CompetitorObservation = {
      sku: attachItem.itemNumber,
      sourceName: result.seller,
      approvedSource: false,
      observedAt: result.retrievedAt,
      price: result.priceAud,
      currency: "AUD",
      gstBasis: result.gstBasis,
      shipping: "",
      stockStatus: "unknown",
      condition: "unknown",
      packCompatible: false,
      productOnly: false,
      matchConfidence: 0,
      reviewState: "quarantined",
      ambiguousMatch: true,
      url: result.url,
      ...(result.packSize ? { packSize: result.packSize } : {}),
    };
    void actions.attachReference(itemId, result, {
      rowId: attachRow?.id ?? itemId,
      observation,
      attachedAt: new Date().toISOString(),
    });
  };

  const updateCredential = async (replace: boolean) => {
    const input = credentialInput.current;
    const secret = input?.value ?? "";
    if (secret.length < 8 || secret.length > 1024) {
      actions.announce(
        "Enter a provider credential between 8 and 1024 characters.",
      );
      return;
    }
    if (input) input.value = "";
    const result = replace
      ? await platform.search.replaceCredential(secret)
      : await platform.search.configureCredential(secret);
    if (result.ok) setProviderStatus(result.value);
    actions.announce(
      result.ok
        ? "Provider credential stored in Windows protected storage."
        : result.error.message,
    );
  };

  const validateCredential = async () => {
    const result = await platform.search.validateCredential();
    if (result.ok) setProviderStatus(result.value);
    actions.announce(
      result.ok
        ? "Provider credential validation completed."
        : result.error.message,
    );
  };

  const removeCredential = async () => {
    const result = await platform.search.removeCredential();
    if (result.ok) setProviderStatus(result.value);
    actions.announce(
      result.ok ? "Provider credential removed." : result.error.message,
    );
  };

  const setPaidCallsEnabled = async (
    enabled: boolean,
    costCeilingCents?: number,
    costPerCallCents?: number,
  ) => {
    const result = await platform.search.setPaidCallsEnabled(
      enabled,
      costCeilingCents,
      costPerCallCents,
    );
    if (result.ok) setProviderStatus(result.value);
    actions.announce(
      result.ok
        ? `Paid provider calls ${result.value.paidCallsEnabled ? "enabled" : "disabled"}.`
        : result.error.message,
    );
  };

  const openSource = async (url: string) => {
    const result = await platform.files.openVerifiedSource(url);
    if (!result.ok) actions.announce(result.error.message);
  };

  // Stored local evidence (manual entries and imports) still searches inline.
  const manualSources = state.competitorSources.filter(
    (s) => s.enabled && s.accessMethod !== "live-api",
  );
  const storedOutcome = useMemo(
    () =>
      searchEvidence(
        state.competitorEvidence,
        state.competitorSources,
        submitted,
      ),
    [state.competitorEvidence, state.competitorSources, submitted],
  );
  const storedBand = priceBand(storedOutcome.results);

  const [entry, setEntry] = useState({
    sku: "",
    price: "",
    gstBasis: "inc-gst" as CompetitorObservation["gstBasis"],
    sourceId: "manual",
    url: "",
    packSize: "each",
  });
  const entryPrice = parseMoney(entry.price);
  const entryUrlValid = (() => {
    if (entry.url.trim() === "") return true;
    try {
      const parsed = new URL(entry.url.trim());
      return (
        parsed.protocol === "https:" &&
        parsed.username === "" &&
        parsed.password === ""
      );
    } catch {
      return false;
    }
  })();
  const entryValid = entry.sku.trim() !== "" && entryPrice.ok && entryUrlValid;

  const storeManualObservation = async () => {
    if (!entryPrice.ok || !entryUrlValid) return;
    const itemIdentifier = entry.sku.trim();
    const source = manualSources.find(
      (candidate) => candidate.id === entry.sourceId,
    );
    const observedAt = new Date().toISOString();
    const observation: CompetitorObservation = {
      sku: itemIdentifier,
      sourceName: source?.name ?? "Manual operator entry",
      approvedSource: true,
      observedAt,
      price: entryPrice.amount,
      currency: "AUD",
      gstBasis: entry.gstBasis,
      shipping: "0",
      stockStatus: "unknown",
      condition: "new",
      packCompatible: true,
      productOnly: true,
      matchConfidence: 1,
      reviewState: "accepted",
      ...(entry.url.trim() ? { url: entry.url.trim() } : {}),
      ...(entry.packSize.trim() ? { packSize: entry.packSize.trim() } : {}),
    };

    dispatch({ type: "evidence-added", observations: [observation] });
    setSubmitted(itemIdentifier);

    if (catalogueItems === null) {
      actions.announce(
        `Added ${itemIdentifier} to this session. The catalogue was unavailable, so no persistent reference was written.`,
      );
      return;
    }
    const item = catalogueItems.find(
      (candidate) =>
        candidate.id === itemIdentifier ||
        candidate.itemNumber === itemIdentifier,
    );
    if (!item) {
      actions.announce(
        `Added ${itemIdentifier} to this session only. Approve the exact catalogue item before persisting a reference.`,
      );
      return;
    }
    const comparisonRow = (state.comparison?.rows ?? []).find(
      (row) =>
        row.s8?.itemNumber === item.itemNumber ||
        row.supplier?.code === item.itemNumber,
    );
    await actions.attachReference(item.id, observation, {
      rowId: comparisonRow?.id ?? item.id,
      observation,
      attachedAt: observedAt,
    });
  };

  const failureCopy = outcome && stateCopy(outcome.state, platform.kind);

  return (
    <Page
      title="Competitor search"
      primary={
        <button
          type="button"
          className="btn btn-primary"
          disabled={query.trim() === "" || loading}
          onClick={() => void runSearch()}
        >
          Search live prices
        </button>
      }
    >
      {state.demoMode && health !== "checking" && health?.fixtureMode && (
        <IntelligenceWorkspace />
      )}
      <section className="card">
        <form
          className="searchbar"
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch();
          }}
        >
          <label className="grow">
            Product name, part number, SKU, brand, description or barcode
            <input
              type="search"
              value={query}
              maxLength={512}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. Lockwood 4570, LW4570 or 9312345678907"
            />
          </label>
        </form>
        <p className="hint" role="status">
          {health === "checking"
            ? "Checking live search availability…"
            : health === null
              ? platform.kind === "desktop"
                ? "Native search is unavailable or offline. Manual entry works now."
                : "The optional web demonstration service is unavailable. Manual entry works now."
              : health.fixtureMode
                ? "Fixture provider active: deterministic offline results for testing and demos."
                : health.liveSearchConfigured
                  ? "Live search ready: native or same-origin provider, Australian region, AUD, rate limited and cached."
                  : "Live search is not configured. Manual entry works now."}
        </p>
      </section>

      {platform.capabilities.protectedCredentials && (
        <section className="card" aria-labelledby="provider-credential-title">
          <h2 id="provider-credential-title">Optional provider credential</h2>
          <p className="hint">
            State: {providerStatus?.state ?? "checking"}. Paid calls remain{" "}
            {providerStatus?.paidCallsEnabled
              ? "enabled within the configured ceiling"
              : "disabled"}
            .
            {providerStatus?.credentialHint
              ? ` Stored hint: ${providerStatus.credentialHint}.`
              : ""}
          </p>
          <label>
            New provider credential
            <input
              ref={credentialInput}
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={1024}
            />
          </label>
          <div className="btn-row">
            <button
              type="button"
              className="btn"
              onClick={() =>
                void updateCredential(
                  providerStatus?.credentialConfigured === true,
                )
              }
            >
              {providerStatus?.credentialConfigured
                ? "Replace credential"
                : "Configure credential"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => void validateCredential()}
            >
              Validate stored credential
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={!providerStatus?.credentialConfigured}
              onClick={() => void removeCredential()}
            >
              Remove credential
            </button>
          </div>
          <ProviderPaidCallsControl
            status={providerStatus}
            onToggle={(enabled, costCeilingCents, costPerCallCents) =>
              void setPaidCallsEnabled(
                enabled,
                costCeilingCents,
                costPerCallCents,
              )
            }
          />
          <p className="hint">
            The complete stored value is never displayed or retained in React
            state, SQLite, exports or logs.
          </p>
        </section>
      )}

      {loading && (
        <section
          className="card state-loading"
          role="status"
          aria-live="polite"
        >
          <span className="spinner" aria-hidden="true" />
          <div>
            <h2>
              Searching live sources for &ldquo;{submitted}&rdquo;&hellip;
            </h2>
            <p className="hint">
              {platform.kind === "desktop"
                ? "The native service"
                : "The web demonstration server"}{" "}
              is querying the provider now. Results include seller, GST
              treatment and a retrieval timestamp.
            </p>
          </div>
        </section>
      )}

      {!loading && outcome === null && (
        <EmptyState
          title="Type a product and search the live market"
          detail="One box, no search-type selector: the application works out whether the query is a part number, barcode or free text. Results arrive with an AUD price band, GST treatment, seller, retrieval time and a working source link. Nothing needs importing first."
        />
      )}

      {!loading && outcome !== null && failureCopy && (
        <section
          className={`card state-banner state-${failureCopy.tone}`}
          role="alert"
        >
          <h2>{failureCopy.title}</h2>
          <p>{failureCopy.detail}</p>
          {outcome.detail && (
            <p className="hint">Search detail: {outcome.detail}</p>
          )}
        </section>
      )}

      {!loading && outcome?.state === "empty" && (
        <EmptyState
          title={`No live prices found for “${submitted}”`}
          detail="The provider answered but returned no priced listings. That is a genuine zero, not a failure. Try a broader term, or record a price you found yourself with manual entry below."
        />
      )}

      {!loading && outcome?.state === "ok" && outcome.band && (
        <>
          <div
            className="metric-row"
            role="group"
            aria-label="Price band across live sources"
          >
            <div className="metric-card">
              <span className="metric-label">Lowest</span>
              <strong className="metric-value">
                {formatAmount(outcome.band.lowest)}
              </strong>
              <span className="metric-state pill pill-ok">
                across live sources
              </span>
            </div>
            <div className="metric-card">
              <span className="metric-label">Median</span>
              <strong className="metric-value">
                {formatAmount(outcome.band.median)}
              </strong>
              <span className="metric-state">
                of {outcome.band.pricedResults} priced results
              </span>
            </div>
            <div className="metric-card">
              <span className="metric-label">Highest</span>
              <strong className="metric-value">
                {formatAmount(outcome.band.highest)}
              </strong>
              <span className="metric-state">
                spread{" "}
                {formatAmount(
                  centsToAud(
                    outcome.band.highestCents - outcome.band.lowestCents,
                  ),
                )}
              </span>
            </div>
            <div className="metric-card">
              <span className="metric-label">Sources responding</span>
              <strong className="metric-value">
                {outcome.coverage?.sourcesWithPrice ?? 0}
              </strong>
              <span className="metric-state">
                {outcome.cached ? "served from cache" : "fresh retrieval"}
              </span>
            </div>
          </div>

          <ResultsTable
            results={outcome.results}
            attachEnabled={attachEnabled}
            onAttach={attach}
            onOpenSource={(url) => void openSource(url)}
          />

          <section className="card">
            <h2>Coverage</h2>
            <dl className="kv">
              <dt>Provider queried</dt>
              <dd>
                {outcome.provider} ({outcome.queryKind} query
                {outcome.cached ? ", cached response" : ""})
              </dd>
              <dt>Source domains with a price</dt>
              <dd>{outcome.coverage?.sourceDomains.join(", ") || "none"}</dd>
              <dt>Sources returning nothing this search</dt>
              <dd>
                {storedOutcome.sourcesWithoutResults.length > 0
                  ? `${storedOutcome.sourcesWithoutResults.join(", ")} (stored evidence)`
                  : "none of the registered evidence sources"}
              </dd>
              <dt>Failed sources</dt>
              <dd>
                none this search; provider failures are shown as their own
                state, never hidden
              </dd>
              <dt>Retrieved</dt>
              <dd>
                {outcome.retrievedAt
                  ? retrievedLabel(outcome.retrievedAt)
                  : "unknown"}
              </dd>
            </dl>
          </section>
        </>
      )}

      <section className="card">
        <h2>Attach target</h2>
        <div className="form-grid">
          <label>
            Catalogue item (ServiceM8 item number, supplier code or SKU)
            <input
              value={attachTarget}
              onChange={(e) => setAttachTarget(e.target.value)}
              placeholder="e.g. LW4570"
            />
          </label>
        </div>
        <p className="hint" role="status">
          {attachTarget.trim() === ""
            ? `${state.references.length} reference(s) attached this session. Enter an item to enable Attach.`
            : catalogueItems === null
              ? "The approved catalogue is unavailable. Attachment is disabled and evidence remains session-only."
              : attachItem
                ? `Reference attachment available for ${attachTarget.trim()}. Provider facts remain quarantined until explicit review; no cost or sell price changes.`
                : `No approved catalogue item matches ${attachTarget.trim()}. Attachment is disabled to prevent an orphan reference.`}
        </p>
      </section>

      {submitted !== "" && storedOutcome.results.length > 0 && (
        <section className="card">
          <h2>Stored local evidence matching &ldquo;{submitted}&rdquo;</h2>
          <p className="hint">
            {storedOutcome.results.length} stored observation(s)
            {storedBand
              ? ` · band ${formatAmount(storedBand.lowest)} to ${formatAmount(storedBand.highest)} ex GST`
              : ""}
          </p>
        </section>
      )}

      <section className="card">
        <h2>Manual entry (fallback for anything the provider cannot reach)</h2>
        <div className="form-grid">
          <label>
            SKU or product
            <input
              value={entry.sku}
              onChange={(e) => setEntry({ ...entry, sku: e.target.value })}
            />
          </label>
          <label>
            Observed price (AUD)
            <input
              value={entry.price}
              onChange={(e) => setEntry({ ...entry, price: e.target.value })}
              inputMode="decimal"
              aria-invalid={entry.price !== "" && !entryPrice.ok}
            />
          </label>
          <label>
            GST basis
            <select
              value={entry.gstBasis}
              onChange={(e) =>
                setEntry({
                  ...entry,
                  gstBasis: e.target.value as CompetitorObservation["gstBasis"],
                })
              }
            >
              <option value="inc-gst">Includes GST</option>
              <option value="ex-gst">Excludes GST</option>
              <option value="unknown">Unknown</option>
            </select>
          </label>
          <label>
            Source
            <select
              value={entry.sourceId}
              onChange={(e) => setEntry({ ...entry, sourceId: e.target.value })}
            >
              {manualSources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Source URL
            <input
              type="url"
              value={entry.url}
              onChange={(e) => setEntry({ ...entry, url: e.target.value })}
              aria-invalid={!entryUrlValid}
              placeholder="https://…"
            />
          </label>
          <label>
            Unit or pack size
            <input
              value={entry.packSize}
              onChange={(e) => setEntry({ ...entry, packSize: e.target.value })}
            />
          </label>
        </div>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!entryValid}
            onClick={() => void storeManualObservation()}
          >
            Store observation
          </button>
        </div>
        <p className="hint">
          Evidence for an exact approved catalogue item is persisted as a
          reference. Otherwise it remains in this session. Neither path writes
          to a cost or sell price, directly or indirectly.
        </p>
      </section>
    </Page>
  );
}

const ACCESS_LABELS: Record<string, string> = {
  "live-api": "Licensed provider API",
  "manual-entry": "Manual entry",
  "file-import": "File import",
};

/** Source registry: every source, how it is accessed, and an enable toggle. */
export function SourcesPage() {
  const state = useAppState();
  const actions = useActions();
  const platform = usePlatform();
  return (
    <Page title="Source registry">
      <div
        className="table-scroll"
        role="region"
        aria-label="Registered sources"
        tabIndex={0}
      >
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Access method</th>
              <th scope="col">How access works</th>
              <th scope="col">State</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {state.competitorSources.map((source) => (
              <tr key={source.id}>
                <td data-label="Source">{source.name}</td>
                <td data-label="Access method">
                  {ACCESS_LABELS[source.accessMethod] ?? source.accessMethod}
                </td>
                <td data-label="How access works">
                  {source.automatedAccessNote}
                </td>
                <td data-label="State">
                  <span
                    className={
                      source.enabled ? "pill pill-ok" : "pill pill-error"
                    }
                  >
                    {source.enabled ? "enabled" : "disabled"}
                  </span>
                </td>
                <td data-label="Action">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      void actions
                        .toggleCompetitorSource(source.id)
                        .then((saved) => {
                          if (saved)
                            actions.announce(
                              `${source.name} ${source.enabled ? "disabled" : "enabled"}.`,
                            );
                        });
                    }}
                  >
                    {source.enabled ? "Disable" : "Enable"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="card">
        <h2>Access policy</h2>
        <dl className="kv">
          <dt>Live retrieval</dt>
          <dd>
            {platform.kind === "desktop"
              ? "Performed by the native Rust service through an exact allowlisted licensed shopping-search API."
              : "Performed by the web demonstration's Node service through a licensed shopping-search API."}{" "}
            Requests are rate limited and cached and identify the client
            honestly. Retailer websites are never scraped directly; robots.txt,
            site terms, rate limits and bot protections are never circumvented.
          </dd>
          <dt>Fallback paths</dt>
          <dd>
            Manual entry and operator-provided file import. A source that cannot
            be supported lawfully or reliably is disabled here and says why,
            instead of failing silently.
          </dd>
        </dl>
      </section>
    </Page>
  );
}
