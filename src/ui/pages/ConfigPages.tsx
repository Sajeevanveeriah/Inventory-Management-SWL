import { useState } from 'react';
import {
  changeImpact,
  defaultConfig,
  resetConfigSection,
  serialiseConfig,
  SETTING_REGISTRY,
  validateConfigImport,
} from '../../core/configRegistry';
import { Page } from './PageChrome';

/** Versioned configuration registry: locked invariants stay locked. */
export function SettingsPage({ openSettingsDialog }: { openSettingsDialog: () => void }) {
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState(JSON.stringify(serialiseConfig(defaultConfig()), null, 2));
  const parsed = (() => {
    try {
      const value = JSON.parse(draft) as { values?: unknown };
      return validateConfigImport(
        (value.values ?? value) as Parameters<typeof validateConfigImport>[0],
      );
    } catch {
      return ['configuration JSON is invalid'];
    }
  })();
  const settings = SETTING_REGISTRY.filter((setting) =>
    `${setting.key} ${setting.category}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <Page
      title="Settings"
      primary={
        <button type="button" className="btn btn-primary" onClick={openSettingsDialog}>
          Edit markup, tax and theme
        </button>
      }
    >
      <section className="card">
        <h2>Configuration centre</h2>
        <div className="form-grid">
          <label>
            Search settings
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
        </div>
        <textarea
          className="config-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Configuration JSON"
          spellCheck={false}
        />
        <div className="btn-row">
          <button type="button" className="btn btn-primary" disabled={parsed.length > 0}>
            Import configuration
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setDraft(JSON.stringify(serialiseConfig(defaultConfig()), null, 2))}
          >
            Reset draft to defaults
          </button>
          <button
            type="button"
            className="btn"
            onClick={() =>
              setDraft(
                JSON.stringify(
                  serialiseConfig(resetConfigSection(defaultConfig(), 'Pricing and tax')),
                  null,
                  2,
                ),
              )
            }
          >
            Reset pricing section
          </button>
        </div>
        <p className="form-error" role="status">
          {parsed.length ? parsed.join('; ') : changeImpact('pricing.markupPercent', 30)}
        </p>
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
