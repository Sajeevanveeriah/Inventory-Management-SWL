import { usePlatform } from "../../platform/context";
import { Page } from "./PageChrome";

interface AdapterCard {
  name: string;
  mode: string;
  state: "locked" | "file-handoff" | "available";
  detail: string;
  boundary: string;
}

const ADAPTERS: AdapterCard[] = [
  {
    name: "ServiceM8",
    mode: "File handoff (ServiceM8 Materials & Services CSV)",
    state: "file-handoff",
    detail:
      "The export step produces a ready-to-import Materials & Services CSV in the exact ServiceM8 column order. Choose one folder, write all outputs, then upload the servicem8-import CSV through ServiceM8 without copying rows or patching headers.",
    boundary:
      "No ServiceM8 API credential is required. Existing rows retain every source column except the reviewed price and cost changes; the paired rollback CSV restores prior values in one import.",
  },
  {
    name: "Xero",
    mode: "Adapter boundary only (no live connection)",
    state: "locked",
    detail:
      "Price and cost updates reach Xero indirectly through ServiceM8 or through manual import of the change report. A direct Xero adapter is represented here as a locked boundary until credentials and an approved scope exist.",
    boundary:
      "Live Xero updates are locked off. Enabling them would require explicit configuration, credentials stored outside this repository, and an explicit in-application confirmation for every write.",
  },
];

/**
 * Integration status: honest, read-only representation of the external
 * boundaries. Nothing on this page can trigger a live external update.
 */
export function IntegrationsPage() {
  const platform = usePlatform();
  return (
    <Page title="Integrations">
      <div className="integration-grid">
        {ADAPTERS.map((adapter) => (
          <section key={adapter.name} className="card">
            <div className="integration-head">
              <h2>{adapter.name}</h2>
              <span
                className={
                  adapter.state === "file-handoff"
                    ? "badge badge-unchanged"
                    : "badge badge-invalid"
                }
              >
                {adapter.state === "file-handoff" ? "File handoff" : "Locked"}
              </span>
            </div>
            <dl className="kv">
              <dt>Mode</dt>
              <dd>{adapter.mode}</dd>
              <dt>How updates flow</dt>
              <dd>{adapter.detail}</dd>
              <dt>Safety boundary</dt>
              <dd>{adapter.boundary}</dd>
            </dl>
          </section>
        ))}
      </div>
      <section className="card">
        <h2>Runtime</h2>
        <dl className="kv">
          <dt>Shell</dt>
          <dd>
            {platform.kind === "desktop"
              ? "Windows desktop application (Tauri) — exports can be written to a chosen folder via the native picker."
              : "Web browser — exports are delivered as downloads. The Windows desktop application adds native folder output."}
          </dd>
          <dt>Live external writes</dt>
          <dd>
            None possible. Every outbound update is a reviewed, exported file
            that an operator imports manually.
          </dd>
        </dl>
      </section>
    </Page>
  );
}
