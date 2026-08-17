import { TAX_HANDLING_OPTIONS } from '../../core/settings';
import { ROUNDING_RULE_LABEL } from '../../core/money';
import { useAppDispatch, useAppState } from '../../state/store';
import { useActions } from '../../state/useActions';
import { usePlatform } from '../../platform/context';

export function StartStep() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const actions = useActions();
  const platform = usePlatform();

  return (
    <div>
      <div className="card">
        <h2>Supplier price comparison for ServiceM8</h2>
        <p>
          An untouched supplier price export is compared against the current ServiceM8 materials
          list, the confirmed {state.settings.markupPercent}% markup on cost is applied, and a
          reviewed import file is prepared with its change, exception, rollback and audit reports.
        </p>
        <p className="hint">
          Local processing only: files are read in{' '}
          {platform.kind === 'desktop' ? 'application memory' : 'this browser tab'} and never
          uploaded.
        </p>
        <div className="btn-row" style={{ marginTop: 'var(--space-4)' }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => dispatch({ type: 'go-to-step', step: 'files' })}
          >
            Start new comparison
          </button>
          <button type="button" className="btn" onClick={() => void actions.loadDemo()}>
            Load synthetic demonstration
          </button>
        </div>
      </div>

      <div className="grid-2">
        <section className="card" aria-labelledby="start-rules">
          <h3 id="start-rules">Current business rules</h3>
          <dl className="kv">
            <dt>Pricing rule</dt>
            <dd>
              Selling price = supplier cost ×{' '}
              {(1 + Number(state.settings.markupPercent) / 100).toString()} (
              {state.settings.markupPercent}% markup on cost)
            </dd>
            <dt>Rounding</dt>
            <dd>{ROUNDING_RULE_LABEL}</dd>
            <dt>Currency</dt>
            <dd>AUD</dd>
            <dt>Tax handling</dt>
            <dd>{TAX_HANDLING_OPTIONS[state.settings.taxHandling]}</dd>
          </dl>
        </section>

        <section className="card" aria-labelledby="start-profiles">
          <h3 id="start-profiles">Saved mapping profiles</h3>
          {state.profiles.length === 0 ? (
            <p className="muted">
              No profiles saved yet. Map a supplier&rsquo;s columns once, then save the layout so
              future comparisons are one click.
            </p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
              {state.profiles.map((p) => (
                <li key={p.id} style={{ marginBottom: '0.4rem' }}>
                  <strong>{p.name}</strong>{' '}
                  <span className="muted small">
                    v{p.version} · updated {p.updatedAt.slice(0, 10)}
                  </span>{' '}
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => actions.applyProfile(p)}
                  >
                    Use profile
                  </button>
                </li>
              ))}
            </ul>
          )}
          {state.aliases.length > 0 && (
            <p className="muted small" style={{ marginTop: '0.6rem' }}>
              {state.aliases.length} approved alias
              {state.aliases.length === 1 ? '' : 'es'} saved in
              {platform.kind === 'desktop' ? ' local application data.' : ' this browser.'}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
