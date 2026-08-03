import { useState } from 'react';
import { fieldsForRole } from '../../core/fields';
import { validateMapping } from '../../core/mapping';
import { buildReleaseChecklist, checklistPasses, rowsForImport } from '../../core/output';
import { TAX_HANDLING_OPTIONS } from '../../core/settings';
import { triggerDownload } from '../../io/download';
import { useAppDispatch, useAppState } from '../../state/store';
import { useActions } from '../../state/useActions';

export function ExportStep() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const actions = useActions();
  const [generating, setGenerating] = useState(false);
  const comparison = state.comparison;

  if (comparison === null || state.supplier.table === null || state.servicem8.table === null) {
    return (
      <div className="card">
        <h2>Export</h2>
        <p>Run the comparison and complete the checklist first.</p>
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
  const importCount = rowsForImport(comparison.rows, state.review.decisions).length;

  return (
    <div>
      <div className="card">
        <h2>Generate outputs</h2>
        <div className="callout callout-warn">
          <strong>Candidate import file.</strong> A genuine ServiceM8 import template has not been
          verified, so the import workbook uses the loaded ServiceM8 export’s column layout and is
          labelled a candidate. Validate it against a real ServiceM8 import (or supply the official
          template) before importing into production.
        </div>
        <p className="muted">
          {importCount} approved change(s) will be written to the import workbook. Unchanged,
          excluded, ambiguous and invalid records are never included. All five outputs are generated
          locally and downloaded straight from this browser.
        </p>
        {!passes && (
          <div className="callout callout-danger" role="alert">
            The release checklist has failing gates. Return to the checklist step to repair them.
          </div>
        )}
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!passes || generating}
            onClick={() => {
              setGenerating(true);
              void actions.generateOutputs().finally(() => setGenerating(false));
            }}
          >
            {generating ? 'Generating…' : 'Generate all output files'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => dispatch({ type: 'go-to-step', step: 'checklist' })}
          >
            Back to checklist
          </button>
        </div>
      </div>

      {state.outputs !== null && (
        <div className="card">
          <h3>Generated files</h3>
          <ul className="gate-list">
            {state.outputs.map((out) => (
              <li key={out.filename}>
                <span className="gate-icon gate-pass" aria-hidden="true">
                  ✓
                </span>
                <div style={{ flex: 1 }}>
                  <strong>{out.label}</strong>
                  <div className="small mono muted">{out.filename}</div>
                  {out.sanitizedCells > 0 && (
                    <div className="small" style={{ color: 'var(--warn)' }}>
                      {out.sanitizedCells} formula-like value(s) were neutralised for safety.
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => triggerDownload(out.blob, out.filename)}
                >
                  Download
                </button>
              </li>
            ))}
          </ul>
          <p className="muted small" style={{ marginTop: '0.7rem' }}>
            Keep the rollback workbook and audit summary with your records. Nothing was transmitted
            anywhere — files exist only on this computer once downloaded.
          </p>
        </div>
      )}
    </div>
  );
}
