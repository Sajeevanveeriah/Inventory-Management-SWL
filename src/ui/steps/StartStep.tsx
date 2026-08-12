import { TAX_HANDLING_OPTIONS } from "../../core/settings";
import { ROUNDING_RULE_LABEL } from "../../core/money";
import { useAppDispatch, useAppState } from "../../state/store";
import { useActions } from "../../state/useActions";
import { usePlatform } from "../../platform/context";

export function StartStep() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const actions = useActions();
  const platform = usePlatform();

  return (
    <div>
      <div className="card">
        <h2>Supplier price comparison for ServiceM8</h2>
        <p>
          This tool compares an untouched supplier price export against your
          current ServiceM8 materials list, applies the confirmed 30% markup on
          cost, and prepares a controlled, reviewed import file - together with
          change, exception, rollback and audit reports.
        </p>
        <div className="callout callout-ok">
          <strong>Local processing only.</strong> Files are read and processed
          entirely in{" "}
          {platform.kind === "desktop"
            ? "application memory"
            : "this browser tab"}
          . Nothing is uploaded, and imported rows are never stored. See the
          Privacy panel in the header for exactly what is and is not kept.
        </div>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => dispatch({ type: "go-to-step", step: "files" })}
          >
            Start new comparison
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void actions.loadDemo()}
          >
            Load synthetic demonstration
          </button>
        </div>
        <p className="muted small" style={{ marginTop: "0.6rem" }}>
          The demonstration uses clearly fictional “Fictionville” products so
          the full workflow can be evaluated before genuine exports are
          available.
        </p>
      </div>

      <div className="grid-2">
        <section className="card" aria-labelledby="start-rules">
          <h3 id="start-rules">Current business rules</h3>
          <div
            className="file-meta"
            style={{ borderTop: 0, paddingTop: 0, marginTop: 0 }}
          >
            <dl>
              <dt>Pricing rule</dt>
              <dd>
                Selling price = supplier cost ×{" "}
                {(1 + Number(state.settings.markupPercent) / 100).toString()} (
                {state.settings.markupPercent}% markup on cost)
              </dd>
              <dt>Rounding</dt>
              <dd>{ROUNDING_RULE_LABEL}</dd>
              <dt>Currency</dt>
              <dd>AUD</dd>
              <dt>Tax handling</dt>
              <dd>{TAX_HANDLING_OPTIONS[state.settings.taxHandling]}</dd>
            </dl>
          </div>
          <p className="muted small">
            Markup and tax settings can be changed in Settings; every change
            requires confirmation and is recorded in the audit report.
          </p>
        </section>

        <section className="card" aria-labelledby="start-profiles">
          <h3 id="start-profiles">Saved mapping profiles</h3>
          {state.profiles.length === 0 ? (
            <p className="muted">
              No profiles saved yet. After you map columns for a supplier, save
              the layout as a profile so future comparisons are one click.
            </p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: "1.2rem" }}>
              {state.profiles.map((p) => (
                <li key={p.id} style={{ marginBottom: "0.4rem" }}>
                  <strong>{p.name}</strong>{" "}
                  <span className="muted small">
                    v{p.version} · updated {p.updatedAt.slice(0, 10)}
                  </span>{" "}
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => actions.applyProfile(p)}
                  >
                    Use profile
                  </button>
                </li>
              ))}
            </ul>
          )}
          {state.aliases.length > 0 && (
            <p className="muted small" style={{ marginTop: "0.6rem" }}>
              {state.aliases.length} approved alias
              {state.aliases.length === 1 ? "" : "es"} saved in
              {platform.kind === "desktop"
                ? " local application data."
                : " this browser."}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
