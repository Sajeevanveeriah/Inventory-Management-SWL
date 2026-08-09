import { useState } from "react";
import { ROUNDING_RULE_LABEL } from "../core/money";
import {
  TAX_HANDLING_OPTIONS,
  type Settings,
  type TaxHandling,
} from "../core/settings";
import { useAppState } from "../state/store";
import { useActions } from "../state/useActions";
import { Dialog } from "./Dialog";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const state = useAppState();
  const actions = useActions();
  const [markup, setMarkup] = useState(state.settings.markupPercent);
  const [tax, setTax] = useState<TaxHandling>(state.settings.taxHandling);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  const markupValid =
    /^\d{1,3}(\.\d{1,2})?$/.test(markup) && Number(markup) >= 30;
  const changed =
    markup !== state.settings.markupPercent ||
    tax !== state.settings.taxHandling;

  const apply = async () => {
    const next: Settings = {
      ...state.settings,
      markupPercent: markup,
      taxHandling: tax,
    };
    const parts: string[] = [];
    if (markup !== state.settings.markupPercent)
      parts.push(
        `markup changed ${state.settings.markupPercent}% → ${markup}%`,
      );
    if (tax !== state.settings.taxHandling)
      parts.push(`tax handling changed to “${TAX_HANDLING_OPTIONS[tax]}”`);
    setSaving(true);
    const saved = await actions.changeSettings(next, parts.join("; "));
    setSaving(false);
    if (!saved) return;
    setConfirming(false);
    onClose();
  };

  return (
    <Dialog open={open} title="Settings" onClose={onClose}>
      {!confirming ? (
        <div>
          <div className="field">
            <label htmlFor="setting-markup">Markup percentage (on cost)</label>
            <span className="help">
              Selling price = supplier cost × (1 + markup ÷ 100). The confirmed
              business rule is 30%. Rounding: {ROUNDING_RULE_LABEL}.
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
                style={{ color: "var(--danger)" }}
                role="alert"
              >
                Enter a number between 30 and 999.99. The minimum is 30%.
              </span>
            )}
          </div>
          <fieldset>
            <legend>Tax handling (GST)</legend>
            <p
              className="help small muted"
              style={{ margin: "0.2rem 0 0.5rem" }}
            >
              This tool does not infer or alter GST treatment. No transformation
              is applied under any option; the selection is recorded in the
              audit report so downstream use is unambiguous.
            </p>
            {(Object.keys(TAX_HANDLING_OPTIONS) as TaxHandling[]).map((key) => (
              <label
                key={key}
                style={{
                  display: "block",
                  fontWeight: 400,
                  marginBottom: "0.3rem",
                }}
              >
                <input
                  type="radio"
                  name="tax-handling"
                  value={key}
                  checked={tax === key}
                  onChange={() => setTax(key)}
                />{" "}
                {TAX_HANDLING_OPTIONS[key]}
              </label>
            ))}
          </fieldset>
          <div className="field">
            <label htmlFor="setting-theme">Theme</label>
            <select
              id="setting-theme"
              value={state.settings.theme}
              disabled={saving}
              onChange={(e) => {
                setSaving(true);
                void actions
                  .changeSettings(
                    {
                      ...state.settings,
                      theme: e.target.value as Settings["theme"],
                    },
                    `theme changed to ${e.target.value}`,
                    false,
                  )
                  .finally(() => setSaving(false));
              }}
            >
              <option value="light">Light (default)</option>
              <option value="dark">Dark</option>
            </select>
          </div>
          <div className="btn-row" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving || !changed || !markupValid}
              onClick={() => setConfirming(true)}
            >
              Apply changes…
            </button>
          </div>
        </div>
      ) : (
        <div>
          <div className="callout callout-warn" role="alert">
            <p style={{ marginBottom: "0.4rem" }}>
              <strong>Confirm business-rule change.</strong> This change is
              recorded in the audit report, and any existing comparison will be
              re-run, which may reset review decisions.
            </p>
            <ul className="small" style={{ margin: 0, paddingLeft: "1.2rem" }}>
              {markup !== state.settings.markupPercent && (
                <li>
                  Markup: {state.settings.markupPercent}% →{" "}
                  <strong>{markup}%</strong>
                </li>
              )}
              {tax !== state.settings.taxHandling && (
                <li>
                  Tax handling: <strong>{TAX_HANDLING_OPTIONS[tax]}</strong>
                </li>
              )}
            </ul>
          </div>
          <div className="btn-row" style={{ justifyContent: "flex-end" }}>
            <button
              type="button"
              className="btn"
              disabled={saving}
              onClick={() => setConfirming(false)}
            >
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving}
              onClick={() => void apply()}
            >
              {saving ? "Saving verified settings…" : "Confirm and apply"}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
