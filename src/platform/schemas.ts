import { z } from 'zod';
import { SettingsSchema } from '../core/settings';

const boundedText = (max: number) => z.string().min(1).max(max);
const timestamp = z.string().min(1).max(64);
const cents = z.number().int().min(0).max(1_000_000_000);
const gstBasis = z.enum(['inc-gst', 'ex-gst', 'unknown']);
const httpsUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
  }, 'A credential-free HTTPS URL is required.');

const columnIndex = z.number().int().min(0).max(4095);
// These enumerations must stay in step with SupplierFieldKey and S8FieldKey in
// src/core/fields.ts; a field missing here makes every profile that uses it
// fail validation and become unsaveable. src/core/fields.test.ts asserts it.
export const SUPPLIER_MAPPING_KEYS = [
  'supplierCode',
  'supplierDescription',
  'supplierCost',
  'supplierBarcode',
] as const;
export const SERVICEM8_MAPPING_KEYS = [
  'itemNumber',
  'itemDescription',
  'existingCost',
  'existingSellPrice',
  'priceIncludesTaxes',
  'taxRate',
  'quantityInStock',
  'itemIsInventoried',
  'barcode',
] as const;
const SupplierMappingSchema = z.partialRecord(z.enum(SUPPLIER_MAPPING_KEYS), columnIndex);
const Servicem8MappingSchema = z.partialRecord(z.enum(SERVICEM8_MAPPING_KEYS), columnIndex);
export const MappingProfileSchema = z
  .object({
    id: boundedText(128),
    name: boundedText(160),
    version: z.number().int().min(1).max(1_000_000),
    supplierMapping: SupplierMappingSchema,
    supplierHeaders: z.array(z.string().max(512)).max(512),
    servicem8Mapping: Servicem8MappingSchema,
    servicem8Headers: z.array(z.string().max(512)).max(512),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

export const AliasRecordSchema = z
  .object({
    supplierCode: boundedText(128),
    itemNumber: boundedText(128),
    approvedAt: timestamp,
  })
  .strict();

export const CatalogueItemSchema = z
  .object({
    id: boundedText(128),
    itemNumber: boundedText(128),
    description: z.string().max(2000),
    costCents: cents,
    sellPriceCents: cents,
    gstBasis,
    updatedAt: timestamp,
  })
  .strict();

export const ApprovalRecordSchema = z
  .object({
    id: boundedText(128),
    itemId: boundedText(128),
    approvedBy: boundedText(128),
    proposedSellCents: cents,
    reason: z.string().max(1000),
    approvedAt: timestamp,
  })
  .strict();

export const PriceHistoryVersionSchema = z
  .object({
    id: boundedText(128),
    itemId: boundedText(128),
    cost: z.string().max(32),
    sellPrice: z.string().max(32),
    costCents: cents,
    sellPriceCents: cents,
    approvalId: boundedText(128),
    recordedAt: timestamp,
  })
  .strict();

export const PublishedChangeSchema = z
  .object({
    item: CatalogueItemSchema,
    approval: ApprovalRecordSchema,
    priceHistory: PriceHistoryVersionSchema,
  })
  .strict();

export const LiveSearchResultSchema = z
  .object({
    title: boundedText(1000),
    priceCents: cents,
    priceAud: z.string().regex(/^\d+(?:\.\d{2})$/),
    currency: z.literal('AUD'),
    gstBasis,
    packSize: z.string().max(256).nullable(),
    seller: boundedText(512),
    sourceDomain: boundedText(253),
    url: httpsUrl,
    retrievedAt: timestamp,
  })
  .strict();

export const CompetitorObservationSchema = z
  .object({
    sku: boundedText(128),
    sourceName: boundedText(256),
    approvedSource: z.boolean(),
    observedAt: timestamp,
    price: z
      .string()
      .regex(/^\d+(?:\.\d{1,2})?$/)
      .max(32),
    currency: z.literal('AUD'),
    gstBasis,
    shipping: z
      .string()
      .regex(/^\d+(?:\.\d{1,2})?$/)
      .max(32),
    stockStatus: z.enum(['in-stock', 'out-of-stock', 'unknown']),
    condition: z.enum(['new', 'used', 'unknown']),
    packCompatible: z.boolean(),
    productOnly: z.boolean(),
    matchConfidence: z.number().min(0).max(1),
    reviewState: z.enum(['accepted', 'rejected', 'quarantined']),
    ambiguousMatch: z.boolean().optional(),
    url: httpsUrl.optional(),
    packSize: z.string().max(256).optional(),
  })
  .strict();

export const LiveSearchOutcomeSchema = z
  .object({
    state: z.enum([
      'ok',
      'empty',
      'not_configured',
      'offline',
      'timeout',
      'provider_error',
      'quota_exhausted',
      'rate_limited',
      'invalid_query',
      'server_unreachable',
    ]),
    query: z.string().max(512),
    queryKind: z.enum(['identifier', 'barcode', 'free-text', 'empty']),
    provider: z.string().max(128),
    results: z.array(LiveSearchResultSchema).max(100),
    band: z
      .object({
        lowest: z.string(),
        median: z.string(),
        highest: z.string(),
        lowestCents: cents,
        medianCents: cents,
        highestCents: cents,
        pricedResults: z.number().int().min(0).max(100),
      })
      .strict()
      .nullable(),
    retrievedAt: timestamp.nullish(),
    cached: z.boolean().nullish(),
    detail: z.string().max(1000).nullish(),
    coverage: z
      .object({
        providerQueried: z.string().max(128),
        sourcesWithPrice: z.number().int().min(0).max(100),
        sourceDomains: z.array(z.string().max(253)).max(100),
        pricedResults: z.number().int().min(0).max(100),
      })
      .strict()
      .nullish(),
  })
  .strict();

export const LiveHealthSchema = z
  .object({
    ok: z.boolean(),
    provider: z.string().max(128),
    liveSearchConfigured: z.boolean(),
    fixtureMode: z.boolean(),
    paidCallsEnabled: z.boolean().optional(),
    costCeilingAud: z
      .string()
      .regex(/^\d+(?:\.\d{2})$/)
      .optional(),
    costCeilingCents: z.number().int().min(0).max(1_000_000_000).optional(),
    costPerCallCents: z.number().int().min(0).max(1_000_000_000).optional(),
    spentCents: z.number().int().min(0).max(1_000_000_000).optional(),
    paidPolicyState: z.enum(['fixture', 'disabled', 'invalid', 'enabled', 'exhausted']).optional(),
    schemaVersion: z.number().int().min(0).optional(),
  })
  .strict();

export const CompetitorSourceSchema = z
  .object({
    id: boundedText(128),
    name: boundedText(256),
    accessMethod: z.enum(['live-api', 'manual-entry', 'file-import']),
    automatedAccessNote: z.string().max(2000),
    enabled: z.boolean(),
  })
  .strict();

export const CompetitorReferenceRecordSchema = z
  .object({
    id: boundedText(128),
    itemId: boundedText(128),
    observation: z.union([LiveSearchResultSchema, CompetitorObservationSchema]),
    attachedAt: timestamp,
  })
  .strict();

const ConfigurationCountsSchema = z
  .object({
    profiles: z.number().int().min(0).max(1000),
    aliases: z.number().int().min(0).max(100_000),
    settings: z.literal(1),
  })
  .strict();
const ConfigurationConflictCountsSchema = z
  .object({
    profiles: z.number().int().min(0).max(1000),
    aliases: z.number().int().min(0).max(100_000),
    settings: z.number().int().min(0).max(1),
  })
  .strict();

export const ConfigurationEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    application: z.literal('swl-pricing-inventory-control'),
    exportedAt: timestamp,
    counts: ConfigurationCountsSchema,
    data: z
      .object({
        profiles: z.array(MappingProfileSchema).max(1000),
        aliases: z.array(AliasRecordSchema).max(100_000),
        settings: SettingsSchema,
      })
      .strict(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const ConfigurationPreviewSchema = z
  .object({
    previewToken: boundedText(256),
    schemaVersion: z.number().int().min(1),
    counts: ConfigurationEnvelopeSchema.shape.counts,
    conflicts: ConfigurationConflictCountsSchema,
    valid: z.boolean(),
    validationMessages: z.array(z.string().max(500)).max(100),
  })
  .strict();

export const ConfigurationMigrationStatusSchema = z
  .object({
    legacyConfigurationFound: z.boolean(),
    alreadyImported: z.boolean(),
    counts: ConfigurationEnvelopeSchema.shape.counts,
    valid: z.boolean(),
    invalidCounts: z
      .object({
        profiles: z.number().int().min(0).max(1000),
        aliases: z.number().int().min(0).max(100_000),
        settings: z.number().int().min(0).max(1),
      })
      .strict(),
    validationMessages: z.array(z.string().max(500)).max(100),
  })
  .strict();

export const BackupRecordCountsSchema = z
  .object({
    catalogueItems: z.number().int().min(0),
    approvals: z.number().int().min(0),
    priceHistory: z.number().int().min(0),
    competitorReferences: z.number().int().min(0),
    sources: z.number().int().min(0),
    profiles: z.number().int().min(0),
    aliases: z.number().int().min(0),
    settings: z.number().int().min(0).max(1),
  })
  .strict();

export const BackupSummarySchema = z
  .object({
    id: boundedText(256),
    filename: boundedText(260),
    createdAt: timestamp,
    applicationVersion: boundedText(64),
    schemaVersion: z.number().int().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    recordCounts: BackupRecordCountsSchema,
  })
  .strict();

export const RestorePreviewSchema = BackupSummarySchema.extend({
  previewToken: boundedText(256),
  integrityOk: z.boolean(),
}).strict();

export const ResetPreviewSchema = z
  .object({
    resetToken: boundedText(256),
    confirmationPhrase: boundedText(128),
    scope: z.array(z.string().max(256)).min(1).max(32),
    recordCounts: BackupRecordCountsSchema,
  })
  .strict();

export const ProviderStatusSchema = z
  .object({
    provider: z.string().max(128),
    state: z.enum([
      'configured',
      'fixture',
      'not_configured',
      'offline',
      'timeout',
      'quota_exhausted',
      'rate_limited',
      'provider_error',
    ]),
    paidCallsEnabled: z.boolean(),
    costCeilingAud: z.string().regex(/^\d+(?:\.\d{2})$/),
    costCeilingCents: z.number().int().min(0).max(1_000_000_000),
    costPerCallCents: z.number().int().min(0).max(1_000_000_000),
    spentCents: z.number().int().min(0).max(1_000_000_000),
    credentialConfigured: z.boolean(),
    credentialHint: z.string().max(64).nullable(),
    lastValidatedAt: timestamp.nullable(),
  })
  .strict();

export const OutputDestinationGrantSchema = z
  .object({
    grantId: boundedText(256),
    displayName: boundedText(512),
  })
  .strict();

export const InputFileGrantSchema = z
  .object({
    grantId: boundedText(256),
    displayName: boundedText(720),
    length: z
      .number()
      .int()
      .min(1)
      .max(25 * 1024 * 1024),
    extension: z.enum(['csv', 'xlsx', 'json']),
  })
  .strict();

export const BeginExportSchema = z
  .object({
    sessionId: boundedText(256),
    conflict: z.literal(false),
  })
  .strict();
