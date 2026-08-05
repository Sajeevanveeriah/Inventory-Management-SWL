import { useState } from 'react';
import {
  recommendCompetitivePrice,
  type CompetitorObservation,
  type ReviewState,
} from '../../core/competitors';
import {
  changeImpact,
  defaultConfig,
  resetConfigSection,
  serialiseConfig,
  SETTING_REGISTRY,
  validateConfigImport,
} from '../../core/configRegistry';
import { parseCompetitorEvidenceRows } from '../../core/operations';
import { Page } from './PageChrome';

/** Manual local competitor evidence with a deterministic recommendation preview. */
export function CompetitorsPage() {
  const [sku, setSku] = useState('00123');
  const [price, setPrice] = useState('143.00');
  const [confidence, setConfidence] = useState('0.91');
  const [reviewState, setReviewState] = useState<ReviewState>('accepted');
  const [observations, setObservations] = useState<CompetitorObservation[]>([]);
  const imported = parseCompetitorEvidenceRows(
    [
      {
        sku,
        sourceName: 'Example Manual Source',
        price,
        gstBasis: 'inc-gst',
        matchConfidence: confidence,
      },
    ],
    reviewState,
  );
  const working = observations.length ? observations : imported.observations;
  const rec = recommendCompetitivePrice({
    costEx: '100.00',
    observations: working,
    strategy: 'MATCH',
    now: new Date().toISOString(),
  });
  return (
    <Page title="Competitors">
      <section className="card">
        <h2>Local evidence</h2>
        <div className="form-grid">
          <label>
            Internal SKU
            <input value={sku} onChange={(e) => setSku(e.target.value)} />
          </label>
          <label>
            Observed price inc GST
            <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
          </label>
          <label>
            Match confidence
            <input
              value={confidence}
              onChange={(e) => setConfidence(e.target.value)}
              inputMode="decimal"
            />
          </label>
          <label>
            Review state
            <select
              value={reviewState}
              onChange={(e) => setReviewState(e.target.value as ReviewState)}
            >
              <option value="accepted">accepted</option>
              <option value="rejected">rejected</option>
              <option value="quarantined">quarantined</option>
            </select>
          </label>
        </div>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setObservations(imported.observations)}
          >
            Add observation
          </button>
          <button
            type="button"
            className="btn"
            onClick={() =>
              setObservations(
                parseCompetitorEvidenceRows([
                  {
                    sku: '00123',
                    sourceName: 'Example CSV',
                    price: '110.00',
                    gstBasis: 'inc-gst',
                    matchConfidence: '0.95',
                  },
                ]).observations,
              )
            }
          >
            Import local evidence sample
          </button>
          <button type="button" className="btn" onClick={() => setReviewState('quarantined')}>
            Quarantine match
          </button>
        </div>
        <p className="form-error" role="status">
          {imported.errors.join('; ') ||
            `${working.length} local observation(s). Live fetching and scraping are locked off.`}
        </p>
      </section>
      <section className="card">
        <h2>Recommendation preview</h2>
        <dl className="kv">
          <dt>Normalised competitor ex GST</dt>
          <dd>AUD {rec.normalisedCompetitorEx ?? 'n/a'}</dd>
          <dt>Cost floor</dt>
          <dd>AUD {rec.floorEx ?? 'n/a'}</dd>
          <dt>Recommendation</dt>
          <dd>{rec.blocked ? 'Blocked' : `AUD ${rec.recommendedEx}`}</dd>
          <dt>State</dt>
          <dd>{rec.exception}</dd>
          <dt>Reason</dt>
          <dd>{rec.reason}</dd>
        </dl>
      </section>
    </Page>
  );
}

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
