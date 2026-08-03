import { useMemo } from 'react';
import { suggestMappings, type ColumnMapping, type MappingProfile } from '../core/mapping';
import { SUPPLIER_FIELDS, SERVICEM8_FIELDS } from '../core/fields';
import type { FileRole } from '../core/table';
import { parseFile, ParseError } from '../io/parse';
import { buildAllOutputs } from '../io/exportWorkbooks';
import * as db from '../storage/db';
import {
  computeComparison,
  useAppDispatch,
  useAppState,
  type AppState,
  type StepId,
} from './store';
import type { Settings } from '../core/settings';
import {
  demoServicem8File,
  demoSupplierFile,
  DEMO_ALIAS,
  DEMO_PROFILE_NAME,
} from '../demo/fixtures';
import { normalizeIdentifier } from '../core/normalize';

/**
 * Async orchestration around the pure core. Suggested mappings are applied as
 * PRE-SELECTED values that the operator still reviews and confirms on the
 * mapping step before any comparison can run.
 */
export function useActions() {
  const dispatch = useAppDispatch();
  const state = useAppState();

  return useMemo(() => {
    const announce = (message: string) => dispatch({ type: 'announce', message });

    const loadFile = async (role: FileRole, file: File, preferredSheet?: string) => {
      dispatch({ type: 'file-loading', role });
      try {
        const table = await parseFile(file, preferredSheet);
        dispatch({ type: 'file-loaded', role, table, file });
        const fields = role === 'supplier' ? SUPPLIER_FIELDS : SERVICEM8_FIELDS;
        const suggestions = suggestMappings(table.headers, fields);
        const mapping: ColumnMapping = {};
        for (const s of suggestions) mapping[s.field] = s.columnIndex;
        dispatch({ type: 'set-mapping', role, mapping });
        announce(
          `${file.name} loaded: ${table.rows.length} data rows, ${table.headers.length} columns.`,
        );
      } catch (err) {
        const message =
          err instanceof ParseError ? err.message : `“${file.name}” could not be read.`;
        const detail =
          err instanceof ParseError
            ? err.detail
            : 'An unexpected parsing problem occurred. Re-export the file and try again.';
        dispatch({ type: 'file-error', role, message, detail });
        announce(`File rejected: ${message}`);
      }
    };

    const loadDemo = async () => {
      dispatch({ type: 'set-demo-mode', on: true });
      dispatch({
        type: 'alias-approved',
        alias: {
          supplierCode: normalizeIdentifier(DEMO_ALIAS.supplierCode),
          itemNumber: normalizeIdentifier(DEMO_ALIAS.itemNumber),
          approvedAt: new Date().toISOString(),
        },
        persisted: false,
      });
      await loadFile('supplier', demoSupplierFile());
      await loadFile('servicem8', demoServicem8File());
      dispatch({ type: 'go-to-step', step: 'files' });
      announce('Fictional demonstration data loaded. All records are synthetic.');
    };

    const runCompare = (current: AppState, goTo: StepId = 'validate') => {
      const comparison = computeComparison(current);
      if (comparison === null) return;
      dispatch({
        type: 'comparison-run',
        comparison,
        startedAt: new Date().toISOString(),
      });
      dispatch({ type: 'go-to-step', step: goTo });
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
      await db.saveProfile(profile);
      dispatch({ type: 'profile-saved', profile });
      announce(`Mapping profile “${name}” saved (version ${profile.version}).`);
    };

    const applyProfile = (profile: MappingProfile) => {
      dispatch({ type: 'profile-applied', profile });
      announce(`Mapping profile “${profile.name}” applied. Review the mappings before comparing.`);
    };

    const changeSettings = async (settings: Settings, description: string, businessRule = true) => {
      await db.saveSettings(settings);
      dispatch({ type: 'settings-changed', settings, description, businessRule });
      announce(`Settings updated: ${description}`);
    };

    const approveAlias = async (supplierCode: string, itemNumber: string, persist: boolean) => {
      const alias = {
        supplierCode: normalizeIdentifier(supplierCode),
        itemNumber: normalizeIdentifier(itemNumber),
        approvedAt: new Date().toISOString(),
      };
      if (persist) await db.saveAlias(alias);
      dispatch({ type: 'alias-approved', alias, persisted: persist });
      announce(
        `Alias approved: ${alias.supplierCode} now matches ServiceM8 item ${alias.itemNumber}. Re-run the comparison to apply it.`,
      );
    };

    const generateOutputs = async () => {
      if (
        state.comparison === null ||
        state.supplier.table === null ||
        state.servicem8.table === null
      )
        return;
      const outputs = await buildAllOutputs({
        comparison: state.comparison,
        decisions: state.review.decisions,
        supplierTable: state.supplier.table,
        s8Table: state.servicem8.table,
        s8Mapping: state.s8Mapping,
        profileName:
          state.activeProfileName === 'unsaved profile' && state.demoMode
            ? DEMO_PROFILE_NAME
            : state.activeProfileName,
        profileVersion: state.activeProfileVersion,
        taxHandling: state.settings.taxHandling,
        settingsChanges: state.settingsChanges,
        startedAt: state.comparisonStartedAt ?? new Date().toISOString(),
        now: new Date(),
      });
      dispatch({ type: 'outputs-ready', outputs });
      announce(`${outputs.length} output files generated and ready to download.`);
    };

    const deleteStoredData = async () => {
      await db.deleteAllStoredData();
      dispatch({ type: 'profiles-loaded', profiles: [] });
      dispatch({ type: 'aliases-loaded', aliases: [] });
      announce('All saved profiles, aliases and settings have been deleted from this browser.');
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
      deleteStoredData,
    };
  }, [dispatch, state]);
}
