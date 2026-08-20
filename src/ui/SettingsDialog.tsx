import { useState } from 'react';
import { ROUNDING_RULE_LABEL } from '../core/money';
import {
  DEFAULT_SETTINGS,
  SETTING_DEFINITIONS,
  SETTING_DEFINITION_LIST,
  SettingsSchema,
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

  const markupDefinition = SETTING_DEFINITIONS.markupPercent;
  const taxDefinition = SETTING_DEFINITIONS.taxHandling;
  const themeDefinition = SETTING_DEFINITIONS.theme;
  const glassDefinition = SETTING_DEFINITIONS.glassTint;
  const pricingDefinitions = SETTING_DEFINITION_LIST.filter(
    (definition) => definition.group === 'Pricing',
  );
  const markupValid = markupDefinition.schema.safeParse(markup).success;
  const changed = markup !== state.settings.markupPercent || tax !== state.settings.taxHandling;
  const busy = saving || appearanceSaving;

  const apply = async () => {
    const parsed = SettingsSchema.safeParse({
      ...state.settings,
      markupPercent: markup,
      taxHandling: tax,
    });
    if (!parsed.success) return;
    const next = parsed.data;
    const parts: string[] = [];
    if (markup !== state.settings.markupPercent)
      parts.push(`markup changed ${state.settings.markupPercent}% → ${markup}%`);
    if (tax !== state.settings.taxHandling)
      parts.push(`supplier cost basis changed to “${taxDefinition.options[tax]}”`);
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
          {pricingDefinitions.map((definition) => {
            if (definition.key === 'markupPercent') {
              return (
                <div className="field" key={definition.key}>
                  <label htmlFor="setting-markup">
                    {definition.name} ({definition.unit})
                  </label>
                  <span className="help">
                    {definition.help} Selling price = supplier cost × (1 + markup ÷ 100). Rounding:{' '}
                    {ROUNDING_RULE_LABEL}.
                  </span>
                  <input
                    id="setting-markup"
                    type="number"
                    min={definition.min}
                    max={definition.max}
                    step={definition.step}
                    value={markup}
                    onChange={(event) => setMarkup(event.target.value)}
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
                      Enter a number between {definition.min} and {definition.max}. The minimum is{' '}
                      {definition.min}%.
                    </span>
                  )}
                </div>
              );
            }
            if (definition.key === 'taxHandling') {
              return (
                <fieldset key={definition.key}>
                  <legend>{definition.name}</legend>
                  <p className="help small muted" style={{ margin: '0.2rem 0 0.5rem' }}>
                    {definition.help} Export stays blocked until this is set.
                  </p>
                  <p className="help small muted" style={{ margin: '0.2rem 0 0.5rem' }}>
                    This does <strong>not</strong> decide whether each ServiceM8 price includes GST.
                    That is read from each row and is never assumed.
                  </p>
                  {(Object.keys(definition.options) as TaxHandling[]).map((key) => (
                    <label
                      key={key}
                      style={{ display: 'block', fontWeight: 400, marginBottom: '0.3rem' }}
                    >
                      <input
                        type="radio"
                        name="tax-handling"
                        value={key}
                        checked={tax === key}
                        onChange={() => setTax(key)}
                      />{' '}
                      {definition.options[key]}
                    </label>
                  ))}
                </fieldset>
              );
            }
            return null;
          })}
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => {
                setMarkup(DEFAULT_SETTINGS.markupPercent);
                setTax(DEFAULT_SETTINGS.taxHandling);
              }}
            >
              Reset pricing settings to defaults
            </button>
          </div>
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
                <span className="field-label">{themeDefinition.name}</span>
                <AppearanceControl
                  value={state.settings.theme}
                  disabled={busy}
                  onChange={(theme: AppearanceTheme) => {
                    void onAppearanceChange({ theme }, `theme changed to ${theme}`);
                  }}
                />
              </div>
              <div className="field appearance-field">
                <span className="field-label">{glassDefinition.name}</span>
                <div className="glass-tint-control" role="group" aria-label={glassDefinition.name}>
                  {(Object.keys(glassDefinition.options) as GlassTint[]).map((glassTint) => (
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
                      {glassDefinition.options[glassTint]}
                    </button>
                  ))}
                </div>
              </div>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => {
                  void onAppearanceChange(
                    {
                      theme: DEFAULT_SETTINGS.theme,
                      glassTint: DEFAULT_SETTINGS.glassTint,
                    },
                    'appearance reset to defaults',
                  );
                }}
              >
                Reset appearance to defaults
              </button>
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
                  Supplier cost basis: <strong>{taxDefinition.options[tax]}</strong>
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
