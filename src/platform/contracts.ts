import type { CompetitorObservation } from '../core/competitors';
import type { ItemKind } from '../core/catalogue';
import type { LiveHealth, LiveSearchOutcome, LiveSearchResult } from '../core/liveSearch';
import type { MappingProfile } from '../core/mapping';
import type { MarkupSource } from '../core/pricingRules';
import type { AppearanceTheme, Settings } from '../core/settings';
import type { CompetitorSource } from '../core/sources';
import type { GeneratedOutput } from '../io/exportWorkbooks';

export type PlatformKind = 'desktop' | 'web';

export type PlatformErrorCode =
  | 'cancelled'
  | 'conflict'
  | 'integrity_failed'
  | 'invalid_input'
  | 'not_configured'
  | 'offline'
  | 'permission_denied'
  | 'provider_error'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'selection_expired'
  | 'timeout'
  | 'unavailable'
  | 'unsupported_version';

export interface PlatformError {
  code: PlatformErrorCode;
  message: string;
  retryable: boolean;
}

export type PlatformResult<T> = { ok: true; value: T } | { ok: false; error: PlatformError };

export function platformOk<T>(value: T): PlatformResult<T> {
  return { ok: true, value };
}

export function platformFail<T>(
  code: PlatformErrorCode,
  message: string,
  retryable = false,
): PlatformResult<T> {
  return { ok: false, error: { code, message, retryable } };
}

export interface PlatformCapabilities {
  nativeFiles: boolean;
  nativePersistence: boolean;
  protectedCredentials: boolean;
  recovery: boolean;
  liveSearch: boolean;
}

export interface AliasRecord {
  supplierCode: string;
  itemNumber: string;
  approvedAt: string;
}

export interface CatalogueItem {
  id: string;
  itemNumber: string;
  description: string;
  itemKind: ItemKind;
  brandId: string | null;
  markupOverridePercent: string | null;
  xeroReference: string | null;
  servicem8Reference: string | null;
  barcodeGtin: string | null;
  selectedOfferId: string | null;
  costCents: number;
  sellPriceCents: number;
  /** GST basis of the purchase cost. */
  gstBasis: 'inc-gst' | 'ex-gst' | 'unknown';
  sellPriceGstBasis: 'inc-gst' | 'ex-gst' | 'unknown';
  updatedAt: string;
}

export interface BrandRecord {
  id: string;
  name: string;
  markupHundredths: number | null;
  updatedAt: string;
}

export interface CatalogueSupplier {
  id: string;
  name: string;
  active: boolean;
  externalReference: string | null;
  updatedAt: string;
}

export interface SupplierOfferRecord {
  id: string;
  productId: string;
  supplierId: string;
  supplierSku: string;
  costCents: number;
  gstBasis: 'inc-gst' | 'ex-gst' | 'unknown';
  currency: 'AUD';
  active: boolean;
  isPreferred: boolean;
  validFrom: string | null;
  validUntil: string | null;
  provenanceType: 'legacy-local' | 'manual' | 'supplier-file' | 'xero';
  provenanceReference: string | null;
  observedAt: string;
}

export interface OfferSelectionRecord {
  productId: string;
  offerId: string;
  selectedBy: string;
  reason: string;
  selectedAt: string;
}

export interface ProductMetadataUpdate {
  productId: string;
  itemKind: ItemKind;
  brandId: string | null;
  markupOverridePercent: string | null;
  xeroReference: string | null;
  servicem8Reference: string | null;
  barcodeGtin: string | null;
  updatedAt: string;
}

export interface ApprovalInput {
  itemId: string;
  approvedBy: string;
  proposedSellCents: number;
  reason: string;
}

export interface ApprovalRecord extends ApprovalInput {
  id: string;
  approvedAt: string;
}

export interface PriceHistoryInput {
  itemId: string;
  costCents: number;
  sellPriceCents: number;
  approvalId: string;
  selectedOfferId: string | null;
  supplierId: string | null;
  supplierName: string | null;
  supplierSku: string | null;
  costGstBasis: 'inc-gst' | 'ex-gst' | 'unknown' | null;
  currency: 'AUD' | null;
  costBasisCents: number;
  markupSourceType: MarkupSource;
  markupSourceId: string | null;
  appliedMarkupHundredths: number;
  brandId: string | null;
  itemKind: ItemKind;
  pricingExplanation: string;
  ruleVersion: string;
  recordedAt?: string;
}

export interface PriceHistoryVersion {
  id: string;
  itemId: string;
  cost: string;
  sellPrice: string;
  costCents: number;
  sellPriceCents: number;
  approvalId: string;
  selectedOfferId: string | null;
  supplierId: string | null;
  supplierName: string | null;
  supplierSku: string | null;
  costGstBasis: 'inc-gst' | 'ex-gst' | 'unknown' | null;
  sellPriceGstBasis: 'inc-gst' | 'ex-gst' | 'unknown';
  currency: 'AUD' | null;
  costBasisCents: number;
  markupSourceType: MarkupSource | 'legacy-global';
  markupSourceId: string | null;
  appliedMarkupHundredths: number | null;
  brandId: string | null;
  itemKind: ItemKind | null;
  pricingExplanation: string | null;
  ruleVersion: string;
  provenanceState: 'resolved' | 'legacy-unresolved';
  recordedAt: string;
}

export interface SettingsAuditRecord {
  id: string;
  previous: Settings | null;
  current: Settings;
  changedBy: string;
  changedAt: string;
}

export type SyncSystem = 'xero' | 'servicem8';
export type SyncDirection = 'upstream-read' | 'downstream-write';
export type SyncStatus = 'preview' | 'running' | 'completed' | 'partial' | 'failed';

export interface SyncRunRecord {
  id: string;
  system: SyncSystem;
  direction: SyncDirection;
  status: SyncStatus;
  mode: 'preview' | 'approved';
  startedAt: string;
  completedAt: string | null;
  approvedBy: string | null;
  summary: Record<string, unknown>;
}

export interface SyncCheckpointRecord {
  id: string;
  runId: string;
  cursorValue: string;
  recordedAt: string;
}

export interface SyncItemOutcomeRecord {
  id: string;
  runId: string;
  itemId: string | null;
  externalId: string | null;
  action: 'create' | 'update' | 'read' | 'skip';
  status: 'planned' | 'succeeded' | 'skipped' | 'failed';
  idempotencyKey: string;
  attemptCount: number;
  retryable: boolean;
  errorClass: string | null;
  reconciliation: 'not-run' | 'matched' | 'mismatch' | 'not-applicable';
  message: string;
  recordedAt: string;
}

export interface ApprovedCatalogueChange {
  item: CatalogueItem;
  approvedBy: string;
  reason: string;
  pricingProvenance: PricingApprovalProvenance;
}

export interface PricingApprovalProvenance {
  selectedOfferId: string;
  supplierId: string;
  supplierName: string;
  supplierSku: string;
  costGstBasis: 'inc-gst' | 'ex-gst';
  currency: 'AUD';
  markupPercent: string;
  markupSource: MarkupSource;
  markupSourceId: string | null;
  brandId: string | null;
  itemKind: ItemKind;
  sellPriceGstBasis: 'inc-gst' | 'ex-gst';
  explanation: string;
  ruleVersion: string;
}

export interface PublishedChange {
  item: CatalogueItem;
  approval: ApprovalRecord;
  priceHistory: PriceHistoryVersion;
}

export interface CompetitorReferenceRecord {
  id: string;
  itemId: string;
  observation: LiveSearchResult | CompetitorObservation;
  attachedAt: string;
}

export const CONFIGURATION_SCHEMA_VERSION = 1 as const;

export interface ConfigurationEnvelope {
  schemaVersion: typeof CONFIGURATION_SCHEMA_VERSION;
  application: 'swl-pricing-inventory-control';
  exportedAt: string;
  counts: {
    profiles: number;
    aliases: number;
    settings: number;
  };
  data: {
    profiles: MappingProfile[];
    aliases: AliasRecord[];
    settings: Settings;
  };
  sha256: string;
}

function canonicalConfigurationValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalConfigurationValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalConfigurationValue(entry)]),
    );
  }
  return value;
}

/** Stable checksum payload: recursively sorted object keys and ordered arrays. */
export function canonicalConfigurationPayload(
  envelope: Omit<ConfigurationEnvelope, 'sha256'>,
): string {
  return JSON.stringify(canonicalConfigurationValue(envelope));
}

export interface ConfigurationPreview {
  previewToken: string;
  schemaVersion: number;
  counts: ConfigurationEnvelope['counts'];
  conflicts: {
    profiles: number;
    aliases: number;
    settings: number;
  };
  valid: boolean;
  validationMessages: string[];
}

export interface ConfigurationMigrationStatus {
  legacyConfigurationFound: boolean;
  alreadyImported: boolean;
  counts: ConfigurationEnvelope['counts'];
  valid: boolean;
  invalidCounts: ConfigurationEnvelope['counts'];
  validationMessages: string[];
}

export type BackupReason = 'migration' | 'import' | 'restore' | 'reset' | 'manual';

export interface BackupRecordCounts {
  catalogueItems: number;
  approvals: number;
  priceHistory: number;
  competitorReferences: number;
  sources: number;
  profiles: number;
  aliases: number;
  settings: number;
  brands: number;
  suppliers: number;
  productSupplierOffers: number;
  productOfferSelections: number;
  syncRuns: number;
  syncCheckpoints: number;
  syncItemOutcomes: number;
  settingsAudit: number;
}

export interface BackupSummary {
  id: string;
  filename: string;
  createdAt: string;
  applicationVersion: string;
  schemaVersion: number;
  sha256: string;
  recordCounts: BackupRecordCounts;
}

export interface RestorePreview extends BackupSummary {
  previewToken: string;
  integrityOk: boolean;
}

export interface ResetPreview {
  resetToken: string;
  confirmationPhrase: string;
  scope: string[];
  recordCounts: BackupRecordCounts;
}

export type ProviderState =
  | 'configured'
  | 'fixture'
  | 'not_configured'
  | 'offline'
  | 'timeout'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'provider_error';

export interface ProviderStatus {
  provider: string;
  state: ProviderState;
  paidCallsEnabled: boolean;
  costCeilingAud: string;
  costCeilingCents: number;
  costPerCallCents: number;
  spentCents: number;
  credentialConfigured: boolean;
  credentialHint: string | null;
  lastValidatedAt: string | null;
}

export interface OutputDestinationGrant {
  grantId: string;
  displayName: string;
}

export type InputFileRole = 'supplier' | 'servicem8' | 'configuration';

export interface PlatformSaveResult {
  written: string[];
  failed: { filename: string; error: string; code: PlatformErrorCode }[];
}

export interface PlatformService {
  readonly kind: PlatformKind;
  readonly capabilities: PlatformCapabilities;

  appearance: {
    setTheme(theme: AppearanceTheme): Promise<PlatformResult<void>>;
  };
  health(): Promise<PlatformResult<LiveHealth>>;

  catalogue: {
    list(): Promise<PlatformResult<CatalogueItem[]>>;
    publishApproved(
      changes: readonly ApprovedCatalogueChange[],
    ): Promise<PlatformResult<PublishedChange[]>>;
  };
  brands: {
    list(): Promise<PlatformResult<BrandRecord[]>>;
    save(brand: BrandRecord): Promise<PlatformResult<BrandRecord>>;
  };
  suppliers: {
    list(): Promise<PlatformResult<CatalogueSupplier[]>>;
    save(supplier: CatalogueSupplier): Promise<PlatformResult<CatalogueSupplier>>;
  };
  offers: {
    list(productId?: string): Promise<PlatformResult<SupplierOfferRecord[]>>;
    save(offer: SupplierOfferRecord): Promise<PlatformResult<SupplierOfferRecord>>;
    listSelections(): Promise<PlatformResult<OfferSelectionRecord[]>>;
    select(selection: OfferSelectionRecord): Promise<PlatformResult<OfferSelectionRecord>>;
  };
  productMetadata: {
    update(update: ProductMetadataUpdate): Promise<PlatformResult<ProductMetadataUpdate>>;
  };
  approvals: {
    list(itemId?: string): Promise<PlatformResult<ApprovalRecord[]>>;
  };
  priceHistory: {
    list(itemId?: string): Promise<PlatformResult<PriceHistoryVersion[]>>;
  };
  references: {
    list(itemId?: string): Promise<PlatformResult<CompetitorReferenceRecord[]>>;
    attach(
      itemId: string,
      observation: LiveSearchResult | CompetitorObservation,
    ): Promise<PlatformResult<CompetitorReferenceRecord>>;
  };
  sources: {
    list(): Promise<PlatformResult<CompetitorSource[]>>;
    replace(sources: readonly CompetitorSource[]): Promise<PlatformResult<CompetitorSource[]>>;
  };
  profiles: {
    list(): Promise<PlatformResult<MappingProfile[]>>;
    save(profile: MappingProfile): Promise<PlatformResult<MappingProfile>>;
    delete(id: string): Promise<PlatformResult<void>>;
  };
  aliases: {
    list(): Promise<PlatformResult<AliasRecord[]>>;
    save(alias: AliasRecord): Promise<PlatformResult<AliasRecord>>;
    delete(supplierCode: string): Promise<PlatformResult<void>>;
  };
  settings: {
    load(): Promise<PlatformResult<Settings>>;
    save(settings: Settings): Promise<PlatformResult<Settings>>;
    audit(): Promise<PlatformResult<SettingsAuditRecord[]>>;
  };
  sync: {
    listRuns(): Promise<PlatformResult<SyncRunRecord[]>>;
    saveRun(run: SyncRunRecord): Promise<PlatformResult<SyncRunRecord>>;
    listCheckpoints(runId?: string): Promise<PlatformResult<SyncCheckpointRecord[]>>;
    appendCheckpoint(
      checkpoint: SyncCheckpointRecord,
    ): Promise<PlatformResult<SyncCheckpointRecord>>;
    listItemOutcomes(runId?: string): Promise<PlatformResult<SyncItemOutcomeRecord[]>>;
    appendItemOutcome(
      outcome: SyncItemOutcomeRecord,
    ): Promise<PlatformResult<SyncItemOutcomeRecord>>;
  };
  configuration: {
    export(): Promise<PlatformResult<ConfigurationEnvelope>>;
    exportToSelectedFolder(filename: string): Promise<PlatformResult<string | null>>;
    previewImport(serialised: string): Promise<PlatformResult<ConfigurationPreview>>;
    applyImport(previewToken: string): Promise<PlatformResult<ConfigurationEnvelope['counts']>>;
    migrationStatus(): Promise<PlatformResult<ConfigurationMigrationStatus>>;
    previewLegacyImport(): Promise<PlatformResult<ConfigurationPreview>>;
  };
  recovery: {
    createBackup(reason: BackupReason): Promise<PlatformResult<BackupSummary>>;
    listBackups(): Promise<PlatformResult<BackupSummary[]>>;
    previewRestore(backupId?: string): Promise<PlatformResult<RestorePreview>>;
    restore(previewToken: string): Promise<PlatformResult<BackupSummary>>;
    previewReset(): Promise<PlatformResult<ResetPreview>>;
    reset(resetToken: string, confirmation: string): Promise<PlatformResult<BackupSummary>>;
  };
  search: {
    status(): Promise<PlatformResult<ProviderStatus>>;
    query(query: string, candidateToken?: string): Promise<LiveSearchOutcome>;
    setPaidCallsEnabled(
      enabled: boolean,
      costCeilingCents?: number,
      costPerCallCents?: number,
    ): Promise<PlatformResult<ProviderStatus>>;
    configureCredential(secret: string): Promise<PlatformResult<ProviderStatus>>;
    validateCredential(): Promise<PlatformResult<ProviderStatus>>;
    replaceCredential(secret: string): Promise<PlatformResult<ProviderStatus>>;
    removeCredential(): Promise<PlatformResult<ProviderStatus>>;
  };
  files: {
    chooseInputFile(role: InputFileRole): Promise<PlatformResult<File | null>>;
    chooseOutputDestination(): Promise<PlatformResult<OutputDestinationGrant | null>>;
    saveOutputs(
      destination: OutputDestinationGrant,
      outputs: readonly GeneratedOutput[],
    ): Promise<PlatformResult<PlatformSaveResult>>;
    openVerifiedSource(url: string): Promise<PlatformResult<void>>;
  };

  readonly rawImportPersistence: 'never';
  /** Manual evidence is persisted only when it names an existing catalogue item. */
  readonly manualEvidencePersistence: 'catalogue-reference-or-session';
}
