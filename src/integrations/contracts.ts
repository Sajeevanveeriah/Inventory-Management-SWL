export type SyncOperation = 'read' | 'create' | 'update' | 'unchanged' | 'blocked';

export type SyncOutcomeStatus =
  'succeeded' | 'failed' | 'uncertain' | 'manual-reconciliation-required' | 'skipped';

export interface SyncManualReconciliationRequired {
  readonly state: 'manual-reconciliation-required';
  readonly operation: 'create';
  readonly localItemId: string;
  readonly idempotencyKey: string;
  readonly reason: string;
  readonly recordedAt: string;
}

export interface SyncCreateAttemptedAwaitingReconciliation {
  readonly state: 'create-attempted-awaiting-reconciliation';
  readonly operation: 'create';
  readonly localItemId: string;
  readonly idempotencyKey: string;
  readonly recordedAt: string;
}

export interface SyncItemOutcome {
  readonly localItemId: string;
  readonly idempotencyKey?: string;
  readonly operation: SyncOperation;
  readonly status: SyncOutcomeStatus;
  readonly externalId?: string;
  readonly reason?: string;
  readonly attempts: number;
}

export interface SyncCheckpoint {
  readonly runId: string;
  readonly nextIndex: number;
  readonly completedLocalItemIds: readonly string[];
  readonly intentSetFingerprint: string;
  readonly persistedIdempotencyKeys: readonly string[];
  readonly createAttemptedAwaitingReconciliation?: SyncCreateAttemptedAwaitingReconciliation;
  readonly manualReconciliationRequired?: SyncManualReconciliationRequired;
  readonly updatedAt: string;
}

export interface SyncBatchResult {
  readonly outcomes: readonly SyncItemOutcome[];
  readonly checkpoint: SyncCheckpoint;
}

/**
 * Persistence boundary for a resumable sync. `save` must be atomic and durable:
 * it resolves only after the exact checkpoint is committed and recoverable
 * after process or host termination. Calls for one run must remain ordered.
 * Before any non-idempotent create, orchestration saves a write-ahead
 * create-attempt marker and must not call the provider if that save rejects.
 * Later outcome or checkpoint failures must never erase that last committed
 * marker. `appendOutcome` may be replayed after recovery and implementations
 * should deduplicate by run, item, idempotency key and outcome identity.
 * Implementations store operational identifiers and outcomes only, never
 * provider credentials or tokens.
 */
export interface SyncCheckpointStore {
  load(runId: string): Promise<SyncCheckpoint | undefined>;
  save(checkpoint: SyncCheckpoint): Promise<void>;
  appendOutcome(runId: string, outcome: SyncItemOutcome): Promise<void>;
}

export interface HttpRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: Readonly<Record<string, unknown>>;
}

export interface HttpResponse<T> {
  readonly status: number;
  readonly body?: T;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  /** True when the transport cannot determine whether the provider applied the request. */
  readonly uncertain?: boolean;
}

/** Injected authenticated transport. Authentication never enters domain models. */
export type HttpTransport = <T>(request: HttpRequest) => Promise<HttpResponse<T>>;
