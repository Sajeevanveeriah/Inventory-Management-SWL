import { useEffect, useMemo, useRef } from "react";
import Big from "big.js";
import {
  suggestMappings,
  type ColumnMapping,
  type MappingProfile,
} from "../core/mapping";
import { SUPPLIER_FIELDS, SERVICEM8_FIELDS } from "../core/fields";
import type { FileRole } from "../core/table";
import { parseFile, ParseError } from "../io/parse";
import { buildAllOutputs } from "../io/exportWorkbooks";
import { usePlatform } from "../platform/context";
import {
  computeComparison,
  loadPersistentConfiguration,
  useAppDispatch,
  useAppState,
  type AppState,
  type StepId,
} from "./store";
import type { Settings } from "../core/settings";
import type { AttachedReference } from "../core/sources";
import {
  demoServicem8File,
  demoSupplierFile,
  DEMO_ALIAS,
  DEMO_PROFILE_NAME,
} from "../demo/fixtures";
import { normalizeIdentifier } from "../core/normalize";

/**
 * Async orchestration around the pure core. Suggested mappings are applied as
 * PRE-SELECTED values that the operator still reviews and confirms on the
 * mapping step before any comparison can run.
 */
export function useActions() {
  const dispatch = useAppDispatch();
  const state = useAppState();
  const platform = usePlatform();
  const approvalGuards = useRef(new Map<string, "pending" | "committed">());

  useEffect(() => {
    for (const [guard, status] of approvalGuards.current) {
      const rowId = guard.split("\u0000", 1)[0] ?? "";
      if (
        status === "committed" &&
        state.review.committedApprovals[rowId] === true
      ) {
        // The reducer is now the durable UI guard. Releasing this transient
        // bridge also allows the same synthetic record to be approved again
        // after an explicit full application-data reset.
        approvalGuards.current.delete(guard);
      }
    }
  }, [state.review.committedApprovals]);

  return useMemo(() => {
    const announce = (message: string) =>
      dispatch({ type: "announce", message });

    const loadFile = async (
      role: FileRole,
      file: File,
      preferredSheet?: string,
    ) => {
      dispatch({ type: "file-loading", role });
      try {
        const table = await parseFile(file, preferredSheet);
        dispatch({ type: "file-loaded", role, table, file });
        const fields = role === "supplier" ? SUPPLIER_FIELDS : SERVICEM8_FIELDS;
        const suggestions = suggestMappings(table.headers, fields);
        const mapping: ColumnMapping = {};
        for (const s of suggestions) mapping[s.field] = s.columnIndex;
        dispatch({ type: "set-mapping", role, mapping });
        announce(
          `${file.name} loaded: ${table.rows.length} data rows, ${table.headers.length} columns.`,
        );
      } catch (err) {
        const message =
          err instanceof ParseError
            ? err.message
            : `“${file.name}” could not be read.`;
        const detail =
          err instanceof ParseError
            ? err.detail
            : "An unexpected parsing problem occurred. Re-export the file and try again.";
        dispatch({ type: "file-error", role, message, detail });
        announce(`File rejected: ${message}`);
      }
    };

    const loadDemo = async () => {
      dispatch({ type: "set-demo-mode", on: true });
      dispatch({
        type: "alias-approved",
        alias: {
          supplierCode: normalizeIdentifier(DEMO_ALIAS.supplierCode),
          itemNumber: normalizeIdentifier(DEMO_ALIAS.itemNumber),
          approvedAt: new Date().toISOString(),
        },
        persisted: false,
      });
      await loadFile("supplier", demoSupplierFile());
      await loadFile("servicem8", demoServicem8File());
      dispatch({ type: "go-to-step", step: "files" });
      announce(
        "Fictional demonstration data loaded. All records are synthetic.",
      );
    };

    const runCompare = (current: AppState, goTo: StepId = "validate") => {
      if (current.configurationHydration.status !== "ready") {
        announce(
          "Comparison is blocked until stored configuration is loaded and verified.",
        );
        return;
      }
      const comparison = computeComparison(current);
      if (comparison === null) return;
      dispatch({
        type: "comparison-run",
        comparison,
        startedAt: new Date().toISOString(),
      });
      dispatch({ type: "go-to-step", step: goTo });
      announce(
        `Comparison complete: ${comparison.totals.priceChanged} price changes, ${comparison.totals.newItems} new items, ${comparison.totals.blocked} blocked records.`,
      );
    };

    const saveProfile = async (name: string) => {
      const existing = state.profiles.find((p) => p.name === name);
      const profile: MappingProfile = {
        id: existing?.id ?? `profile-${Date.now().toString(36)}`,
        name,
        version: (existing?.version ?? 0) + 1,
        supplierMapping: state.supplierMapping,
        supplierHeaders: state.supplier.table?.headers ?? [],
        servicem8Mapping: state.s8Mapping,
        servicem8Headers: state.servicem8.table?.headers ?? [],
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const saved = await platform.profiles.save(profile);
      if (!saved.ok) {
        announce(saved.error.message);
        return;
      }
      dispatch({ type: "profile-saved", profile });
      announce(`Mapping profile “${name}” saved (version ${profile.version}).`);
    };

    const applyProfile = (profile: MappingProfile) => {
      dispatch({ type: "profile-applied", profile });
      announce(
        `Mapping profile “${profile.name}” applied. Review the mappings before comparing.`,
      );
    };

    const changeSettings = async (
      settings: Settings,
      description: string,
      businessRule = true,
    ) => {
      const saved = await platform.settings.save(settings);
      if (!saved.ok) {
        announce(saved.error.message);
        return false;
      }
      // A safety-critical rule is not exposed to comparison, approval or
      // export until the authoritative platform store has accepted it.
      dispatch({
        type: "settings-changed",
        settings: saved.value,
        description,
        businessRule,
      });
      announce(`Settings updated: ${description}`);
      return true;
    };

    const approveAlias = async (
      supplierCode: string,
      itemNumber: string,
      persist: boolean,
    ) => {
      const alias = {
        supplierCode: normalizeIdentifier(supplierCode),
        itemNumber: normalizeIdentifier(itemNumber),
        approvedAt: new Date().toISOString(),
      };
      if (persist) {
        const saved = await platform.aliases.save(alias);
        if (!saved.ok) {
          announce(saved.error.message);
          return;
        }
      }
      dispatch({ type: "alias-approved", alias, persisted: persist });
      announce(
        `Alias approved: ${alias.supplierCode} now matches ServiceM8 item ${alias.itemNumber}. Re-run the comparison to apply it.`,
      );
    };

    const generateOutputs = async () => {
      if (state.configurationHydration.status !== "ready") {
        announce(
          "Export is blocked until stored configuration is loaded and verified.",
        );
        return;
      }
      if (
        state.comparison === null ||
        state.supplier.table === null ||
        state.servicem8.table === null
      )
        return;
      const expectedRevision = state.outputRevision;
      const outputs = await buildAllOutputs({
        comparison: state.comparison,
        decisions: state.review.decisions,
        supplierTable: state.supplier.table,
        s8Table: state.servicem8.table,
        s8Mapping: state.s8Mapping,
        profileName:
          state.activeProfileName === "unsaved profile" && state.demoMode
            ? DEMO_PROFILE_NAME
            : state.activeProfileName,
        profileVersion: state.activeProfileVersion,
        taxHandling: state.settings.taxHandling,
        settingsChanges: state.settingsChanges,
        startedAt: state.comparisonStartedAt ?? new Date().toISOString(),
        now: new Date(),
      });
      dispatch({ type: "outputs-ready", outputs, expectedRevision });
    };

    const deleteProfile = async (id: string) => {
      const removed = await platform.profiles.delete(id);
      if (!removed.ok) {
        announce(removed.error.message);
        return false;
      }
      dispatch({
        type: "profiles-loaded",
        profiles: state.profiles.filter((profile) => profile.id !== id),
      });
      return true;
    };

    const reloadPersistentConfiguration = async () => {
      dispatch({ type: "configuration-hydration-started" });
      const loaded = await loadPersistentConfiguration(platform);
      if (!loaded.ok) {
        dispatch({
          type: "configuration-hydration-failed",
          error: loaded.error,
        });
        announce(loaded.error);
        return false;
      }
      dispatch({ type: "configuration-hydration-succeeded", ...loaded.value });
      return true;
    };

    const approveRows = async (rowIds: string[]) => {
      if (state.configurationHydration.status !== "ready") {
        announce(
          "Approval is blocked until stored configuration is loaded and verified.",
        );
        return false;
      }
      const uniqueRowIds = [...new Set(rowIds)];
      const rows = (state.comparison?.rows ?? []).filter(
        (row) =>
          uniqueRowIds.includes(row.id) &&
          (row.status === "new-item" || row.status === "price-changed") &&
          row.supplier?.cost != null &&
          row.proposedSell !== null &&
          state.review.committedApprovals[row.id] !== true,
      );
      if (rows.length !== uniqueRowIds.length) {
        announce(
          "One or more selected records are blocked or already recorded.",
        );
        return false;
      }
      const guards = rows.map(
        (row) =>
          `${row.id}\u0000${row.supplier?.cost ?? ""}\u0000${row.proposedSell ?? ""}`,
      );
      if (guards.some((guard) => approvalGuards.current.has(guard))) {
        announce(
          "This approval is already being recorded or has already been recorded.",
        );
        return false;
      }
      for (const guard of guards) approvalGuards.current.set(guard, "pending");
      const changes = rows.map((row) => {
        const gstBasis =
          state.settings.taxHandling === "prices-inc-gst"
            ? ("inc-gst" as const)
            : state.settings.taxHandling === "prices-ex-gst"
              ? ("ex-gst" as const)
              : ("unknown" as const);
        const item = {
          id: row.s8?.itemNumber || row.supplier?.code || row.id,
          itemNumber: row.s8?.itemNumber || row.supplier?.code || row.id,
          description: row.supplier?.description || row.s8?.description || "",
          costCents: Number(
            new Big(row.supplier?.cost as string).times(100).toFixed(0),
          ),
          sellPriceCents: Number(
            new Big(row.proposedSell as string).times(100).toFixed(0),
          ),
          // Record the operator's explicit GST selection without inferring or
          // transforming any source value.
          gstBasis,
          updatedAt: new Date().toISOString(),
        };
        return {
          item,
          approvedBy: "Local operator",
          reason: `Explicit operator approval of ${row.status}`,
        };
      });
      let published: Awaited<
        ReturnType<typeof platform.catalogue.publishApproved>
      >;
      try {
        published = await platform.catalogue.publishApproved(changes);
      } catch {
        for (const guard of guards) approvalGuards.current.delete(guard);
        announce(
          "Approval was not recorded because the local platform service failed safely.",
        );
        return false;
      }
      if (!published.ok) {
        for (const guard of guards) approvalGuards.current.delete(guard);
        announce(`Approval was not recorded: ${published.error.message}`);
        return false;
      }
      for (const guard of guards)
        approvalGuards.current.set(guard, "committed");
      dispatch({ type: "approve", rowIds: uniqueRowIds });
      announce(
        `Approved and recorded ${rowIds.length} record${rowIds.length === 1 ? "" : "s"}.`,
      );
      return true;
    };

    const toggleCompetitorSource = async (sourceId: string) => {
      const next = state.competitorSources.map((source) =>
        source.id === sourceId
          ? { ...source, enabled: !source.enabled }
          : source,
      );
      const saved = await platform.sources.replace(next);
      if (!saved.ok) {
        announce(saved.error.message);
        return false;
      }
      dispatch({ type: "sources-loaded", sources: saved.value });
      return true;
    };

    const attachReference = async (
      itemId: string,
      result: Parameters<typeof platform.references.attach>[1],
      reference: AttachedReference,
    ) => {
      const attached = await platform.references.attach(itemId, result);
      if (!attached.ok) {
        announce(attached.error.message);
        return false;
      }
      dispatch({ type: "reference-attached", reference });
      announce(
        `Reference price stored for ${itemId}. No cost or sell price changed.`,
      );
      return true;
    };

    const clearStoredStateAfterReset = async () => {
      dispatch({ type: "clear-session" });
      return reloadPersistentConfiguration();
    };

    const reloadAfterRestore = async () => {
      dispatch({ type: "clear-session" });
      return reloadPersistentConfiguration();
    };

    return {
      announce,
      loadFile,
      loadDemo,
      runCompare,
      saveProfile,
      applyProfile,
      changeSettings,
      approveAlias,
      generateOutputs,
      deleteProfile,
      reloadPersistentConfiguration,
      approveRows,
      toggleCompetitorSource,
      attachReference,
      clearStoredStateAfterReset,
      reloadAfterRestore,
    };
  }, [dispatch, platform, state]);
}
