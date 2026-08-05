import { useEffect, useMemo, useRef, useState } from 'react';
import type { CompetitorObservation } from '../../core/competitors';
import {
  centsToAud,
  fetchLiveHealth,
  fetchLiveSearch,
  postReference,
  type LiveHealth,
  type LiveSearchOutcome,
  type LiveSearchResult,
} from '../../core/liveSearch';
import { formatAmount, parseMoney } from '../../core/money';
import { priceBand, searchEvidence } from '../../core/sources';
import { useAppDispatch, useAppState } from '../../state/store';
import { useActions } from '../../state/useActions';
import { EmptyState, Page } from './PageChrome';

const MELBOURNE_TIME = new Intl.DateTimeFormat('en-AU', {
  timeZone: 'Australia/Melbourne',
  dateStyle: 'medium',
  timeStyle: 'short',
});

function retrievedLabel(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const ageHours = Math.max(0, Math.floor((Date.now() - at.getTime()) / 3600000));
  const age =
    ageHours < 1
      ? 'under 1 h ago'
      : ageHours < 48
        ? `${ageHours} h ago`
        : `${Math.floor(ageHours / 24)} d ago`;
  return `${MELBOURNE_TIME.format(at)} (${age})`;
}

const GST_LABELS: Record<CompetitorObservation['gstBasis'], string> = {
  'inc-gst': 'inc GST',
  'ex-gst': 'ex GST',
  unknown: 'GST unknown',
};

/** Distinct, visible copy for every non-result search state. Never one blank screen. */
const STATE_COPY: Record<
  string,
  { title: string; tone: 'info' | 'warn' | 'error'; detail: string }
> = {
  not_configured: {
    title: 'Live search is not configured',
    tone: 'warn',
    detail:
      'No provider API key is set. Copy .env.example to .env, set SERPAPI_KEY, and restart the server (npm run server). Manual entry below works now.',
  },
  timeout: {
    title: 'The search provider timed out',
    tone: 'error',
    detail:
      'The provider did not answer in time. This is a provider-side delay, not an empty result. Try again shortly, or record the price manually below.',
  },
  provider_error: {
    title: 'The search provider returned an error',
    tone: 'error',
    detail: 'The provider rejected or failed the request. This is a failure, not an empty result.',
  },
  quota_exhausted: {
    title: 'Provider quota is exhausted',
    tone: 'warn',
    detail:
      'The provider account has no searches left. No result could be retrieved. Top up the plan or wait for the quota window to reset.',
  },
  rate_limited: {
    title: 'Local rate limit reached',
    tone: 'warn',
    detail:
      'This application limits its own outbound searches. Wait about a minute and retry; cached results continue to work.',
  },
  server_unreachable: {
    title: 'The application server is not reachable',
    tone: 'error',
    detail:
      'Live search runs through this application’s own server, which did not respond. Start it with: npm run server. Manual entry below still works.',
  },
};

type SortKey = 'price' | 'seller' | 'title';

function ResultsTable({
  results,
  attachEnabled,
  onAttach,
}: {
  results: LiveSearchResult[];
  attachEnabled: boolean;
  onAttach: (result: LiveSearchResult) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>('price');
  const [ascending, setAscending] = useState(true);
  const sorted = useMemo(() => {
    const copy = [...results];
    copy.sort((a, b) => {
      const delta =
        sortKey === 'price'
          ? a.priceCents - b.priceCents
          : sortKey === 'seller'
            ? a.seller.localeCompare(b.seller)
            : a.title.localeCompare(b.title);
      return ascending ? delta : -delta;
    });
    return copy;
  }, [results, sortKey, ascending]);

  const header = (key: SortKey, label: string, numeric = false) => (
    <th scope="col" aria-sort={sortKey === key ? (ascending ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        className={`th-sort${numeric ? ' th-num' : ''}`}
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
          {sortKey === key ? (ascending ? '▴' : '▾') : ''}
        </span>
      </button>
    </th>
  );

  return (
    <div className="table-scroll" role="region" aria-label="Live search results" tabIndex={0}>
      <table className="data-table">
        <thead>
          <tr>
            {header('title', 'Product')}
            {header('price', 'Price (AUD)', true)}
            <th scope="col">GST</th>
            <th scope="col">Unit / pack</th>
            {header('seller', 'Seller')}
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
                <span className={`pill ${result.gstBasis === 'unknown' ? 'pill-warn' : 'pill-ok'}`}>
                  {GST_LABELS[result.gstBasis]}
                </span>
              </td>
              <td data-label="Unit / pack">{result.packSize ?? 'not stated'}</td>
              <td data-label="Seller">
                {result.seller}
                <span className="hint-block">{result.sourceDomain}</span>
              </td>
              <td data-label="Retrieved">{retrievedLabel(result.retrievedAt)}</td>
              <td data-label="Link">
                <a href={result.url} target="_blank" rel="noreferrer noopener">
                  Source page
                </a>
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
 * this application's own server and a licensed provider, plus stored local
 * evidence and manual entry as the fallback. Five distinct visual states:
 * idle, loading, results, no results, provider unavailable.
 */
export function CompetitorsPage() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const actions = useActions();
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState<LiveSearchOutcome | null>(null);
  const [health, setHealth] = useState<LiveHealth | null>(null);
  const [attachTarget, setAttachTarget] = useState('');
  const requestSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void fetchLiveHealth().then((h) => {
      if (!cancelled) setHealth(h);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const runSearch = async () => {
    const q = query.trim();
    if (q === '') return;
    const seq = ++requestSeq.current;
    setSubmitted(q);
    setLoading(true);
    const result = await fetchLiveSearch(q);
    if (seq !== requestSeq.current) return;
    setOutcome(result);
    setLoading(false);
    actions.announce(
      result.state === 'ok'
        ? `${result.results.length} live results for ${q}.`
        : `Live search state: ${result.state.replace(/_/g, ' ')}.`,
    );
  };

  const attachRow = (state.comparison?.rows ?? []).find(
    (r) => r.s8?.itemNumber === attachTarget.trim() || r.supplier?.code === attachTarget.trim(),
  );
  const attachEnabled = attachTarget.trim() !== '';

  const attach = (result: LiveSearchResult) => {
    const itemId = attachTarget.trim();
    const observation: CompetitorObservation = {
      sku: itemId,
      sourceName: result.seller,
      approvedSource: true,
      observedAt: result.retrievedAt,
      price: result.priceAud,
      currency: 'AUD',
      gstBasis: result.gstBasis,
      shipping: '0',
      stockStatus: 'unknown',
      condition: 'new',
      packCompatible: true,
      productOnly: true,
      matchConfidence: 0.9,
      reviewState: 'accepted',
      url: result.url,
      ...(result.packSize ? { packSize: result.packSize } : {}),
    };
    if (attachRow) {
      dispatch({
        type: 'reference-attached',
        reference: { rowId: attachRow.id, observation, attachedAt: new Date().toISOString() },
      });
    }
    void postReference(itemId, result).then((persisted) => {
      actions.announce(
        persisted
          ? `Reference price stored for ${itemId} on the server. No cost or sell price changed.`
          : `Reference attached for ${itemId} in this session. Server persistence unavailable.`,
      );
    });
  };

  // Stored local evidence (manual entries and imports) still searches inline.
  const manualSources = state.competitorSources.filter(
    (s) => s.enabled && s.accessMethod !== 'live-api',
  );
  const storedOutcome = useMemo(
    () => searchEvidence(state.competitorEvidence, state.competitorSources, submitted),
    [state.competitorEvidence, state.competitorSources, submitted],
  );
  const storedBand = priceBand(storedOutcome.results);

  const [entry, setEntry] = useState({
    sku: '',
    price: '',
    gstBasis: 'inc-gst' as CompetitorObservation['gstBasis'],
    sourceId: 'manual',
    url: '',
    packSize: 'each',
  });
  const entryPrice = parseMoney(entry.price);
  const entryValid = entry.sku.trim() !== '' && entryPrice.ok;

  const failureCopy = outcome && STATE_COPY[outcome.state];

  return (
    <Page
      title="Competitor search"
      lead="Search the live market for any product and keep every price as reference evidence."
      primary={
        <button
          type="button"
          className="btn btn-primary"
          disabled={query.trim() === '' || loading}
          onClick={() => void runSearch()}
        >
          Search live prices
        </button>
      }
    >
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
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. Lockwood 4570, LW4570 or 9312345678907"
            />
          </label>
        </form>
        <p className="hint" role="status">
          {health === null
            ? 'Checking live search availability…'
            : health.fixtureMode
              ? 'Fixture provider active: deterministic offline results for testing and demos.'
              : health.liveSearchConfigured
                ? 'Live search ready: server-side provider, Australian region, AUD, rate limited and cached.'
                : 'Live search is NOT configured: set SERPAPI_KEY on the server (.env.example shows how). Manual entry works now.'}
        </p>
      </section>

      {loading && (
        <section className="card state-loading" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <div>
            <h2>Searching live sources for &ldquo;{submitted}&rdquo;&hellip;</h2>
            <p className="hint">
              The server is querying the provider now. Results include seller, GST treatment and a
              retrieval timestamp.
            </p>
          </div>
        </section>
      )}

      {!loading && outcome === null && (
        <EmptyState
          title="Type a product and search the live market"
          detail="One box, no search-type selector: the server works out whether the query is a part number, barcode or free text. Results arrive with an AUD price band, GST treatment, seller, retrieval time and a working source link. Nothing needs importing first."
        />
      )}

      {!loading && outcome !== null && failureCopy && (
        <section className={`card state-banner state-${failureCopy.tone}`} role="alert">
          <h2>{failureCopy.title}</h2>
          <p>{failureCopy.detail}</p>
          {outcome.detail && <p className="hint">Server detail: {outcome.detail}</p>}
        </section>
      )}

      {!loading && outcome?.state === 'empty' && (
        <EmptyState
          title={`No live prices found for “${submitted}”`}
          detail="The provider answered but returned no priced listings. That is a genuine zero, not a failure. Try a broader term, or record a price you found yourself with manual entry below."
        />
      )}

      {!loading && outcome?.state === 'ok' && outcome.band && (
        <>
          <div className="metric-row" role="group" aria-label="Price band across live sources">
            <div className="metric-card">
              <span className="metric-label">Lowest</span>
              <strong className="metric-value">{formatAmount(outcome.band.lowest)}</strong>
              <span className="metric-state pill pill-ok">across live sources</span>
            </div>
            <div className="metric-card">
              <span className="metric-label">Median</span>
              <strong className="metric-value">{formatAmount(outcome.band.median)}</strong>
              <span className="metric-state">of {outcome.band.pricedResults} priced results</span>
            </div>
            <div className="metric-card">
              <span className="metric-label">Highest</span>
              <strong className="metric-value">{formatAmount(outcome.band.highest)}</strong>
              <span className="metric-state">
                spread{' '}
                {formatAmount(centsToAud(outcome.band.highestCents - outcome.band.lowestCents))}
              </span>
            </div>
            <div className="metric-card">
              <span className="metric-label">Sources responding</span>
              <strong className="metric-value">{outcome.coverage?.sourcesWithPrice ?? 0}</strong>
              <span className="metric-state">
                {outcome.cached ? 'served from cache' : 'fresh retrieval'}
              </span>
            </div>
          </div>

          <ResultsTable results={outcome.results} attachEnabled={attachEnabled} onAttach={attach} />

          <section className="card">
            <h2>Coverage</h2>
            <dl className="kv">
              <dt>Provider queried</dt>
              <dd>
                {outcome.provider} ({outcome.queryKind} query
                {outcome.cached ? ', cached response' : ''})
              </dd>
              <dt>Source domains with a price</dt>
              <dd>{outcome.coverage?.sourceDomains.join(', ') || 'none'}</dd>
              <dt>Sources returning nothing this search</dt>
              <dd>
                {storedOutcome.sourcesWithoutResults.length > 0
                  ? `${storedOutcome.sourcesWithoutResults.join(', ')} (stored evidence)`
                  : 'none of the registered evidence sources'}
              </dd>
              <dt>Failed sources</dt>
              <dd>
                none this search; provider failures are shown as their own state, never hidden
              </dd>
              <dt>Retrieved</dt>
              <dd>{outcome.retrievedAt ? retrievedLabel(outcome.retrievedAt) : 'unknown'}</dd>
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
          {attachTarget.trim() === ''
            ? `${state.references.length} reference(s) attached this session. Enter an item to enable Attach.`
            : `Attach enabled for ${attachTarget.trim()}. Attaching stores price, source and timestamp as reference only; it never changes a cost or sell price (enforced and tested server-side).`}
        </p>
      </section>

      {submitted !== '' && storedOutcome.results.length > 0 && (
        <section className="card">
          <h2>Stored local evidence matching &ldquo;{submitted}&rdquo;</h2>
          <p className="hint">
            {storedOutcome.results.length} stored observation(s)
            {storedBand
              ? ` · band ${formatAmount(storedBand.lowest)} to ${formatAmount(storedBand.highest)} ex GST`
              : ''}
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
              aria-invalid={entry.price !== '' && !entryPrice.ok}
            />
          </label>
          <label>
            GST basis
            <select
              value={entry.gstBasis}
              onChange={(e) =>
                setEntry({
                  ...entry,
                  gstBasis: e.target.value as CompetitorObservation['gstBasis'],
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
            onClick={() => {
              if (!entryPrice.ok) return;
              const source = manualSources.find((s) => s.id === entry.sourceId);
              const observation: CompetitorObservation = {
                sku: entry.sku.trim(),
                sourceName: source?.name ?? 'Manual operator entry',
                approvedSource: true,
                observedAt: new Date().toISOString(),
                price: entryPrice.amount,
                currency: 'AUD',
                gstBasis: entry.gstBasis,
                shipping: '0',
                stockStatus: 'unknown',
                condition: 'new',
                packCompatible: true,
                productOnly: true,
                matchConfidence: 1,
                reviewState: 'accepted',
                ...(entry.url.trim() ? { url: entry.url.trim() } : {}),
                ...(entry.packSize.trim() ? { packSize: entry.packSize.trim() } : {}),
              };
              dispatch({ type: 'evidence-added', observations: [observation] });
              setSubmitted(entry.sku.trim());
              actions.announce(`Stored ${entry.sku.trim()} from ${observation.sourceName}.`);
            }}
          >
            Store observation
          </button>
        </div>
        <p className="hint">
          Stored evidence is reference information: it never writes to a cost or a sell price,
          directly or indirectly.
        </p>
      </section>
    </Page>
  );
}

const ACCESS_LABELS: Record<string, string> = {
  'live-api': 'Live API (server-side)',
  'manual-entry': 'Manual entry',
  'file-import': 'File import',
};

/** Source registry: every source, how it is accessed, and an enable toggle. */
export function SourcesPage() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const actions = useActions();
  return (
    <Page title="Source registry" lead="Where competitor evidence comes from, honestly stated.">
      <div className="table-scroll" role="region" aria-label="Registered sources" tabIndex={0}>
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
                <td data-label="How access works">{source.automatedAccessNote}</td>
                <td data-label="State">
                  <span className={source.enabled ? 'pill pill-ok' : 'pill pill-error'}>
                    {source.enabled ? 'enabled' : 'disabled'}
                  </span>
                </td>
                <td data-label="Action">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      dispatch({ type: 'source-toggled', sourceId: source.id });
                      actions.announce(
                        `${source.name} ${source.enabled ? 'disabled' : 'enabled'}.`,
                      );
                    }}
                  >
                    {source.enabled ? 'Disable' : 'Enable'}
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
            Performed server-side through a licensed shopping-search API only, rate limited and
            cached, identifying the client honestly. Retailer websites are never scraped directly;
            robots.txt, site terms, rate limits and bot protections are never circumvented.
          </dd>
          <dt>Fallback paths</dt>
          <dd>
            Manual entry and operator-provided file import. A source that cannot be supported
            lawfully or reliably is disabled here and says why, instead of failing silently.
          </dd>
        </dl>
      </section>
    </Page>
  );
}
