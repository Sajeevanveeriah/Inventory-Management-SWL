import { useMemo, useState } from 'react';
import { fieldsForRole, type FieldDefinition } from '../../core/fields';
import { suggestMappings, validateMapping, type ColumnMapping } from '../../core/mapping';
import type { FileRole, ParsedTable } from '../../core/table';
import { useAppDispatch, useAppState } from '../../state/store';
import { useActions } from '../../state/useActions';
import { Dialog } from '../Dialog';

function sampleValues(table: ParsedTable, col: number): string[] {
  const seen: string[] = [];
  for (const row of table.rows) {
    const v = (row[col] ?? '').trim();
    if (v !== '' && !seen.includes(v)) seen.push(v);
    if (seen.length >= 3) break;
  }
  return seen;
}

function MappingPanel({
  role,
  table,
  mapping,
  onChange,
}: {
  role: FileRole;
  table: ParsedTable;
  mapping: ColumnMapping;
  onChange: (mapping: ColumnMapping) => void;
}) {
  const fields = fieldsForRole(role);
  const suggestions = useMemo(
    () => suggestMappings(table.headers, fields),
    [table.headers, fields],
  );
  const issues = validateMapping(mapping, fields, table.headers);
  const title = role === 'supplier' ? 'Supplier file fields' : 'ServiceM8 file fields';
  const headingId = `mapping-${role}`;

  return (
    <section className="card" aria-labelledby={headingId}>
      <h3 id={headingId}>{title}</h3>
      <p className="muted small">
        File: <strong>{table.fileName}</strong> · sheet “{table.selectedSheet}” ·{' '}
        {table.rows.length.toLocaleString()} rows
      </p>
      {issues.length > 0 && (
        <div className="error-summary" role="alert">
          <h3>Fix before comparing</h3>
          <ul>
            {issues.map((i) => (
              <li key={i.message}>{i.message}</li>
            ))}
          </ul>
        </div>
      )}
      {fields.map((field: FieldDefinition) => {
        const selectId = `map-${role}-${field.key}`;
        const value = mapping[field.key];
        const suggestion = suggestions.find((s) => s.field === field.key);
        return (
          <div className="field" key={field.key}>
            <label htmlFor={selectId}>
              {field.label}{' '}
              {field.required ? (
                <span className="badge badge-invalid" style={{ verticalAlign: 'middle' }}>
                  Required
                </span>
              ) : (
                <span className="badge badge-neutral" style={{ verticalAlign: 'middle' }}>
                  Optional
                </span>
              )}
            </label>
            <span className="help">{field.help}</span>
            <select
              id={selectId}
              value={value === undefined ? '' : String(value)}
              onChange={(e) => {
                const next = { ...mapping };
                if (e.target.value === '') {
                  delete next[field.key];
                } else {
                  next[field.key] = Number(e.target.value);
                }
                onChange(next);
              }}
            >
              <option value="">— not mapped —</option>
              {table.headers.map((h, i) => (
                <option key={`${i}-${h}`} value={String(i)}>
                  {h || `(column ${i + 1})`}
                </option>
              ))}
            </select>
            {value !== undefined && (
              <span className="help">
                Sample values:{' '}
                {sampleValues(table, value)
                  .map((s) => `“${s}”`)
                  .join(', ') || '(all blank)'}
              </span>
            )}
            {value !== undefined &&
              suggestion !== undefined &&
              suggestion.columnIndex === value && (
                <span className="help">
                  Suggested automatically ({suggestion.confidence} confidence): {suggestion.reason}{' '}
                  Confirm it is correct before comparing.
                </span>
              )}
          </div>
        );
      })}
    </section>
  );
}

export function MappingStep() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const actions = useActions();
  const [saveOpen, setSaveOpen] = useState(false);
  const [profileName, setProfileName] = useState('');

  const supplierTable = state.supplier.table;
  const s8Table = state.servicem8.table;
  if (supplierTable === null || s8Table === null) {
    return (
      <div className="card">
        <h2>Map columns</h2>
        <p>Both files must be loaded first.</p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => dispatch({ type: 'go-to-step', step: 'files' })}
        >
          Go to Add files
        </button>
      </div>
    );
  }

  const supplierIssues = validateMapping(
    state.supplierMapping,
    fieldsForRole('supplier'),
    supplierTable.headers,
  ).filter((i) => i.severity === 'error');
  const s8Issues = validateMapping(
    state.s8Mapping,
    fieldsForRole('servicem8'),
    s8Table.headers,
  ).filter((i) => i.severity === 'error');
  const mappingOk = supplierIssues.length === 0 && s8Issues.length === 0;

  return (
    <div>
      <div className="card">
        <h2>Map columns to fields</h2>
        <p className="muted">
          Tell the tool which column holds each piece of information. Automatic suggestions are
          pre-selected where the headers look familiar, but nothing proceeds until you confirm the
          mapping here. Identifiers keep leading zeroes and punctuation exactly as supplied;
          matching compares them case-insensitively after trimming surrounding spaces.
        </p>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!mappingOk}
            onClick={() => actions.runCompare(state)}
          >
            Confirm mapping and run comparison
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setSaveOpen(true)}
            disabled={!mappingOk}
          >
            Save as mapping profile
          </button>
          {state.comparison !== null && (
            <span
              className="callout callout-warn small"
              style={{ margin: 0, padding: '0.4rem 0.7rem' }}
            >
              Re-running the comparison after mapping changes may reset review approvals for rows
              whose data changed.
            </span>
          )}
          {!mappingOk && (
            <span className="muted small">Resolve the highlighted mapping errors to continue.</span>
          )}
        </div>
      </div>
      <div className="grid-2">
        <MappingPanel
          role="supplier"
          table={supplierTable}
          mapping={state.supplierMapping}
          onChange={(mapping) => dispatch({ type: 'set-mapping', role: 'supplier', mapping })}
        />
        <MappingPanel
          role="servicem8"
          table={s8Table}
          mapping={state.s8Mapping}
          onChange={(mapping) => dispatch({ type: 'set-mapping', role: 'servicem8', mapping })}
        />
      </div>

      <Dialog open={saveOpen} title="Save mapping profile" onClose={() => setSaveOpen(false)}>
        <p className="muted small">
          Saves only the column layout (header names and positions) for reuse — never any imported
          rows. Use a supplier-specific name.
        </p>
        <div className="field">
          <label htmlFor="profile-name">Profile name</label>
          <input
            id="profile-name"
            type="text"
            value={profileName}
            onChange={(e) => setProfileName(e.target.value)}
            placeholder="e.g. Acme Locks monthly price list"
          />
        </div>
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={() => setSaveOpen(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={profileName.trim() === ''}
            onClick={() => {
              void actions.saveProfile(profileName.trim());
              setSaveOpen(false);
            }}
          >
            Save profile
          </button>
        </div>
      </Dialog>
    </div>
  );
}
