import { useRef, useState } from "react";
import type { FileRole, ParsedTable } from "../core/table";
import { describeLimits } from "../io/limits";

interface FileDropProps {
  role: FileRole;
  label: string;
  hint: string;
  slot: {
    table: ParsedTable | null;
    error: { message: string; detail: string } | null;
    loading: boolean;
  };
  onFile: (file: File) => void;
  nativePicker?: boolean;
  onChooseFile?: () => void;
  onSheetChange: (sheet: string) => void;
  onClear: () => void;
}

/** Drop zone with a keyboard/screen-reader-equivalent file picker button. */
export function FileDrop({
  role,
  label,
  hint,
  slot,
  onFile,
  nativePicker = false,
  onChooseFile,
  onSheetChange,
  onClear,
}: FileDropProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const { table, error, loading } = slot;
  const inputId = `file-input-${role}`;
  const headingId = `file-heading-${role}`;

  return (
    <section aria-labelledby={headingId} className="card">
      <h3 id={headingId}>{label}</h3>
      <p className="muted small">{hint}</p>
      <div
        className={`dropzone${dragging ? " dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!nativePicker) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (nativePicker) return;
          const file = e.dataTransfer.files[0];
          if (file !== undefined) onFile(file);
        }}
      >
        <p className="muted" style={{ marginBottom: "0.6rem" }}>
          {nativePicker
            ? "Use the native Windows picker to select a CSV or XLSX file."
            : "Drag a CSV or XLSX file here, or"}
        </p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() =>
            nativePicker ? onChooseFile?.() : inputRef.current?.click()
          }
          disabled={loading}
        >
          {loading ? "Reading file…" : "Choose file"}
        </button>
        {!nativePicker && (
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept=".csv,.xlsx"
            className="visually-hidden"
            aria-label={`${label} file`}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file !== undefined) onFile(file);
              e.target.value = "";
            }}
          />
        )}
        <p
          className="muted small"
          style={{ marginTop: "0.6rem", marginBottom: 0 }}
        >
          {describeLimits()}
        </p>
      </div>

      {error !== null && (
        <div className="callout callout-danger" role="alert">
          <strong>{error.message}</strong>
          <p className="small" style={{ marginTop: "0.3rem" }}>
            {error.detail}
          </p>
        </div>
      )}

      {table !== null && (
        <div className="file-meta">
          <dl>
            <dt>File name</dt>
            <dd>{table.fileName}</dd>
            <dt>Type</dt>
            <dd>{table.fileType.toUpperCase()}</dd>
            <dt>Size</dt>
            <dd>{(table.byteSize / 1024).toFixed(1)} KB</dd>
            <dt>Sheets</dt>
            <dd>{table.sheetNames.join(", ")}</dd>
            <dt>Data rows</dt>
            <dd>{table.rows.length.toLocaleString()}</dd>
            <dt>Detected headers</dt>
            <dd>{table.headers.join(" · ")}</dd>
            <dt>Validation</dt>
            <dd>
              <span className="badge badge-approved">Readable</span>
              {table.warnings.length > 0 && (
                <ul
                  className="small"
                  style={{ margin: "0.3rem 0 0", paddingLeft: "1.1rem" }}
                >
                  {table.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
            </dd>
          </dl>
          {table.sheetNames.length > 1 && (
            <div className="field" style={{ marginTop: "0.7rem" }}>
              <label htmlFor={`${inputId}-sheet`}>Worksheet to use</label>
              <select
                id={`${inputId}-sheet`}
                value={table.selectedSheet}
                onChange={(e) => onSheetChange(e.target.value)}
              >
                {table.sheetNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="btn-row" style={{ marginTop: "0.7rem" }}>
            <button type="button" className="btn btn-sm" onClick={onClear}>
              Remove file
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
