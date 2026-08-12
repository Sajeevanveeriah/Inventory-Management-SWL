import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react';
import type { ComparisonResult } from '../core/compare';
import { runComparison } from '../core/compare';
import { deriveTaxConvention } from '../core/conventions';
import { costBasisFromTaxHandling } from '../core/pricing';
import type { ColumnMapping, MappingProfile } from '../core/mapping';
import { extractS8Records, extractSupplierRecords } from '../core/records';
import {
  EMPTY_REVIEW,
  approveRows,
  carryDecisionsForward,
  clearDecision,
  excludeRows,
  redo,
  resetAllDecisions,
  undo,
  type ReviewState,
} from '../core/review';
import type { CompetitorObservation } from '../core/competitors';
import {
  defaultSources,
  toggleSource,
  type AttachedReference,
  type CompetitorSource,
} from '../core/sources';
import {
  DEFAULT_SETTINGS,
  type AppearanceTheme,
  type Settings,
  type SettingsChangeLogEntry,
} from '../core/settings';
import type { FileRole, ParsedTable } from '../core/table';
import type { GeneratedOutput } from '../io/exportWorkbooks';
import type { AliasRecord } from '../platform/contracts';
import type { PlatformService } from '../platform/contracts';
import { usePlatform } from '../platform/context';
import { normalizeIdentifier } from '../core/normalize';

export interface FileSlotState {
  table: ParsedTable | null;
  /** Original File kept in memory so another sheet can be re-parsed. */
  file: File | null;
  error: { message: string; detail: string } | null;
  loading: boolean;
}

export type StepId = 'start' | 'files' | 'mapping' | 'validate' | 'review' | 'checklist' | 'export';
export const STEP_ORDER: StepId[] = [
  'start',
  'files',
  'mapping',
  'validate',
  'review',
  'checklist',
  'export',
];
export const STEP_TITLES: Record<StepId, string> = {
  start: 'Start',
  files: 'Add files',
  mapping: 'Map columns',
  validate: 'Validate & compare',
  review: 'Review changes',
  checklist: 'Pre-export checks',
  export: 'Export',
};

export interface AppState {
  step: StepId;
  supplier: FileSlotState;
  servicem8: FileSlotState;
  supplierMapping: ColumnMapping;
  s8Mapping: ColumnMapping;
  activeProfileName: string;
  activeProfileVersion: number;
  profiles: MappingProfile[];
  aliases: AliasRecord[];
  /** Session-only aliases approved during this comparison (not yet persisted). */
  sessionAliases: AliasRecord[];
  settings: Settings;
  settingsChanges: SettingsChangeLogEntry[];
  comparison: ComparisonResult | null;
  comparisonStartedAt: string | null;
  review: ReviewState;
  outputs: GeneratedOutput[] | null;
  /** Monotonic guard preventing asynchronous generation from restoring stale outputs. */
  outputRevision: number;
  competitorEvidence: CompetitorObservation[];
  competitorSources: CompetitorSource[];
  references: AttachedReference[];
  demoMode: boolean;
  /** Text for the aria-live status region. */
  announcement: string;
  /** Safety-critical persisted configuration must load before operations run. */
  configurationHydration: {
    status: 'loading' | 'ready' | 'error';
    error: string | null;
    attempt: number;
  };
}

const EMPTY_SLOT: FileSlotState = {
  table: null,
  file: null,
  error: null,
  loading: false,
};

export const INITIAL_STATE: AppState = {
  step: 'start',
  supplier: EMPTY_SLOT,
  servicem8: EMPTY_SLOT,
  supplierMapping: {},
  s8Mapping: {},
  activeProfileName: 'unsaved profile',
  activeProfileVersion: 1,
  profiles: [],
  aliases: [],
  sessionAliases: [],
  settings: DEFAULT_SETTINGS,
  settingsChanges: [],
  comparison: null,
  comparisonStartedAt: null,
  review: EMPTY_REVIEW,
  outputs: null,
  outputRevision: 0,
  competitorEvidence: [],
  competitorSources: defaultSources(),
  references: [],
  demoMode: false,
  announcement: '',
  configurationHydration: { status: 'loading', error: null, attempt: 0 },
};

export type Action =
  | { type: 'go-to-step'; step: StepId }
  | { type: 'file-loading'; role: FileRole }
  | { type: 'file-loaded'; role: FileRole; table: ParsedTable; file: File }
  | { type: 'file-error'; role: FileRole; message: string; detail: string }
  | { type: 'file-cleared'; role: FileRole }
  | { type: 'set-mapping'; role: FileRole; mapping: ColumnMapping }
  | { type: 'profiles-loaded'; profiles: MappingProfile[] }
  | { type: 'aliases-loaded'; aliases: AliasRecord[] }
  | { type: 'sources-loaded'; sources: CompetitorSource[] }
  | { type: 'configuration-hydration-started' }
  | { type: 'configuration-hydration-retry' }
  | {
      type: 'configuration-hydration-succeeded';
      settings: Settings;
      profiles: MappingProfile[];
      aliases: AliasRecord[];
      sources: CompetitorSource[];
    }
  | { type: 'configuration-hydration-failed'; error: string }
  | { type: 'profile-applied'; profile: MappingProfile }
  | { type: 'profile-saved'; profile: MappingProfile }
  | { type: 'settings-loaded'; settings: Settings }
  | {
      type: 'settings-changed';
      settings: Settings;
      description: string;
      /** Business-rule changes (markup, tax) invalidate the comparison and are audit-logged; cosmetic ones (theme) are not. */
      businessRule: boolean;
    }
  | { type: 'comparison-run'; comparison: ComparisonResult; startedAt: string }
  | { type: 'approve'; rowIds: string[] }
  | { type: 'exclude'; rowIds: string[]; reason: string }
  | { type: 'clear-decision'; rowIds: string[] }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset-decisions' }
  | { type: 'alias-approved'; alias: AliasRecord; persisted: boolean }
  | {
      type: 'outputs-ready';
      outputs: GeneratedOutput[];
      expectedRevision: number;
    }
  | { type: 'announce'; message: string }
  | { type: 'set-demo-mode'; on: boolean }
  | { type: 'evidence-added'; observations: CompetitorObservation[] }
  | { type: 'source-toggled'; sourceId: string }
  | { type: 'reference-attached'; reference: AttachedReference }
  | { type: 'clear-session' };

function slotKey(role: FileRole): 'supplier' | 'servicem8' {
  return role === 'supplier' ? 'supplier' : 'servicem8';
}

function invalidateComparison(state: AppState): AppState {
  return {
    ...state,
    comparison: null,
    outputs: null,
    review: EMPTY_REVIEW,
    outputRevision: state.outputRevision + 1,
  };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'go-to-step':
      return { ...state, step: action.step };
    case 'file-loading':
      return invalidateComparison({
        ...state,
        [slotKey(action.role)]: {
          table: null,
          file: null,
          error: null,
          loading: true,
        },
      });
    case 'file-loaded':
      return invalidateComparison({
        ...state,
        [slotKey(action.role)]: {
          table: action.table,
          file: action.file,
          error: null,
          loading: false,
        },
      });
    case 'file-error':
      return invalidateComparison({
        ...state,
        [slotKey(action.role)]: {
          table: null,
          file: null,
          error: { message: action.message, detail: action.detail },
          loading: false,
        },
      });
    case 'file-cleared':
      return invalidateComparison({
        ...state,
        [slotKey(action.role)]: EMPTY_SLOT,
      });
    case 'set-mapping':
      return invalidateComparison(
        action.role === 'supplier'
          ? { ...state, supplierMapping: action.mapping }
          : { ...state, s8Mapping: action.mapping },
      );
    case 'profiles-loaded':
      return { ...state, profiles: action.profiles };
    case 'aliases-loaded':
      return invalidateComparison({ ...state, aliases: action.aliases });
    case 'sources-loaded':
      return { ...state, competitorSources: action.sources };
    case 'configuration-hydration-started':
      return {
        ...state,
        configurationHydration: {
          ...state.configurationHydration,
          status: 'loading',
          error: null,
        },
      };
    case 'configuration-hydration-retry':
      return {
        ...state,
        configurationHydration: {
          status: 'loading',
          error: null,
          attempt: state.configurationHydration.attempt + 1,
        },
      };
    case 'configuration-hydration-succeeded':
      return invalidateComparison({
        ...state,
        settings: action.settings,
        profiles: action.profiles,
        aliases: action.aliases,
        competitorSources: action.sources,
        configurationHydration: {
          ...state.configurationHydration,
          status: 'ready',
          error: null,
        },
      });
    case 'configuration-hydration-failed':
      return invalidateComparison({
        ...state,
        configurationHydration: {
          ...state.configurationHydration,
          status: 'error',
          error: action.error,
        },
      });
    case 'profile-applied':
      return invalidateComparison({
        ...state,
        supplierMapping: action.profile.supplierMapping,
        s8Mapping: action.profile.servicem8Mapping,
        activeProfileName: action.profile.name,
        activeProfileVersion: action.profile.version,
      });
    case 'profile-saved': {
      const others = state.profiles.filter((p) => p.id !== action.profile.id);
      return {
        ...state,
        profiles: [...others, action.profile].sort((a, b) => a.name.localeCompare(b.name)),
        activeProfileName: action.profile.name,
        activeProfileVersion: action.profile.version,
        outputs: null,
        outputRevision: state.outputRevision + 1,
      };
    }
    case 'settings-loaded':
      return invalidateComparison({ ...state, settings: action.settings });
    case 'settings-changed': {
      if (!action.businessRule) {
        return { ...state, settings: action.settings };
      }
      return invalidateComparison({
        ...state,
        settings: action.settings,
        settingsChanges: [
          ...state.settingsChanges,
          { at: new Date().toISOString(), change: action.description },
        ],
      });
    }
    case 'comparison-run': {
      if (state.comparison !== null) {
        const carried = carryDecisionsForward(
          state.review,
          state.comparison.rows,
          action.comparison.rows,
        );
        return {
          ...state,
          comparison: action.comparison,
          comparisonStartedAt: action.startedAt,
          review: carried.review,
          outputs: null,
          outputRevision: state.outputRevision + 1,
        };
      }
      return {
        ...state,
        comparison: action.comparison,
        comparisonStartedAt: action.startedAt,
        review: EMPTY_REVIEW,
        outputs: null,
        outputRevision: state.outputRevision + 1,
      };
    }
    case 'approve': {
      if (state.comparison === null) return state;
      const rows = state.comparison.rows.filter((r) => action.rowIds.includes(r.id));
      const result = approveRows(state.review, rows);
      return {
        ...state,
        review: result.state,
        outputs: null,
        outputRevision: state.outputRevision + 1,
      };
    }
    case 'exclude': {
      if (state.comparison === null) return state;
      const rows = state.comparison.rows.filter((r) => action.rowIds.includes(r.id));
      const result = excludeRows(state.review, rows, action.reason);
      return {
        ...state,
        review: result.state,
        outputs: null,
        outputRevision: state.outputRevision + 1,
      };
    }
    case 'clear-decision': {
      if (state.comparison === null) return state;
      const rows = state.comparison.rows.filter((r) => action.rowIds.includes(r.id));
      return {
        ...state,
        review: clearDecision(state.review, rows),
        outputs: null,
        outputRevision: state.outputRevision + 1,
      };
    }
    case 'undo':
      return {
        ...state,
        review: undo(state.review),
        outputs: null,
        outputRevision: state.outputRevision + 1,
      };
    case 'redo':
      return {
        ...state,
        review: redo(state.review),
        outputs: null,
        outputRevision: state.outputRevision + 1,
      };
    case 'reset-decisions':
      return {
        ...state,
        review: resetAllDecisions(state.review),
        outputs: null,
        outputRevision: state.outputRevision + 1,
      };
    case 'alias-approved': {
      const without = state.sessionAliases.filter(
        (a) => a.supplierCode !== action.alias.supplierCode,
      );
      const persistedAliases = action.persisted
        ? [
            ...state.aliases.filter((a) => a.supplierCode !== action.alias.supplierCode),
            action.alias,
          ]
        : state.aliases;
      return invalidateComparison({
        ...state,
        aliases: persistedAliases,
        sessionAliases: [...without, action.alias],
      });
    }
    case 'outputs-ready':
      if (action.expectedRevision !== state.outputRevision) return state;
      return {
        ...state,
        outputs: action.outputs,
        announcement: `${action.outputs.length} output file${action.outputs.length === 1 ? '' : 's'} generated and ready to save.`,
      };
    case 'announce':
      return { ...state, announcement: action.message };
    case 'set-demo-mode':
      return { ...state, demoMode: action.on };
    case 'evidence-added':
      return {
        ...state,
        competitorEvidence: [...state.competitorEvidence, ...action.observations],
      };
    case 'source-toggled':
      return {
        ...state,
        competitorSources: toggleSource(state.competitorSources, action.sourceId),
      };
    // Reference only: stores the observation against a row without touching
    // the comparison, so no cost or sell price can change through this path.
    case 'reference-attached':
      return { ...state, references: [...state.references, action.reference] };
    case 'clear-session':
      return {
        ...INITIAL_STATE,
        profiles: state.profiles,
        aliases: state.aliases,
        settings: state.settings,
        outputRevision: state.outputRevision + 1,
        configurationHydration: state.configurationHydration,
        announcement: 'Session data cleared. Saved profiles, aliases and settings are unchanged.',
      };
    default:
      return state;
  }
}

/** Effective aliases used for matching: persisted + session-approved. */
export function effectiveAliases(state: AppState): Map<string, string> {
  const map = new Map<string, string>();
  for (const a of state.aliases)
    map.set(normalizeIdentifier(a.supplierCode), normalizeIdentifier(a.itemNumber));
  for (const a of state.sessionAliases)
    map.set(normalizeIdentifier(a.supplierCode), normalizeIdentifier(a.itemNumber));
  return map;
}

/** Run (or re-run) the comparison from current files, mappings and aliases. */
export function computeComparison(state: AppState): ComparisonResult | null {
  if (state.configurationHydration.status !== 'ready') return null;
  if (state.supplier.table === null || state.servicem8.table === null) return null;
  const supplierRecords = extractSupplierRecords(state.supplier.table, state.supplierMapping);
  const s8Records = extractS8Records(state.servicem8.table, state.s8Mapping);
  const costBasis = costBasisFromTaxHandling(state.settings.taxHandling);
  return runComparison(supplierRecords, s8Records, effectiveAliases(state), {
    markupPercent: state.settings.markupPercent,
    // An unconfirmed supplier basis still classifies every record so the data
    // can be inspected; the release checklist blocks the export instead.
    costBasis: costBasis ?? 'excluding-gst',
    costBasisConfirmed: costBasis !== null,
    newItemConvention: deriveTaxConvention(s8Records),
  });
}

const StateContext = createContext<AppState>(INITIAL_STATE);
const DispatchContext = createContext<Dispatch<Action>>(() => undefined);

export type LoadedPersistentConfiguration = {
  settings: Settings;
  profiles: MappingProfile[];
  aliases: AliasRecord[];
  sources: CompetitorSource[];
};

export async function loadPersistentConfiguration(
  platform: PlatformService,
): Promise<{ ok: true; value: LoadedPersistentConfiguration } | { ok: false; error: string }> {
  let settings: Awaited<ReturnType<PlatformService['settings']['load']>>;
  let profiles: Awaited<ReturnType<PlatformService['profiles']['list']>>;
  let aliases: Awaited<ReturnType<PlatformService['aliases']['list']>>;
  let sources: Awaited<ReturnType<PlatformService['sources']['list']>>;
  try {
    [settings, profiles, aliases, sources] = await Promise.all([
      platform.settings.load(),
      platform.profiles.list(),
      platform.aliases.list(),
      platform.sources.list(),
    ]);
  } catch {
    return {
      ok: false,
      error: 'Stored configuration could not be loaded safely.',
    };
  }
  const failed = [settings, profiles, aliases, sources].find((result) => !result.ok);
  if (failed && !failed.ok) {
    return {
      ok: false,
      error: `Stored configuration could not be loaded safely. ${failed.error.message}`,
    };
  }
  if (!settings.ok || !profiles.ok || !aliases.ok || !sources.ok) {
    return {
      ok: false,
      error: 'Stored configuration could not be loaded safely.',
    };
  }
  if (platform.kind === 'desktop') {
    try {
      const migration = await platform.configuration.migrationStatus();
      if (!migration.ok) {
        return {
          ok: false,
          error: `Legacy configuration could not be inspected safely. ${migration.error.message}`,
        };
      }
      if (migration.value.legacyConfigurationFound && !migration.value.valid) {
        const detail = migration.value.validationMessages[0];
        return {
          ok: false,
          error: `Legacy configuration could not be inspected safely.${detail ? ` ${detail}` : ''}`,
        };
      }
    } catch {
      return {
        ok: false,
        error: 'Legacy configuration could not be inspected safely.',
      };
    }
  }
  return {
    ok: true,
    value: {
      settings: settings.value,
      profiles: profiles.value,
      aliases: aliases.value,
      sources: sources.value,
    },
  };
}

export function resolveAppearanceTheme(
  preference: AppearanceTheme,
  systemPrefersDark: boolean,
): 'light' | 'dark' {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const platform = usePlatform();
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded = await loadPersistentConfiguration(platform);
      if (cancelled) return;
      if (!loaded.ok) {
        dispatch({
          type: 'configuration-hydration-failed',
          error: loaded.error,
        });
        return;
      }
      dispatch({ type: 'configuration-hydration-succeeded', ...loaded.value });
    })();
    return () => {
      cancelled = true;
    };
  }, [platform, state.configurationHydration.attempt]);

  useEffect(() => {
    const media =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;
    const applyAppearance = () => {
      const resolvedTheme = resolveAppearanceTheme(state.settings.theme, media?.matches ?? false);
      const root = document.documentElement;
      root.dataset.theme = resolvedTheme;
      root.dataset.themePreference = state.settings.theme;
      root.dataset.glassTint = state.settings.glassTint;
      root.style.colorScheme = resolvedTheme;
    };
    applyAppearance();
    if (state.settings.theme !== 'system' || media === null) return undefined;
    media.addEventListener('change', applyAppearance);
    return () => media.removeEventListener('change', applyAppearance);
  }, [state.settings.glassTint, state.settings.theme]);

  useEffect(() => {
    let cancelled = false;
    void platform.appearance.setTheme(state.settings.theme).then((result) => {
      if (cancelled || result.ok) return;
      dispatch({
        type: 'announce',
        message: `The native window appearance could not be updated. ${result.error.message}`,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [platform, state.settings.theme]);

  const stateValue = useMemo(() => state, [state]);
  return (
    <StateContext.Provider value={stateValue}>
      <DispatchContext.Provider value={dispatch}>{children}</DispatchContext.Provider>
    </StateContext.Provider>
  );
}

export function useAppState(): AppState {
  return useContext(StateContext);
}

export function useAppDispatch(): Dispatch<Action> {
  return useContext(DispatchContext);
}
