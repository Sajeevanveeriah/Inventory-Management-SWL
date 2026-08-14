import { useEffect, useRef, useState } from 'react';
import { changeImpact, SETTING_REGISTRY } from '../../core/configRegistry';
import { datePrefix } from '../../core/run';
import { triggerDownload } from '../../io/download';
import { usePlatform } from '../../platform/context';
import type {
  BackupSummary,
  ConfigurationMigrationStatus,
  ConfigurationPreview,
  PlatformService,
  RestorePreview,
} from '../../platform/contracts';
import { useActions } from '../../state/useActions';
import { Page } from './PageChrome';

const MAX_CONFIGURATION_BYTES = 10 * 1024 * 1024;

export function RecoveryPanel({
  platform,
  announce,
  afterRestore,
}: {
  platform: PlatformService;
  announce: (message: string) => void;
  afterRestore: () => Promise<boolean>;
}) {
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [selectedBackupId, setSelectedBackupId] = useState('');
  const [restorePreview, setRestorePreview] = useState<RestorePreview | null>(null);
  const [restoreConfirmed, setRestoreConfirmed] = useState(false);
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void platform.recovery.listBackups().then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setMessage(result.error.message);
        return;
      }
      setBackups(result.value);
      setSelectedBackupId((current) => current || result.value[0]?.id || '');
    });
    return () => {
      cancelled = true;
    };
  }, [platform]);

  const createBackup = async () => {
    setWorking(true);
    setMessage('');
    const result = await platform.recovery.createBackup('manual');
    setWorking(false);
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    setBackups((current) => [
      result.value,
      ...current.filter((item) => item.id !== result.value.id),
    ]);
    setSelectedBackupId(result.value.id);
    setRestorePreview(null);
    setRestoreConfirmed(false);
    setMessage(`Verified backup created: ${result.value.filename}.`);
    announce('Verified local backup created.');
  };

  const previewSelected = async () => {
    if (selectedBackupId === '') return;
    setWorking(true);
    setMessage('');
    setRestorePreview(null);
    setRestoreConfirmed(false);
    const result = await platform.recovery.previewRestore(selectedBackupId);
    setWorking(false);
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    setRestorePreview(result.value);
    setMessage('Restore preview verified. No live data has changed.');
  };

  const restoreSelected = async () => {
    if (!restorePreview || !restoreConfirmed) return;
    setWorking(true);
    setMessage('');
    const result = await platform.recovery.restore(restorePreview.previewToken);
    if (!result.ok) {
      setWorking(false);
      setMessage(result.error.message);
      return;
    }
    const reloaded = await afterRestore();
    setWorking(false);
    if (!reloaded) {
      setMessage(
        'Restore completed, but the restored configuration could not be loaded safely. The workflow remains blocked.',
      );
      announce(
        'Restore completed, but verified configuration reload failed. The workflow remains blocked.',
      );
      return;
    }
    setRestorePreview(null);
    setRestoreConfirmed(false);
    setMessage(
      `Restored and verified ${result.value.filename} after creating a pre-restore backup.`,
    );
    announce('Backup restored and active workflow cleared.');
  };

  return (
    <section className="card" aria-labelledby="recovery-title">
      <h2 id="recovery-title">Backup and recovery</h2>
      <p className="hint">
        {platform.kind === 'desktop'
          ? 'Backups are verified local database copies in the application data directory. Credentials and raw imported rows are excluded.'
          : 'Web demonstration backups contain browser configuration only and remain in application memory until this page is reloaded.'}
      </p>
      <div className="btn-row">
        <button
          type="button"
          className="btn"
          disabled={working}
          onClick={() => void createBackup()}
        >
          Create verified backup
        </button>
      </div>
      {backups.length === 0 ? (
        <p className="muted">No verified backup is available yet.</p>
      ) : (
        <>
          <label>
            Backup to preview
            <select
              value={selectedBackupId}
              disabled={working}
              onChange={(event) => {
                setSelectedBackupId(event.target.value);
                setRestorePreview(null);
                setRestoreConfirmed(false);
              }}
            >
              {backups.map((backup) => (
                <option key={backup.id} value={backup.id}>
                  {backup.filename} ({backup.createdAt.slice(0, 19)})
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn"
            disabled={working || selectedBackupId === ''}
            onClick={() => void previewSelected()}
          >
            Preview selected backup
          </button>
        </>
      )}
      {restorePreview && (
        <div className="callout callout-warn" role="status">
          <strong>Verified restore preview</strong>
          <p>
            {restorePreview.filename}, schema {restorePreview.schemaVersion}, application{' '}
            {restorePreview.applicationVersion}. Integrity check:{' '}
            {restorePreview.integrityOk ? 'passed' : 'failed'}.
          </p>
          <p className="small">
            Records: {restorePreview.recordCounts.catalogueItems} catalogue items,{' '}
            {restorePreview.recordCounts.approvals} approvals,{' '}
            {restorePreview.recordCounts.priceHistory} price versions,{' '}
            {restorePreview.recordCounts.competitorReferences} references,{' '}
            {restorePreview.recordCounts.profiles} profiles and{' '}
            {restorePreview.recordCounts.aliases} aliases. SHA-256: {restorePreview.sha256}.
          </p>
          <label>
            <input
              type="checkbox"
              checked={restoreConfirmed}
              onChange={(event) => setRestoreConfirmed(event.target.checked)}
            />{' '}
            I understand that restore replaces the current authorised local data after creating a
            verified pre-restore backup.
          </label>
          <div className="btn-row">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setRestorePreview(null);
                setRestoreConfirmed(false);
                setMessage('Restore cancelled. Live data was not changed.');
              }}
            >
              Cancel restore
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={working || !restoreConfirmed || !restorePreview.integrityOk}
              onClick={() => void restoreSelected()}
            >
              Restore selected backup
            </button>
          </div>
        </div>
      )}
      {message !== '' && (
        <p className="hint" role="status">
          {message}
        </p>
      )}
    </section>
  );
}

/** Versioned configuration transfer and recovery entry point. */
export function SettingsPage({ openSettingsDialog }: { openSettingsDialog: () => void }) {
  const platform = usePlatform();
  const actions = useActions();
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [preview, setPreview] = useState<ConfigurationPreview | null>(null);
  const [migration, setMigration] = useState<ConfigurationMigrationStatus | null>(null);
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void platform.configuration.migrationStatus().then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setMessage(`Legacy configuration inspection failed. ${result.error.message}`);
        return;
      }
      setMigration(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, [platform]);

  const settings = SETTING_REGISTRY.filter((setting) =>
    `${setting.key} ${setting.category}`.toLowerCase().includes(query.toLowerCase()),
  );

  const exportConfiguration = async () => {
    setWorking(true);
    setMessage('');
    const filename = `${datePrefix()}-SWL-Configuration.json`;
    if (platform.kind === 'desktop') {
      const saved = await platform.configuration.exportToSelectedFolder(filename);
      setWorking(false);
      if (!saved.ok) {
        setMessage(saved.error.message);
        return;
      }
      if (saved.value === null) {
        setMessage('Configuration export cancelled. No file was written.');
        return;
      }
      setMessage(
        `Saved ${saved.value} through the native folder picker. Keep this source export until an imported store is verified.`,
      );
      return;
    }
    const result = await platform.configuration.export();
    setWorking(false);
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    triggerDownload(
      new Blob([JSON.stringify(result.value, null, 2)], {
        type: 'application/json',
      }),
      filename,
    );
    setMessage(
      `Exported ${result.value.counts.profiles} profiles, ${result.value.counts.aliases} aliases and settings. Keep this source export until an imported store is verified.`,
    );
  };

  const previewImport = async (serialised = draft) => {
    setWorking(true);
    setPreview(null);
    setMessage('');
    const result = await platform.configuration.previewImport(serialised);
    setWorking(false);
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    setPreview(result.value);
    setMessage('Preview validated. No live data has changed. Review counts and conflicts below.');
  };

  const previewLegacy = async () => {
    setWorking(true);
    setPreview(null);
    setMessage('');
    const result = await platform.configuration.previewLegacyImport();
    setWorking(false);
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    setPreview(result.value);
    setMessage('Legacy WebView configuration validated. No live data has changed.');
  };

  const applyImport = async () => {
    if (!preview) return;
    setWorking(true);
    const result = await platform.configuration.applyImport(preview.previewToken);
    setWorking(false);
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    const reloaded = await actions.reloadPersistentConfiguration();
    if (!reloaded) {
      setMessage(
        'Import completed, but the imported configuration could not be loaded safely. The workflow remains blocked.',
      );
      return;
    }
    setMessage(
      `Imported and verified ${result.value.profiles} profiles, ${result.value.aliases} aliases and settings after backup.`,
    );
    setPreview(null);
    setDraft('');
  };

  const readImportFile = async (file: File) => {
    setPreview(null);
    if (file.size === 0 || file.size > MAX_CONFIGURATION_BYTES) {
      setMessage('The configuration file size is outside the supported range.');
      return;
    }
    const text = await file.text();
    setDraft(text);
    await previewImport(text);
  };

  const chooseConfigurationFile = async () => {
    if (platform.kind === 'web') {
      importInput.current?.click();
      return;
    }
    const selected = await platform.files.chooseInputFile('configuration');
    if (!selected.ok) {
      if (selected.error.code !== 'cancelled') setMessage(selected.error.message);
      return;
    }
    if (selected.value !== null) await readImportFile(selected.value);
  };

  return (
    <Page
      title="Settings"
      primary={
        <button type="button" className="btn btn-primary" onClick={openSettingsDialog}>
          Edit markup, tax and theme
        </button>
      }
    >
      <section className="card" aria-labelledby="configuration-transfer-title">
        <h2 id="configuration-transfer-title">Configuration transfer</h2>
        <p className="hint">
          The versioned export contains mapping profiles, approved aliases and settings only. It
          excludes imported business rows, operational prices and provider credentials.
        </p>
        <div className="btn-row">
          <button
            type="button"
            className="btn"
            disabled={working}
            onClick={() => void exportConfiguration()}
          >
            Export versioned configuration
          </button>
          <button
            type="button"
            className="btn"
            disabled={working}
            onClick={() => void chooseConfigurationFile()}
          >
            Choose configuration JSON
          </button>
          {platform.kind === 'web' && (
            <input
              ref={importInput}
              type="file"
              accept="application/json,.json"
              hidden
              aria-label="Choose a versioned configuration JSON file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void readImportFile(file);
                event.target.value = '';
              }}
            />
          )}
          {platform.kind === 'desktop' &&
            migration?.legacyConfigurationFound &&
            !migration.alreadyImported && (
              <button
                type="button"
                className="btn"
                disabled={working || !migration.valid}
                onClick={() => void previewLegacy()}
              >
                Preview legacy WebView configuration
              </button>
            )}
        </div>
        {platform.kind === 'desktop' && migration?.legacyConfigurationFound && (
          <div className={migration.valid ? 'callout' : 'callout callout-danger'} role="status">
            <strong>Legacy WebView migration inspection</strong>
            <p>
              Found {migration.counts.profiles} profile record(s), {migration.counts.aliases} alias
              record(s) and {migration.counts.settings} settings record. Invalid:{' '}
              {migration.invalidCounts.profiles} profiles, {migration.invalidCounts.aliases} aliases
              and {migration.invalidCounts.settings} settings record.
            </p>
            {migration.alreadyImported && (
              <p>This exact legacy configuration was already imported and verified.</p>
            )}
            {migration.validationMessages.length > 0 && (
              <ul>
                {migration.validationMessages.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <label>
          Versioned configuration JSON
          <textarea
            className="config-textarea"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setPreview(null);
            }}
            aria-label="Versioned configuration JSON"
            placeholder="Paste a complete SWL configuration export, then preview it"
            spellCheck={false}
          />
        </label>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={working || draft.trim() === ''}
            onClick={() => void previewImport()}
          >
            Preview import
          </button>
          <button
            type="button"
            className="btn"
            disabled={preview === null || working || !preview.valid}
            onClick={() => void applyImport()}
          >
            Confirm import after backup
          </button>
        </div>
        {preview !== null && (
          <div className="callout callout-warn" role="status">
            <strong>Validated preview, schema {preview.schemaVersion}</strong>
            <p>
              Incoming: {preview.counts.profiles} profiles, {preview.counts.aliases} aliases and{' '}
              {preview.counts.settings} settings record. Conflicts: {preview.conflicts.profiles}{' '}
              profiles, {preview.conflicts.aliases} aliases and {preview.conflicts.settings}{' '}
              settings record. Applying requires this separate confirmation and creates a verified
              backup first.
            </p>
            {preview.validationMessages.length > 0 && (
              <ul>
                {preview.validationMessages.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {message !== '' && (
          <p className={preview?.valid ? 'hint' : 'form-error'} role="status">
            {message}
          </p>
        )}
      </section>

      <RecoveryPanel
        platform={platform}
        announce={actions.announce}
        afterRestore={actions.reloadAfterRestore}
      />

      <section className="card">
        <h2>Configuration registry</h2>
        <label>
          Search settings
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <p className="hint">{changeImpact('pricing.markupPercent', 30)}</p>
      </section>
      <div className="settings-grid">
        {settings.map((setting) => (
          <article className="setting-row" key={setting.key}>
            <strong>{setting.key}</strong>
            <span>{setting.category}</span>
            <span>
              {String(setting.defaultValue)}
              {'unit' in setting ? setting.unit : ''}
            </span>
            <span>{setting.locked ? 'Locked invariant' : 'Adjustable'}</span>
          </article>
        ))}
      </div>
    </Page>
  );
}
