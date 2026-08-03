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
import { DEFAULT_SETTINGS, type Settings, type SettingsChangeLogEntry } from '../core/settings';
import type { FileRole, ParsedTable } from '../core/table';
import type { GeneratedOutput } from '../io/exportWorkbooks';
import type { AliasRecord } from '../storage/db';
import * as db from '../storage/db';
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
  demoMode: boolean;
  /** Text for the aria-live status region. */
  announcement: string;
}

const EMPTY_SLOT: FileSlotState = { table: null, file: null, error: null, loading: false };

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
  demoMode: false,
  announcement: '',
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
  | { type: 'outputs-ready'; outputs: GeneratedOutput[] }
  | { type: 'announce'; message: string }
  | { type: 'set-demo-mode'; on: boolean }
  | { type: 'clear-session' };

function slotKey(role: FileRole): 'supplier' | 'servicem8' {
  return role === 'supplier' ? 'supplier' : 'servicem8';
}

function invalidateComparison(state: AppState): AppState {
  return { ...state, comparison: null, outputs: null, review: EMPTY_REVIEW };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'go-to-step':
      return { ...state, step: action.step };
    case 'file-loading':
      return {
        ...state,
        [slotKey(action.role)]: { table: null, file: null, error: null, loading: true },
      };
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
      return {
        ...state,
        [slotKey(action.role)]: {
          table: null,
          file: null,
          error: { message: action.message, detail: action.detail },
          loading: false,
        },
      };
    case 'file-cleared':
      return invalidateComparison({ ...state, [slotKey(action.role)]: EMPTY_SLOT });
    case 'set-mapping':
      return invalidateComparison(
        action.role === 'supplier'
          ? { ...state, supplierMapping: action.mapping }
          : { ...state, s8Mapping: action.mapping },
      );
    case 'profiles-loaded':
      return { ...state, profiles: action.profiles };
    case 'aliases-loaded':
      return { ...state, aliases: action.aliases };
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
      };
    }
    case 'settings-loaded':
      return { ...state, settings: action.settings };
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
        };
      }
      return {
        ...state,
        comparison: action.comparison,
        comparisonStartedAt: action.startedAt,
        review: EMPTY_REVIEW,
        outputs: null,
      };
    }
    case 'approve': {
      if (state.comparison === null) return state;
      const rows = state.comparison.rows.filter((r) => action.rowIds.includes(r.id));
      const result = approveRows(state.review, rows);
      return { ...state, review: result.state, outputs: null };
    }
    case 'exclude': {
      if (state.comparison === null) return state;
      const rows = state.comparison.rows.filter((r) => action.rowIds.includes(r.id));
      const result = excludeRows(state.review, rows, action.reason);
      return { ...state, review: result.state, outputs: null };
    }
    case 'clear-decision': {
      if (state.comparison === null) return state;
      const rows = state.comparison.rows.filter((r) => action.rowIds.includes(r.id));
      return { ...state, review: clearDecision(state.review, rows), outputs: null };
    }
    case 'undo':
      return { ...state, review: undo(state.review), outputs: null };
    case 'redo':
      return { ...state, review: redo(state.review), outputs: null };
    case 'reset-decisions':
      return { ...state, review: resetAllDecisions(state.review), outputs: null };
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
      return {
        ...state,
        aliases: persistedAliases,
        sessionAliases: [...without, action.alias],
      };
    }
    case 'outputs-ready':
      return { ...state, outputs: action.outputs };
    case 'announce':
      return { ...state, announcement: action.message };
    case 'set-demo-mode':
      return { ...state, demoMode: action.on };
    case 'clear-session':
      return {
        ...INITIAL_STATE,
        profiles: state.profiles,
        aliases: state.aliases,
        settings: state.settings,
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
  if (state.supplier.table === null || state.servicem8.table === null) return null;
  const supplierRecords = extractSupplierRecords(state.supplier.table, state.supplierMapping);
  const s8Records = extractS8Records(state.servicem8.table, state.s8Mapping);
  return runComparison(
    supplierRecords,
    s8Records,
    effectiveAliases(state),
    state.settings.markupPercent,
  );
}

const StateContext = createContext<AppState>(INITIAL_STATE);
const DispatchContext = createContext<Dispatch<Action>>(() => undefined);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [settings, profiles, aliases] = await Promise.all([
        db.loadSettings(),
        db.listProfiles(),
        db.listAliases(),
      ]);
      if (cancelled) return;
      dispatch({ type: 'settings-loaded', settings });
      dispatch({ type: 'profiles-loaded', profiles });
      dispatch({ type: 'aliases-loaded', aliases });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = state.settings.theme;
  }, [state.settings.theme]);

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
