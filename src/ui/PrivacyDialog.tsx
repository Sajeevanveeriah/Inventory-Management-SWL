import { useState } from 'react';
import { useAppDispatch } from '../state/store';
import { useActions } from '../state/useActions';
import { ConfirmDialog } from './ConfirmDialog';
import { Dialog } from './Dialog';

interface PrivacyDialogProps {
  open: boolean;
  onClose: () => void;
}

export function PrivacyDialog({ open, onClose }: PrivacyDialogProps) {
  const dispatch = useAppDispatch();
  const actions = useActions();
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <>
      <Dialog open={open} title="Privacy — what is and is not stored" onClose={onClose}>
        <h3>Processing</h3>
        <p className="small">
          Everything happens locally in this browser tab. The production build ships with a Content
          Security Policy whose <code>connect-src 'none'</code> directive makes the browser refuse
          any network transmission of page data. There is no server, no account, no analytics and no
          telemetry.
        </p>
        <h3>Never stored, never sent</h3>
        <ul className="small">
          <li>Uploaded supplier and ServiceM8 files (memory only; gone when the tab closes)</li>
          <li>Imported rows, prices, descriptions and identifiers</li>
          <li>Generated import files and reports (created on demand, downloaded by you)</li>
        </ul>
        <h3>Stored in this browser only (IndexedDB), if you choose to save them</h3>
        <ul className="small">
          <li>Mapping profiles — column layout names and positions only</li>
          <li>Approved aliases — supplier code → ServiceM8 item number pairs</li>
          <li>Settings — markup %, tax-handling selection, theme</li>
        </ul>
        <div className="btn-row" style={{ marginTop: '0.8rem' }}>
          <button
            type="button"
            className="btn"
            onClick={() => {
              dispatch({ type: 'clear-session' });
              onClose();
            }}
          >
            Clear session data
          </button>
          <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)}>
            Delete saved profiles and aliases…
          </button>
          <span className="spacer" style={{ flex: 1 }} />
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </Dialog>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete all saved data"
        danger
        body={
          <p>
            This permanently deletes every saved mapping profile, approved alias and setting from
            this browser. It cannot be undone.
          </p>
        }
        confirmLabel="Delete everything"
        onConfirm={() => {
          void actions.deleteStoredData();
          setConfirmDelete(false);
          onClose();
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}
