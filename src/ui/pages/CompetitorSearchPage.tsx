import { useMemo, useState } from 'react';
import type { CompetitorObservation } from '../../core/competitors';
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

/**
 * Competitor product search: one query across every enabled source of stored
 * evidence, with the price band, explicit coverage gaps, manual entry and
 * attach-as-reference. Fully usable on an empty database via manual entry.
 * Search runs locally and synchronously; there is no remote fetching.
 */
export function CompetitorsPage() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const actions = useActions();
  const [query, setQuery] = useState('');
  const [attachTarget, setAttachTarget] = useState('');

  // Manual entry fallback: works before any data is imported.
  const manualSources = state.competitorSources.filter((s) => s.enabled);
  const [entry, setEntry] = useState({
    sku: '',
    price: '',
    gstBasis: 'inc-gst' as CompetitorObservation['gstBasis'],
    sourceId: manualSources[0]?.id ?? 'manual',
    url: '',
    packSize: 'each',
  });
  const entryPrice = parseMoney(entry.price);
  const entryValid = entry.sku.trim() !== '' && entryPrice.ok;

  const outcome = useMemo(
    () => searchEvidence(state.competitorEvidence, state.competitorSources, query),
    [state.competitorEvidence, state.competitorSources, query],
  );
  const band = priceBand(outcome.results);
  const rows = state.comparison?.rows ?? [];
  const attachRow = rows.find(
    (r) => r.s8?.itemNumber === attachTarget.trim() || r.supplier?.code === attachTarget.trim(),
  );

  return (
    <Page title="Competitor search">
      <section className="card">
        <div className="form-grid">
          <label>
            Search all sources
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Product, part number, SKU, brand or barcode"
            />
          </label>
        </div>
        <p className="result-count" role="status">
          {query.trim() === ''
            ? `${state.competitorEvidence.length} stored observation(s) across ${manualSources.length} enabled source(s). Type to search.`
            : `${outcome.results.length} result(s) for ${outcome.queryKind === 'part-number' ? 'part number' : 'free text'} “${query.trim()}”`}
        </p>
      </section>

      {band && (
        <section className="card">
          <h2>Price band (AUD ex GST, shipping included)</h2>
          <div className="ops-grid">
            <div className="ops-card">
              <strong className="num">{formatAmount(band.lowest)}</strong>
              <span>Lowest</span>
            </div>
            <div className="ops-card">
              <strong className="num">{formatAmount(band.median)}</strong>
              <span>Median</span>
            </div>
            <div className="ops-card">
              <strong className="num">{formatAmount(band.highest)}</strong>
              <span>Highest</span>
            </div>
            <div className="ops-card">
              <strong className="num">{band.sourceCount}</strong>
              <span>Sources with a price</span>
            </div>
          </div>
        </section>
      )}

      {query.trim() !== '' && outcome.results.length === 0 && (
        <EmptyState
          title="No stored evidence matches this search"
          detail="No enabled source holds a matching observation. Add the price you found using manual entry below, or import evidence on the supplier side."
        />
      )}

      {outcome.results.length > 0 && (
        <div
          className="table-scroll"
          role="region"
          aria-label="Competitor search results"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th scope="col">SKU / product</th>
                <th scope="col">Price</th>
                <th scope="col">GST</th>
                <th scope="col">Unit / pack</th>
                <th scope="col">Source</th>
                <th scope="col">Retrieved (Melbourne time)</th>
                <th scope="col">Link</th>
                <th scope="col">Attach</th>
              </tr>
            </thead>
            <tbody>
              {outcome.results.map((result, index) => {
                const o = result.observation;
                return (
                  <tr key={`${o.sku}-${o.sourceName}-${o.observedAt}-${index}`}>
                    <td className="mono">{o.sku}</td>
                    <td className="num">
                      {(() => {
                        const parsed = parseMoney(o.price);
                        return parsed.ok ? formatAmount(parsed.amount) : o.price;
                      })()}
                      {result.normalisedEx !== null && (
                        <span className="hint"> · {formatAmount(result.normalisedEx)} ex GST</span>
                      )}
                    </td>
                    <td>{GST_LABELS[o.gstBasis]}</td>
                    <td>{o.packSize ?? 'not stated'}</td>
                    <td>{o.sourceName}</td>
                    <td>{retrievedLabel(o.observedAt)}</td>
                    <td>
                      {o.url ? (
                        <a href={o.url} target="_blank" rel="noreferrer noopener">
                          Source page
                        </a>
                      ) : (
                        'none'
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={attachRow === undefined}
                        onClick={() => {
                          if (attachRow === undefined) return;
                          dispatch({
                            type: 'reference-attached',
                            reference: {
                              rowId: attachRow.id,
                              observation: o,
                              attachedAt: new Date().toISOString(),
                            },
                          });
                          actions.announce(
                            `Reference price attached to ${attachTarget.trim()}. No cost or sell price changed.`,
                          );
                        }}
                      >
                        Attach as reference
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {query.trim() !== '' && (
        <section className="card">
          <h2>Coverage</h2>
          <dl className="kv">
            <dt>Sources with no result</dt>
            <dd>{outcome.sourcesWithoutResults.join(', ') || 'none'}</dd>
            <dt>Disabled sources (see Source registry)</dt>
            <dd>{outcome.disabledSources.join(', ') || 'none'}</dd>
            <dt>Automated retrieval</dt>
            <dd>
              Off for every source: this application performs no live fetching or scraping. Evidence
              is entered manually or imported from operator-provided files.
            </dd>
          </dl>
        </section>
      )}

      <section className="card">
        <h2>Attach target</h2>
        <div className="form-grid">
          <label>
            Catalogue item (ServiceM8 item number or supplier code)
            <input
              value={attachTarget}
              onChange={(e) => setAttachTarget(e.target.value)}
              placeholder={rows.length === 0 ? 'Run a comparison first' : 'e.g. LW4570'}
              disabled={rows.length === 0}
            />
          </label>
        </div>
        <p className="hint" role="status">
          {rows.length === 0
            ? 'No catalogue loaded: attach becomes available after a comparison runs. Search and manual entry work now.'
            : attachTarget.trim() === ''
              ? `${state.references.length} reference(s) attached this session. Enter an item to enable Attach.`
              : attachRow
                ? `Attach enabled for ${attachTarget.trim()}. Attaching stores the price, source and timestamp for reference only; it never changes a cost or sell price.`
                : `No catalogue item matches “${attachTarget.trim()}”.`}
        </p>
      </section>

      <section className="card">
        <h2>Manual entry</h2>
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
              setQuery(entry.sku.trim());
              actions.announce(`Stored ${entry.sku.trim()} from ${observation.sourceName}.`);
            }}
          >
            Store observation
          </button>
        </div>
        <p className="hint">
          Stored evidence stays in this session only and is reference information: it never writes
          to a cost or a sell price, directly or indirectly.
        </p>
      </section>
    </Page>
  );
}

/**
 * Source registry: every competitor or supplier source, how it is accessed,
 * and an enable/disable toggle. Fully usable on an empty database.
 */
export function SourcesPage() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const actions = useActions();
  return (
    <Page title="Source registry">
      <div className="table-scroll" role="region" aria-label="Registered sources" tabIndex={0}>
        <table>
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Access method</th>
              <th scope="col">Automated access</th>
              <th scope="col">State</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {state.competitorSources.map((source) => (
              <tr key={source.id}>
                <td>{source.name}</td>
                <td>{source.accessMethod === 'manual-entry' ? 'Manual entry' : 'File import'}</td>
                <td>{source.automatedAccessNote}</td>
                <td>
                  <span
                    className={source.enabled ? 'badge badge-unchanged' : 'badge badge-invalid'}
                  >
                    {source.enabled ? 'enabled' : 'disabled'}
                  </span>
                </td>
                <td>
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
          <dt>Live fetching and scraping</dt>
          <dd>
            Not performed for any source. The production build ships connect-src 'none'; robots.txt,
            site terms, rate limits and bot protections are never circumvented.
          </dd>
          <dt>Lawful path</dt>
          <dd>
            Manual entry and operator-provided file import. A source that cannot be supported
            lawfully or reliably is disabled here and says why, instead of failing silently.
          </dd>
          <dt>Official APIs</dt>
          <dd>
            Preferred when a supplier offers one; none is integrated yet, so no source claims it.
          </dd>
        </dl>
      </section>
    </Page>
  );
}
