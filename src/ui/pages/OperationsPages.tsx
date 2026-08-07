import { useEffect, useMemo, useState } from 'react';
import { fetchPriceHistory, type PriceHistoryVersion } from '../../core/liveSearch';
import { applyMarkup, CURRENCY, parseMoney, ROUNDING_RULE_LABEL } from '../../core/money';
import { BarChart, LineChart, type ChartSeries } from '../Charts';
import { buildApprovalProposals, buildRunMetadata, deriveExceptions } from '../../core/operations';
import { isExcludable, STATUS_LABELS } from '../../core/statuses';
import { triggerDownload } from '../../io/download';
import { useAppDispatch, useAppState } from '../../state/store';
import { useActions } from '../../state/useActions';
import { StatusBadge } from '../StatusBadge';
import { EmptyState, OperationalList, Page } from './PageChrome';

const MONTH_LABEL = new Intl.DateTimeFormat('en-AU', { month: 'short', year: '2-digit' });

/** Average sell and cost per calendar month from persisted price history. */
function historySeries(history: PriceHistoryVersion[]): ChartSeries[] {
  const byMonth = new Map<number, { costCents: number[]; sellCents: number[] }>();
  for (const version of history) {
    const at = new Date(version.recordedAt);
    if (Number.isNaN(at.getTime())) continue;
    const key = new Date(at.getFullYear(), at.getMonth(), 1).getTime();
    const bucket = byMonth.get(key) ?? { costCents: [], sellCents: [] };
    bucket.costCents.push(version.costCents);
    bucket.sellCents.push(version.sellPriceCents);
    byMonth.set(key, bucket);
  }
  const months = [...byMonth.entries()].sort((a, b) => a[0] - b[0]);
  const avg = (values: number[]) =>
    Math.round(values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length));
  return [
    {
      label: 'Avg sell',
      points: months.map(([x, b]) => ({ x, y: avg(b.sellCents) / 100 })),
    },
    {
      label: 'Avg cost',
      points: months.map(([x, b]) => ({ x, y: avg(b.costCents) / 100 })),
    },
  ];
}

/** Distribution of latest sell prices across brackets. */
function priceBuckets(history: PriceHistoryVersion[]) {
  const latest = new Map<string, PriceHistoryVersion>();
  for (const version of history) {
    const existing = latest.get(version.itemId);
    if (!existing || version.recordedAt > existing.recordedAt) latest.set(version.itemId, version);
  }
  const brackets = [
    ['Under $25', 0, 2500],
    ['$25-$75', 2500, 7500],
    ['$75-$150', 7500, 15000],
    ['$150-$250', 15000, 25000],
    ['$250+', 25000, Number.MAX_SAFE_INTEGER],
  ] as const;
  return brackets.map(([label, lo, hi]) => ({
    label,
    count: [...latest.values()].filter((v) => v.sellPriceCents >= lo && v.sellPriceCents < hi)
      .length,
  }));
}

export function DashboardPage({ go }: { go: (route: string) => void }) {
  const state = useAppState();
  const rows = state.comparison?.rows ?? [];
  const decisions = Object.values(state.review.decisions);
  const [history, setHistory] = useState<PriceHistoryVersion[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchPriceHistory().then((versions) => {
      if (!cancelled) setHistory(versions);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const series = useMemo(() => historySeries(history ?? []), [history]);
  const buckets = useMemo(() => priceBuckets(history ?? []), [history]);
  const hasHistory = (history?.length ?? 0) > 0;
  const changed = rows.filter((r) => r.status === 'price-changed').length;
  const blocked = rows.filter((r) => r.status === 'ambiguous' || r.status === 'invalid').length;
  const approved = decisions.filter((d) => d.state === 'approved').length;

  const cards = [
    {
      label: 'Changed awaiting review',
      value: changed,
      route: '#/approvals',
      state: changed > 0 ? 'attention' : 'ok',
      note: changed > 0 ? 'needs review' : 'nothing waiting',
    },
    {
      label: 'New items proposed',
      value: rows.filter((r) => r.status === 'new-item').length,
      route: '#/approvals',
      state: 'ok',
      note: 'require explicit approval',
    },
    {
      label: 'Blocking exceptions',
      value: blocked,
      route: '#/exceptions',
      state: blocked > 0 ? 'error' : 'ok',
      note: blocked > 0 ? 'blocked from import' : 'all clear',
    },
    {
      label: 'Approved for import',
      value: approved,
      route: '#/exports',
      state: 'ok',
      note: approved > 0 ? 'ready to export' : 'none yet',
    },
    {
      label: 'Price versions on record',
      value: history?.length ?? 0,
      route: '#/runs',
      state: 'ok',
      note: hasHistory ? 'append-only history' : 'server not seeded',
    },
    {
      label: 'Saved supplier profiles',
      value: state.profiles.length,
      route: '#/suppliers',
      state: 'ok',
      note: 'stored in this browser',
    },
  ];

  return (
    <Page
      title="Dashboard"
      primary={
        <button type="button" className="btn btn-primary" onClick={() => go('#/new-run')}>
          Start a comparison
        </button>
      }
    >
      <div className="metric-row" role="group" aria-label="Key metrics">
        {cards.map((card) => (
          <button
            key={card.label}
            type="button"
            className="metric-card metric-link"
            onClick={() => go(card.route)}
          >
            <span className="metric-label">{card.label}</span>
            <strong className="metric-value">{card.value}</strong>
            <span
              className={`metric-state pill ${
                card.state === 'error'
                  ? 'pill-error'
                  : card.state === 'attention'
                    ? 'pill-warn'
                    : 'pill-ok'
              }`}
            >
              {card.note}
            </span>
          </button>
        ))}
      </div>

      {hasHistory ? (
        <div className="chart-row">
          <section className="card">
            <LineChart
              series={series}
              title="Average cost and sell price over time (AUD, from persisted price history)"
              formatY={(y) => `$${Math.round(y)}`}
              formatX={(x) => MONTH_LABEL.format(new Date(x))}
            />
          </section>
          <section className="card">
            <BarChart
              buckets={buckets}
              title="Catalogue items by current sell price bracket"
              unit="items"
            />
          </section>
        </div>
      ) : (
        <EmptyState
          title={history === null ? 'Loading price history…' : 'No persisted price history yet'}
          detail="The dashboard charts draw from the server's append-only price history. Seed fictional sample data with `npm run seed` (then refresh), or publish approved price versions through a run. If the server is not running, start it with `npm run server`."
        />
      )}

      {state.comparison === null && (
        <EmptyState
          title="No run in progress"
          detail="Import a supplier price file and the current ServiceM8 export to compare costs, review proposed prices and produce a candidate import file. Business rows stay in this browser."
          action={
            <div className="btn-row">
              <button type="button" className="btn btn-primary" onClick={() => go('#/new-run')}>
                Start a run
              </button>
            </div>
          }
        />
      )}
    </Page>
  );
}

export function PricingRulesPage() {
  const state = useAppState();
  const [cost, setCost] = useState('100.00');
  const parsed = parseMoney(cost);
  const markup = state.settings.markupPercent;
  const proposed = parsed.ok ? applyMarkup(parsed.amount, markup) : null;
  return (
    <Page title="Pricing rules">
      <section className="card">
        <h2>Active rule</h2>
        <dl className="kv">
          <dt>Strategy</dt>
          <dd>Markup on cost (not gross margin)</dd>
          <dt>Markup</dt>
          <dd>{markup}% — change it in Settings with confirmation; the change is audit-logged</dd>
          <dt>Rounding</dt>
          <dd>{ROUNDING_RULE_LABEL}</dd>
          <dt>Tax (GST)</dt>
          <dd>Never inferred or altered; the selected handling is recorded in the audit report</dd>
        </dl>
      </section>
      <section className="card">
        <h2>Deterministic preview</h2>
        <div className="form-grid">
          <label>
            Supplier cost ({CURRENCY})
            <input
              value={cost}
              onChange={(event) => setCost(event.target.value)}
              inputMode="decimal"
              aria-invalid={!parsed.ok}
            />
          </label>
          <label>
            Proposed sell ({CURRENCY})
            <input readOnly value={proposed ?? 'Enter a valid cost'} />
          </label>
        </div>
        <p className={parsed.ok ? 'hint' : 'form-error'} role="status">
          {parsed.ok
            ? `${CURRENCY} ${parsed.amount} × ${(1 + Number(markup) / 100).toFixed(2)} = ${CURRENCY} ${proposed} (decimal-safe, ${ROUNDING_RULE_LABEL.toLowerCase()})`
            : parsed.error}
        </p>
      </section>
    </Page>
  );
}

export function ExceptionsPage() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const actions = useActions();
  const exceptions = deriveExceptions(state.comparison);
  const [query, setQuery] = useState('');
  const [reason, setReason] = useState('');
  const visible = exceptions.filter((e) =>
    `${e.type} ${e.product} ${e.reason}`.toLowerCase().includes(query.toLowerCase()),
  );
  const rowById = new Map((state.comparison?.rows ?? []).map((row) => [row.id, row]));

  if (state.comparison === null) {
    return (
      <Page title="Exceptions">
        <EmptyState
          title="No comparison data loaded"
          detail="Exceptions (ambiguous matches, invalid records and items missing from the supplier file) appear here after a comparison runs."
        />
      </Page>
    );
  }

  return (
    <Page title="Exceptions">
      <section className="card">
        <div className="form-grid">
          <label>
            Search exceptions
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Type, product or reason"
            />
          </label>
          <label>
            Exclusion reason (applied by the Exclude action)
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. superseded product line"
            />
          </label>
        </div>
        <p className="result-count" role="status">
          {visible.length} of {exceptions.length} exceptions shown
        </p>
      </section>
      {visible.length === 0 ? (
        <EmptyState
          title="No exceptions"
          detail="Every record classified cleanly, or the search filtered everything out."
        />
      ) : (
        <div className="table-scroll" role="region" aria-label="Exceptions" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Severity</th>
                <th scope="col">Product</th>
                <th scope="col">Reason</th>
                <th scope="col">Suggested resolution</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((exception) => {
                const row = rowById.get(exception.id);
                const decision = state.review.decisions[exception.id];
                const excludable = row !== undefined && isExcludable(row.status);
                return (
                  <tr key={exception.id}>
                    <td>{row ? <StatusBadge status={row.status} /> : exception.type}</td>
                    <td>{exception.severity}</td>
                    <td className="mono">{exception.product}</td>
                    <td>{exception.reason}</td>
                    <td>{exception.suggestedResolution}</td>
                    <td>
                      {decision?.state === 'excluded' ? (
                        <span className="badge badge-invalid">excluded</span>
                      ) : excludable ? (
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={reason.trim().length < 3}
                          onClick={() => {
                            dispatch({
                              type: 'exclude',
                              rowIds: [exception.id],
                              reason: reason.trim(),
                            });
                            actions.announce(`Excluded ${exception.product}: ${reason.trim()}`);
                          }}
                        >
                          Exclude with reason
                        </button>
                      ) : (
                        <span className="hint">Blocked or review-only</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint">
        Ambiguous and invalid records stay blocked from the import output. Resolve ambiguity by
        approving an alias or fixing the source file in the Review step, then re-run the comparison.
      </p>
    </Page>
  );
}

export function ApprovalsPage({ go }: { go: (route: string) => void }) {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const proposals = buildApprovalProposals(state.comparison, state.review.decisions);

  if (state.comparison === null) {
    return (
      <Page title="Approvals">
        <EmptyState
          title="Nothing to approve yet"
          detail="Proposed price changes and new items appear here after a comparison runs. Approval is an explicit local decision recorded in the audit report."
        />
      </Page>
    );
  }

  return (
    <Page
      title="Approvals"
      primary={
        <button type="button" className="btn" onClick={() => go('#/new-run')}>
          Open review workspace
        </button>
      }
    >
      {proposals.length === 0 ? (
        <EmptyState
          title="No proposals"
          detail="The comparison produced no price changes, new items or blocked records."
        />
      ) : (
        <div className="table-scroll" role="region" aria-label="Proposals" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Old sell</th>
                <th scope="col">Proposed sell</th>
                <th scope="col">Markup</th>
                <th scope="col">Reason</th>
                <th scope="col">Decision</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {proposals.map((proposal) => {
                const decision = state.review.decisions[proposal.id];
                return (
                  <tr key={proposal.id}>
                    <td>
                      {STATUS_LABELS[proposal.exceptionState as keyof typeof STATUS_LABELS] ??
                        proposal.exceptionState}
                    </td>
                    <td className="num">{proposal.oldValue || '-'}</td>
                    <td className="num">{proposal.proposedValue || 'blocked'}</td>
                    <td className="num">{proposal.markup}</td>
                    <td>{proposal.reason}</td>
                    <td>{decision?.state ?? 'pending'}</td>
                    <td>
                      {proposal.approvable ? (
                        decision?.state === 'approved' ? (
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() =>
                              dispatch({ type: 'clear-decision', rowIds: [proposal.id] })
                            }
                          >
                            Withdraw approval
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            onClick={() => dispatch({ type: 'approve', rowIds: [proposal.id] })}
                          >
                            Approve
                          </button>
                        )
                      ) : (
                        <span className="hint">Not approvable</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint">
        Approval only changes local proposal state. Nothing is sent anywhere: approved records are
        included in the exported candidate import file once every pre-export check passes.
      </p>
    </Page>
  );
}

export function RunsPage() {
  const state = useAppState();
  const actions = useActions();
  const metadata = useMemo(
    () =>
      buildRunMetadata({
        comparison: state.comparison,
        decisions: state.review.decisions,
        inputFilenames: [state.supplier.table?.fileName, state.servicem8.table?.fileName].filter(
          (n): n is string => Boolean(n),
        ),
        outputFilenames: state.outputs?.map((o) => o.filename) ?? [],
        profileName: state.activeProfileName,
        profileVersion: state.activeProfileVersion,
      }),
    [state],
  );
  return (
    <Page title="Runs">
      <section className="card">
        <h2>Current run</h2>
        <dl className="kv">
          <dt>Run identifier</dt>
          <dd className="mono">{metadata.id}</dd>
          <dt>Validation</dt>
          <dd>{metadata.validationOutcome}</dd>
          <dt>Input files</dt>
          <dd>{metadata.inputFilenames.join(', ') || 'none loaded'}</dd>
          <dt>Mapping profile</dt>
          <dd>
            {metadata.supplierProfile} v{metadata.mappingVersion}
          </dd>
          <dt>Approved / excluded</dt>
          <dd>
            {metadata.approvalTotals.approved} approved · {metadata.approvalTotals.excluded}{' '}
            excluded · {metadata.approvalTotals.importEligible} import-eligible
          </dd>
          <dt>Outputs generated</dt>
          <dd>{metadata.outputFilenames.join(', ') || 'none yet'}</dd>
        </dl>
        <div className="btn-row">
          <button
            type="button"
            className="btn"
            disabled={state.comparison === null}
            onClick={() => {
              const blob = new Blob([JSON.stringify(metadata, null, 2)], {
                type: 'application/json',
              });
              triggerDownload(blob, `${metadata.id}-run-metadata.json`);
              actions.announce('Run metadata downloaded as JSON.');
            }}
          >
            Download run metadata (JSON)
          </button>
        </div>
        <p className="hint">
          Run history is intentionally not persisted: business rows never leave the session. The
          exported audit summary is the durable record of each completed run.
        </p>
      </section>
    </Page>
  );
}

export function AuditPage() {
  const state = useAppState();
  return (
    <Page title="Audit">
      <OperationalList
        items={
          state.settingsChanges.length
            ? state.settingsChanges.map((entry) => `${entry.at}: ${entry.change}`)
            : [
                'No business-rule changes in this session.',
                'Markup and tax-handling changes are recorded here and in the exported audit summary.',
                'The exported audit summary also records file hashes, rules, totals and every operator decision.',
              ]
        }
      />
    </Page>
  );
}

export function HelpPage() {
  return (
    <Page title="Help">
      <OperationalList
        items={[
          'All business files stay in this browser or on this computer; nothing is transmitted.',
          'Workflow: Add files, Map columns, Validate and compare, Review, Pre-export checks, Export.',
          'Pricing: selling price = supplier cost x 1.30 (markup on cost), rounded half-up to 2 decimal places, AUD.',
          'Matching: exact code, then approved alias; description similarity only ever suggests, never matches.',
          'The ServiceM8 output is a candidate import file until validated against a genuine template.',
          'ServiceM8 and Xero are file-handoff integrations: see the Integrations page for the adapter status.',
          'On the Windows desktop application, exports can be written straight to a chosen output folder.',
          'Keyboard: press / to focus search from anywhere.',
        ]}
      />
    </Page>
  );
}
