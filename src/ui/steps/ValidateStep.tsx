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
        <h2>Validation and comparison results</h2>
        <p className="muted">
          Every record received exactly one status. Blocked records (ambiguous or invalid) can never
          enter the import output; missing items are flagged only and never deleted.
        </p>
        <div className="pipeline" role="list" aria-label="Record counts by category">
          <Stat n={t.supplierRecords} label="Supplier records" tone="neutral" />
          <Stat n={t.s8Records} label="ServiceM8 records" tone="neutral" />
          <Stat n={t.exactMatches} label="Exact matches" tone="info" />
          <Stat n={t.aliasMatches} label="Alias matches" tone="info" />
          <Stat n={t.priceChanged} label="Changed prices" tone="info" />
          <Stat n={t.newItems} label="New items" tone="ok" />
          <Stat n={t.unchanged} label="Unchanged" tone="neutral" />
          <Stat n={t.missingFromSupplier} label="Missing from supplier" tone="warn" />
          <Stat n={t.ambiguous} label="Ambiguous" tone="warn" />
          <Stat n={t.invalid} label="Invalid" tone="danger" />
          <Stat n={t.duplicates} label="Duplicate identifiers" tone="danger" />
          <Stat n={t.blocked} label="Blocked from import" tone="danger" />
        </div>
      </div>

      <div className="card">
        <h3>Where records went</h3>
        <p className="small muted" style={{ marginBottom: '0.6rem' }}>
          Processing pipeline for this run:
        </p>
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
