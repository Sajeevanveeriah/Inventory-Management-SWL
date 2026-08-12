import { useState } from 'react';
import { ROUNDING_RULE_LABEL } from '../core/money';
import {
  GLASS_TINT_OPTIONS,
  TAX_HANDLING_OPTIONS,
  type AppearanceTheme,
  type GlassTint,
  type Settings,
  type TaxHandling,
} from '../core/settings';
import { useAppState } from '../state/store';
import { useActions } from '../state/useActions';
import { AppearanceControl } from './AppearanceControl';
import { Dialog } from './Dialog';

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  appearanceSaving: boolean;
  onAppearanceChange: (
    change: Partial<Pick<Settings, 'theme' | 'glassTint'>>,
    description: string,
  ) => Promise<boolean>;
}

export function SettingsDialog({
  open,
  onClose,
  appearanceSaving,
  onAppearanceChange,
}: SettingsDialogProps) {
  const state = useAppState();
  const actions = useActions();
  const [markup, setMarkup] = useState(state.settings.markupPercent);
  const [tax, setTax] = useState<TaxHandling>(state.settings.taxHandling);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  const markupValid = /^\d{1,3}(\.\d{1,2})?$/.test(markup) && Number(markup) >= 30;
  const changed = markup !== state.settings.markupPercent || tax !== state.settings.taxHandling;
  const busy = saving || appearanceSaving;

  const apply = async () => {
    const next: Settings = {
      ...state.settings,
      markupPercent: markup,
      taxHandling: tax,
    };
    const parts: string[] = [];
    if (markup !== state.settings.markupPercent)
      parts.push(`markup changed ${state.settings.markupPercent}% → ${markup}%`);
    if (tax !== state.settings.taxHandling)
      parts.push(`supplier cost basis changed to “${TAX_HANDLING_OPTIONS[tax]}”`);
    setSaving(true);
    let saved: boolean;
    try {
      saved = await actions.changeSettings(next, parts.join('; '));
    } finally {
      setSaving(false);
    }
    if (!saved) return;
    setConfirming(false);
    onClose();
  };

  return (
    <Dialog
      open={open}
      title="Settings"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      {!confirming ? (
        <div>
          <div className="field">
            <label htmlFor="setting-markup">Markup percentage (on cost)</label>
            <span className="help">
              Selling price = supplier cost × (1 + markup ÷ 100). The confirmed business rule is
              30%. Rounding: {ROUNDING_RULE_LABEL}.
            </span>
            <input
              id="setting-markup"
              type="text"
              inputMode="decimal"
              value={markup}
              onChange={(e) => setMarkup(e.target.value)}
              aria-invalid={!markupValid}
              aria-describedby="markup-error"
            />
            {!markupValid && (
              <span
                id="markup-error"
                className="small"
                style={{ color: 'var(--danger)' }}
                role="alert"
              >
                Enter a number between 30 and 999.99. The minimum is 30%.
              </span>
            )}
          </div>
          <fieldset>
            <legend>Supplier cost basis (GST)</legend>
            <p className="help small muted" style={{ margin: '0.2rem 0 0.5rem' }}>
              State how your supplier quotes its costs. It is the one fact this tool cannot read
              from the files, and the markup must be applied to a GST-exclusive cost, so reading it
              wrongly moves every generated price by the full GST rate. Export stays blocked until
              it is set.
            </p>
            <p className="help small muted" style={{ margin: '0.2rem 0 0.5rem' }}>
              This does <strong>not</strong> decide whether each ServiceM8 price includes GST. That
              is read per row from that row&rsquo;s own &ldquo;Price Includes Taxes&rdquo; column
              and is never assumed.
            </p>
            {(Object.keys(TAX_HANDLING_OPTIONS) as TaxHandling[]).map((key) => (
              <label
                key={key}
                style={{
                  display: 'block',
                  fontWeight: 400,
                  marginBottom: '0.3rem',
                }}
              >
                <input
                  type="radio"
                  name="tax-handling"
                  value={key}
                  checked={tax === key}
                  onChange={() => setTax(key)}
                />{' '}
                {TAX_HANDLING_OPTIONS[key]}
              </label>
            ))}
          </fieldset>
          <section className="appearance-settings" aria-labelledby="appearance-settings-title">
            <div className="appearance-settings-copy">
              <h3 id="appearance-settings-title">Appearance</h3>
              <p>
                System follows the current Windows appearance automatically. Glass tint changes the
                interface material only and never changes status colours.
              </p>
            </div>
            <div className="appearance-settings-controls">
              <div className="field appearance-field">
                <span className="field-label">Theme</span>
                <AppearanceControl
                  value={state.settings.theme}
                  disabled={busy}
                  onChange={(theme: AppearanceTheme) => {
                    void onAppearanceChange({ theme }, `theme changed to ${theme}`);
                  }}
                />
              </div>
              <div className="field appearance-field">
                <span className="field-label">Glass finish</span>
                <div className="glass-tint-control" role="group" aria-label="Glass finish">
                  {(Object.keys(GLASS_TINT_OPTIONS) as GlassTint[]).map((glassTint) => (
                    <button
                      key={glassTint}
                      type="button"
                      aria-pressed={state.settings.glassTint === glassTint}
                      disabled={busy}
                      onClick={() => {
                        void onAppearanceChange(
                          { glassTint },
                          `glass finish changed to ${glassTint}`,
                        );
                      }}
                    >
                      <span
                        className={`glass-swatch glass-swatch-${glassTint}`}
                        aria-hidden="true"
                      />
                      {GLASS_TINT_OPTIONS[glassTint]}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>
          <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" disabled={busy} onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !changed || !markupValid}
              onClick={() => setConfirming(true)}
            >
              Apply changes…
            </button>
          </div>
        </div>
      ) : (
        <div>
          <div className="callout callout-warn" role="alert">
            <p style={{ marginBottom: '0.4rem' }}>
              <strong>Confirm business-rule change.</strong> This change is recorded in the audit
              report, and any existing comparison will be re-run, which may reset review decisions.
            </p>
            <ul className="small" style={{ margin: 0, paddingLeft: '1.2rem' }}>
              {markup !== state.settings.markupPercent && (
                <li>
                  Markup: {state.settings.markupPercent}% → <strong>{markup}%</strong>
                </li>
              )}
              {tax !== state.settings.taxHandling && (
                <li>
                  Supplier cost basis: <strong>{TAX_HANDLING_OPTIONS[tax]}</strong>
                </li>
              )}
            </ul>
          </div>
          <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void apply()}
            >
              {saving ? 'Saving verified settings…' : 'Confirm and apply'}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
