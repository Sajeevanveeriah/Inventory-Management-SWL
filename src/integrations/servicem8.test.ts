import { describe, expect, it, vi } from 'vitest';
import type {
  HttpRequest,
  SyncCheckpoint,
  SyncCheckpointStore,
  SyncItemOutcome,
} from './contracts';
import {
  createServiceM8MaterialsPort,
  createServiceM8SyncPreview,
  createServiceM8WriteIntent,
  syncServiceM8Materials as executeServiceM8Materials,
  type ServiceM8ApprovalLedgerRecord,
  type ServiceM8SyncOptions,
  type ServiceM8SyncPreview,
} from './servicem8';

function approvalRecord(preview: ServiceM8SyncPreview): ServiceM8ApprovalLedgerRecord {
  return Object.freeze({
    proofReference: 'synthetic-approval-record',
    runId: preview.runId,
    previewFingerprint: preview.intentSetFingerprint,
    previewCreatedAt: preview.createdAt,
    orderedLocalItemIds: Object.freeze([...preview.orderedLocalItemIds]),
    persistedIdempotencyKeys: Object.freeze([...preview.persistedIdempotencyKeys]),
    approvedBy: 'Synthetic test operator',
    approvedAt: '2026-08-20T00:00:01.000Z',
  });
}

async function syncServiceM8Materials(
  options: Omit<ServiceM8SyncOptions, 'preview' | 'approvalProofReference' | 'approvalLedger'>,
) {
  const preview = await createServiceM8SyncPreview(
    options.runId,
    options.intents,
    '2026-08-20T00:00:00.000Z',
  );
  return executeServiceM8Materials({
    ...options,
    preview,
    approvalProofReference: 'synthetic-approval-record',
    approvalLedger: {
      loadApproval: vi.fn().mockResolvedValue(approvalRecord(preview)),
    },
  });
}

function memoryStore(initial?: SyncCheckpoint): SyncCheckpointStore & {
  checkpoints: SyncCheckpoint[];
  outcomes: SyncItemOutcome[];
} {
  const checkpoints: SyncCheckpoint[] = [];
  const outcomes: SyncItemOutcome[] = [];
  return {
    checkpoints,
    outcomes,
    load: vi.fn().mockResolvedValue(initial),
    save: vi.fn(async (checkpoint) => void checkpoints.push(checkpoint)),
    appendOutcome: vi.fn(async (_runId, outcome) => void outcomes.push(outcome)),
  };
}

function durableFailureStore(
  options: {
    initial?: SyncCheckpoint;
    rejectAppend?: boolean;
    rejectSaveCall?: number;
    commitThenRejectSaveCall?: number;
  } = {},
): SyncCheckpointStore & {
  readonly durableCheckpoint: SyncCheckpoint | undefined;
  readonly outcomes: SyncItemOutcome[];
} {
  let durableCheckpoint = options.initial;
  let saveCall = 0;
  const outcomes: SyncItemOutcome[] = [];
  return {
    get durableCheckpoint() {
      return durableCheckpoint;
    },
    outcomes,
    load: vi.fn(async () => durableCheckpoint),
    save: vi.fn(async (checkpoint) => {
      saveCall += 1;
      if (saveCall === options.commitThenRejectSaveCall) {
        durableCheckpoint = checkpoint;
        throw new Error('synthetic termination after durable checkpoint commit');
      }
      if (saveCall === options.rejectSaveCall) {
        throw new Error('synthetic checkpoint save failure');
      }
      durableCheckpoint = checkpoint;
    }),
    appendOutcome: vi.fn(async (_runId, outcome) => {
      if (options.rejectAppend) throw new Error('synthetic outcome append failure');
      outcomes.push(outcome);
    }),
  };
}

describe('ServiceM8 materials port', () => {
  it('serialises only approved fields and never quantity-on-hand', async () => {
    const requests: HttpRequest[] = [];
    const port = createServiceM8MaterialsPort(async (request) => {
      requests.push(request);
      return { status: 200 };
    });
    const input = {
      name: 'Lock',
      item_number: 'LOCK-1',
      description: 'Synthetic fixture',
      price: 40,
      cost: 20,
      tax: 1 as const,
      inventory: 1 as const,
    };
    await port.createMaterial(input);
    await port.updateMaterial('abc-123', input);

    expect(requests[0]?.body).toEqual(input);
    expect(requests[0]?.body).not.toHaveProperty('quantity');
    expect(requests[0]?.body).not.toHaveProperty('quantity_on_hand');
    expect(requests[1]?.path).toBe('/api_1.0/material/abc-123.json');
    expect(Object.keys(port)).toEqual(['listMaterials', 'createMaterial', 'updateMaterial']);
    expect(port).not.toHaveProperty('deleteMaterial');
    expect(port).not.toHaveProperty('deactivateMaterial');
  });

  it('validates and projects the bounded material list response', async () => {
    const port = createServiceM8MaterialsPort(
      vi.fn().mockResolvedValue({
        status: 200,
        body: [
          {
            uuid: 'abc12345',
            name: 'Lock',
            item_number: 'LOCK-1',
            price: 40,
            cost: 20,
            tax: 1,
            inventory: 1,
            quantity: 7,
          },
        ],
      }),
    );

    await expect(port.listMaterials()).resolves.toEqual([
      {
        uuid: 'abc12345',
        name: 'Lock',
        item_number: 'LOCK-1',
        price: 40,
        cost: 20,
        tax: 1,
        inventory: 1,
      },
    ]);
  });

  it.each([
    ['an object instead of an array', {}, /must be an array/],
    ['a missing uuid', [{ item_number: 'LOCK-1' }], /invalid uuid/],
    [
      'duplicate uuids',
      [
        { uuid: 'abc12345', item_number: 'LOCK-1' },
        { uuid: 'abc12345', item_number: 'LOCK-2' },
      ],
      /duplicate uuid/,
    ],
    [
      'duplicate item numbers',
      [
        { uuid: 'abc12345', item_number: 'LOCK-1' },
        { uuid: 'def12345', item_number: 'LOCK-1' },
      ],
      /duplicate item_number/,
    ],
    [
      'a non-finite price',
      [{ uuid: 'abc12345', price: Number.POSITIVE_INFINITY }],
      /price is outside/,
    ],
    ['a negative cost', [{ uuid: 'abc12345', cost: -1 }], /cost is outside/],
    ['an invalid inventory flag', [{ uuid: 'abc12345', inventory: 2 }], /inventory must be 0 or 1/],
    [
      'an unexpected field',
      [{ uuid: 'abc12345', access_token: 'unexpected' }],
      /unexpected field access_token/,
    ],
  ])('rejects %s', async (_label, body, error) => {
    const port = createServiceM8MaterialsPort(vi.fn().mockResolvedValue({ status: 200, body }));
    await expect(port.listMaterials()).rejects.toThrow(error);
  });

  it('rejects malformed transport responses for reads and writes', async () => {
    const invalidStatus = createServiceM8MaterialsPort(
      vi.fn().mockResolvedValue({ status: Number.NaN, body: [] }),
    );
    await expect(invalidStatus.listMaterials()).rejects.toThrow(/invalid HTTP status/);

    const unexpected = createServiceM8MaterialsPort(
      vi.fn().mockResolvedValue({ status: 200, debug: true }),
    );
    await expect(
      unexpected.createMaterial({ name: 'Lock', item_number: 'LOCK-1' }),
    ).rejects.toThrow(/unexpected field debug/);
  });
});

describe('ServiceM8 write-intent creation', () => {
  it.each([
    ['physical-product', 1],
    ['service', 0],
    ['labour', 0],
  ] as const)('maps %s to inventory %i through the core item-kind rule', (itemKind, inventory) => {
    const intent = createServiceM8WriteIntent({
      runId: 'run-1',
      localItemId: 'local-1',
      revision: 'v1',
      itemKind,
      name: 'Synthetic item',
      itemNumber: 'ITEM-1',
      price: 40,
      cost: 20,
    });

    expect(intent).toMatchObject({
      idempotencyKey: 'run-1:local-1:v1',
      material: { inventory },
    });
  });

  it('rejects an unknown item kind instead of silently disabling inventory', () => {
    expect(() =>
      createServiceM8WriteIntent({
        runId: 'run-1',
        localItemId: 'local-1',
        revision: 'v1',
        itemKind: 'unknown-kind' as never,
        name: 'Synthetic item',
        itemNumber: 'ITEM-1',
      }),
    ).toThrow(/itemKind is invalid/);
  });
});

describe('ServiceM8 sync orchestration', () => {
  const intent = {
    localItemId: 'local-1',
    idempotencyKey: 'run-1:local-1:v1',
    material: { name: 'Lock', item_number: 'LOCK-1', price: 40 },
  };

  it('requires an authoritative ledger record before checkpoint or provider access', async () => {
    const preview = await createServiceM8SyncPreview('run-1', [intent], '2026-08-20T00:00:00.000Z');
    expect(Object.isFrozen(preview)).toBe(true);
    expect(Object.isFrozen(preview.orderedLocalItemIds)).toBe(true);
    const listMaterials = vi.fn();
    const createMaterial = vi.fn();
    const updateMaterial = vi.fn();
    const store = memoryStore();
    const fabricatedApproval = approvalRecord(preview);
    const loadApproval = vi.fn().mockResolvedValue(undefined);

    await expect(
      executeServiceM8Materials({
        runId: 'run-1',
        intents: [intent],
        port: { listMaterials, createMaterial, updateMaterial },
        checkpointStore: store,
        preview,
        approvalProofReference: fabricatedApproval.proofReference,
        approvalLedger: { loadApproval },
      }),
    ).rejects.toThrow(/authoritative approval record was not found/);

    expect(loadApproval).toHaveBeenCalledWith('synthetic-approval-record');
    expect(store.load).not.toHaveBeenCalled();
    expect(listMaterials).not.toHaveBeenCalled();
    expect(createMaterial).not.toHaveBeenCalled();
    expect(updateMaterial).not.toHaveBeenCalled();
  });

  it('requires the ledger record to bind the exact immutable preview and intent order', async () => {
    const preview = await createServiceM8SyncPreview('run-1', [intent], '2026-08-20T00:00:00.000Z');
    const listMaterials = vi.fn();
    const store = memoryStore();
    const base = {
      runId: 'run-1',
      intents: [{ ...intent, material: { ...intent.material, price: 41 } }],
      port: { listMaterials, createMaterial: vi.fn(), updateMaterial: vi.fn() },
      checkpointStore: store,
      preview,
      approvalProofReference: 'synthetic-approval-record',
      approvalLedger: {
        loadApproval: vi.fn().mockResolvedValue(approvalRecord(preview)),
      },
    };

    await expect(executeServiceM8Materials(base)).rejects.toThrow(
      /does not match the immutable approved preview/,
    );

    const mismatchedRecord = {
      ...approvalRecord(preview),
      orderedLocalItemIds: ['different-item'],
    };
    await expect(
      executeServiceM8Materials({
        ...base,
        intents: [intent],
        approvalLedger: {
          loadApproval: vi.fn().mockResolvedValue(mismatchedRecord),
        },
      }),
    ).rejects.toThrow(/does not bind this exact preview and intent set/);
    await expect(
      executeServiceM8Materials({
        ...base,
        intents: [intent],
        approvalLedger: {
          loadApproval: vi.fn().mockResolvedValue({
            ...approvalRecord(preview),
            access_token: 'synthetic-forbidden-field',
          }),
        },
      }),
    ).rejects.toThrow(/authoritative approval record is malformed/);
    await expect(
      executeServiceM8Materials({
        ...base,
        intents: [intent],
        preview: { ...preview, persistedIdempotencyKeys: null } as never,
      }),
    ).rejects.toThrow(/does not contain a valid immutable preview/);
    expect(store.load).not.toHaveBeenCalled();
    expect(listMaterials).not.toHaveBeenCalled();
  });

  it('reads before create and confirms the write by read-back', async () => {
    const listMaterials = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ uuid: 'external-1', ...intent.material }]);
    const createMaterial = vi.fn().mockResolvedValue({ status: 200 });
    const store = memoryStore();

    const result = await syncServiceM8Materials({
      runId: 'run-1',
      intents: [intent],
      port: { listMaterials, createMaterial, updateMaterial: vi.fn() },
      checkpointStore: store,
      now: () => '2026-08-20T00:00:00.000Z',
    });

    expect(listMaterials).toHaveBeenCalledTimes(2);
    expect(createMaterial).toHaveBeenCalledOnce();
    expect(result.outcomes[0]).toMatchObject({ status: 'succeeded', externalId: 'external-1' });
    expect(store.checkpoints.at(-1)?.nextIndex).toBe(1);
    expect(store.checkpoints[0]).toMatchObject({ nextIndex: 0, completedLocalItemIds: [] });
    expect(Object.isFrozen(result.checkpoint)).toBe(true);
    expect(Object.isFrozen(result.checkpoint.completedLocalItemIds)).toBe(true);
  });

  it('uses bounded Retry-After retries for an idempotent update and reconciles it', async () => {
    const before = { uuid: 'external-1', ...intent.material, price: 20 };
    const listMaterials = vi
      .fn()
      .mockResolvedValueOnce([before])
      .mockResolvedValueOnce([before])
      .mockResolvedValueOnce([before])
      .mockResolvedValueOnce([{ uuid: 'external-1', ...intent.material }]);
    const updateMaterial = vi
      .fn()
      .mockResolvedValueOnce({ status: 429, headers: { 'retry-after': '0.01' } })
      .mockResolvedValueOnce({ status: 503, uncertain: true })
      .mockResolvedValueOnce({ status: 503, uncertain: true });
    const createMaterial = vi.fn();
    const delay = vi.fn().mockResolvedValue(undefined);

    const result = await syncServiceM8Materials({
      runId: 'run-1',
      intents: [intent],
      port: { listMaterials, createMaterial, updateMaterial },
      checkpointStore: memoryStore(),
      delay,
    });

    expect(createMaterial).not.toHaveBeenCalled();
    expect(updateMaterial).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenNthCalledWith(1, 10);
    expect(delay).toHaveBeenNthCalledWith(2, 500);
    expect(result.outcomes[0]).toMatchObject({ status: 'succeeded', attempts: 3 });
  });

  it('does not advance past a failed item and resumes it with the same bound intent set', async () => {
    const second = {
      localItemId: 'local-2',
      idempotencyKey: 'run-1:local-2:v1',
      material: { name: 'Key', item_number: 'KEY-1' },
    };
    const firstStore = memoryStore();
    const first = await syncServiceM8Materials({
      runId: 'run-1',
      intents: [intent, second],
      port: {
        listMaterials: vi
          .fn()
          .mockResolvedValueOnce([{ uuid: 'external-1', ...intent.material }])
          .mockResolvedValueOnce([]),
        createMaterial: vi.fn().mockResolvedValue({ status: 400 }),
        updateMaterial: vi.fn(),
      },
      checkpointStore: firstStore,
    });

    expect(first.outcomes).toEqual([
      expect.objectContaining({ localItemId: 'local-1', status: 'succeeded' }),
      expect.objectContaining({ localItemId: 'local-2', status: 'failed', attempts: 1 }),
    ]);
    expect(first.checkpoint).toMatchObject({
      nextIndex: 1,
      completedLocalItemIds: ['local-1'],
      persistedIdempotencyKeys: [intent.idempotencyKey, second.idempotencyKey],
    });
    expect(first.checkpoint.intentSetFingerprint).toMatch(/^[a-f0-9]{64}$/);

    const resumeStore = memoryStore(first.checkpoint);
    const resumed = await syncServiceM8Materials({
      runId: 'run-1',
      intents: [intent, second],
      port: {
        listMaterials: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ uuid: 'external-2', ...second.material }]),
        createMaterial: vi.fn().mockResolvedValue({ status: 200 }),
        updateMaterial: vi.fn(),
      },
      checkpointStore: resumeStore,
    });

    expect(resumed.outcomes).toEqual([
      expect.objectContaining({ localItemId: 'local-2', status: 'succeeded' }),
    ]);
    expect(resumed.checkpoint).toMatchObject({
      nextIndex: 2,
      completedLocalItemIds: ['local-1', 'local-2'],
    });
  });

  it('records a per-item failure and performs no write when read-before-write fails', async () => {
    const store = memoryStore();
    const createMaterial = vi.fn();
    const result = await syncServiceM8Materials({
      runId: 'run-1',
      intents: [intent],
      port: {
        listMaterials: vi.fn().mockRejectedValue(new Error('synthetic read failure')),
        createMaterial,
        updateMaterial: vi.fn(),
      },
      checkpointStore: store,
    });

    expect(createMaterial).not.toHaveBeenCalled();
    expect(result.outcomes).toEqual([
      expect.objectContaining({ operation: 'read', status: 'failed', attempts: 0 }),
    ]);
    expect(store.outcomes).toEqual(result.outcomes);
  });

  it('rejects duplicate idempotency intents before a second provider write', async () => {
    const duplicate = { ...intent, localItemId: 'local-2' };
    const createMaterial = vi.fn().mockResolvedValue({ status: 400 });
    const port = {
      listMaterials: vi.fn().mockResolvedValue([]),
      createMaterial,
      updateMaterial: vi.fn(),
    };

    await expect(
      syncServiceM8Materials({
        runId: 'run-1',
        intents: [intent, duplicate],
        port,
        checkpointStore: memoryStore(),
      }),
    ).rejects.toThrow(/unique stable idempotency key/);
    expect(createMaterial).not.toHaveBeenCalled();
  });

  it.each([
    ['HTTP 429', { status: 429 }],
    ['HTTP 503', { status: 503 }],
    ['an uncertain success', { status: 202, uncertain: true }],
  ])('never automatically retries create after %s', async (_label, response) => {
    const createMaterial = vi.fn().mockResolvedValue(response);
    const result = await syncServiceM8Materials({
      runId: 'run-1',
      intents: [intent],
      port: {
        listMaterials: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]),
        createMaterial,
        updateMaterial: vi.fn(),
      },
      checkpointStore: memoryStore(),
    });

    expect(createMaterial).toHaveBeenCalledOnce();
    expect(result.outcomes[0]).toMatchObject({
      status: 'manual-reconciliation-required',
      attempts: 1,
    });
    expect(result.checkpoint.manualReconciliationRequired?.idempotencyKey).toBe(
      intent.idempotencyKey,
    );
  });

  it('recovers read-only when the provider applies then execution terminates immediately', async () => {
    const store = durableFailureStore();
    let providerAppliedCount = 0;
    const createMaterial = vi.fn().mockImplementation(async () => {
      providerAppliedCount += 1;
      throw new Error('synthetic termination immediately after provider apply');
    });

    await expect(
      syncServiceM8Materials({
        runId: 'run-1',
        intents: [intent],
        port: {
          listMaterials: vi.fn().mockResolvedValue([]),
          createMaterial,
          updateMaterial: vi.fn(),
        },
        checkpointStore: store,
        now: () => '2026-08-20T00:00:02.000Z',
      }),
    ).rejects.toThrow(/termination immediately after provider apply/);

    expect(providerAppliedCount).toBe(1);
    expect(createMaterial).toHaveBeenCalledOnce();
    expect(store.appendOutcome).not.toHaveBeenCalled();
    expect(store.save).toHaveBeenCalledTimes(2);
    expect(store.durableCheckpoint).toMatchObject({
      nextIndex: 0,
      completedLocalItemIds: [],
      createAttemptedAwaitingReconciliation: {
        state: 'create-attempted-awaiting-reconciliation',
        localItemId: intent.localItemId,
        idempotencyKey: intent.idempotencyKey,
      },
    });

    const resumeCreate = vi.fn();
    const recovered = await syncServiceM8Materials({
      runId: 'run-1',
      intents: [intent],
      port: {
        listMaterials: vi.fn().mockResolvedValue([{ uuid: 'external-1', ...intent.material }]),
        createMaterial: resumeCreate,
        updateMaterial: vi.fn(),
      },
      checkpointStore: memoryStore(store.durableCheckpoint),
    });

    expect(resumeCreate).not.toHaveBeenCalled();
    expect(recovered.outcomes[0]).toMatchObject({
      operation: 'create',
      status: 'succeeded',
      attempts: 0,
    });
    expect(recovered.checkpoint).toMatchObject({
      nextIndex: 1,
      completedLocalItemIds: [intent.localItemId],
    });
    expect(recovered.checkpoint.createAttemptedAwaitingReconciliation).toBeUndefined();
  });

  it('retains the write-ahead marker when outcome persistence fails after provider apply', async () => {
    const store = durableFailureStore({ rejectAppend: true });
    let providerAppliedCount = 0;
    const createMaterial = vi.fn().mockImplementation(async () => {
      providerAppliedCount += 1;
      return { status: 503, uncertain: true };
    });

    await expect(
      syncServiceM8Materials({
        runId: 'run-1',
        intents: [intent],
        port: {
          listMaterials: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]),
          createMaterial,
          updateMaterial: vi.fn(),
        },
        checkpointStore: store,
      }),
    ).rejects.toThrow(/synthetic outcome append failure/);

    expect(createMaterial).toHaveBeenCalledOnce();
    expect(providerAppliedCount).toBe(1);
    expect(store.durableCheckpoint?.createAttemptedAwaitingReconciliation).toMatchObject({
      idempotencyKey: intent.idempotencyKey,
    });

    const resumeCreate = vi.fn();
    const resumed = await syncServiceM8Materials({
      runId: 'run-1',
      intents: [intent],
      port: {
        listMaterials: vi.fn().mockResolvedValue([]),
        createMaterial: resumeCreate,
        updateMaterial: vi.fn(),
      },
      checkpointStore: memoryStore(store.durableCheckpoint),
    });

    expect(resumeCreate).not.toHaveBeenCalled();
    expect(resumed.outcomes[0]).toMatchObject({
      operation: 'blocked',
      status: 'manual-reconciliation-required',
    });
  });

  it('retains the write-ahead marker when the post-provider checkpoint save fails', async () => {
    const store = durableFailureStore({ rejectSaveCall: 3 });
    let providerAppliedCount = 0;
    const createMaterial = vi.fn().mockImplementation(async () => {
      providerAppliedCount += 1;
      return { status: 503, uncertain: true };
    });

    await expect(
      syncServiceM8Materials({
        runId: 'run-1',
        intents: [intent],
        port: {
          listMaterials: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]),
          createMaterial,
          updateMaterial: vi.fn(),
        },
        checkpointStore: store,
      }),
    ).rejects.toThrow(/synthetic checkpoint save failure/);

    expect(createMaterial).toHaveBeenCalledOnce();
    expect(providerAppliedCount).toBe(1);
    expect(store.appendOutcome).toHaveBeenCalledOnce();
    expect(store.durableCheckpoint?.createAttemptedAwaitingReconciliation).toMatchObject({
      idempotencyKey: intent.idempotencyKey,
    });

    const resumeCreate = vi.fn();
    await syncServiceM8Materials({
      runId: 'run-1',
      intents: [intent],
      port: {
        listMaterials: vi.fn().mockResolvedValue([]),
        createMaterial: resumeCreate,
        updateMaterial: vi.fn(),
      },
      checkpointStore: memoryStore(store.durableCheckpoint),
    });
    expect(resumeCreate).not.toHaveBeenCalled();
  });

  it('recovers read-only when termination occurs after marker commit but before provider access', async () => {
    const store = durableFailureStore({ commitThenRejectSaveCall: 2 });
    const createMaterial = vi.fn();

    await expect(
      syncServiceM8Materials({
        runId: 'run-1',
        intents: [intent],
        port: {
          listMaterials: vi.fn().mockResolvedValue([]),
          createMaterial,
          updateMaterial: vi.fn(),
        },
        checkpointStore: store,
      }),
    ).rejects.toThrow(/termination after durable checkpoint commit/);

    expect(createMaterial).not.toHaveBeenCalled();
    expect(store.durableCheckpoint?.createAttemptedAwaitingReconciliation).toMatchObject({
      idempotencyKey: intent.idempotencyKey,
    });

    const resumeCreate = vi.fn();
    const resumed = await syncServiceM8Materials({
      runId: 'run-1',
      intents: [intent],
      port: {
        listMaterials: vi.fn().mockResolvedValue([]),
        createMaterial: resumeCreate,
        updateMaterial: vi.fn(),
      },
      checkpointStore: memoryStore(store.durableCheckpoint),
    });

    expect(resumeCreate).not.toHaveBeenCalled();
    expect(resumed.checkpoint.nextIndex).toBe(0);
    expect(resumed.checkpoint.completedLocalItemIds).toEqual([]);
    expect(resumed.checkpoint.manualReconciliationRequired).toMatchObject({
      idempotencyKey: intent.idempotencyKey,
    });
  });

  it('fails closed for legacy or tampered write-ahead create markers before provider access', async () => {
    const store = durableFailureStore({ commitThenRejectSaveCall: 2 });

    await expect(
      syncServiceM8Materials({
        runId: 'run-1',
        intents: [intent],
        port: {
          listMaterials: vi.fn().mockResolvedValue([]),
          createMaterial: vi.fn(),
          updateMaterial: vi.fn(),
        },
        checkpointStore: store,
      }),
    ).rejects.toThrow(/termination after durable checkpoint commit/);

    const durable = store.durableCheckpoint;
    expect(durable?.createAttemptedAwaitingReconciliation).toBeDefined();
    const invalidMarkers = [
      {
        ...durable?.createAttemptedAwaitingReconciliation,
        idempotencyKey: 'tampered-key',
      },
      {
        state: 'create-attempted-awaiting-reconciliation',
        operation: 'create',
        localItemId: intent.localItemId,
      },
      {
        ...durable?.createAttemptedAwaitingReconciliation,
        unexpected: true,
      },
    ];

    for (const createAttemptedAwaitingReconciliation of invalidMarkers) {
      const listMaterials = vi.fn();
      const createMaterial = vi.fn();
      const tampered = {
        ...durable,
        createAttemptedAwaitingReconciliation,
      } as unknown as SyncCheckpoint;

      await expect(
        syncServiceM8Materials({
          runId: 'run-1',
          intents: [intent],
          port: { listMaterials, createMaterial, updateMaterial: vi.fn() },
          checkpointStore: memoryStore(tampered),
        }),
      ).rejects.toThrow(/create-attempt marker is invalid/);
      expect(listMaterials).not.toHaveBeenCalled();
      expect(createMaterial).not.toHaveBeenCalled();
    }
  });

  it('calls create once, persists a manual hold, and blocks create on stale resume', async () => {
    const store = memoryStore();
    let providerAppliedCount = 0;
    const createMaterial = vi.fn().mockImplementation(async () => {
      providerAppliedCount += 1;
      return { status: 503, uncertain: true };
    });
    const result = await syncServiceM8Materials({
      runId: 'run-1',
      intents: [intent],
      port: {
        listMaterials: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]),
        createMaterial,
        updateMaterial: vi.fn(),
      },
      checkpointStore: store,
      now: () => '2026-08-20T00:00:02.000Z',
    });

    expect(createMaterial).toHaveBeenCalledOnce();
    expect(providerAppliedCount).toBe(1);
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        localItemId: 'local-1',
        idempotencyKey: intent.idempotencyKey,
        operation: 'create',
        status: 'manual-reconciliation-required',
        attempts: 1,
      }),
    ]);
    expect(result.checkpoint).toMatchObject({
      nextIndex: 0,
      completedLocalItemIds: [],
      persistedIdempotencyKeys: [intent.idempotencyKey],
      manualReconciliationRequired: {
        state: 'manual-reconciliation-required',
        operation: 'create',
        localItemId: 'local-1',
        idempotencyKey: intent.idempotencyKey,
        recordedAt: '2026-08-20T00:00:02.000Z',
      },
    });
    expect(Object.isFrozen(result.checkpoint.manualReconciliationRequired)).toBe(true);
    expect(store.checkpoints.at(-1)).toEqual(result.checkpoint);

    const resumeCreate = vi.fn();
    const resumed = await syncServiceM8Materials({
      runId: 'run-1',
      intents: [intent],
      port: {
        listMaterials: vi.fn().mockResolvedValue([]),
        createMaterial: resumeCreate,
        updateMaterial: vi.fn(),
      },
      checkpointStore: memoryStore(result.checkpoint),
      now: () => '2026-08-20T00:00:03.000Z',
    });

    expect(resumeCreate).not.toHaveBeenCalled();
    expect(resumed.outcomes).toEqual([
      expect.objectContaining({
        operation: 'blocked',
        status: 'manual-reconciliation-required',
        attempts: 0,
      }),
    ]);
    expect(resumed.checkpoint).toMatchObject({
      nextIndex: 0,
      completedLocalItemIds: [],
      manualReconciliationRequired: {
        idempotencyKey: intent.idempotencyKey,
      },
    });

    const clearCreate = vi.fn();
    const cleared = await syncServiceM8Materials({
      runId: 'run-1',
      intents: [intent],
      port: {
        listMaterials: vi.fn().mockResolvedValue([{ uuid: 'external-1', ...intent.material }]),
        createMaterial: clearCreate,
        updateMaterial: vi.fn(),
      },
      checkpointStore: memoryStore(resumed.checkpoint),
      now: () => '2026-08-20T00:00:04.000Z',
    });

    expect(clearCreate).not.toHaveBeenCalled();
    expect(cleared.outcomes).toEqual([
      expect.objectContaining({ operation: 'create', status: 'succeeded', attempts: 0 }),
    ]);
    expect(cleared.checkpoint.nextIndex).toBe(1);
    expect(cleared.checkpoint.completedLocalItemIds).toEqual(['local-1']);
    expect(cleared.checkpoint.manualReconciliationRequired).toBeUndefined();
  });

  it('fails closed for a legacy checkpoint without intent binding', async () => {
    const legacy = {
      runId: 'run-1',
      nextIndex: 0,
      completedLocalItemIds: [],
      updatedAt: '2026-08-20T00:00:00.000Z',
    } as unknown as SyncCheckpoint;
    const listMaterials = vi.fn();

    await expect(
      syncServiceM8Materials({
        runId: 'run-1',
        intents: [intent],
        port: { listMaterials, createMaterial: vi.fn(), updateMaterial: vi.fn() },
        checkpointStore: memoryStore(legacy),
      }),
    ).rejects.toThrow(/Legacy ServiceM8 checkpoint lacks intent binding/);
    expect(listMaterials).not.toHaveBeenCalled();
  });

  it('fails closed when resumed intents are changed or reordered', async () => {
    const second = {
      localItemId: 'local-2',
      idempotencyKey: 'run-1:local-2:v1',
      material: { name: 'Key', item_number: 'KEY-1' },
    };
    const completed = await syncServiceM8Materials({
      runId: 'run-1',
      intents: [intent, second],
      port: {
        listMaterials: vi
          .fn()
          .mockResolvedValueOnce([{ uuid: 'external-1', ...intent.material }])
          .mockResolvedValueOnce([{ uuid: 'external-2', ...second.material }]),
        createMaterial: vi.fn(),
        updateMaterial: vi.fn(),
      },
      checkpointStore: memoryStore(),
    });
    const listMaterials = vi.fn();
    const port = { listMaterials, createMaterial: vi.fn(), updateMaterial: vi.fn() };

    await expect(
      syncServiceM8Materials({
        runId: 'run-1',
        intents: [second, intent],
        port,
        checkpointStore: memoryStore(completed.checkpoint),
      }),
    ).rejects.toThrow(/intent set does not match/);
    await expect(
      syncServiceM8Materials({
        runId: 'run-1',
        intents: [{ ...intent, material: { ...intent.material, price: 41 } }, second],
        port,
        checkpointStore: memoryStore(completed.checkpoint),
      }),
    ).rejects.toThrow(/intent set does not match/);
    expect(listMaterials).not.toHaveBeenCalled();
  });

  it('fails closed when persisted idempotency keys are tampered', async () => {
    const completed = await syncServiceM8Materials({
      runId: 'run-1',
      intents: [intent],
      port: {
        listMaterials: vi.fn().mockResolvedValue([{ uuid: 'external-1', ...intent.material }]),
        createMaterial: vi.fn(),
        updateMaterial: vi.fn(),
      },
      checkpointStore: memoryStore(),
    });
    const tampered = {
      ...completed.checkpoint,
      persistedIdempotencyKeys: ['different-key'],
    };
    const listMaterials = vi.fn();

    await expect(
      syncServiceM8Materials({
        runId: 'run-1',
        intents: [intent],
        port: { listMaterials, createMaterial: vi.fn(), updateMaterial: vi.fn() },
        checkpointStore: memoryStore(tampered),
      }),
    ).rejects.toThrow(/idempotency keys do not match/);
    expect(listMaterials).not.toHaveBeenCalled();
  });
});
