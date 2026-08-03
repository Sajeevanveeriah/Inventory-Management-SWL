import { fieldsForRole } from '../../core/fields';
import { validateMapping } from '../../core/mapping';
import { buildReleaseChecklist, checklistPasses } from '../../core/output';
import { TAX_HANDLING_OPTIONS } from '../../core/settings';
import { useAppDispatch, useAppState } from '../../state/store';

export function ChecklistStep() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const comparison = state.comparison;

  if (comparison === null || state.supplier.table === null || state.servicem8.table === null) {
    return (
      <div className="card">
        <h2>Pre-export checks</h2>
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

  const mappingComplete =
    validateMapping(
      state.supplierMapping,
      fieldsForRole('supplier'),
      state.supplier.table.headers,
    ).filter((i) => i.severity === 'error').length === 0 &&
    validateMapping(
      state.s8Mapping,
      fieldsForRole('servicem8'),
      state.servicem8.table.headers,
    ).filter((i) => i.severity === 'error').length === 0;

  const gates = buildReleaseChecklist({
    comparison,
    decisions: state.review.decisions,
    mappingComplete,
    templateAdapted: true,
    markupPercent: comparison.markupPercent,
    taxHandling: TAX_HANDLING_OPTIONS[state.settings.taxHandling],
  });
  const passes = checklistPasses(gates);

  return (
    <div>
      <div className="card">
        <h2>Release checklist</h2>
        <p className="muted">
          Every blocking gate must pass before the import file can be generated. Non-blocking items
          are shown for awareness.
        </p>
        <ul className="gate-list">
          {gates.map((gate) => (
            <li key={gate.id}>
              <span
                className={`gate-icon ${gate.ok ? (gate.blocking ? 'gate-pass' : 'gate-info') : gate.blocking ? 'gate-fail' : 'gate-info'}`}
                aria-hidden="true"
              >
                {gate.ok ? '✓' : gate.blocking ? '✕' : 'i'}
              </span>
              <div>
                <strong>{gate.label}</strong>{' '}
                <span className="visually-hidden">
                  {gate.ok ? '(passed)' : gate.blocking ? '(failed)' : '(informational)'}
                </span>
                <div className="small muted">{gate.detail}</div>
                {!gate.ok && gate.repair !== undefined && (
                  <div className="small" style={{ color: 'var(--danger)' }}>
                    How to fix: {gate.repair}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
        {!passes && (
          <div className="callout callout-danger" style={{ marginTop: '0.9rem' }} role="alert">
            Export is disabled until every blocking gate above passes.
          </div>
        )}
        <div className="btn-row" style={{ marginTop: '0.9rem' }}>
          <button
            type="button"
            className="btn"
            onClick={() => dispatch({ type: 'go-to-step', step: 'review' })}
          >
            Back to review
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!passes}
            onClick={() => dispatch({ type: 'go-to-step', step: 'export' })}
          >
            Continue to export
          </button>
        </div>
      </div>
    </div>
  );
}
