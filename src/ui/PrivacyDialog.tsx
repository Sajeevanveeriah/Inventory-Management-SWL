import { useState } from 'react';
import { useAppDispatch } from '../state/store';
import { useActions } from '../state/useActions';
import { usePlatform } from '../platform/context';
import type { ResetPreview } from '../platform/contracts';
import { Dialog } from './Dialog';

interface PrivacyDialogProps {
  open: boolean;
  onClose: () => void;
}

export function PrivacyDialog({ open, onClose }: PrivacyDialogProps) {
  const dispatch = useAppDispatch();
  const actions = useActions();
  const platform = usePlatform();
  const [resetPreview, setResetPreview] = useState<ResetPreview | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [resetError, setResetError] = useState('');
  const [resetting, setResetting] = useState(false);

  const close = () => {
    setResetPreview(null);
    setConfirmation('');
    setResetError('');
    onClose();
  };

  const prepareReset = async () => {
    setResetError('');
    const preview = await platform.recovery.previewReset();
    if (preview.ok) setResetPreview(preview.value);
    else setResetError(preview.error.message);
  };

  const applyReset = async () => {
    if (!resetPreview || confirmation !== resetPreview.confirmationPhrase) return;
    setResetting(true);
    const result = await platform.recovery.reset(resetPreview.resetToken, confirmation);
    setResetting(false);
    if (!result.ok) {
      setResetError(result.error.message);
      return;
    }
    const reloaded = await actions.clearStoredStateAfterReset();
    if (!reloaded) {
      setResetError(
        'Application data was erased after backup, but the new configuration could not be loaded safely. The workflow remains blocked.',
      );
      return;
    }
    actions.announce(
      `Application data erased after backup ${result.value.filename}. Session files were not affected.`,
    );
    setResetPreview(null);
    setConfirmation('');
    close();
  };

  return (
    <>
      <Dialog open={open} title="Privacy - what is and is not stored" onClose={close}>
        <h3>Processing</h3>
        <p className="small">
          Business files are processed locally in memory.{' '}
          {platform.kind === 'desktop'
            ? 'The Windows application stores authorised operational records in its local database and performs optional search through its native, allowlisted provider integration.'
            : platform.capabilities.liveSearch
              ? "The server-backed web demonstration stores authorised demonstration records through this application's Node service."
              : 'Static Pages has no Node server or provider integration and keeps authorised fictional demonstration records only for this browser session.'}{' '}
          There is no analytics or telemetry.
        </p>
        <h3>Memory-only business inputs</h3>
        <ul className="small">
          <li>Supplier and ServiceM8 files are memory only and are never uploaded</li>
          <li>Raw imported rows are not written to the operational database</li>
          <li>
            Generated files stay local and leave application memory only when you explicitly save
            them through the native picker or download them from the web demonstration
          </li>
        </ul>
        <h3>Optional network search</h3>
        <p className="small">
          An explicit search sends the product query you type and, after exact selection, an opaque
          product token.{' '}
          {platform.kind === 'desktop'
            ? 'The desktop application sends those search fields through the native Rust service to its exact allowlisted HTTPS provider.'
            : platform.capabilities.liveSearch
              ? "The server-backed web demonstration sends those search fields through this application's Node service."
              : 'Static Pages cannot make a provider request; manual evidence remains available.'}{' '}
          Supplier cost, sell price, private notes, customer data and full imported rows are never
          included.
        </p>
        <h3>
          {platform.kind === 'desktop'
            ? 'Stored in local application data'
            : 'Stored in this browser only'}
        </h3>
        <ul className="small">
          {platform.kind === 'desktop' && (
            <>
              <li>Catalogue items, append-only approvals and price history</li>
              <li>Approved competitor references and price-source preferences</li>
            </>
          )}
          <li>Mapping profiles - column layout names and positions only</li>
          <li>Approved aliases - supplier code → ServiceM8 item number pairs</li>
          <li>Settings - markup %, tax-handling selection, theme</li>
        </ul>
        <p className="small">
          Clearing the active workflow removes imported files, mappings and review decisions from
          the current run. It does not erase catalogue, approval/history, competitor references,
          source state, configuration or provider credentials and access tokens.
        </p>
        <div className="btn-row" style={{ marginTop: '0.8rem' }}>
          <button
            type="button"
            className="btn"
            onClick={() => {
              dispatch({ type: 'clear-session' });
              actions.announce(
                'Active workflow cleared. Operational records, configuration and provider credentials or access tokens were not erased.',
              );
              close();
            }}
          >
            Clear active workflow
          </button>
          <button type="button" className="btn btn-danger" onClick={() => void prepareReset()}>
            Preview application data erasure…
          </button>
          <span className="spacer" style={{ flex: 1 }} />
          <button type="button" className="btn btn-primary" onClick={close}>
            Close
          </button>
        </div>
        {resetPreview !== null && (
          <section className="callout callout-danger" aria-labelledby="reset-scope-title">
            <h3 id="reset-scope-title">Final erasure scope</h3>
            <p>
              A verified backup is created first. Uninstall is not affected and never erases this
              data. This action removes only:
            </p>
            <ul>
              {resetPreview.scope.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p className="small">
              Records: {resetPreview.recordCounts.catalogueItems} catalogue items,{' '}
              {resetPreview.recordCounts.approvals} approvals,{' '}
              {resetPreview.recordCounts.priceHistory} price versions,{' '}
              {resetPreview.recordCounts.competitorReferences} references,{' '}
              {resetPreview.recordCounts.profiles} profiles and {resetPreview.recordCounts.aliases}{' '}
              aliases.
              {platform.kind === 'desktop'
                ? ' The Windows-protected provider credential is included in this exact reset scope but is never copied into the backup.'
                : ' The web demonstration does not store provider credentials in the browser.'}
            </p>
            {platform.kind === 'desktop' && (
              <p className="small">
                Legacy configuration in the same WebView IndexedDB profile is preserved outside this
                reset scope as a migration source. It is never treated as the native operational
                store and remains available for a later previewed reimport.
              </p>
            )}
            <label>
              Type <strong>{resetPreview.confirmationPhrase}</strong> to confirm
              <input
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
              />
            </label>
            <div className="btn-row">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setResetPreview(null);
                  setConfirmation('');
                }}
              >
                Cancel erasure
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={confirmation !== resetPreview.confirmationPhrase || resetting}
                onClick={() => void applyReset()}
              >
                {resetting ? 'Creating backup and erasing…' : 'Create backup and erase exact scope'}
              </button>
            </div>
          </section>
        )}
        {resetError !== '' && (
          <p className="form-error" role="alert">
            {resetError}
          </p>
        )}
      </Dialog>
    </>
  );
}
