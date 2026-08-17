import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ComparisonRow } from '../../core/compare';
import { formatAmount } from '../../core/money';
import { isApprovable, isExcludable, type BaseStatus } from '../../core/statuses';
import { decisionFor } from '../../core/review';
import { useAppDispatch, useAppState } from '../../state/store';
import { useActions } from '../../state/useActions';
import { ConfirmDialog } from '../ConfirmDialog';
import { Dialog } from '../Dialog';
import { DecisionBadge, StatusBadge } from '../StatusBadge';

const ROW_HEIGHT = 44;
const OVERSCAN = 10;

type TabId = 'all' | BaseStatus;
const TABS: { id: TabId; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'price-changed', label: 'Price changed' },
  { id: 'new-item', label: 'New items' },
  { id: 'unchanged', label: 'Unchanged' },
  { id: 'missing-from-supplier', label: 'Missing' },
  { id: 'ambiguous', label: 'Ambiguous' },
  { id: 'invalid', label: 'Invalid' },
];

type SortKey = 'identifier' | 'status' | 'cost' | 'delta';

function identifierOf(row: ComparisonRow): string {
  return row.supplier?.code ?? row.s8?.itemNumber ?? '';
}

/**
 * Signed cost movement as a percentage of the cost ServiceM8 holds today.
 * Display only: the comparison engine keeps the decimal-safe amounts.
 */
function deltaPercent(row: ComparisonRow): number | null {
  const before = row.s8?.existingCost;
  const after = row.supplier?.cost;
  if (before == null || after == null) return null;
  const from = Number(before);
  const to = Number(after);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return ((to - from) / from) * 100;
}

function methodLabel(row: ComparisonRow): string {
  if (row.matchMethod === 'exact-code') return 'Exact code';
  if (row.matchMethod === 'alias') return 'Approved alias';
  return '-';
}

export function ReviewStep() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const actions = useActions();
  const comparison = state.comparison;

  const [tab, setTab] = useState<TabId>('all');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('identifier');
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [detailId, setDetailId] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [confirm, setConfirm] = useState<null | {
    kind: 'approve' | 'reset';
    ids: string[];
  }>(null);
  const [excludePrompt, setExcludePrompt] = useState<null | { ids: string[] }>(null);
  const [excludeReason, setExcludeReason] = useState('');
  const [approvalPending, setApprovalPending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => comparison?.rows ?? [], [comparison]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = rows;
    if (tab !== 'all') out = out.filter((r) => r.status === tab);
    if (q !== '') {
      out = out.filter((r) => {
        const hay = `${identifierOf(r)} ${r.supplier?.description ?? ''} ${
          r.s8?.description ?? ''
        }`.toLowerCase();
        return hay.includes(q);
      });
    }
    const dir = sortDir;
    const sorted = [...out].sort((a, b) => {
      switch (sortKey) {
        case 'status':
          return dir * a.status.localeCompare(b.status);
        case 'cost':
          return dir * (Number(a.supplier?.cost ?? -1) - Number(b.supplier?.cost ?? -1));
        case 'delta':
          return dir * (Number(a.costDelta ?? 0) - Number(b.costDelta ?? 0));
        default:
          return (
            dir *
            identifierOf(a).localeCompare(identifierOf(b), undefined, {
              numeric: true,
            })
          );
      }
    });
    return sorted;
  }, [rows, tab, search, sortKey, sortDir]);

  if (comparison === null) {
    return (
      <div className="card">
        <h2>Review proposed changes</h2>
        <p>Run the comparison first.</p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => dispatch({ type: 'go-to-step', step: 'mapping' })}
        >
          Go to Map columns
        </button>
      </div>
    );
  }

  // The detail panel is always populated while there is anything to show, so
  // the operator never faces an empty 340px column beside a full table.
  const activeDetailId = detailId ?? filtered[0]?.id ?? null;
  const detailRow =
    activeDetailId === null ? null : (rows.find((r) => r.id === activeDetailId) ?? null);
  const selectedRows = filtered.filter((r) => selected.has(r.id));
  const actionTargets = selectedRows.length > 0 ? selectedRows : [];
  const eligibleApprove = actionTargets.filter(
    (r) =>
      isApprovable(r.status) &&
      decisionFor(state.review, r.id).state === 'none' &&
      state.review.committedApprovals[r.id] !== true,
  );
  const eligibleExclude = actionTargets.filter(
    (r) => isExcludable(r.status) && state.review.committedApprovals[r.id] !== true,
  );
  const reversibleTargets = actionTargets.filter(
    (r) => decisionFor(state.review, r.id).state === 'excluded',
  );

  const viewportH = 560;
  const total = filtered.length;
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + OVERSCAN);
  const windowRows = filtered.slice(start, end);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(1);
    }
  };
  const ariaSortFor = (key: SortKey): 'ascending' | 'descending' | 'none' =>
    sortKey === key ? (sortDir === 1 ? 'ascending' : 'descending') : 'none';

  const onRowKeyDown = (
    e: KeyboardEvent<HTMLTableRowElement>,
    index: number,
    row: ComparisonRow,
  ) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const nextIndex = e.key === 'ArrowDown' ? index + 1 : index - 1;
      const next = filtered[nextIndex];
      if (next !== undefined) {
        setDetailId(next.id);
        const el = scrollRef.current?.querySelector<HTMLTableRowElement>(
          `[data-row-id="${CSS.escape(next.id)}"]`,
        );
        el?.focus();
      }
    } else if (e.key === ' ') {
      e.preventDefault();
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(row.id)) next.delete(row.id);
        else next.add(row.id);
        return next;
      });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      setDetailId(row.id);
    }
  };

  const doApprove = async (ids: string[]) => {
    if (approvalPending) return;
    setApprovalPending(true);
    try {
      const approved = await actions.approveRows(ids);
      if (approved) {
        setSelected((current) => {
          const next = new Set(current);
          for (const id of ids) next.delete(id);
          return next;
        });
      }
    } finally {
      setApprovalPending(false);
    }
  };
  const doExclude = (ids: string[], reason: string) => {
    dispatch({ type: 'exclude', rowIds: ids, reason });
    actions.announce(`Excluded ${ids.length} record${ids.length === 1 ? '' : 's'}: ${reason}`);
    setSelected(new Set());
  };

  const decisionCounts = {
    approved: rows.filter((r) => decisionFor(state.review, r.id).state === 'approved').length,
    excluded: rows.filter((r) => decisionFor(state.review, r.id).state === 'excluded').length,
  };

  return (
    <div>
      <div className="card">
        <div className="panel-head">
          <h2>Review proposed changes</h2>
          <span className="panel-meta">
            {decisionCounts.approved} approved · {decisionCounts.excluded} excluded ·{' '}
            {comparison.totals.blocked} blocked
          </span>
        </div>

        <div className="chip-row" role="group" aria-label="Filter by status">
          {TABS.map((t) => {
            const count =
              t.id === 'all' ? rows.length : rows.filter((r) => r.status === t.id).length;
            return (
              <button
                key={t.id}
                type="button"
                className={`chip${tab === t.id ? ' chip-active' : ''}`}
                aria-pressed={tab === t.id}
                onClick={() => {
                  setTab(t.id);
                  setScrollTop(0);
                  if (scrollRef.current !== null) scrollRef.current.scrollTop = 0;
                }}
              >
                {t.label} ({count})
              </button>
            );
          })}
        </div>

        <div className="review-toolbar">
          <input
            type="search"
            aria-label="Search identifiers and descriptions"
            placeholder="Search identifiers and descriptions…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-sm"
            disabled={eligibleApprove.length === 0 || approvalPending}
            onClick={() =>
              eligibleApprove.length > 1
                ? setConfirm({
                    kind: 'approve',
                    ids: eligibleApprove.map((r) => r.id),
                  })
                : doApprove(eligibleApprove.map((r) => r.id))
            }
          >
            {approvalPending
              ? 'Recording approval...'
              : `Approve selected (${eligibleApprove.length})`}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={eligibleExclude.length === 0}
            onClick={() => {
              setExcludeReason('');
              setExcludePrompt({ ids: eligibleExclude.map((r) => r.id) });
            }}
          >
            Exclude selected ({eligibleExclude.length})
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={reversibleTargets.length === 0}
            onClick={() => {
              dispatch({
                type: 'clear-decision',
                rowIds: reversibleTargets.map((r) => r.id),
              });
              setSelected(new Set());
            }}
          >
            Clear exclusion
          </button>
          <span aria-hidden="true" style={{ borderLeft: '1px solid var(--border)', height: 24 }} />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => dispatch({ type: 'undo' })}
            disabled={state.review.past.length === 0}
          >
            Undo
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => dispatch({ type: 'redo' })}
            disabled={state.review.future.length === 0}
          >
            Redo
          </button>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            disabled={decisionCounts.excluded === 0}
            onClick={() => setConfirm({ kind: 'reset', ids: [] })}
          >
            Reset exclusions
          </button>
        </div>

        <div className="review-layout">
          <div
            className="review-table-wrap"
            ref={scrollRef}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
            tabIndex={0}
            aria-label="Comparison results table container"
          >
            <table aria-rowcount={total + 1} aria-label="Comparison results">
              {/* Fixed widths on every scanned column; the description takes the
                  remainder and truncates. Old sell and the match method live in
                  the detail panel — they are not scanning columns. */}
              <colgroup>
                <col className="col-select" />
                <col className="col-code" />
                <col />
                <col className="col-status" />
                <col className="col-cost" />
                <col className="col-cost" />
                <col className="col-delta" />
                <col className="col-sell" />
                <col className="col-decision" />
              </colgroup>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Select all visible rows"
                      checked={filtered.length > 0 && filtered.every((r) => selected.has(r.id))}
                      onChange={(e) => {
                        setSelected(
                          e.target.checked ? new Set(filtered.map((r) => r.id)) : new Set(),
                        );
                      }}
                    />
                  </th>
                  <th aria-sort={ariaSortFor('identifier')}>
                    <button
                      type="button"
                      className="sort-btn"
                      onClick={() => toggleSort('identifier')}
                    >
                      Code {sortKey === 'identifier' ? (sortDir === 1 ? '▲' : '▼') : ''}
                    </button>
                  </th>
                  <th>Description</th>
                  <th aria-sort={ariaSortFor('status')}>
                    <button type="button" className="sort-btn" onClick={() => toggleSort('status')}>
                      Status {sortKey === 'status' ? (sortDir === 1 ? '▲' : '▼') : ''}
                    </button>
                  </th>
                  <th className="num">Cost now</th>
                  <th className="num" aria-sort={ariaSortFor('cost')}>
                    <button type="button" className="sort-btn" onClick={() => toggleSort('cost')}>
                      Cost new {sortKey === 'cost' ? (sortDir === 1 ? '▲' : '▼') : ''}
                    </button>
                  </th>
                  <th className="num" aria-sort={ariaSortFor('delta')}>
                    <button type="button" className="sort-btn" onClick={() => toggleSort('delta')}>
                      Δ% {sortKey === 'delta' ? (sortDir === 1 ? '▲' : '▼') : ''}
                    </button>
                  </th>
                  <th className="num">Sell</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {start > 0 && (
                  <tr aria-hidden="true" style={{ height: start * ROW_HEIGHT }}>
                    <td colSpan={9} style={{ padding: 0, border: 0 }} />
                  </tr>
                )}
                {windowRows.map((row, i) => {
                  const index = start + i;
                  const decision = decisionFor(state.review, row.id);
                  return (
                    <tr
                      key={row.id}
                      data-row-id={row.id}
                      tabIndex={0}
                      aria-rowindex={index + 2}
                      aria-selected={activeDetailId === row.id}
                      style={{ height: ROW_HEIGHT, cursor: 'pointer' }}
                      onClick={() => setDetailId(row.id)}
                      onKeyDown={(e) => onRowKeyDown(e, index, row)}
                    >
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${identifierOf(row) || 'row'}`}
                          checked={selected.has(row.id)}
                          onChange={(e) => {
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(row.id);
                              else next.delete(row.id);
                              return next;
                            });
                          }}
                        />
                      </td>
                      <td className="mono">
                        {identifierOf(row) || <span className="muted">(blank)</span>}
                      </td>
                      <td
                        className="col-description"
                        title={row.supplier?.description ?? row.s8?.description ?? ''}
                      >
                        {row.supplier?.description ?? row.s8?.description ?? ''}
                      </td>
                      <td>
                        <StatusBadge status={row.status} compact />
                      </td>
                      <td className="num">
                        {row.s8?.existingCost != null ? formatAmount(row.s8.existingCost) : '—'}
                      </td>
                      <td className="num">
                        {row.supplier?.cost != null ? formatAmount(row.supplier.cost) : '—'}
                      </td>
                      <td className="num">
                        {(() => {
                          const percent = deltaPercent(row);
                          if (percent === null) return '—';
                          return (
                            <span className={percent > 0 ? 'delta-up' : 'delta-down'}>
                              {percent > 0 ? '+' : ''}
                              {percent.toFixed(1)}%
                            </span>
                          );
                        })()}
                      </td>
                      <td className="num sell">
                        {row.proposedSell !== null ? formatAmount(row.proposedSell) : '—'}
                      </td>
                      <td>
                        <DecisionBadge decision={decision.state} />
                        {decision.state === 'none' &&
                          isApprovable(row.status) &&
                          state.review.committedApprovals[row.id] !== true && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={approvalPending}
                              onClick={(e) => {
                                e.stopPropagation();
                                doApprove([row.id]);
                              }}
                            >
                              Approve
                            </button>
                          )}
                      </td>
                    </tr>
                  );
                })}
                {end < total && (
                  <tr aria-hidden="true" style={{ height: (total - end) * ROW_HEIGHT }}>
                    <td colSpan={9} style={{ padding: 0, border: 0 }} />
                  </tr>
                )}
                {total === 0 && (
                  <tr>
                    <td
                      colSpan={9}
                      className="muted"
                      style={{ textAlign: 'center', padding: '1.5rem' }}
                    >
                      No records match the current filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <aside className="detail-panel" aria-label="Record details">
            {detailRow === null ? (
              <div className="card">
                <h3>Record details</h3>
                <p className="muted">No records match the current filter.</p>
              </div>
            ) : (
              <DetailPanel row={detailRow} />
            )}
          </aside>
        </div>

        <div className="table-foot">
          <span>
            {total} of {rows.length} records shown
          </span>
          <span>
            {decisionCounts.approved} approved · {decisionCounts.excluded} excluded
          </span>
        </div>
        <p className="hint">
          Arrow keys move between records, Space selects, Enter opens the record detail.
        </p>

        <div className="btn-row" style={{ marginTop: '0.9rem' }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => dispatch({ type: 'go-to-step', step: 'checklist' })}
          >
            Continue to pre-export checks
          </button>
        </div>

        {state.review.history.length > 0 && (
          <details style={{ marginTop: '0.8rem' }}>
            <summary>Review decision history ({state.review.history.length})</summary>
            <ol className="small" style={{ margin: '0.5rem 0 0', paddingLeft: '1.4rem' }}>
              {state.review.history.map((h, i) => (
                <li key={`${h.at}-${i}`}>
                  {h.label} <span className="muted">({h.at.slice(11, 19)} UTC)</span>
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>

      <ConfirmDialog
        open={confirm !== null && confirm.kind === 'approve'}
        title="Approve selected records"
        body={
          <p>
            Approve and permanently record <strong>{confirm?.ids.length ?? 0}</strong> record(s)?
            Approval and price history are append-only and cannot be withdrawn or undone.
          </p>
        }
        confirmLabel={`Approve ${confirm?.ids.length ?? 0} record(s)`}
        onConfirm={() => {
          if (confirm !== null) doApprove(confirm.ids);
          setConfirm(null);
        }}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm !== null && confirm.kind === 'reset'}
        title="Reset reversible review decisions"
        danger
        body={
          <p>
            This clears <strong>{decisionCounts.excluded}</strong> exclusion(s). The{' '}
            <strong>{decisionCounts.approved}</strong> recorded approval(s) remain immutable.
          </p>
        }
        confirmLabel="Reset exclusions"
        onConfirm={() => {
          dispatch({ type: 'reset-decisions' });
          setConfirm(null);
        }}
        onCancel={() => setConfirm(null)}
      />
      <Dialog
        open={excludePrompt !== null}
        title={`Exclude ${excludePrompt?.ids.length ?? 0} record(s)`}
        onClose={() => setExcludePrompt(null)}
      >
        <p className="muted small">
          The exclusion and its reason are preserved in the audit report.
        </p>
        <div className="field">
          <label htmlFor="exclude-reason">Reason for exclusion</label>
          <input
            id="exclude-reason"
            type="text"
            value={excludeReason}
            onChange={(e) => setExcludeReason(e.target.value)}
            placeholder="e.g. Not stocked any more"
          />
        </div>
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={() => setExcludePrompt(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={excludeReason.trim() === ''}
            onClick={() => {
              if (excludePrompt !== null) doExclude(excludePrompt.ids, excludeReason.trim());
              setExcludePrompt(null);
            }}
          >
            Exclude
          </button>
        </div>
      </Dialog>
    </div>
  );
}

function DetailPanel({ row }: { row: ComparisonRow }) {
  const state = useAppState();
  const actions = useActions();
  const comparison = state.comparison;
  const [aliasTarget, setAliasTarget] = useState('');
  if (comparison === null) return null;

  return (
    <div className="card">
      <h3>
        {identifierOf(row) || 'Record'} <StatusBadge status={row.status} />
      </h3>
      {/* Sell over cost, before and after: the sell price is the number being
          decided, so it is the one set in the display size. */}
      {row.s8 !== null && row.supplier !== null && (
        <div className="before-after">
          <div className="cell">
            <span className="label">Before</span>
            <span className="value">
              {row.s8.existingSell != null ? formatAmount(row.s8.existingSell) : '—'}
            </span>
            <div className="small muted">
              {row.s8.existingCost != null
                ? `${formatAmount(row.s8.existingCost)} cost`
                : 'no cost'}
            </div>
          </div>
          <div className="cell">
            <span className="label">After</span>
            <span className="value">
              {row.proposedSell !== null ? formatAmount(row.proposedSell) : '—'}
            </span>
            <div className="small muted">
              {row.supplier.cost != null ? `${formatAmount(row.supplier.cost)} cost` : 'no cost'}
            </div>
          </div>
        </div>
      )}
      {row.pricing !== null && row.targetBasis !== null && (
        <div>
          <span className="small muted">
            Pricing derivation ({comparison.markupPercent}% on the GST-exclusive cost, AUD - this
            ServiceM8 row stores a price that{' '}
            {row.targetBasis === 'including-gst' ? 'INCLUDES' : 'EXCLUDES'} GST):
          </span>
          <div className="formula-box">{row.pricing.explanation}</div>
        </div>
      )}
      <dl>
        <dt>Match method</dt>
        <dd>{methodLabel(row)}</dd>
        {row.supplier !== null && (
          <>
            <dt>Supplier row</dt>
            <dd>
              row {row.supplier.sourceRow} - “{row.supplier.description}”
            </dd>
            <dt>Supplier cost</dt>
            <dd>
              {row.supplier.cost != null
                ? `${formatAmount(row.supplier.cost)} (from “${row.supplier.costRaw}”)`
                : `unreadable: “${row.supplier.costRaw}”`}
            </dd>
          </>
        )}
        {row.s8 !== null && (
          <>
            <dt>ServiceM8 row</dt>
            <dd>
              row {row.s8.sourceRow} - “{row.s8.description}”
            </dd>
          </>
        )}
      </dl>
      {row.messages.length > 0 && (
        <ul className="small" style={{ paddingLeft: '1.1rem', margin: '0 0 0.8rem' }}>
          {row.messages.map((m, i) => (
            <li
              key={i}
              style={{
                color:
                  m.severity === 'error'
                    ? 'var(--danger)'
                    : m.severity === 'warning'
                      ? 'var(--warn)'
                      : 'inherit',
              }}
            >
              {m.message}
            </li>
          ))}
        </ul>
      )}
      {row.suggestions.length > 0 && (
        <div>
          <h4 className="small" style={{ marginBottom: '0.3rem' }}>
            Possible matches (manual review only)
          </h4>
          <ul className="small" style={{ paddingLeft: '1.1rem', margin: '0 0 0.5rem' }}>
            {row.suggestions.map((s) => (
              <li key={s.itemNumber}>
                <span className="mono">{s.itemNumber}</span> - {s.description} (
                {Math.round(s.similarity * 100)}%)
              </li>
            ))}
          </ul>
          <div className="field">
            <label htmlFor={`alias-${row.id}`}>Approve alias to ServiceM8 item</label>
            <span className="help">
              Creates an exact alias {row.supplier?.code ?? ''} → chosen item. Re-run the comparison
              afterwards to apply it (decisions on unchanged rows are kept).
            </span>
            <select
              id={`alias-${row.id}`}
              value={aliasTarget}
              onChange={(e) => setAliasTarget(e.target.value)}
            >
              <option value="">- choose item -</option>
              {row.suggestions.map((s) => (
                <option key={s.itemNumber} value={s.itemNumber}>
                  {s.itemNumber} - {s.description}
                </option>
              ))}
            </select>
          </div>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-sm"
              disabled={aliasTarget === '' || row.supplier === null}
              onClick={() => {
                if (row.supplier !== null) {
                  void actions.approveAlias(row.supplier.code, aliasTarget, !state.demoMode);
                }
              }}
            >
              Approve alias
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
