import { useEffect, useMemo, useState } from 'react';
import type { PriceHistoryVersion } from '../../platform/contracts';
import { applyMarkup, CURRENCY, parseMoney, ROUNDING_RULE_LABEL } from '../../core/money';
import { BarChart, LineChart, type ChartSeries } from '../Charts';
import { buildApprovalProposals, buildRunMetadata, deriveExceptions } from '../../core/operations';
import { datePrefix } from '../../core/run';
import { isExcludable, STATUS_LABELS } from '../../core/statuses';
import { triggerDownload } from '../../io/download';
import { useAppDispatch, useAppState } from '../../state/store';
import { useActions } from '../../state/useActions';
import { usePlatform } from '../../platform/context';
import { ConfirmDialog } from '../ConfirmDialog';
import { Dialog } from '../Dialog';
import { StatusBadge } from '../StatusBadge';
import { EmptyState, Page, Panel } from './PageChrome';

const MONTH_LABEL = new Intl.DateTimeFormat('en-AU', {
  month: 'short',
  year: '2-digit',
});

/** Average sell and cost per calendar month from the supplied price history. */
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
  const platform = usePlatform();
  const rows = state.comparison?.rows ?? [];
  const decisions = Object.values(state.review.decisions);
  const [history, setHistory] = useState<PriceHistoryVersion[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void platform.priceHistory.list().then((result) => {
      if (!cancelled) setHistory(result.ok ? result.value : []);
    });
    return () => {
      cancelled = true;
    };
  }, [platform]);

  const series = useMemo(() => historySeries(history ?? []), [history]);
  const buckets = useMemo(() => priceBuckets(history ?? []), [history]);
  const hasHistory = (history?.length ?? 0) > 0;
  const pagesSession = platform.kind === 'web' && !platform.capabilities.liveSearch;
  const persistedHistory =
    platform.kind === 'desktop' || (platform.kind === 'web' && platform.capabilities.liveSearch);
  const changed = rows.filter((r) => r.status === 'price-changed').length;
  const blocked = rows.filter((r) => r.status === 'ambiguous' || r.status === 'invalid').length;
  const approved = decisions.filter((d) => d.state === 'approved').length;

  /**
   * Four figures, one bordered row. "Saved supplier profiles" belongs on the
   * Suppliers screen, and blocking exceptions are promoted out of the row
   * entirely: they are the one number that stops an export.
   */
  const cards = [
    {
      label: 'Changed awaiting review',
      value: changed,
      route: '#/approvals',
      attention: changed > 0,
      note: changed > 0 ? 'Needs review' : 'Nothing waiting',
    },
    {
      label: 'New items proposed',
      value: rows.filter((r) => r.status === 'new-item').length,
      route: '#/approvals',
      attention: false,
      note: 'Require explicit approval',
    },
    {
      label: 'Approved for import',
      value: approved,
      route: '#/exports',
      attention: false,
      note: approved > 0 ? 'Ready to export' : 'None yet',
    },
    {
      label: 'Price versions on record',
      value: history?.length ?? 0,
      route: '#/runs',
      attention: false,
      note: hasHistory
        ? persistedHistory
          ? 'Append-only history'
          : 'Current-tab history'
        : platform.kind === 'desktop'
          ? 'No approved versions yet'
          : pagesSession
            ? 'Session-only demo is empty'
            : platform.capabilities.liveSearch
              ? 'Web service not seeded'
              : 'Session-only demo is empty',
    },
  ];

  return (
    <Page
      title="Dashboard"
      lead="The state of the current run: what is waiting, what is approved and what is blocked."
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
            className={`metric-card metric-link${card.attention ? ' metric-attention' : ''}`}
            onClick={() => go(card.route)}
          >
            <span className="metric-label">{card.label}</span>
            <strong className="metric-value">{String(card.value).padStart(2, '0')}</strong>
            <span className="metric-state">{card.note}</span>
          </button>
        ))}
      </div>

      {blocked > 0 && (
        <section className="poster" aria-label="Blocking exceptions">
          <div>
            <span className="poster-kicker">Blocked from import</span>
            <strong className="poster-figure">{String(blocked).padStart(2, '0')}</strong>
            <p>
              Ambiguous and invalid records can never reach the import file. Resolve them, or the
              export stays disabled.
            </p>
          </div>
          <button type="button" className="btn" onClick={() => go('#/exceptions')}>
            Open exceptions
          </button>
        </section>
      )}

      {hasHistory ? (
        <div className="chart-row">
          <section className="card">
            <LineChart
              series={series}
              title={
                persistedHistory
                  ? 'Average cost and sell price over time (AUD, from persisted price history)'
                  : 'Average cost and sell price over time (AUD, current tab only)'
              }
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
          title={
            history === null
              ? 'Loading price history…'
              : persistedHistory
                ? 'No persisted price history yet'
                : 'No price history in this tab yet'
          }
          detail={
            platform.kind === 'desktop'
              ? 'The dashboard charts draw from append-only price history in the local SQLite database. Explicitly publish an approved price change through a run to create the first version.'
              : pagesSession
                ? 'GitHub Pages keeps approved price versions in this browser tab only. Publish an approved price version through a run to populate the chart; refreshing the page clears that session history.'
                : platform.capabilities.liveSearch
                  ? "The dashboard charts draw from the web demonstration server's append-only price history. Seed fictional sample data with `npm run seed` (then refresh), or publish approved price versions through a run."
                  : 'Static Pages keeps approved fictional demonstration records only for this browser session. Publish an approved price version through a run; refreshing the page clears that session-only history.'
          }
        />
      )}

      {state.comparison === null && (
        <EmptyState
          title="No run in progress"
          detail="Load a supplier price file and the current ServiceM8 export to compare costs, review proposed prices and produce a ready-to-import Materials & Services CSV."
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
    <Page
      title="Pricing rules"
      lead="One rule, applied to every record: the selling price is the supplier cost plus a fixed markup."
    >
      <Panel title="Active rule" meta="LOCKED">
        <dl className="kv">
          <dt>Strategy</dt>
          <dd>Markup on cost, not gross margin</dd>
          <dt>Markup</dt>
          <dd>
            <span className="mono">{markup}%</span> — changed in Configuration with confirmation,
            and audit-logged
          </dd>
          <dt>Rounding</dt>
          <dd>{ROUNDING_RULE_LABEL}</dd>
          <dt>Currency</dt>
          <dd>{CURRENCY}</dd>
        </dl>
      </Panel>
      <Panel title="Deterministic preview">
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
        {parsed.ok ? (
          <p className="formula-box" role="status">
            {`${CURRENCY} ${parsed.amount} × ${(1 + Number(markup) / 100).toFixed(2)} = ${CURRENCY} ${proposed}`}
          </p>
        ) : (
          <p className="form-error" role="status">
            {parsed.error}
          </p>
        )}
        <p className="hint">Decimal-safe arithmetic, {ROUNDING_RULE_LABEL.toLowerCase()}.</p>
      </Panel>
      <Panel title="Tax handling">
        <dl className="kv">
          <dt>GST</dt>
          <dd>Never inferred and never altered</dd>
          <dt>Supplier basis</dt>
          <dd>
            Declared once in Configuration; the markup is always applied to a GST-exclusive cost
          </dd>
          <dt>ServiceM8 basis</dt>
          <dd>Read per row from that row&rsquo;s own “Price Includes Taxes” column</dd>
          <dt>Recorded</dt>
          <dd>The handling in force is written into the audit summary for every run</dd>
        </dl>
      </Panel>
      <Panel title="Invalidation">
        <dl className="kv">
          <dt>Unreadable cost</dt>
          <dd>Blocked as invalid; no price is proposed</dd>
          <dt>Ambiguous match</dt>
          <dd>Blocked; a price is never proposed against an uncertain identity</dd>
          <dt>Rule change</dt>
          <dd>Re-runs the comparison, which may reset reversible review decisions</dd>
        </dl>
      </Panel>
    </Page>
  );
}

export function ExceptionsPage() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const actions = useActions();
  const exceptions = deriveExceptions(state.comparison);
  const [query, setQuery] = useState('');
  const [types, setTypes] = useState<Set<string>>(() => new Set());
  const [excluding, setExcluding] = useState<null | { id: string; product: string }>(null);
  const [reason, setReason] = useState('');
  const visible = exceptions.filter(
    (e) =>
      (types.size === 0 || types.has(e.type)) &&
      `${e.type} ${e.product} ${e.reason}`.toLowerCase().includes(query.toLowerCase()),
  );
  const allTypes = [...new Set(exceptions.map((e) => e.type))];
  const rowById = new Map((state.comparison?.rows ?? []).map((row) => [row.id, row]));
  const toggleType = (type: string) => {
    setTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  if (state.comparison === null) {
    return (
      <Page title="Exceptions">
        <EmptyState
          title="No comparison data loaded"
          detail="Ambiguous matches, invalid records and items missing from the supplier file are collected here once a comparison has run."
        />
      </Page>
    );
  }

  return (
    <Page
      title="Exceptions"
      lead="Records the comparison could not classify cleanly; blocking ones keep the export disabled."
    >
      <section className="card">
        <div className="search-bar">
          <input
            className="global-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Type, product or reason"
            aria-label="Search exceptions"
          />
        </div>
        <div className="chip-row" role="group" aria-label="Filter by exception type">
          {allTypes.map((type) => (
            <button
              key={type}
              type="button"
              className={`chip${types.has(type) ? ' chip-active' : ''}`}
              aria-pressed={types.has(type)}
              onClick={() => toggleType(type)}
            >
              {type}{' '}
              <span className="chip-count">{exceptions.filter((e) => e.type === type).length}</span>
            </button>
          ))}
          {types.size > 0 && (
            <button type="button" className="chip chip-clear" onClick={() => setTypes(new Set())}>
              Clear filters
            </button>
          )}
        </div>
        <p className="result-count" role="status">
          {visible.length} of {exceptions.length} exceptions shown
        </p>
      </section>
      {visible.length === 0 ? (
        <EmptyState
          title="No exceptions"
          detail="Every record classified cleanly, or the current filters exclude them all."
        />
      ) : (
        <div className="table-scroll" role="region" aria-label="Exceptions" tabIndex={0}>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Product</th>
                <th scope="col">Reason</th>
                <th scope="col">Suggested resolution</th>
                <th scope="col">Severity</th>
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
                    <td data-label="Status">
                      {row ? <StatusBadge status={row.status} /> : exception.type}
                    </td>
                    <td className="mono" data-label="Product">
                      {exception.product}
                    </td>
                    <td data-label="Reason">{exception.reason}</td>
                    <td data-label="Suggested resolution">{exception.suggestedResolution}</td>
                    <td className="mono" data-label="Severity">
                      {exception.severity}
                    </td>
                    <td data-label="Action">
                      {decision?.state === 'excluded' ? (
                        <span className="badge badge-invalid">Excluded</span>
                      ) : excludable ? (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => {
                            setReason('');
                            setExcluding({ id: exception.id, product: exception.product });
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
      <Dialog
        open={excluding !== null}
        title={`Exclude ${excluding?.product ?? ''}`}
        onClose={() => setExcluding(null)}
      >
        <p className="small muted">
          The exclusion and its reason are preserved in the audit report.
        </p>
        <div className="field">
          <label htmlFor="exception-exclude-reason">Reason for exclusion</label>
          <input
            id="exception-exclude-reason"
            type="text"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. superseded product line"
          />
        </div>
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={() => setExcluding(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={reason.trim().length < 3}
            onClick={() => {
              if (excluding === null) return;
              dispatch({ type: 'exclude', rowIds: [excluding.id], reason: reason.trim() });
              actions.announce(`Excluded ${excluding.product}: ${reason.trim()}`);
              setExcluding(null);
            }}
          >
            Exclude
          </button>
        </div>
      </Dialog>
    </Page>
  );
}

export function ApprovalsPage({ go }: { go: (route: string) => void }) {
  const state = useAppState();
  const actions = useActions();
  const [pendingApprovalIds, setPendingApprovalIds] = useState<Set<string>>(() => new Set());
  const [approvalToConfirm, setApprovalToConfirm] = useState<string | null>(null);
  const proposals = buildApprovalProposals(state.comparison, state.review.decisions);
  const selectedProposal = proposals.find((proposal) => proposal.id === approvalToConfirm) ?? null;

  const confirmApproval = () => {
    if (approvalToConfirm === null) return;
    const proposalId = approvalToConfirm;
    setApprovalToConfirm(null);
    setPendingApprovalIds((current) => new Set(current).add(proposalId));
    void actions.approveRows([proposalId]).finally(() => {
      setPendingApprovalIds((current) => {
        const next = new Set(current);
        next.delete(proposalId);
        return next;
      });
    });
  };

  if (state.comparison === null) {
    return (
      <Page title="Approvals">
        <EmptyState
          title="Nothing to approve yet"
          detail="Proposed price changes and new items are listed here once a comparison has run."
        />
      </Page>
    );
  }

  return (
    <Page
      title="Approvals"
      lead="Each approval is an explicit, append-only decision; it cannot be withdrawn afterwards."
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
        <div className="table-scroll approval-table-scroll" role="region" aria-label="Proposals">
          <table className="data-table approval-table">
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col" className="num">
                  Old sell
                </th>
                <th scope="col" className="num">
                  Proposed sell
                </th>
                <th scope="col" className="num">
                  Markup
                </th>
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
                    <td data-label="Status">
                      {STATUS_LABELS[proposal.exceptionState as keyof typeof STATUS_LABELS] ??
                        proposal.exceptionState}
                    </td>
                    <td className="num" data-label="Old sell">
                      {proposal.oldValue || '-'}
                    </td>
                    <td className="num sell" data-label="Proposed sell">
                      {proposal.proposedValue || 'blocked'}
                    </td>
                    <td className="num" data-label="Markup">
                      {proposal.markup}
                    </td>
                    <td data-label="Reason">{proposal.reason}</td>
                    <td data-label="Decision">{decision?.state ?? 'pending'}</td>
                    <td data-label="Action">
                      {proposal.approvable ? (
                        decision?.state === 'approved' ? (
                          <span className="hint">Recorded, append-only</span>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            disabled={pendingApprovalIds.has(proposal.id)}
                            onClick={() => setApprovalToConfirm(proposal.id)}
                          >
                            {pendingApprovalIds.has(proposal.id) ? 'Recording...' : 'Approve'}
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
        Approved records enter the ServiceM8 import CSV once every pre-export check passes.
      </p>
      <ConfirmDialog
        open={selectedProposal !== null}
        title="Confirm approval"
        body={
          selectedProposal === null ? null : (
            <>
              <p>
                Record the {selectedProposal.proposedValue || 'proposed'} sell price as an explicit,
                append-only approval?
              </p>
              <p className="hint">{selectedProposal.reason}</p>
            </>
          )
        }
        confirmLabel="Confirm approval"
        onConfirm={confirmApproval}
        onCancel={() => setApprovalToConfirm(null)}
      />
    </Page>
  );
}

export function RunsPage() {
  const state = useAppState();
  const actions = useActions();
  const platform = usePlatform();
  const metadata = useMemo(
    () =>
      buildRunMetadata({
        comparison: state.comparison,
        decisions: state.review.decisions,
        inputFiles: [state.supplier.table?.fileName, state.servicem8.table?.fileName].flatMap(
          (filename, index) => {
            const table = index === 0 ? state.supplier.table : state.servicem8.table;
            return filename && table ? [{ filename, sha256: table.sha256 }] : [];
          },
        ),
        outputFilenames: state.outputs?.map((o) => o.filename) ?? [],
        profileName: state.activeProfileName,
        profileVersion: state.activeProfileVersion,
      }),
    [state],
  );
  const evidence: Array<{
    field: string;
    value: string;
    source: string;
    recorded: string;
    hash: string;
    state: string;
  }> = [
    {
      field: 'Run identifier',
      value: metadata.id,
      source: 'Session',
      recorded: 'At first file load',
      hash: '—',
      state: 'Open',
    },
    {
      field: 'Validation',
      value: metadata.validationOutcome,
      source: 'Comparison engine',
      recorded: 'On compare',
      hash: '—',
      state: state.comparison === null ? 'Not run' : 'Recorded',
    },
    ...metadata.inputFilenames.map((filename, index) => ({
      field: `Input file ${index + 1}`,
      value: filename,
      source: 'Operator',
      recorded: 'On load',
      hash: metadata.fileHashes[index]?.slice(0, 12) ?? '—',
      state: 'Verified',
    })),
    {
      field: 'Mapping profile',
      value: `${metadata.supplierProfile} v${metadata.mappingVersion}`,
      source: 'Configuration',
      recorded: 'On compare',
      hash: '—',
      state: 'Applied',
    },
    {
      field: 'Decisions',
      value: `${metadata.approvalTotals.approved} approved · ${metadata.approvalTotals.excluded} excluded · ${metadata.approvalTotals.importEligible} import-eligible`,
      source: 'Operator',
      recorded: 'On decision',
      hash: '—',
      state: 'Append-only',
    },
    {
      field: 'Outputs',
      value: metadata.outputFilenames.join(', ') || 'none yet',
      source: 'Export stage',
      recorded: 'On generate',
      hash: '—',
      state: metadata.outputFilenames.length > 0 ? 'Generated' : 'Pending',
    },
  ];

  return (
    <Page
      title="Runs"
      lead="Evidence for the run in progress; the exported audit summary is the durable record."
    >
      <Panel title="Current run" meta={metadata.id}>
        <div className="table-scroll" role="region" aria-label="Run evidence" tabIndex={0}>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Value</th>
                <th scope="col">Source</th>
                <th scope="col">Recorded</th>
                <th scope="col">Hash</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {evidence.map((entry) => (
                <tr key={entry.field}>
                  <td data-label="Field">{entry.field}</td>
                  <td className="mono" data-label="Value">
                    {entry.value}
                  </td>
                  <td data-label="Source">{entry.source}</td>
                  <td data-label="Recorded">{entry.recorded}</td>
                  <td className="mono" data-label="Hash">
                    {entry.hash}
                  </td>
                  <td data-label="State">{entry.state}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {platform.kind === 'web' ? (
          <div className="btn-row">
            <button
              type="button"
              className="btn"
              disabled={state.comparison === null}
              onClick={() => {
                const blob = new Blob([JSON.stringify(metadata, null, 2)], {
                  type: 'application/json',
                });
                triggerDownload(blob, `${datePrefix()}-${metadata.id}-run-metadata.json`);
                actions.announce('Run metadata downloaded as JSON.');
              }}
            >
              Download run metadata (JSON)
            </button>
          </div>
        ) : (
          <p className="hint">
            Desktop run evidence is included in the audit summary saved with the five workflow
            outputs.
          </p>
        )}
      </Panel>
    </Page>
  );
}

export function AuditPage() {
  const state = useAppState();
  return (
    <Page
      title="Audit"
      lead="Business-rule changes made in this session; the exported audit summary carries the full record."
    >
      <Panel title="Session entries" meta={`${state.settingsChanges.length} recorded`}>
        {state.settingsChanges.length === 0 ? (
          <p className="hint">
            No business-rule changes in this session. Markup and tax-handling changes appear here
            and in the exported audit summary.
          </p>
        ) : (
          <div className="table-scroll" role="region" aria-label="Audit entries" tabIndex={0}>
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Time (UTC)</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Entry</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Reversible</th>
                  <th scope="col">In export</th>
                </tr>
              </thead>
              <tbody>
                {state.settingsChanges.map((entry) => (
                  <tr key={`${entry.at}-${entry.change}`}>
                    <td className="mono" data-label="Time (UTC)">
                      {entry.at.slice(0, 19).replace('T', ' ')}
                    </td>
                    <td data-label="Actor">Operator</td>
                    <td data-label="Entry">{entry.change}</td>
                    <td data-label="Kind">Business rule</td>
                    <td data-label="Reversible">Yes, by a further change</td>
                    <td data-label="In export">Audit summary</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </Page>
  );
}

export function HelpPage() {
  const platform = usePlatform();
  const competitorSearchBoundary =
    platform.kind === 'desktop'
      ? 'Optional competitor search sends only the typed query and selected opaque product token through the native Rust adapter.'
      : platform.capabilities.liveSearch
        ? 'Optional competitor search sends only the typed query and selected opaque product token to the supervised local Node service on the same origin.'
        : 'Static GitHub Pages performs no live competitor search and sends no provider request.';
  return (
    <Page
      title="Help"
      lead="What the tool does, what it will not do, and the keys that move you through it."
    >
      <Panel title="The workflow">
        <ol className="operational-list">
          <li>Add files — the untouched supplier export and the current ServiceM8 export.</li>
          <li>
            Map columns — name which supplier column holds the code, the cost and the category.
          </li>
          <li>Validate and compare — every record receives exactly one status.</li>
          <li>Review changes — approve or exclude each proposed price, record by record.</li>
          <li>Pre-export checks — every blocking gate must pass.</li>
          <li>Export — five deterministic output files.</li>
        </ol>
      </Panel>
      <Panel title="Boundaries">
        <ul className="operational-list">
          <li>
            Raw business files stay in{' '}
            {platform.kind === 'desktop' ? 'application memory' : 'this browser tab'} and are never
            uploaded. {competitorSearchBoundary}
          </li>
          <li>
            Pricing: selling price = supplier cost × 1.30, rounded half-up to two decimal places,
            AUD.
          </li>
          <li>
            Matching: exact code, then approved alias. Description similarity only ever suggests.
          </li>
          <li>
            ServiceM8 and Xero are file-handoff integrations; nothing is written to either system.
          </li>
        </ul>
      </Panel>
      <Panel title="Do not do this" meta="WARNING">
        <ul className="operational-list">
          <li>
            Do not edit the supplier export in a spreadsheet before loading it. Spreadsheets
            silently reformat codes, drop leading zeros and round costs, and the run then compares
            against values the supplier never sent.
          </li>
          <li>Do not hand-edit the generated import CSV; regenerate it from a corrected run.</li>
          <li>Do not approve an ambiguous record by aliasing it to a best guess.</li>
        </ul>
      </Panel>
      <Panel title="Keyboard">
        <dl className="kv">
          <dt>/</dt>
          <dd>Focus the search field from anywhere</dd>
          <dt>Arrow keys</dt>
          <dd>Move between records in the review table</dd>
          <dt>Space</dt>
          <dd>Select or deselect the focused record</dd>
          <dt>Enter</dt>
          <dd>Open the focused record in the detail panel</dd>
          <dt>Escape</dt>
          <dd>Close the open dialog</dd>
        </dl>
      </Panel>
    </Page>
  );
}
