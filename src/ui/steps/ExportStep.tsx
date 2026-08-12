import { useState } from "react";
import { fieldsForRole } from "../../core/fields";
import { validateMapping } from "../../core/mapping";
import {
  buildReleaseChecklist,
  checklistPasses,
  rowsForImport,
} from "../../core/output";
import { TAX_HANDLING_OPTIONS } from "../../core/settings";
import { matchServiceM8Layout } from "../../core/servicem8Format";
import { triggerDownload } from "../../io/download";
import { usePlatform } from "../../platform/context";
import type {
  OutputDestinationGrant,
  PlatformSaveResult,
} from "../../platform/contracts";
import type { GeneratedOutput } from "../../io/exportWorkbooks";
import { useAppDispatch, useAppState } from "../../state/store";
import { useActions } from "../../state/useActions";

export function ExportStep() {
  const platform = usePlatform();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const actions = useActions();
  const [generating, setGenerating] = useState(false);
  const comparison = state.comparison;

  if (
    comparison === null ||
    state.supplier.table === null ||
    state.servicem8.table === null
  ) {
    return (
      <div className="card">
        <h2>Export</h2>
        <p>Run the comparison and complete the checklist first.</p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => dispatch({ type: "go-to-step", step: "mapping" })}
        >
          Go to Map columns
        </button>
      </div>
    );
  }

  const mappingComplete =
    validateMapping(
      state.supplierMapping,
      fieldsForRole("supplier"),
      state.supplier.table.headers,
    ).filter((i) => i.severity === "error").length === 0 &&
    validateMapping(
      state.s8Mapping,
      fieldsForRole("servicem8"),
      state.servicem8.table.headers,
    ).filter((i) => i.severity === "error").length === 0;
  const gates = buildReleaseChecklist({
    comparison,
    decisions: state.review.decisions,
    mappingComplete,
    layout: matchServiceM8Layout(state.servicem8.table.headers),
    markupPercent: comparison.markupPercent,
    taxHandling: TAX_HANDLING_OPTIONS[state.settings.taxHandling],
  });
  const passes = checklistPasses(gates);
  const importCount = rowsForImport(
    comparison.rows,
    state.review.decisions,
  ).length;

  return (
    <div>
      <div className="card">
        <h2>Generate outputs</h2>
        <div className="callout callout-warn">
          <strong>Do not open the import file in Excel.</strong> The generated
          CSV carries ServiceM8’s exact column contract. Opening it in a
          spreadsheet and saving rewrites long item numbers and barcodes into
          scientific notation, which cannot be undone. Import it into ServiceM8
          straight from where it is saved.
        </div>
        <div className="callout">
          <strong>ServiceM8 handoff:</strong> generate the files, choose one
          output folder, then import the file whose name contains
          <span className="mono"> servicem8-import</span> through ServiceM8
          Materials &amp; Services. No manual header or row patching is needed.
        </div>
        <p className="muted">
          {importCount} approved change(s) will be written to the ServiceM8
          import file. Unchanged, excluded, ambiguous and invalid records are
          never included. Every column this application does not own is carried
          through from your ServiceM8 export untouched. All outputs are
          generated locally and{" "}
          {platform.kind === "desktop"
            ? "remain inside the application until you write them through the native folder picker."
            : "downloaded through this browser demonstration."}
        </p>
        {!passes && (
          <div className="callout callout-danger" role="alert">
            The release checklist has failing gates. Return to the checklist
            step to repair them.
          </div>
        )}
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!passes || generating}
            onClick={() => {
              setGenerating(true);
              void actions
                .generateOutputs()
                .finally(() => setGenerating(false));
            }}
          >
            {generating ? "Generating…" : "Generate all output files"}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => dispatch({ type: "go-to-step", step: "checklist" })}
          >
            Back to checklist
          </button>
        </div>
      </div>

      {state.outputs !== null && platform.capabilities.nativeFiles && (
        <DesktopFolderPanel
          outputs={state.outputs}
          announce={actions.announce}
        />
      )}

      {state.outputs !== null && (
        <GeneratedFilesPanel
          outputs={state.outputs}
          platformKind={platform.kind}
        />
      )}
    </div>
  );
}

export function GeneratedFilesPanel({
  outputs,
  platformKind,
}: {
  outputs: GeneratedOutput[];
  platformKind: "desktop" | "web";
}) {
  return (
    <div className="card">
      <h3>Generated files</h3>
      <ul className="gate-list">
        {outputs.map((out) => (
          <li key={out.filename}>
            <span className="gate-icon gate-pass" aria-hidden="true">
              ✓
            </span>
            <div style={{ flex: 1 }}>
              <strong>{out.label}</strong>
              <div className="small mono muted">{out.filename}</div>
              {out.sanitizedCells > 0 && (
                <div className="small" style={{ color: "var(--warn)" }}>
                  {out.sanitizedCells} formula-like value(s) were neutralised
                  for safety.
                </div>
              )}
              {out.serviceM8 !== undefined && (
                <div className="small muted">
                  {out.serviceM8.rowCount} row(s) ·{" "}
                  {out.serviceM8.matchesCanonicalContract
                    ? "matches the ServiceM8 column contract exactly"
                    : `${out.serviceM8.headers.length} columns, taken from your ServiceM8 export`}
                  {out.serviceM8.formulaLikeValues.length > 0 && (
                    <>
                      {" · "}
                      <span style={{ color: "var(--warn)" }}>
                        {out.serviceM8.formulaLikeValues.length} value(s) start
                        with a formula character and were written verbatim so
                        ServiceM8 receives them unchanged
                      </span>
                    </>
                  )}
                  {out.serviceM8.damagedIdentifiers.length > 0 && (
                    <>
                      {" · "}
                      <span style={{ color: "var(--danger)" }}>
                        {out.serviceM8.damagedIdentifiers.length} item number(s)
                        were already damaged into scientific notation by a
                        spreadsheet
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>
            {platformKind === "web" && (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => triggerDownload(out.blob, out.filename)}
              >
                Download
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="muted small" style={{ marginTop: "0.7rem" }}>
        Keep the rollback workbook and audit summary with your records. Nothing
        was transmitted anywhere.{" "}
        {platformKind === "desktop"
          ? "Use the native folder picker above to write them to this computer."
          : "Files exist only on this computer once downloaded."}
      </p>
    </div>
  );
}

/**
 * Desktop-only: write every generated output into a natively chosen folder.
 * Rendered only inside the Tauri shell; the browser keeps per-file downloads.
 */
export function DesktopFolderPanel({
  outputs,
  announce,
}: {
  outputs: GeneratedOutput[];
  announce: (message: string) => void;
}) {
  const platform = usePlatform();
  const [destination, setDestination] = useState<OutputDestinationGrant | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<PlatformSaveResult | null>(null);
  const [error, setError] = useState("");
  const hasConflict =
    result?.failed.some((failure) => failure.code === "conflict") === true;

  const pick = async () => {
    const chosen = await platform.files.chooseOutputDestination();
    if (chosen.ok && chosen.value !== null) {
      setDestination(chosen.value);
      setResult(null);
      setError("");
    } else if (!chosen.ok && chosen.error.code !== "cancelled") {
      setError(chosen.error.message);
    }
  };

  const saveAll = async () => {
    if (destination === null) return;
    setSaving(true);
    try {
      const saved = await platform.files.saveOutputs(destination, outputs);
      if (!saved.ok) {
        setError(saved.error.message);
        return;
      }
      const saveResult = saved.value;
      setResult(saved.value);
      announce(
        saveResult.failed.length === 0
          ? `${saveResult.written.length} file(s) written to the chosen folder.`
          : `${saveResult.written.length} file(s) written; ${saveResult.failed.length} failed.`,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card">
      <h3>Save to output folder</h3>
      <p className="muted">
        Write all {outputs.length} generated files into one folder using the
        native Windows picker.
      </p>
      <div className="btn-row">
        <button type="button" className="btn" onClick={() => void pick()}>
          Choose output folder
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={destination === null || saving}
          onClick={() => void saveAll()}
        >
          {saving ? "Writing…" : "Write all files to folder"}
        </button>
      </div>
      {destination !== null && (
        <p className="small muted">
          Destination selected: {destination.displayName}
        </p>
      )}
      {error !== "" && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {result !== null && result.failed.length === 0 && (
        <p className="small" role="status">
          {result.written.length} file(s) written successfully.
        </p>
      )}
      {result !== null && result.failed.length > 0 && (
        <div className="callout callout-danger" role="alert">
          {result.failed.map((failure) => (
            <div key={failure.filename}>
              {failure.filename}: {failure.error}
            </div>
          ))}
          {hasConflict && (
            <>
              <p>
                An output with the same name already exists. Existing files were
                not overwritten. Cancel is the default choice.
              </p>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn"
                  autoFocus
                  onClick={() => {
                    setResult(null);
                    setError("");
                    announce(
                      "Export cancelled. Existing files were not changed.",
                    );
                  }}
                >
                  Cancel export
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void pick()}
                >
                  Choose another folder
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
