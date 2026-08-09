import { useRef, useState } from "react";
import type { MappingProfile } from "../../core/mapping";
import { triggerDownload } from "../../io/download";
import { usePlatform } from "../../platform/context";
import { MappingProfileSchema } from "../../platform/schemas";
import { useAppDispatch, useAppState } from "../../state/store";
import { useActions } from "../../state/useActions";
import { ConfirmDialog } from "../ConfirmDialog";
import { EmptyState, Page } from "./PageChrome";

/**
 * Supplier mapping profiles: the durable per-supplier configuration
 * (column mappings and header fingerprints). Profiles never contain
 * business rows — only operator-authored mapping metadata.
 */
export function SuppliersPage() {
  const state = useAppState();
  const platform = usePlatform();
  const dispatch = useAppDispatch();
  const actions = useActions();
  const [name, setName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<MappingProfile | null>(
    null,
  );
  const [importError, setImportError] = useState("");
  const importInput = useRef<HTMLInputElement>(null);
  const filesLoaded =
    state.supplier.table !== null && state.servicem8.table !== null;
  const nameValid = name.trim().length >= 3;

  const exportProfile = (profile: MappingProfile) => {
    const blob = new Blob([JSON.stringify(profile, null, 2)], {
      type: "application/json",
    });
    triggerDownload(
      blob,
      `${profile.name.replace(/[^A-Za-z0-9_-]+/g, "-")}-mapping-profile.json`,
    );
    actions.announce(`Mapping profile "${profile.name}" exported as JSON.`);
  };

  const importProfile = async (file: File) => {
    setImportError("");
    try {
      if (file.size === 0 || file.size > 1024 * 1024) {
        setImportError(
          "The mapping profile file size is outside the supported range.",
        );
        return;
      }
      const parsed = JSON.parse(await file.text()) as Partial<MappingProfile>;
      if (
        typeof parsed.name !== "string" ||
        parsed.name.trim() === "" ||
        typeof parsed.supplierMapping !== "object" ||
        typeof parsed.servicem8Mapping !== "object" ||
        !Array.isArray(parsed.supplierHeaders) ||
        !Array.isArray(parsed.servicem8Headers)
      ) {
        setImportError("The file is not a valid mapping profile export.");
        return;
      }
      const existing = state.profiles.find((p) => p.name === parsed.name);
      const profile: MappingProfile = {
        id: existing?.id ?? `profile-${Date.now().toString(36)}`,
        name: parsed.name.trim(),
        version: (existing?.version ?? 0) + 1,
        supplierMapping: parsed.supplierMapping ?? {},
        servicem8Mapping: parsed.servicem8Mapping ?? {},
        supplierHeaders: parsed.supplierHeaders.map(String),
        servicem8Headers: parsed.servicem8Headers.map(String),
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      if (!MappingProfileSchema.safeParse(profile).success) {
        setImportError("The file is not a valid mapping profile export.");
        return;
      }
      const saved = await platform.profiles.save(profile);
      if (!saved.ok) {
        setImportError(saved.error.message);
        return;
      }
      dispatch({ type: "profile-saved", profile });
      actions.announce(
        `Mapping profile "${profile.name}" imported (version ${profile.version}).`,
      );
    } catch {
      setImportError("The file could not be read as JSON.");
    }
  };

  const chooseProfileFile = async () => {
    if (platform.kind === "web") {
      importInput.current?.click();
      return;
    }
    const selected = await platform.files.chooseInputFile("configuration");
    if (!selected.ok) {
      if (selected.error.code !== "cancelled")
        setImportError(selected.error.message);
      return;
    }
    if (selected.value !== null) await importProfile(selected.value);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const removed = await actions.deleteProfile(pendingDelete.id);
    if (removed)
      actions.announce(`Mapping profile "${pendingDelete.name}" deleted.`);
    setPendingDelete(null);
  };

  return (
    <Page title="Suppliers">
      <section className="card">
        <h2>Save the current mapping as a profile</h2>
        <div className="form-grid">
          <label>
            Profile name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={name !== "" && !nameValid}
              placeholder="e.g. Fictionville Wholesale"
            />
          </label>
          <label>
            Header fingerprint
            <input
              readOnly
              value={
                state.supplier.table
                  ? `${state.supplier.table.headers.length} supplier columns`
                  : "No supplier file loaded"
              }
            />
          </label>
        </div>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!nameValid || !filesLoaded}
            onClick={() => {
              void actions.saveProfile(name.trim());
              setName("");
            }}
          >
            Save profile
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void chooseProfileFile()}
          >
            Import profile JSON
          </button>
          {platform.kind === "web" && (
            <input
              ref={importInput}
              type="file"
              accept="application/json,.json"
              hidden
              aria-label="Import a mapping profile JSON file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importProfile(file);
                event.target.value = "";
              }}
            />
          )}
        </div>
        {!filesLoaded && (
          <p className="hint" role="status">
            Load both files in a run before saving a new profile.
          </p>
        )}
        {importError !== "" && (
          <p className="form-error" role="alert">
            {importError}
          </p>
        )}
      </section>

      {state.profiles.length === 0 ? (
        <EmptyState
          title="No saved profiles"
          detail={`Profiles store supplier-specific column mappings and header fingerprints locally in ${
            platform.kind === "desktop" ? "application data" : "this browser"
          }, so repeat runs map instantly. No business rows are ever stored.`}
        />
      ) : (
        <div
          className="table-scroll"
          role="region"
          aria-label="Saved profiles"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Profile</th>
                <th scope="col">Version</th>
                <th scope="col">Supplier columns</th>
                <th scope="col">ServiceM8 columns</th>
                <th scope="col">Updated</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {state.profiles.map((profile) => (
                <tr key={profile.id}>
                  <td>
                    {profile.name}
                    {state.activeProfileName === profile.name && (
                      <span className="badge badge-unchanged"> active</span>
                    )}
                  </td>
                  <td className="num">v{profile.version}</td>
                  <td className="num">{profile.supplierHeaders.length}</td>
                  <td className="num">{profile.servicem8Headers.length}</td>
                  <td>{profile.updatedAt.slice(0, 10)}</td>
                  <td>
                    <div className="btn-row btn-row-tight">
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => actions.applyProfile(profile)}
                      >
                        Apply
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => exportProfile(profile)}
                      >
                        Export JSON
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => setPendingDelete(profile)}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete mapping profile"
        body={`Delete the saved mapping profile "${pendingDelete?.name ?? ""}" from ${
          platform.kind === "desktop"
            ? "local application data"
            : "this browser"
        }? This cannot be undone.`}
        confirmLabel="Delete profile"
        danger
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </Page>
  );
}
