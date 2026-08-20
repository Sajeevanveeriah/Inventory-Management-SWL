import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react';
import type { CataloguePricingContext, ComparisonResult } from '../core/compare';
import { runComparison } from '../core/compare';
import { deriveTaxConvention } from '../core/conventions';
import { costBasisFromTaxHandling, resolvePricingDecision } from '../core/pricing';
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
import type {
  AliasRecord,
  BrandRecord,
  CatalogueItem,
  CatalogueSupplier,
  OfferSelectionRecord,
  SettingsAuditRecord,
  SupplierOfferRecord,
  SyncCheckpointRecord,
  SyncItemOutcomeRecord,
  SyncRunRecord,
} from '../platform/contracts';
import type { PlatformService } from '../platform/contracts';
import { usePlatform } from '../platform/context';
import { normalizeIdentifier } from '../core/normalize';
import { centsToAud } from '../core/liveSearch';
import { resolveSupplierOffer, type SupplierOffer } from '../core/offers';
import type { CatalogueSearchRecord } from '../core/search';

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
  catalogueItems: CatalogueItem[];
  brands: BrandRecord[];
  catalogueSuppliers: CatalogueSupplier[];
  supplierOffers: SupplierOfferRecord[];
  offerSelections: OfferSelectionRecord[];
  settingsAudit: SettingsAuditRecord[];
  syncRuns: SyncRunRecord[];
  syncCheckpoints: SyncCheckpointRecord[];
  syncItemOutcomes: SyncItemOutcomeRecord[];
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
  catalogueItems: [],
  brands: [],
  catalogueSuppliers: [],
  supplierOffers: [],
  offerSelections: [],
  settingsAudit: [],
  syncRuns: [],
  syncCheckpoints: [],
  syncItemOutcomes: [],
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
      catalogueItems: CatalogueItem[];
      brands: BrandRecord[];
      catalogueSuppliers: CatalogueSupplier[];
      supplierOffers: SupplierOfferRecord[];
      offerSelections: OfferSelectionRecord[];
      settingsAudit: SettingsAuditRecord[];
      syncRuns: SyncRunRecord[];
      syncCheckpoints: SyncCheckpointRecord[];
      syncItemOutcomes: SyncItemOutcomeRecord[];
    }
  | {
      type: 'catalogue-domain-loaded';
      catalogueItems: CatalogueItem[];
      brands: BrandRecord[];
      catalogueSuppliers: CatalogueSupplier[];
      supplierOffers: SupplierOfferRecord[];
      offerSelections: OfferSelectionRecord[];
      settingsAudit: SettingsAuditRecord[];
      syncRuns: SyncRunRecord[];
      syncCheckpoints: SyncCheckpointRecord[];
      syncItemOutcomes: SyncItemOutcomeRecord[];
    }
  | { type: 'configuration-hydration-failed'; error: string }
  | { type: 'profile-applied'; profile: MappingProfile }
  | { type: 'profile-saved'; profile: MappingProfile }
  | { type: 'settings-loaded'; settings: Settings }
  | { type: 'catalogue-items-published'; items: CatalogueItem[] }
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
        catalogueItems: action.catalogueItems,
        brands: action.brands,
        catalogueSuppliers: action.catalogueSuppliers,
        supplierOffers: action.supplierOffers,
        offerSelections: action.offerSelections,
        settingsAudit: action.settingsAudit,
        syncRuns: action.syncRuns,
        syncCheckpoints: action.syncCheckpoints,
        syncItemOutcomes: action.syncItemOutcomes,
        configurationHydration: {
          ...state.configurationHydration,
          status: 'ready',
          error: null,
        },
      });
    case 'catalogue-domain-loaded':
      return invalidateComparison({
        ...state,
        catalogueItems: action.catalogueItems,
        brands: action.brands,
        catalogueSuppliers: action.catalogueSuppliers,
        supplierOffers: action.supplierOffers,
        offerSelections: action.offerSelections,
        settingsAudit: action.settingsAudit,
        syncRuns: action.syncRuns,
        syncCheckpoints: action.syncCheckpoints,
        syncItemOutcomes: action.syncItemOutcomes,
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
    case 'catalogue-items-published': {
      const published = new Map(action.items.map((item) => [item.id, item]));
      return {
        ...state,
        catalogueItems: [
          ...state.catalogueItems.filter((item) => !published.has(item.id)),
          ...action.items,
        ].sort((left, right) => left.itemNumber.localeCompare(right.itemNumber)),
      };
    }
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
        catalogueItems: state.catalogueItems,
        brands: state.brands,
        catalogueSuppliers: state.catalogueSuppliers,
        supplierOffers: state.supplierOffers,
        offerSelections: state.offerSelections,
        settingsAudit: state.settingsAudit,
        syncRuns: state.syncRuns,
        syncCheckpoints: state.syncCheckpoints,
        syncItemOutcomes: state.syncItemOutcomes,
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

function percentFromHundredths(value: number | null): string | null {
  if (value === null) return null;
  return (value / 100)
    .toFixed(2)
    .replace(/\.00$/u, '')
    .replace(/(\.\d)0$/u, '$1');
}

export function buildCataloguePricingIndex(state: AppState): {
  byIdentifier: ReadonlyMap<string, CataloguePricingContext>;
  conflicts: ReadonlySet<string>;
} {
  const byIdentifier = new Map<string, CataloguePricingContext>();
  const conflicts = new Set<string>();
  const brands = new Map(state.brands.map((brand) => [brand.id, brand]));
  const suppliers = new Map(state.catalogueSuppliers.map((supplier) => [supplier.id, supplier]));
  const selections = new Map(
    state.offerSelections.map((selection) => [selection.productId, selection.offerId]),
  );

  for (const item of state.catalogueItems) {
    const brand = item.brandId ? brands.get(item.brandId) : undefined;
    const itemOffers: SupplierOffer[] = state.supplierOffers
      .filter(
        (offer) =>
          offer.productId === item.id &&
          offer.gstBasis !== 'unknown' &&
          suppliers.get(offer.supplierId)?.active === true,
      )
      .map((offer) => ({
        id: offer.id,
        productId: offer.productId,
        supplierId: offer.supplierId,
        supplierSku: offer.supplierSku,
        costAmount: centsToAud(offer.costCents),
        costBasis: offer.gstBasis === 'inc-gst' ? 'including-gst' : 'excluding-gst',
        currency: offer.currency,
        active: offer.active,
        preferred: offer.isPreferred,
        observedAt: offer.observedAt,
        effectiveAt: offer.validFrom,
        validUntil: offer.validUntil,
        provenance: {
          sourceSystem: offer.provenanceType,
          sourceRecordId: offer.provenanceReference ?? offer.id,
          evidenceKind:
            offer.provenanceType === 'xero'
              ? 'upstream-read'
              : offer.provenanceType === 'supplier-file'
                ? 'supplier-import'
                : offer.provenanceType === 'manual'
                  ? 'operator-selection'
                  : 'supplier-offer',
          observedAt: offer.observedAt,
          description: `Catalogue offer ${offer.id}`,
        },
      }));
    const context: CataloguePricingContext = {
      productId: item.id,
      itemKind: item.itemKind,
      brandId: item.brandId,
      brandName: brand?.name ?? null,
      brandMarkupPercent: percentFromHundredths(brand?.markupHundredths ?? null),
      productMarkupPercent: item.markupOverridePercent,
      xeroReference: item.xeroReference,
      servicem8Reference: item.servicem8Reference,
      barcodeGtin: item.barcodeGtin,
      offers: itemOffers,
      selectedOfferId: selections.get(item.id) ?? item.selectedOfferId,
      supplierNames: new Map(
        itemOffers.map((offer) => [
          offer.supplierId,
          suppliers.get(offer.supplierId)?.name ?? offer.supplierId,
        ]),
      ),
    };
    const identifiers = [
      item.itemNumber,
      item.xeroReference,
      item.servicem8Reference,
      item.barcodeGtin,
      ...itemOffers.map((offer) => offer.supplierSku),
    ];
    for (const identifier of identifiers) {
      if (!identifier) continue;
      const key = normalizeIdentifier(identifier);
      if (key === '') continue;
      const existing = byIdentifier.get(key);
      if (existing && existing.productId !== context.productId) {
        byIdentifier.delete(key);
        conflicts.add(key);
      } else if (!conflicts.has(key)) {
        byIdentifier.set(key, context);
      }
    }
  }
  return { byIdentifier, conflicts };
}

export function buildCatalogueSearchRecords(
  state: AppState,
  asOf: string,
): CatalogueSearchRecord[] {
  const pricingIndex = buildCataloguePricingIndex(state);
  return state.catalogueItems.map((item) => {
    const key = normalizeIdentifier(item.itemNumber);
    const context = pricingIndex.byIdentifier.get(key);
    const aliases = state.aliases
      .filter(
        (alias) => normalizeIdentifier(alias.itemNumber) === normalizeIdentifier(item.itemNumber),
      )
      .map((alias) => alias.supplierCode);
    const document = {
      productId: item.id,
      kind: item.itemKind,
      name: item.itemNumber,
      description: item.description,
      xeroItemCode: item.xeroReference,
      servicem8ItemNumber: item.servicem8Reference ?? item.itemNumber,
      supplierSkus: context?.offers.map((offer) => offer.supplierSku) ?? [],
      approvedAliases: aliases,
      barcodeGtin: item.barcodeGtin,
      brandName: context?.brandName ?? null,
    };
    if (pricingIndex.conflicts.has(key)) {
      return {
        document,
        price: {
          kind: 'ambiguous' as const,
          explanation:
            'This identifier belongs to more than one product. Choose the product explicitly before resolving a price.',
          candidateOfferIds: [],
        },
      };
    }
    if (!context) {
      return {
        document,
        price: {
          kind: 'unavailable' as const,
          explanation: 'No current supplier offer is recorded for this product.',
          candidateOfferIds: [],
        },
      };
    }
    const selected = resolveSupplierOffer({
      productId: item.id,
      offers: context.offers,
      selectedOfferId: context.selectedOfferId,
      asOf,
    });
    if (!selected.ok) {
      return {
        document,
        price: {
          kind:
            selected.reason === 'ambiguous-offers' ||
            selected.reason === 'multiple-preferred-offers'
              ? ('ambiguous' as const)
              : ('unavailable' as const),
          explanation: selected.explanation,
          candidateOfferIds: selected.candidateOfferIds,
        },
      };
    }
    if (item.sellPriceGstBasis === 'unknown') {
      return {
        document,
        price: {
          kind: 'unavailable' as const,
          explanation: 'The sell-price GST basis must be confirmed before a price can be shown.',
          candidateOfferIds: [selected.offer.id],
        },
      };
    }
    const { markup, pricing } = resolvePricingDecision({
      costAmount: selected.offer.costAmount,
      costBasis: selected.offer.costBasis,
      targetBasis: item.sellPriceGstBasis === 'inc-gst' ? 'including-gst' : 'excluding-gst',
      globalMarkupPercent: state.settings.markupPercent,
      brandMarkupPercent: context.brandMarkupPercent,
      productMarkupPercent: context.productMarkupPercent,
    });
    if (pricing.floor?.blocked) {
      return {
        document,
        price: {
          kind: 'unavailable' as const,
          explanation: pricing.floor.explanation,
          candidateOfferIds: [selected.offer.id],
        },
      };
    }
    return {
      document,
      price: {
        kind: 'resolved' as const,
        offerId: selected.offer.id,
        supplierId: selected.offer.supplierId,
        supplierName:
          context.supplierNames.get(selected.offer.supplierId) ?? selected.offer.supplierId,
        supplierSku: selected.offer.supplierSku,
        purchaseCost: selected.offer.costAmount,
        costBasis: selected.offer.costBasis,
        currency: selected.offer.currency,
        observedAt: selected.offer.observedAt,
        markupPercent: markup.markupPercent,
        markupSource: markup.level,
        sellPrice: pricing.price,
        sellPriceBasis: item.sellPriceGstBasis === 'inc-gst' ? 'including-gst' : 'excluding-gst',
        explanation: `${selected.explanation}; ${markup.explanation}; ${pricing.explanation}`,
      },
    };
  });
}

/** Run (or re-run) the comparison from current files, mappings and aliases. */
export function computeComparison(state: AppState, asOf?: string): ComparisonResult | null {
  if (state.configurationHydration.status !== 'ready') return null;
  if (state.supplier.table === null || state.servicem8.table === null) return null;
  const supplierRecords = extractSupplierRecords(state.supplier.table, state.supplierMapping);
  const s8Records = extractS8Records(state.servicem8.table, state.s8Mapping);
  const costBasis = costBasisFromTaxHandling(state.settings.taxHandling);
  const cataloguePricing = buildCataloguePricingIndex(state);
  return runComparison(supplierRecords, s8Records, effectiveAliases(state), {
    markupPercent: state.settings.markupPercent,
    // An unconfirmed supplier basis still classifies every record so the data
    // can be inspected; the release checklist blocks the export instead.
    costBasis: costBasis ?? 'excluding-gst',
    costBasisConfirmed: costBasis !== null,
    newItemConvention: deriveTaxConvention(s8Records),
    cataloguePricingByIdentifier: cataloguePricing.byIdentifier,
    catalogueIdentifierConflicts: cataloguePricing.conflicts,
    ...(asOf === undefined ? {} : { asOf }),
  });
}

const StateContext = createContext<AppState>(INITIAL_STATE);
const DispatchContext = createContext<Dispatch<Action>>(() => undefined);

export type LoadedPersistentConfiguration = {
  settings: Settings;
  profiles: MappingProfile[];
  aliases: AliasRecord[];
  sources: CompetitorSource[];
  catalogueItems: CatalogueItem[];
  brands: BrandRecord[];
  catalogueSuppliers: CatalogueSupplier[];
  supplierOffers: SupplierOfferRecord[];
  offerSelections: OfferSelectionRecord[];
  settingsAudit: SettingsAuditRecord[];
  syncRuns: SyncRunRecord[];
  syncCheckpoints: SyncCheckpointRecord[];
  syncItemOutcomes: SyncItemOutcomeRecord[];
};

export async function loadPersistentConfiguration(
  platform: PlatformService,
): Promise<{ ok: true; value: LoadedPersistentConfiguration } | { ok: false; error: string }> {
  let loadedResults: Awaited<
    ReturnType<
      typeof Promise.all<
        [
          ReturnType<PlatformService['settings']['load']>,
          ReturnType<PlatformService['profiles']['list']>,
          ReturnType<PlatformService['aliases']['list']>,
          ReturnType<PlatformService['sources']['list']>,
          ReturnType<PlatformService['catalogue']['list']>,
          ReturnType<PlatformService['brands']['list']>,
          ReturnType<PlatformService['suppliers']['list']>,
          ReturnType<PlatformService['offers']['list']>,
          ReturnType<PlatformService['offers']['listSelections']>,
          ReturnType<PlatformService['settings']['audit']>,
          ReturnType<PlatformService['sync']['listRuns']>,
          ReturnType<PlatformService['sync']['listCheckpoints']>,
          ReturnType<PlatformService['sync']['listItemOutcomes']>,
        ]
      >
    >
  >;
  try {
    loadedResults = await Promise.all([
      platform.settings.load(),
      platform.profiles.list(),
      platform.aliases.list(),
      platform.sources.list(),
      platform.catalogue.list(),
      platform.brands.list(),
      platform.suppliers.list(),
      platform.offers.list(),
      platform.offers.listSelections(),
      platform.settings.audit(),
      platform.sync.listRuns(),
      platform.sync.listCheckpoints(),
      platform.sync.listItemOutcomes(),
    ] as const);
  } catch {
    return {
      ok: false,
      error: 'Stored configuration could not be loaded safely.',
    };
  }
  const [
    settings,
    profiles,
    aliases,
    sources,
    catalogueItems,
    brands,
    catalogueSuppliers,
    supplierOffers,
    offerSelections,
    settingsAudit,
    syncRuns,
    syncCheckpoints,
    syncItemOutcomes,
  ] = loadedResults;
  const failed = loadedResults.find((result) => !result.ok);
  if (failed && !failed.ok) {
    return {
      ok: false,
      error: `Stored configuration could not be loaded safely. ${failed.error.message}`,
    };
  }
  if (
    !settings.ok ||
    !profiles.ok ||
    !aliases.ok ||
    !sources.ok ||
    !catalogueItems.ok ||
    !brands.ok ||
    !catalogueSuppliers.ok ||
    !supplierOffers.ok ||
    !offerSelections.ok ||
    !settingsAudit.ok ||
    !syncRuns.ok ||
    !syncCheckpoints.ok ||
    !syncItemOutcomes.ok
  ) {
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
      catalogueItems: catalogueItems.value,
      brands: brands.value,
      catalogueSuppliers: catalogueSuppliers.value,
      supplierOffers: supplierOffers.value,
      offerSelections: offerSelections.value,
      settingsAudit: settingsAudit.value,
      syncRuns: syncRuns.value,
      syncCheckpoints: syncCheckpoints.value,
      syncItemOutcomes: syncItemOutcomes.value,
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
