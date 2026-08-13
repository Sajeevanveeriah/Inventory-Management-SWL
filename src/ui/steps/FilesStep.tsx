import { useAppDispatch, useAppState } from '../../state/store';
import { useActions } from '../../state/useActions';
import { usePlatform } from '../../platform/context';
import type { FileRole } from '../../core/table';
import { FileDrop } from '../FileDrop';

export function FilesStep() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const actions = useActions();
  const platform = usePlatform();
  const bothLoaded = state.supplier.table !== null && state.servicem8.table !== null;
  const chooseNativeFile = async (role: FileRole) => {
    const selected = await platform.files.chooseInputFile(role);
    if (!selected.ok) {
      if (selected.error.code !== 'cancelled') actions.announce(selected.error.message);
      return;
    }
    if (selected.value !== null) await actions.loadFile(role, selected.value);
  };

  return (
    <div>
      <div className="card">
        <h2>Add the two files</h2>
        <p className="muted">
          Load the untouched supplier export and the current ServiceM8 materials &amp; services
          export. Files stay in application memory and are never uploaded.
        </p>
      </div>
      <div className="grid-2">
        <FileDrop
          role="supplier"
          label="Supplier export"
          hint="The price list exactly as the supplier sent it - CSV or XLSX, no editing needed."
          slot={state.supplier}
          nativePicker={platform.kind === 'desktop'}
          onChooseFile={() => void chooseNativeFile('supplier')}
          onFile={(file) => void actions.loadFile('supplier', file)}
          onSheetChange={(sheet) => {
            const file = state.supplier.file;
            if (file !== null) void actions.loadFile('supplier', file, sheet);
          }}
          onClear={() => dispatch({ type: 'file-cleared', role: 'supplier' })}
        />
        <FileDrop
          role="servicem8"
          label="ServiceM8 export"
          hint="Your current ServiceM8 Materials & Services export or import template - CSV or XLSX."
          slot={state.servicem8}
          nativePicker={platform.kind === 'desktop'}
          onChooseFile={() => void chooseNativeFile('servicem8')}
          onFile={(file) => void actions.loadFile('servicem8', file)}
          onSheetChange={(sheet) => {
            const file = state.servicem8.file;
            if (file !== null) void actions.loadFile('servicem8', file, sheet);
          }}
          onClear={() => dispatch({ type: 'file-cleared', role: 'servicem8' })}
        />
      </div>
      <div className="btn-row" style={{ marginTop: '0.5rem' }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!bothLoaded}
          onClick={() => dispatch({ type: 'go-to-step', step: 'mapping' })}
        >
          Continue to column mapping
        </button>
        {!bothLoaded && <span className="muted small">Both files are required to continue.</span>}
      </div>
    </div>
  );
}
