import type {
  HttpResponse,
  HttpTransport,
  SyncBatchResult,
  SyncCheckpoint,
  SyncCheckpointStore,
  SyncCreateAttemptedAwaitingReconciliation,
  SyncItemOutcome,
  SyncManualReconciliationRequired,
} from './contracts';
import { CATALOGUE_ITEM_KINDS, isStockTrackedKind, type ItemKind } from '../core/catalogue';

const MATERIAL_PATH = '/api_1.0/material.json';
const MAX_ATTEMPTS = 3;
const MAX_PROVIDER_AMOUNT = 1_000_000_000;
const RESPONSE_FIELDS = new Set(['status', 'body', 'headers', 'uncertain']);
const MATERIAL_FIELDS = new Set([
  'uuid',
  'name',
  'item_number',
  'description',
  'price',
  'cost',
  'tax',
  'barcode',
  'inventory',
  'quantity',
  'active',
  'edit_date',
  'category_uuid',
  'photo_document_uuid',
]);
const MATERIAL_WRITE_FIELDS = new Set([
  'name',
  'item_number',
  'description',
  'price',
  'cost',
  'tax',
  'barcode',
  'inventory',
]);
const MATERIAL_ID = /^[A-Za-z0-9-]{8,64}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const PREVIEW_FIELDS = new Set([
  'runId',
  'intentSetFingerprint',
  'orderedLocalItemIds',
  'persistedIdempotencyKeys',
  'createdAt',
]);
const APPROVAL_RECORD_FIELDS = new Set([
  'proofReference',
  'runId',
  'previewFingerprint',
  'previewCreatedAt',
  'orderedLocalItemIds',
  'persistedIdempotencyKeys',
  'approvedBy',
  'approvedAt',
]);
const MANUAL_RECONCILIATION_FIELDS = new Set([
  'state',
  'operation',
  'localItemId',
  'idempotencyKey',
  'reason',
  'recordedAt',
]);
const CREATE_ATTEMPT_FIELDS = new Set([
  'state',
  'operation',
  'localItemId',
  'idempotencyKey',
  'recordedAt',
]);

export interface ServiceM8Material {
  readonly uuid: string;
  readonly name?: string;
  readonly item_number?: string;
  readonly description?: string;
  readonly price?: number;
  readonly cost?: number;
  readonly tax?: 0 | 1;
  readonly barcode?: string;
  readonly inventory?: 0 | 1;
}

export interface ServiceM8MaterialWrite {
  readonly name: string;
  readonly item_number: string;
  readonly description?: string;
  readonly price?: number;
  readonly cost?: number;
  readonly tax?: 0 | 1;
  readonly barcode?: string;
  readonly inventory?: 0 | 1;
}

export interface ServiceM8SyncIntent {
  readonly localItemId: string;
  readonly idempotencyKey: string;
  readonly externalId?: string;
  readonly material: ServiceM8MaterialWrite;
}

export interface ServiceM8WriteIntentInput {
  readonly runId: string;
  readonly localItemId: string;
  readonly revision: string;
  readonly externalId?: string;
  readonly itemKind: ItemKind;
  readonly name: string;
  readonly itemNumber: string;
  readonly description?: string;
  readonly price?: number;
  readonly cost?: number;
  readonly tax?: 0 | 1;
  readonly barcode?: string;
}

export interface ServiceM8SyncPreview {
  readonly runId: string;
  readonly intentSetFingerprint: string;
  readonly orderedLocalItemIds: readonly string[];
  readonly persistedIdempotencyKeys: readonly string[];
  readonly createdAt: string;
}

export interface ServiceM8ApprovalLedgerRecord {
  readonly proofReference: string;
  readonly runId: string;
  readonly previewFingerprint: string;
  readonly previewCreatedAt: string;
  readonly orderedLocalItemIds: readonly string[];
  readonly persistedIdempotencyKeys: readonly string[];
  readonly approvedBy: string;
  readonly approvedAt: string;
}

/**
 * Authoritative approval evidence boundary. Implementations resolve a durable
 * approval record by reference and never return provider credentials or tokens.
 */
export interface ServiceM8ApprovalLedgerPort {
  loadApproval(proofReference: string): Promise<ServiceM8ApprovalLedgerRecord | undefined>;
}

export interface ServiceM8MaterialsPort {
  listMaterials(): Promise<readonly ServiceM8Material[]>;
  createMaterial(material: ServiceM8MaterialWrite): Promise<HttpResponse<unknown>>;
  updateMaterial(uuid: string, material: ServiceM8MaterialWrite): Promise<HttpResponse<unknown>>;
}

export interface ServiceM8SyncOptions {
  readonly runId: string;
  readonly intents: readonly ServiceM8SyncIntent[];
  readonly port: ServiceM8MaterialsPort;
  readonly checkpointStore: SyncCheckpointStore;
  readonly preview: ServiceM8SyncPreview;
  readonly approvalProofReference: string;
  readonly approvalLedger: ServiceM8ApprovalLedgerPort;
  readonly now?: () => string;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

export function createServiceM8WriteIntent(input: ServiceM8WriteIntentInput): ServiceM8SyncIntent {
  if (!CATALOGUE_ITEM_KINDS.includes(input.itemKind)) {
    throw new Error('ServiceM8 write intent itemKind is invalid.');
  }
  for (const [field, value, maximum] of [
    ['runId', input.runId, 200],
    ['localItemId', input.localItemId, 200],
    ['revision', input.revision, 100],
    ['name', input.name, 255],
    ['itemNumber', input.itemNumber, 30],
  ] as const) {
    if (value.trim() === '' || value.length > maximum) {
      throw new Error('ServiceM8 write intent ' + field + ' is invalid.');
    }
  }
  const idempotencyKey = input.runId + ':' + input.localItemId + ':' + input.revision;
  if (idempotencyKey.length > 500)
    throw new Error('ServiceM8 write intent idempotency key is too long.');
  const intent: ServiceM8SyncIntent = {
    localItemId: input.localItemId,
    idempotencyKey,
    ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
    material: {
      name: input.name,
      item_number: input.itemNumber,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.price !== undefined ? { price: input.price } : {}),
      ...(input.cost !== undefined ? { cost: input.cost } : {}),
      ...(input.tax !== undefined ? { tax: input.tax } : {}),
      ...(input.barcode !== undefined ? { barcode: input.barcode } : {}),
      inventory: isStockTrackedKind(input.itemKind) ? 1 : 0,
    },
  };
  assertIntentIdentities([intent]);
  return intent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, field: string, maximum: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > maximum) {
    throw new Error('ServiceM8 ' + field + ' must be bounded text.');
  }
  return value;
}

function boundedAmount(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_PROVIDER_AMOUNT
  ) {
    throw new Error('ServiceM8 ' + field + ' is outside the supported range.');
  }
  return value;
}

function zeroOrOne(value: unknown, field: string): 0 | 1 | undefined {
  if (value === undefined || value === null) return undefined;
  if (value !== 0 && value !== 1) throw new Error('ServiceM8 ' + field + ' must be 0 or 1.');
  return value;
}

function assertTransportResponse<T>(
  value: unknown,
  label: string,
): asserts value is HttpResponse<T> {
  if (!isRecord(value)) throw new Error(label + ' transport response must be an object.');
  const unexpected = Object.keys(value).find((field) => !RESPONSE_FIELDS.has(field));
  if (unexpected)
    throw new Error(label + ' transport response contains unexpected field ' + unexpected + '.');
  if (
    !Number.isInteger(value.status) ||
    (value.status as number) < 100 ||
    (value.status as number) > 599
  ) {
    throw new Error(label + ' transport response has an invalid HTTP status.');
  }
  if (value.uncertain !== undefined && typeof value.uncertain !== 'boolean') {
    throw new Error(label + ' transport response has an invalid uncertainty flag.');
  }
  if (value.headers !== undefined) {
    if (!isRecord(value.headers) || Object.keys(value.headers).length > 100) {
      throw new Error(label + ' transport response has invalid headers.');
    }
    for (const [name, header] of Object.entries(value.headers)) {
      if (
        name.length === 0 ||
        name.length > 100 ||
        (header !== undefined && (typeof header !== 'string' || header.length > 4_000))
      ) {
        throw new Error(label + ' transport response has an invalid header.');
      }
    }
  }
}

function parseMaterials(body: unknown): readonly ServiceM8Material[] {
  if (!Array.isArray(body)) throw new Error('ServiceM8 materials response must be an array.');
  const ids = new Set<string>();
  const itemNumbers = new Set<string>();
  return body.map((value, index) => {
    if (!isRecord(value)) throw new Error('ServiceM8 material ' + index + ' must be an object.');
    const unexpected = Object.keys(value).find((field) => !MATERIAL_FIELDS.has(field));
    if (unexpected) {
      throw new Error(
        'ServiceM8 material ' + index + ' contains unexpected field ' + unexpected + '.',
      );
    }
    if (typeof value.uuid !== 'string' || !MATERIAL_ID.test(value.uuid)) {
      throw new Error('ServiceM8 material ' + index + ' has an invalid uuid.');
    }
    if (ids.has(value.uuid))
      throw new Error('ServiceM8 materials response contains a duplicate uuid.');
    ids.add(value.uuid);
    const itemNumber = boundedText(value.item_number, 'item_number', 30);
    if (itemNumber) {
      if (itemNumbers.has(itemNumber)) {
        throw new Error('ServiceM8 materials response contains a duplicate item_number.');
      }
      itemNumbers.add(itemNumber);
    }
    boundedAmount(value.quantity, 'quantity');
    zeroOrOne(value.active, 'active');
    const name = boundedText(value.name, 'name', 255);
    const description = boundedText(value.description, 'description', 4_000);
    const price = boundedAmount(value.price, 'price');
    const cost = boundedAmount(value.cost, 'cost');
    const tax = zeroOrOne(value.tax, 'tax');
    const barcode = boundedText(value.barcode, 'barcode', 255);
    const inventory = zeroOrOne(value.inventory, 'inventory');
    boundedText(value.edit_date, 'edit_date', 100);
    boundedText(value.category_uuid, 'category_uuid', 64);
    boundedText(value.photo_document_uuid, 'photo_document_uuid', 64);
    return {
      uuid: value.uuid,
      ...(name !== undefined ? { name } : {}),
      ...(itemNumber !== undefined ? { item_number: itemNumber } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(price !== undefined ? { price } : {}),
      ...(cost !== undefined ? { cost } : {}),
      ...(tax !== undefined ? { tax } : {}),
      ...(barcode !== undefined ? { barcode } : {}),
      ...(inventory !== undefined ? { inventory } : {}),
    };
  });
}

function serialiseMaterial(input: ServiceM8MaterialWrite): Readonly<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    name: input.name,
    item_number: input.item_number,
  };
  for (const key of ['description', 'price', 'cost', 'tax', 'barcode', 'inventory'] as const) {
    const value = input[key];
    if (value !== undefined) body[key] = value;
  }
  return body;
}

function retryDelay(response: HttpResponse<unknown>, attempt: number): number {
  const raw = response.headers?.['retry-after'];
  const seconds = raw === undefined ? Number.NaN : Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 30_000);
  return Math.min(250 * 2 ** (attempt - 1), 2_000);
}

async function withBoundedUpdateRetry(
  request: () => Promise<HttpResponse<unknown>>,
  delay: (milliseconds: number) => Promise<void>,
  reconcile: () => Promise<string | undefined>,
): Promise<{ response: HttpResponse<unknown>; attempts: number; reconciledId?: string }> {
  let last: HttpResponse<unknown> = { status: 503, uncertain: true };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      last = await request();
    } catch {
      last = { status: 503, uncertain: true };
    }
    if (last.status !== 429 && last.status !== 503 && !last.uncertain) {
      return { response: last, attempts: attempt };
    }
    const reconciledId = await reconcile();
    if (reconciledId) return { response: last, attempts: attempt, reconciledId };
    if (attempt < MAX_ATTEMPTS) await delay(retryDelay(last, attempt));
  }
  return { response: last, attempts: MAX_ATTEMPTS };
}

async function createOnceThenReconcile(
  request: () => Promise<HttpResponse<unknown>>,
  reconcile: () => Promise<string | undefined>,
): Promise<{ response: HttpResponse<unknown>; attempts: 1; reconciledId?: string }> {
  const response = await request();
  const possiblyApplied =
    response.uncertain === true ||
    response.status === 429 ||
    response.status === 503 ||
    (response.status >= 200 && response.status < 300);
  if (!possiblyApplied) return { response, attempts: 1 };
  const reconciledId = await reconcile();
  return reconciledId === undefined
    ? { response, attempts: 1 }
    : { response, attempts: 1, reconciledId };
}

export function createServiceM8MaterialsPort(transport: HttpTransport): ServiceM8MaterialsPort {
  return {
    async listMaterials() {
      const response = await transport<unknown>({
        method: 'GET',
        path: MATERIAL_PATH,
      });
      assertTransportResponse<unknown>(response, 'ServiceM8 materials read');
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`ServiceM8 material read failed with HTTP ${response.status}.`);
      }
      return parseMaterials(response.body);
    },
    async createMaterial(material) {
      const response = await transport({
        method: 'POST',
        path: MATERIAL_PATH,
        body: serialiseMaterial(material),
      });
      assertTransportResponse<unknown>(response, 'ServiceM8 material create');
      return response;
    },
    async updateMaterial(uuid, material) {
      if (!/^[A-Za-z0-9-]+$/.test(uuid)) throw new Error('Invalid ServiceM8 material identifier.');
      const response = await transport({
        method: 'POST',
        path: `/api_1.0/material/${encodeURIComponent(uuid)}.json`,
        body: serialiseMaterial(material),
      });
      assertTransportResponse<unknown>(response, 'ServiceM8 material update');
      return response;
    },
  };
}

function sameMaterial(current: ServiceM8Material, intended: ServiceM8MaterialWrite): boolean {
  return (Object.keys(serialiseMaterial(intended)) as (keyof ServiceM8MaterialWrite)[]).every(
    (key) => current[key] === intended[key],
  );
}

function findExisting(
  materials: readonly ServiceM8Material[],
  intent: ServiceM8SyncIntent,
): ServiceM8Material | undefined {
  if (intent.externalId) return materials.find((item) => item.uuid === intent.externalId);
  return materials.find((item) => item.item_number === intent.material.item_number);
}

function assertIntentIdentities(intents: readonly ServiceM8SyncIntent[]) {
  const idempotencyKeys = new Set<string>();
  const localItemIds = new Set<string>();
  for (const intent of intents) {
    if (
      !intent.idempotencyKey.trim() ||
      intent.idempotencyKey.length > 500 ||
      idempotencyKeys.has(intent.idempotencyKey)
    ) {
      throw new Error('Every ServiceM8 sync intent requires a unique stable idempotency key.');
    }
    if (
      !intent.localItemId.trim() ||
      intent.localItemId.length > 200 ||
      localItemIds.has(intent.localItemId)
    ) {
      throw new Error(
        'Every ServiceM8 sync intent requires a unique stable local item identifier.',
      );
    }
    if (intent.externalId !== undefined && !MATERIAL_ID.test(intent.externalId)) {
      throw new Error('ServiceM8 sync intent has an invalid external identifier.');
    }
    const unexpected = Object.keys(intent.material).find(
      (field) => !MATERIAL_WRITE_FIELDS.has(field),
    );
    if (unexpected) {
      throw new Error(
        'ServiceM8 sync intent contains unexpected material field ' + unexpected + '.',
      );
    }
    if (
      typeof intent.material.name !== 'string' ||
      intent.material.name.trim() === '' ||
      intent.material.name.length > 255 ||
      typeof intent.material.item_number !== 'string' ||
      intent.material.item_number.trim() === '' ||
      intent.material.item_number.length > 30
    ) {
      throw new Error('ServiceM8 sync intent has invalid required material text.');
    }
    boundedText(intent.material.description, 'intent description', 4_000);
    boundedText(intent.material.barcode, 'intent barcode', 255);
    boundedAmount(intent.material.price, 'intent price');
    boundedAmount(intent.material.cost, 'intent cost');
    zeroOrOne(intent.material.tax, 'intent tax');
    zeroOrOne(intent.material.inventory, 'intent inventory');
    idempotencyKeys.add(intent.idempotencyKey);
    localItemIds.add(intent.localItemId);
  }
}

function snapshotIntentSet(
  intents: readonly ServiceM8SyncIntent[],
): readonly ServiceM8SyncIntent[] {
  assertIntentIdentities(intents);
  return Object.freeze(
    intents.map((intent) =>
      Object.freeze({
        localItemId: intent.localItemId,
        idempotencyKey: intent.idempotencyKey,
        ...(intent.externalId !== undefined ? { externalId: intent.externalId } : {}),
        material: Object.freeze({
          name: intent.material.name,
          item_number: intent.material.item_number,
          ...(intent.material.description !== undefined
            ? { description: intent.material.description }
            : {}),
          ...(intent.material.price !== undefined ? { price: intent.material.price } : {}),
          ...(intent.material.cost !== undefined ? { cost: intent.material.cost } : {}),
          ...(intent.material.tax !== undefined ? { tax: intent.material.tax } : {}),
          ...(intent.material.barcode !== undefined ? { barcode: intent.material.barcode } : {}),
          ...(intent.material.inventory !== undefined
            ? { inventory: intent.material.inventory }
            : {}),
        }),
      }),
    ),
  );
}

async function fingerprintIntentSet(intents: readonly ServiceM8SyncIntent[]): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Secure intent fingerprinting is unavailable; the sync cannot start safely.');
  }
  const canonical = intents.map((intent) => ({
    localItemId: intent.localItemId,
    idempotencyKey: intent.idempotencyKey,
    externalId: intent.externalId ?? null,
    material: serialiseMaterial(intent.material),
  }));
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(canonical)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createServiceM8SyncPreview(
  runId: string,
  intents: readonly ServiceM8SyncIntent[],
  createdAt = new Date().toISOString(),
): Promise<ServiceM8SyncPreview> {
  if (runId.trim() === '' || runId.length > 200 || !Number.isFinite(Date.parse(createdAt))) {
    throw new Error('ServiceM8 preview identity or creation time is invalid.');
  }
  const snapshot = snapshotIntentSet(intents);
  const preview = {
    runId,
    intentSetFingerprint: await fingerprintIntentSet(snapshot),
    orderedLocalItemIds: Object.freeze(snapshot.map((intent) => intent.localItemId)),
    persistedIdempotencyKeys: Object.freeze(snapshot.map((intent) => intent.idempotencyKey)),
    createdAt,
  };
  return Object.freeze(preview);
}

function snapshotPreview(value: unknown): ServiceM8SyncPreview {
  if (!isRecord(value)) {
    throw new Error('ServiceM8 execution does not contain a valid immutable preview.');
  }
  const unexpected = Object.keys(value).find((field) => !PREVIEW_FIELDS.has(field));
  if (
    unexpected ||
    typeof value.runId !== 'string' ||
    typeof value.intentSetFingerprint !== 'string' ||
    !FINGERPRINT.test(value.intentSetFingerprint) ||
    !Array.isArray(value.orderedLocalItemIds) ||
    !value.orderedLocalItemIds.every((id) => typeof id === 'string') ||
    !Array.isArray(value.persistedIdempotencyKeys) ||
    !value.persistedIdempotencyKeys.every((key) => typeof key === 'string') ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw new Error('ServiceM8 execution does not contain a valid immutable preview.');
  }
  return Object.freeze({
    runId: value.runId,
    intentSetFingerprint: value.intentSetFingerprint,
    orderedLocalItemIds: Object.freeze([...value.orderedLocalItemIds]),
    persistedIdempotencyKeys: Object.freeze([...value.persistedIdempotencyKeys]),
    createdAt: value.createdAt,
  });
}

function assertPreviewMatchesIntentSet(
  runId: string,
  intents: readonly ServiceM8SyncIntent[],
  fingerprint: string,
  preview: ServiceM8SyncPreview,
) {
  const localItemIds = intents.map((intent) => intent.localItemId);
  const idempotencyKeys = intents.map((intent) => intent.idempotencyKey);
  if (
    preview.runId !== runId ||
    preview.intentSetFingerprint !== fingerprint ||
    preview.orderedLocalItemIds.length !== localItemIds.length ||
    preview.orderedLocalItemIds.some((id, index) => id !== localItemIds[index]) ||
    preview.persistedIdempotencyKeys.length !== idempotencyKeys.length ||
    preview.persistedIdempotencyKeys.some((key, index) => key !== idempotencyKeys[index])
  ) {
    throw new Error('ServiceM8 execution does not match the immutable approved preview.');
  }
}

function snapshotApprovalRecord(value: unknown): ServiceM8ApprovalLedgerRecord {
  if (!isRecord(value)) {
    throw new Error('ServiceM8 authoritative approval record was not found.');
  }
  const unexpected = Object.keys(value).find((field) => !APPROVAL_RECORD_FIELDS.has(field));
  if (
    unexpected ||
    typeof value.proofReference !== 'string' ||
    value.proofReference.trim() === '' ||
    value.proofReference.length > 500 ||
    typeof value.runId !== 'string' ||
    value.runId.trim() === '' ||
    value.runId.length > 200 ||
    typeof value.previewFingerprint !== 'string' ||
    !FINGERPRINT.test(value.previewFingerprint) ||
    typeof value.previewCreatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.previewCreatedAt)) ||
    !Array.isArray(value.orderedLocalItemIds) ||
    !value.orderedLocalItemIds.every((id) => typeof id === 'string') ||
    !Array.isArray(value.persistedIdempotencyKeys) ||
    !value.persistedIdempotencyKeys.every((key) => typeof key === 'string') ||
    typeof value.approvedBy !== 'string' ||
    value.approvedBy.trim() === '' ||
    value.approvedBy.length > 200 ||
    typeof value.approvedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.approvedAt))
  ) {
    throw new Error('ServiceM8 authoritative approval record is malformed.');
  }
  return Object.freeze({
    proofReference: value.proofReference,
    runId: value.runId,
    previewFingerprint: value.previewFingerprint,
    previewCreatedAt: value.previewCreatedAt,
    orderedLocalItemIds: Object.freeze([...value.orderedLocalItemIds]),
    persistedIdempotencyKeys: Object.freeze([...value.persistedIdempotencyKeys]),
    approvedBy: value.approvedBy,
    approvedAt: value.approvedAt,
  });
}

function assertAuthoritativeApproval(
  proofReference: string,
  preview: ServiceM8SyncPreview,
  approval: ServiceM8ApprovalLedgerRecord,
) {
  if (
    approval.proofReference !== proofReference ||
    approval.runId !== preview.runId ||
    approval.previewFingerprint !== preview.intentSetFingerprint ||
    approval.previewCreatedAt !== preview.createdAt ||
    approval.orderedLocalItemIds.length !== preview.orderedLocalItemIds.length ||
    approval.orderedLocalItemIds.some((id, index) => id !== preview.orderedLocalItemIds[index]) ||
    approval.persistedIdempotencyKeys.length !== preview.persistedIdempotencyKeys.length ||
    approval.persistedIdempotencyKeys.some(
      (key, index) => key !== preview.persistedIdempotencyKeys[index],
    ) ||
    Date.parse(approval.approvedAt) < Date.parse(preview.createdAt)
  ) {
    throw new Error(
      'ServiceM8 authoritative approval does not bind this exact preview and intent set.',
    );
  }
}

function checkpointFor(
  runId: string,
  nextIndex: number,
  completedLocalItemIds: readonly string[],
  intentSetFingerprint: string,
  persistedIdempotencyKeys: readonly string[],
  updatedAt: string,
  manualReconciliationRequired?: SyncManualReconciliationRequired,
  createAttemptedAwaitingReconciliation?: SyncCreateAttemptedAwaitingReconciliation,
): SyncCheckpoint {
  if (
    manualReconciliationRequired !== undefined &&
    createAttemptedAwaitingReconciliation !== undefined
  ) {
    throw new Error('ServiceM8 checkpoint cannot contain two create reconciliation states.');
  }
  return Object.freeze({
    runId,
    nextIndex,
    completedLocalItemIds: Object.freeze([...completedLocalItemIds]),
    intentSetFingerprint,
    persistedIdempotencyKeys: Object.freeze([...persistedIdempotencyKeys]),
    ...(manualReconciliationRequired !== undefined
      ? {
          manualReconciliationRequired: Object.freeze({
            ...manualReconciliationRequired,
          }),
        }
      : {}),
    ...(createAttemptedAwaitingReconciliation !== undefined
      ? {
          createAttemptedAwaitingReconciliation: Object.freeze({
            ...createAttemptedAwaitingReconciliation,
          }),
        }
      : {}),
    updatedAt,
  });
}

function assertResumeCheckpoint(
  checkpoint: SyncCheckpoint,
  runId: string,
  intents: readonly ServiceM8SyncIntent[],
  intentSetFingerprint: string,
  persistedIdempotencyKeys: readonly string[],
) {
  if (
    typeof checkpoint.intentSetFingerprint !== 'string' ||
    !Array.isArray(checkpoint.persistedIdempotencyKeys) ||
    !Array.isArray(checkpoint.completedLocalItemIds)
  ) {
    throw new Error(
      'Legacy ServiceM8 checkpoint lacks intent binding; start a new run with a new run identifier.',
    );
  }
  if (checkpoint.runId !== runId) {
    throw new Error('ServiceM8 checkpoint run identifier does not match the requested run.');
  }
  if (checkpoint.intentSetFingerprint !== intentSetFingerprint) {
    throw new Error('ServiceM8 checkpoint intent set does not match the current ordered intents.');
  }
  if (
    checkpoint.persistedIdempotencyKeys.length !== persistedIdempotencyKeys.length ||
    checkpoint.persistedIdempotencyKeys.some(
      (key, index) => key !== persistedIdempotencyKeys[index],
    )
  ) {
    throw new Error(
      'ServiceM8 checkpoint idempotency keys do not match the current ordered intents.',
    );
  }
  if (
    !Number.isInteger(checkpoint.nextIndex) ||
    checkpoint.nextIndex < 0 ||
    checkpoint.nextIndex > intents.length ||
    typeof checkpoint.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(checkpoint.updatedAt))
  ) {
    throw new Error('ServiceM8 checkpoint cursor is outside the current intent set.');
  }
  const expectedCompleted = intents
    .slice(0, checkpoint.nextIndex)
    .map((intent) => intent.localItemId);
  if (
    checkpoint.completedLocalItemIds.length !== expectedCompleted.length ||
    checkpoint.completedLocalItemIds.some((id, index) => id !== expectedCompleted[index])
  ) {
    throw new Error('ServiceM8 checkpoint completion set is not the exact resolved cursor prefix.');
  }
  const hold = checkpoint.manualReconciliationRequired;
  const createAttempt = checkpoint.createAttemptedAwaitingReconciliation;
  if (hold !== undefined && createAttempt !== undefined) {
    throw new Error('ServiceM8 checkpoint contains conflicting create reconciliation states.');
  }
  if (hold !== undefined) {
    const currentIntent = intents[checkpoint.nextIndex];
    const unexpected = isRecord(hold)
      ? Object.keys(hold).find((field) => !MANUAL_RECONCILIATION_FIELDS.has(field))
      : 'invalid';
    if (
      !isRecord(hold) ||
      unexpected ||
      hold.state !== 'manual-reconciliation-required' ||
      hold.operation !== 'create' ||
      typeof hold.localItemId !== 'string' ||
      typeof hold.idempotencyKey !== 'string' ||
      typeof hold.reason !== 'string' ||
      hold.reason.trim() === '' ||
      hold.reason.length > 500 ||
      typeof hold.recordedAt !== 'string' ||
      !Number.isFinite(Date.parse(hold.recordedAt)) ||
      currentIntent === undefined ||
      hold.localItemId !== currentIntent.localItemId ||
      hold.idempotencyKey !== currentIntent.idempotencyKey
    ) {
      throw new Error('ServiceM8 checkpoint manual reconciliation state is invalid.');
    }
  }
  if (createAttempt !== undefined) {
    const currentIntent = intents[checkpoint.nextIndex];
    const unexpected = isRecord(createAttempt)
      ? Object.keys(createAttempt).find((field) => !CREATE_ATTEMPT_FIELDS.has(field))
      : 'invalid';
    if (
      !isRecord(createAttempt) ||
      unexpected ||
      createAttempt.state !== 'create-attempted-awaiting-reconciliation' ||
      createAttempt.operation !== 'create' ||
      typeof createAttempt.localItemId !== 'string' ||
      typeof createAttempt.idempotencyKey !== 'string' ||
      typeof createAttempt.recordedAt !== 'string' ||
      !Number.isFinite(Date.parse(createAttempt.recordedAt)) ||
      currentIntent === undefined ||
      createAttempt.localItemId !== currentIntent.localItemId ||
      createAttempt.idempotencyKey !== currentIntent.idempotencyKey
    ) {
      throw new Error('ServiceM8 checkpoint create-attempt marker is invalid.');
    }
  }
}

export async function syncServiceM8Materials(
  options: ServiceM8SyncOptions,
): Promise<SyncBatchResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const delay =
    options.delay ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const outcomes: SyncItemOutcome[] = [];
  const readMaterials = async (): Promise<readonly ServiceM8Material[] | undefined> => {
    try {
      return await options.port.listMaterials();
    } catch {
      return undefined;
    }
  };
  const executionIntents = snapshotIntentSet(options.intents);
  const persistedIdempotencyKeys = executionIntents.map((intent) => intent.idempotencyKey);
  const intentSetFingerprint = await fingerprintIntentSet(executionIntents);
  const preview = snapshotPreview(options.preview);
  assertPreviewMatchesIntentSet(options.runId, executionIntents, intentSetFingerprint, preview);
  if (
    typeof options.approvalProofReference !== 'string' ||
    options.approvalProofReference.trim() === '' ||
    options.approvalProofReference.length > 500 ||
    !isRecord(options.approvalLedger) ||
    typeof options.approvalLedger.loadApproval !== 'function'
  ) {
    throw new Error('ServiceM8 execution requires an authoritative approval ledger reference.');
  }
  const approval = snapshotApprovalRecord(
    await options.approvalLedger.loadApproval(options.approvalProofReference),
  );
  assertAuthoritativeApproval(options.approvalProofReference, preview, approval);
  const loaded = await options.checkpointStore.load(options.runId);
  if (loaded) {
    assertResumeCheckpoint(
      loaded,
      options.runId,
      executionIntents,
      intentSetFingerprint,
      persistedIdempotencyKeys,
    );
  }
  const completed = [...(loaded?.completedLocalItemIds ?? [])];
  let durableCheckpoint =
    loaded !== undefined
      ? checkpointFor(
          loaded.runId,
          loaded.nextIndex,
          loaded.completedLocalItemIds,
          loaded.intentSetFingerprint,
          loaded.persistedIdempotencyKeys,
          loaded.updatedAt,
          loaded.manualReconciliationRequired,
          loaded.createAttemptedAwaitingReconciliation,
        )
      : checkpointFor(
          options.runId,
          0,
          completed,
          intentSetFingerprint,
          persistedIdempotencyKeys,
          now(),
        );
  if (!loaded) await options.checkpointStore.save(durableCheckpoint);

  for (let index = durableCheckpoint.nextIndex; index < executionIntents.length; index += 1) {
    const intent = executionIntents[index];
    if (!intent) break;
    let outcome: SyncItemOutcome;
    let checkpointHold = durableCheckpoint.manualReconciliationRequired;
    let createAttemptMarker = durableCheckpoint.createAttemptedAwaitingReconciliation;
    let materials = await readMaterials();
    const before = materials ? findExisting(materials, intent) : undefined;

    if (checkpointHold !== undefined || createAttemptMarker !== undefined) {
      if (before && sameMaterial(before, intent.material)) {
        outcome = {
          localItemId: intent.localItemId,
          idempotencyKey: intent.idempotencyKey,
          operation: 'create',
          status: 'succeeded',
          externalId: before.uuid,
          reason: 'Authoritative ServiceM8 read cleared the manual reconciliation hold.',
          attempts: 0,
        };
        checkpointHold = undefined;
        createAttemptMarker = undefined;
      } else {
        if (createAttemptMarker !== undefined) {
          checkpointHold = Object.freeze({
            state: 'manual-reconciliation-required',
            operation: 'create',
            localItemId: intent.localItemId,
            idempotencyKey: intent.idempotencyKey,
            reason:
              'The write-ahead create attempt remains unconfirmed, so automatic create is blocked pending authoritative reconciliation.',
            recordedAt: now(),
          });
          createAttemptMarker = undefined;
        }
        outcome = {
          localItemId: intent.localItemId,
          idempotencyKey: intent.idempotencyKey,
          operation: 'blocked',
          status: 'manual-reconciliation-required',
          reason:
            'Automatic create remains blocked until an authoritative ServiceM8 read confirms the result.',
          attempts: 0,
        };
      }
    } else if (!materials) {
      outcome = {
        localItemId: intent.localItemId,
        idempotencyKey: intent.idempotencyKey,
        operation: 'read',
        status: 'failed',
        reason: 'ServiceM8 materials could not be read before a write decision.',
        attempts: 0,
      };
    } else if (before && sameMaterial(before, intent.material)) {
      outcome = {
        localItemId: intent.localItemId,
        idempotencyKey: intent.idempotencyKey,
        operation: 'unchanged',
        status: 'succeeded',
        externalId: before.uuid,
        attempts: 0,
      };
    } else if (!before) {
      const createAttemptedAt = now();
      createAttemptMarker = Object.freeze({
        state: 'create-attempted-awaiting-reconciliation',
        operation: 'create',
        localItemId: intent.localItemId,
        idempotencyKey: intent.idempotencyKey,
        recordedAt: createAttemptedAt,
      });
      durableCheckpoint = checkpointFor(
        options.runId,
        index,
        completed,
        intentSetFingerprint,
        persistedIdempotencyKeys,
        createAttemptedAt,
        undefined,
        createAttemptMarker,
      );
      await options.checkpointStore.save(durableCheckpoint);
      const result = await createOnceThenReconcile(
        () => options.port.createMaterial(intent.material),
        async () => {
          const current = await readMaterials();
          const reconciled = current ? findExisting(current, intent) : undefined;
          return reconciled && sameMaterial(reconciled, intent.material)
            ? reconciled.uuid
            : undefined;
        },
      );
      if (result.reconciledId) {
        createAttemptMarker = undefined;
        outcome = {
          localItemId: intent.localItemId,
          idempotencyKey: intent.idempotencyKey,
          operation: 'create',
          status: 'succeeded',
          externalId: result.reconciledId,
          reason: 'Reconciled after an uncertain provider result.',
          attempts: 1,
        };
      } else if (
        result.response.uncertain ||
        result.response.status === 429 ||
        result.response.status === 503 ||
        (result.response.status >= 200 && result.response.status < 300)
      ) {
        createAttemptMarker = undefined;
        checkpointHold = Object.freeze({
          state: 'manual-reconciliation-required',
          operation: 'create',
          localItemId: intent.localItemId,
          idempotencyKey: intent.idempotencyKey,
          reason:
            'The create may have been applied, so automatic create retries are blocked pending authoritative reconciliation.',
          recordedAt: now(),
        });
        outcome = {
          localItemId: intent.localItemId,
          idempotencyKey: intent.idempotencyKey,
          operation: 'create',
          status: 'manual-reconciliation-required',
          reason: checkpointHold.reason,
          attempts: 1,
        };
      } else {
        createAttemptMarker = undefined;
        outcome = {
          localItemId: intent.localItemId,
          idempotencyKey: intent.idempotencyKey,
          operation: 'create',
          status: 'failed',
          reason: `ServiceM8 returned HTTP ${result.response.status}.`,
          attempts: 1,
        };
      }
    } else {
      const result = await withBoundedUpdateRetry(
        () => options.port.updateMaterial(before.uuid, intent.material),
        delay,
        async () => {
          const current = await readMaterials();
          const reconciled = current ? findExisting(current, intent) : undefined;
          return reconciled && sameMaterial(reconciled, intent.material)
            ? reconciled.uuid
            : undefined;
        },
      );
      if (result.reconciledId) {
        outcome = {
          localItemId: intent.localItemId,
          idempotencyKey: intent.idempotencyKey,
          operation: 'update',
          status: 'succeeded',
          externalId: result.reconciledId,
          reason: 'Reconciled after an uncertain provider result.',
          attempts: result.attempts,
        };
      } else if (
        result.response.status >= 200 &&
        result.response.status < 300 &&
        !result.response.uncertain
      ) {
        materials = await readMaterials();
        const reconciled = materials ? findExisting(materials, intent) : undefined;
        outcome =
          reconciled && sameMaterial(reconciled, intent.material)
            ? {
                localItemId: intent.localItemId,
                idempotencyKey: intent.idempotencyKey,
                operation: 'update',
                status: 'succeeded',
                externalId: reconciled.uuid,
                attempts: result.attempts,
              }
            : {
                localItemId: intent.localItemId,
                idempotencyKey: intent.idempotencyKey,
                operation: 'update',
                status: 'uncertain',
                reason: 'Provider success could not be confirmed by read-back.',
                attempts: result.attempts,
              };
      } else if (
        result.response.uncertain ||
        result.response.status === 429 ||
        result.response.status === 503
      ) {
        materials = await readMaterials();
        const reconciled = materials ? findExisting(materials, intent) : undefined;
        outcome =
          reconciled && sameMaterial(reconciled, intent.material)
            ? {
                localItemId: intent.localItemId,
                idempotencyKey: intent.idempotencyKey,
                operation: 'update',
                status: 'succeeded',
                externalId: reconciled.uuid,
                reason: 'Reconciled after an uncertain provider result.',
                attempts: result.attempts,
              }
            : {
                localItemId: intent.localItemId,
                idempotencyKey: intent.idempotencyKey,
                operation: 'update',
                status: 'uncertain',
                reason: `Provider result remained uncertain after ${result.attempts} bounded attempts.`,
                attempts: result.attempts,
              };
      } else {
        outcome = {
          localItemId: intent.localItemId,
          idempotencyKey: intent.idempotencyKey,
          operation: 'update',
          status: 'failed',
          reason: `ServiceM8 returned HTTP ${result.response.status}.`,
          attempts: result.attempts,
        };
      }
    }

    outcomes.push(outcome);
    await options.checkpointStore.appendOutcome(options.runId, outcome);
    if (outcome.status !== 'succeeded') {
      durableCheckpoint = checkpointFor(
        options.runId,
        index,
        completed,
        intentSetFingerprint,
        persistedIdempotencyKeys,
        now(),
        checkpointHold,
        createAttemptMarker,
      );
      await options.checkpointStore.save(durableCheckpoint);
      break;
    }
    completed.push(intent.localItemId);
    durableCheckpoint = checkpointFor(
      options.runId,
      index + 1,
      completed,
      intentSetFingerprint,
      persistedIdempotencyKeys,
      now(),
    );
    await options.checkpointStore.save(durableCheckpoint);
  }

  return { outcomes, checkpoint: durableCheckpoint };
}
