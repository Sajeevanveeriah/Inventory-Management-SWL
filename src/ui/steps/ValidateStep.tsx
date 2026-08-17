import { useAppDispatch, useAppState } from '../../state/store';
import { useActions } from '../../state/useActions';

function Stat({ n, label, tone }: { n: number; label: string; tone: string }) {
  return (
    <div className={`stat tone-${tone}`} role="listitem">
      <span className="n">{n.toLocaleString()}</span>
      <span className="lbl">{label}</span>
    </div>
  );
}

export function ValidateStep() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const actions = useActions();
  const comparison = state.comparison;

  if (comparison === null) {
    return (
      <div className="card">
        <h2>Validate &amp; compare</h2>
        <p>Run the comparison from the mapping step first.</p>
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

  const t = comparison.totals;
  const accepted = t.unchanged + t.priceChanged + t.newItems;

  return (
    <div>
      <div className="card">
        <div className="panel-head">
          <h2>Validation and comparison results</h2>
          <span className="panel-meta">Every record carries exactly one status</span>
        </div>
        <div className="pipeline" role="list" aria-label="Record counts by category">
          <Stat n={t.supplierRecords} label="Supplier records" tone="neutral" />
          <Stat n={t.s8Records} label="ServiceM8 records" tone="neutral" />
          <Stat n={t.exactMatches + t.aliasMatches} label="Matched" tone="info" />
          <Stat n={t.priceChanged} label="Changed" tone="info" />
          <Stat n={t.newItems} label="New" tone="ok" />
          <Stat n={t.blocked} label="Blocked" tone="danger" />
          <Stat n={t.missingFromSupplier} label="Flagged" tone="warn" />
        </div>
        {/* Match hierarchy, stated once. Similarity never creates a match. */}
        <p className="hint">
          Match hierarchy: exact supplier code, then approved alias. Description similarity only
          ever suggests. {t.duplicates} duplicate identifier
          {t.duplicates === 1 ? '' : 's'} · {t.ambiguous} ambiguous · {t.invalid} invalid.
        </p>
      </div>

      <div className="card">
        <h3>Where records went</h3>
        <ol style={{ margin: 0, paddingLeft: '1.3rem', fontSize: '0.9rem' }}>
          <li>
            <strong>{t.supplierRecords + t.s8Records}</strong> records read from both files
          </li>
          <li>
            <strong>{t.invalid}</strong> blocked as invalid (missing or malformed required values)
          </li>
          <li>
            <strong>{t.ambiguous}</strong> blocked as ambiguous (duplicates or uncertain matches
            {t.duplicates > 0 ? `, including ${t.duplicates} duplicate identifier record(s)` : ''})
          </li>
          <li>
            <strong>{accepted}</strong> accepted for review: {t.priceChanged} price change(s),{' '}
            {t.newItems} new item(s), {t.unchanged} unchanged
          </li>
          <li>
            <strong>{t.missingFromSupplier}</strong> flagged as missing from the supplier file
            (never deleted)
          </li>
        </ol>
        <div className="btn-row" style={{ marginTop: '1rem' }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => dispatch({ type: 'go-to-step', step: 'review' })}
          >
            Review proposed changes
          </button>
          <button type="button" className="btn" onClick={() => actions.runCompare(state)}>
            Re-run comparison
          </button>
        </div>
      </div>
    </div>
  );
}
