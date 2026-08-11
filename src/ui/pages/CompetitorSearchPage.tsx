import { useEffect, useMemo, useRef, useState } from "react";
import type { CompetitorObservation } from "../../core/competitors";
import {
  centsToAud,
  type LiveHealth,
  type LiveProductCandidate,
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
  liveSearchSupported: boolean,
): SearchStateCopy | undefined {
  if (!liveSearchSupported) {
    return {
      title: "Live provider search is unavailable in Static Pages",
      tone: "info",
      detail:
        "Static Pages has no Node service and makes no provider request. Manual evidence and the core comparison workflow remain available.",
    };
  }
  const copy: Partial<Record<LiveSearchState, SearchStateCopy>> = {
    not_configured: {
      title: "Live search is not configured",
      tone: "warn",
      detail:
        platformKind === "desktop"
          ? "No provider credential is configured. Use the protected provider controls below. Manual entry works now."
          : "No provider is configured for the web search service. Manual entry works now.",
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
      title: "Approved search allowance is exhausted",
      tone: "warn",
      detail:
        "The approved local cost ceiling or provider plan quota cannot authorise another search. Review the displayed budget and provider account before retrying.",
    },
    rate_limited: {
      title: "Local rate limit reached",
      tone: "warn",
      detail:
        platformKind === "desktop"
          ? "The native application limits its own outbound searches. Wait about a minute and retry; manual evidence remains available."
          : "The web service limits its own outbound searches. Wait about a minute and retry; no provider result was returned for this attempt.",
    },
    search_in_progress: {
      title: "This search is already in progress",
      tone: "info",
      detail:
        "An identical live request is already retrieving merchant evidence. Wait briefly, then retry so the completed cached result can be reused.",
    },
    selection_expired: {
      title: "The selected product has expired",
      tone: "info",
      detail:
        "Run the product search again, then select the exact product from the new candidates. No merchant comparison was made from the expired selection.",
    },
    server_unreachable: {
      title:
        platformKind === "desktop"
          ? "The native search service is not reachable"
          : "The web search service is not reachable",
      tone: "error",
      detail:
        platformKind === "desktop"
          ? "The native search service did not respond. Manual entry and the core comparison workflow still work without it."
          : "The web search service did not respond. Manual entry and the core comparison workflow still work without it.",
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
          ? (a.comparisonPriceCents ?? Number.MAX_SAFE_INTEGER) -
            (b.comparisonPriceCents ?? Number.MAX_SAFE_INTEGER)
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
            {header("price", "Observed total (AUD)", true)}
            <th scope="col">Item and shipping</th>
            <th scope="col">Comparison basis</th>
            <th scope="col">GST</th>
            <th scope="col">Unit / pack</th>
            {header("seller", "Seller")}
            <th scope="col">Retrieved (Melbourne time)</th>
            <th scope="col">Link</th>
            <th scope="col">Attach</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((result, index) => (
            <tr
              key={`${result.url}-${result.seller}-${result.title}-${result.totalPriceCents ?? result.priceCents}-${index}`}
            >
              <td data-label="Product">{result.title}</td>
              <td data-label="Observed total (AUD)" className="num">
                {result.comparisonPriceAud
                  ? formatAmount(result.comparisonPriceAud)
                  : "not comparable"}
              </td>
              <td data-label="Item and shipping">
                Item {formatAmount(result.itemPriceAud)}
                <span className="hint-block">
                  Shipping{" "}
                  {result.shippingAud === null
                    ? "unknown"
                    : formatAmount(result.shippingAud)}
                </span>
                <span className="hint-block">
                  Provider total{" "}
                  {result.totalPriceAud === null
                    ? "not supplied"
                    : formatAmount(result.totalPriceAud)}
                </span>
              </td>
              <td data-label="Comparison basis">
                <span
                  className={`pill ${result.comparisonEligible ? "pill-ok" : "pill-warn"}`}
                >
                  {result.comparisonEligible ? "comparable" : "excluded"}
                </span>
                <span className="hint-block">
                  {result.priceBasis.replaceAll("_", " ")}
                </span>
                {!result.comparisonEligible && (
                  <span className="hint-block">
                    {result.exclusionReasons.join(", ") || "basis unknown"}
                  </span>
                )}
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

function ProductCandidates({
  candidates,
  loading,
  onCompare,
  onOpenProduct,
}: {
  candidates: LiveProductCandidate[];
  loading: boolean;
  onCompare: (candidate: LiveProductCandidate) => void;
  onOpenProduct: (url: string) => void;
}) {
  return (
    <section className="card" aria-labelledby="product-candidates-title">
      <h2 id="product-candidates-title">
        Select the exact product before comparing stores
      </h2>
      <p className="hint">
        These are Google Shopping product candidates, not competitor offers.
        Check the model, variant and pack, then choose one product to retrieve
        its direct merchant offers through SerpAPI Immersive Product.
      </p>
      <div
        className="table-scroll"
        role="region"
        aria-label="Product candidates"
        tabIndex={0}
      >
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Candidate</th>
              <th scope="col">Discovery price</th>
              <th scope="col">Evidence</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((candidate) => (
              <tr key={candidate.token}>
                <td data-label="Candidate">
                  <strong>{candidate.title}</strong>
                  <span className="hint-block">
                    {[candidate.brand, candidate.productId]
                      .filter(Boolean)
                      .join(" | ") || "Brand and product ID not supplied"}
                  </span>
                  <span className="hint-block">
                    {candidate.packSize ?? "Pack not stated"} | condition{" "}
                    {candidate.condition}
                  </span>
                </td>
                <td data-label="Discovery price">
                  {candidate.displayedPrice ?? "not supplied"}
                </td>
                <td data-label="Evidence">
                  {candidate.multipleSources
                    ? "Multiple stores indicated"
                    : "Store count not established"}
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => onOpenProduct(candidate.productUrl)}
                  >
                    Open Google product page
                  </button>
                </td>
                <td data-label="Action">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={loading || candidate.condition === "used"}
                    onClick={() => onCompare(candidate)}
                  >
                    Compare this exact product
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
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
  const liveSearchAvailable =
    platform.capabilities.liveSearch &&
    health !== "checking" &&
    health !== null &&
    health.fixtureMode === false;
  const liveSearchSourceEnabled = state.competitorSources.some(
    (source) =>
      source.id === "live-provider" &&
      source.accessMethod === "live-api" &&
      source.enabled,
  );
  const desktopBudgetExhausted =
    platform.kind === "desktop" &&
    providerStatus?.paidCallsEnabled === true &&
    providerStatus.costPerCallCents > 0 &&
    providerStatus.spentCents >
      providerStatus.costCeilingCents - providerStatus.costPerCallCents;
  const paidCallsReady =
    platform.kind === "web"
      ? health !== "checking" &&
        health !== null &&
        health.paidCallsEnabled === true
      : providerStatus?.paidCallsEnabled === true && !desktopBudgetExhausted;
  const liveSearchReady =
    liveSearchAvailable &&
    liveSearchSourceEnabled &&
    health.liveSearchConfigured &&
    paidCallsReady;

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

  const runSearch = async (candidateToken?: string) => {
    if (!liveSearchReady) {
      actions.announce(
        liveSearchSourceEnabled
          ? "Live search is not ready. Check the credential and approved budget."
          : "The licensed live API source is disabled in the Source registry.",
      );
      return;
    }
    const q = candidateToken ? submitted : query.trim();
    if (q === "") return;
    const seq = ++requestSeq.current;
    if (!candidateToken) setSubmitted(q);
    setLoading(true);
    const result = await platform.search.query(q, candidateToken);
    if (seq !== requestSeq.current) return;
    setOutcome(result);
    setLoading(false);
    actions.announce(
      result.state === "selection_required"
        ? `${result.candidates.length} product candidates require exact selection for ${q}.`
        : result.state === "ok"
          ? `${result.results.length} observed merchant offers for ${q}.`
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
      price: result.itemPriceAud,
      currency: "AUD",
      gstBasis: result.gstBasis,
      shipping: result.shippingAud ?? "",
      stockStatus: result.availability,
      condition: result.condition,
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
    if (result.ok) {
      setProviderStatus(result.value);
    }
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
    if (result.ok) {
      setProviderStatus(result.value);
    }
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

  // Stored non-live local evidence still searches inline.
  const manualSources = state.competitorSources.filter(
    (s) => s.enabled && s.accessMethod !== "live-api",
  );
  const storedOutcome = useMemo(
    () =>
      searchEvidence(
        state.competitorEvidence,
        state.competitorSources.filter(
          (source) => source.accessMethod !== "live-api",
        ),
        submitted,
      ),
    [state.competitorEvidence, state.competitorSources, submitted],
  );
  const storedBand = priceBand(storedOutcome.results);

  const [entry, setEntry] = useState({
    sku: "",
    price: "",
    shipping: "",
    gstBasis: "inc-gst" as CompetitorObservation["gstBasis"],
    stockStatus: "unknown" as CompetitorObservation["stockStatus"],
    condition: "unknown" as CompetitorObservation["condition"],
    sourceId: "manual",
    url: "",
    packSize: "each",
  });
  const entryPrice = parseMoney(entry.price);
  const entryShipping = parseMoney(entry.shipping);
  const selectedManualSource = manualSources.find(
    (candidate) => candidate.id === entry.sourceId,
  );
  const entryUrlValid = (() => {
    if (entry.url.trim() === "") return false;
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
  const entryValid =
    entry.sku.trim() !== "" &&
    entryPrice.ok &&
    entryShipping.ok &&
    selectedManualSource !== undefined &&
    entryUrlValid &&
    entry.packSize.trim() !== "";

  const storeManualObservation = async () => {
    if (!entryPrice.ok || !entryShipping.ok || !entryUrlValid) return;
    const itemIdentifier = entry.sku.trim();
    const source = selectedManualSource;
    if (!source) return;
    const observedAt = new Date().toISOString();
    const observation: CompetitorObservation = {
      sku: itemIdentifier,
      sourceName: source.name,
      approvedSource: false,
      observedAt,
      price: entryPrice.amount,
      currency: "AUD",
      gstBasis: entry.gstBasis,
      shipping: entryShipping.amount,
      stockStatus: entry.stockStatus,
      condition: entry.condition,
      packCompatible: false,
      productOnly: false,
      matchConfidence: 0,
      reviewState: "quarantined",
      ambiguousMatch: true,
      url: entry.url.trim(),
      packSize: entry.packSize.trim(),
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

  const failureCopy =
    outcome && stateCopy(outcome.state, platform.kind, liveSearchAvailable);

  return (
    <Page
      title="Competitor search"
      primary={
        liveSearchReady ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={query.trim() === "" || loading}
            onClick={() => void runSearch()}
          >
            Search live prices
          </button>
        ) : undefined
      }
    >
      <section className="card">
        {liveSearchReady ? (
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
        ) : (
          <p>
            {!liveSearchSourceEnabled
              ? "The licensed live API source is disabled in Source registry. Enable it before searching."
              : "Live provider search is unavailable. Use the manual evidence form below with an operator-verified HTTPS source."}
          </p>
        )}
        <p className="hint" role="status">
          {health === "checking"
            ? "Checking live search availability…"
            : !liveSearchSourceEnabled
              ? "Licensed live API retrieval is disabled in Source registry. No provider request can start."
              : health === null
                ? platform.kind === "desktop"
                  ? "Native search is unavailable or offline. Manual entry works now."
                  : platform.capabilities.liveSearch
                    ? "The optional web search service is unavailable. Manual entry works now."
                    : "Static Pages has no live provider service. Manual entry works now."
                : health.fixtureMode
                  ? "Live search is disabled because the configured service is not a live provider."
                  : !health.liveSearchConfigured
                    ? "Live search is not configured. Manual entry works now."
                    : !paidCallsReady
                      ? desktopBudgetExhausted ||
                        health.paidPolicyState === "exhausted" ||
                        providerStatus?.state === "quota_exhausted"
                        ? "Live search budget is exhausted. No provider request can start until the approved budget period or ceiling changes."
                        : "Live search paid calls are disabled. Configure and validate the protected credential, then enable an explicit budget."
                      : health.liveSearchConfigured
                        ? platform.kind === "desktop"
                          ? "Live search ready: native provider, Australian region, AUD and rate limited."
                          : "Live search ready: own-origin service, configured Australian location, AUD, rate limited and cache controlled."
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

      {loading && liveSearchReady && (
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
                : "The web search service"}{" "}
              is resolving the request. Product discovery and merchant-offer
              retrieval remain separate so a Shopping product tile is never
              mislabelled as a competitor offer.
            </p>
          </div>
        </section>
      )}

      {!loading && outcome === null && (
        <EmptyState
          title={
            liveSearchReady
              ? "Type a product and search live provider evidence"
              : !liveSearchSourceEnabled
                ? "Live API source is disabled"
                : "Manual competitor evidence remains available"
          }
          detail={
            liveSearchReady
              ? "Search by part number, barcode or description. First select the exact product candidate; the application then retrieves direct merchant offers and compares only offers with a supported total-price basis. GST remains unverified unless evidence establishes it."
              : !liveSearchSourceEnabled
                ? "Enable the licensed live API source in Source registry before searching. No provider request is made while it is disabled."
                : "Static Pages is provider-free and session-only. Record an observed price through the manual form below; no Node service or provider request is used."
          }
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

      {!loading && outcome?.state === "selection_required" && (
        <ProductCandidates
          candidates={outcome.candidates}
          loading={loading || !liveSearchReady}
          onCompare={(candidate) => void runSearch(candidate.token)}
          onOpenProduct={(url) => void openSource(url)}
        />
      )}

      {!loading && outcome?.state === "empty" && (
        <EmptyState
          title={`No usable product candidates found for “${submitted}”`}
          detail="The provider returned no supported product candidates in the observed Shopping sections. This is not a claim that no competitor sells the product. Try an exact part number, brand and model, or record verified evidence manually below."
        />
      )}

      {!loading &&
        outcome?.selectedProduct &&
        ["ok", "no_comparable_offers"].includes(outcome.state) && (
          <section className="card" aria-labelledby="selected-product-title">
            <h2 id="selected-product-title">Selected exact product</h2>
            <dl className="kv">
              <dt>Search query</dt>
              <dd>{outcome.query}</dd>
              <dt>Product</dt>
              <dd>{outcome.selectedProduct.title}</dd>
              <dt>Brand</dt>
              <dd>{outcome.selectedProduct.brand ?? "not supplied"}</dd>
              <dt>Provider product ID</dt>
              <dd>{outcome.selectedProduct.productId ?? "not supplied"}</dd>
            </dl>
            <p className="hint">
              Every merchant row below belongs to this operator-selected product
              cluster. Discovery prices were not used as merchant offers.
            </p>
          </section>
        )}

      {!loading && outcome?.state === "no_comparable_offers" && (
        <>
          <EmptyState
            title={
              outcome.results.length === 0
                ? "No merchant-store offers were returned for the selected product"
                : "Merchant offers were observed, but none had a safe comparison basis"
            }
            detail={
              outcome.results.length === 0
                ? "The selected product was valid, but the bounded Immersive Product response contained no supported direct merchant rows. This is not evidence that no merchant sells it."
                : "The offers remain visible below as evidence. Financing, used condition, unknown shipping or an incomplete provider total can exclude an offer from the delivered-total band."
            }
          />
          {outcome.results.length > 0 && (
            <ResultsTable
              results={outcome.results}
              attachEnabled={attachEnabled}
              onAttach={attach}
              onOpenSource={(url) => void openSource(url)}
            />
          )}
        </>
      )}

      {!loading && outcome?.state === "ok" && outcome.band && (
        <>
          <div
            className="metric-row"
            role="group"
            aria-label="Observed delivered-total band across comparable merchant offers"
          >
            <div className="metric-card">
              <span className="metric-label">Lowest observed total</span>
              <strong className="metric-value">
                {formatAmount(outcome.band.lowest)}
              </strong>
              <span className="metric-state pill pill-ok">
                comparable basis, GST unverified
              </span>
            </div>
            <div className="metric-card">
              <span className="metric-label">Median observed total</span>
              <strong className="metric-value">
                {formatAmount(outcome.band.median)}
              </strong>
              <span className="metric-state">
                of {outcome.band.pricedResults} comparable offers
              </span>
            </div>
            <div className="metric-card">
              <span className="metric-label">Highest observed total</span>
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
              <span className="metric-label">Merchant sources</span>
              <strong className="metric-value">
                {outcome.coverage?.sourcesWithPrice ?? 0}
              </strong>
              <span className="metric-state">
                {outcome.cached
                  ? "served from application cache"
                  : "provider cache status not asserted"}
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
              <dt>Merchant domains with an observed price</dt>
              <dd>{outcome.coverage?.sourceDomains.join(", ") || "none"}</dd>
              <dt>Non-live sources with no stored match</dt>
              <dd>
                {storedOutcome.sourcesWithoutResults.length > 0
                  ? `${storedOutcome.sourcesWithoutResults.join(", ")} (stored evidence)`
                  : "none of the registered evidence sources"}
              </dd>
              <dt>Candidates in this response</dt>
              <dd>{outcome.coverage?.providerCandidates ?? 0}</dd>
              <dt>Parsed merchant offers</dt>
              <dd>
                {outcome.coverage?.parsedOffers ?? outcome.results.length}
              </dd>
              <dt>Comparable / excluded offers</dt>
              <dd>
                {outcome.coverage?.comparableOffers ?? 0} /{" "}
                {outcome.coverage?.excludedOffers ?? 0}
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
            Observed shipping (AUD)
            <input
              value={entry.shipping}
              onChange={(e) => setEntry({ ...entry, shipping: e.target.value })}
              inputMode="decimal"
              aria-invalid={entry.shipping !== "" && !entryShipping.ok}
              placeholder="Enter 0 only when the source states free shipping"
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
              aria-invalid={entry.url !== "" && !entryUrlValid}
              placeholder="https://…"
              required
            />
          </label>
          <label>
            Observed stock status
            <select
              value={entry.stockStatus}
              onChange={(e) =>
                setEntry({
                  ...entry,
                  stockStatus: e.target
                    .value as CompetitorObservation["stockStatus"],
                })
              }
            >
              <option value="unknown">Unknown</option>
              <option value="in-stock">In stock</option>
              <option value="out-of-stock">Out of stock</option>
            </select>
          </label>
          <label>
            Observed condition
            <select
              value={entry.condition}
              onChange={(e) =>
                setEntry({
                  ...entry,
                  condition: e.target
                    .value as CompetitorObservation["condition"],
                })
              }
            >
              <option value="unknown">Unknown</option>
              <option value="new">New</option>
              <option value="used">Used or refurbished</option>
            </select>
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
          A source URL, explicit shipping amount and stated pack are required.
          Manual observations are always quarantined with product and pack
          matching unconfirmed; they never become accepted comparison evidence
          merely because they were typed here. Neither path writes to a cost or
          sell price, directly or indirectly.
        </p>
      </section>
    </Page>
  );
}

const ACCESS_LABELS: Record<string, string> = {
  "live-api": "Licensed provider API",
  "manual-entry": "Manual entry",
  "file-import": "Legacy file-import record (not available)",
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
              ? "Performed by the native Rust service through an exact allowlisted licensed shopping-search API. Native requests are rate limited and do not claim a response cache."
              : platform.capabilities.liveSearch
                ? "Performed by the Node web service through a licensed shopping-search API. Requests are rate limited, cached and identify the client honestly."
                : "Static Pages has no Node service and performs no live provider retrieval."}{" "}
            Retailer websites are never scraped directly; robots.txt, site
            terms, rate limits and bot protections are never circumvented.
          </dd>
          <dt>Fallback paths</dt>
          <dd>
            Manual entry. A source that cannot be supported lawfully or reliably
            is disabled here and says why, instead of failing silently. Bulk
            evidence-file import is not available in this release.
          </dd>
        </dl>
      </section>
    </Page>
  );
}
