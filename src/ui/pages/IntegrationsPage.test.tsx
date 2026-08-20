import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../state/store';
import { IntegrationsPage } from './IntegrationsPage';

const mocks = vi.hoisted(() => ({
  state: { current: undefined as unknown },
}));

vi.mock('../../state/store', () => ({
  useAppState: () => mocks.state.current,
}));
vi.mock('../../platform/context', () => ({
  usePlatform: () => ({ kind: 'desktop' }),
}));

function stateFixture(): AppState {
  return {
    syncRuns: [
      {
        id: 'run-xero',
        system: 'xero',
        direction: 'upstream-read',
        status: 'completed',
        mode: 'preview',
        startedAt: '2026-08-20T00:00:00.000Z',
        completedAt: '2026-08-20T00:01:00.000Z',
        approvedBy: null,
        summary: {},
      },
      {
        id: 'run-s8',
        system: 'servicem8',
        direction: 'downstream-write',
        status: 'partial',
        mode: 'approved',
        startedAt: '2026-08-20T01:00:00.000Z',
        completedAt: null,
        approvedBy: 'Operator',
        summary: {},
      },
    ],
    syncCheckpoints: [
      {
        id: 'checkpoint-1',
        runId: 'run-s8',
        cursorValue: 'item 2 of 3',
        recordedAt: '2026-08-20T01:01:00.000Z',
      },
    ],
    syncItemOutcomes: [
      {
        id: 'outcome-1',
        runId: 'run-s8',
        itemId: 'product-1',
        externalId: 'external-1',
        action: 'update',
        status: 'succeeded',
        idempotencyKey: 'run-s8:product-1:v1',
        attemptCount: 1,
        retryable: false,
        errorClass: null,
        reconciliation: 'matched',
        message: 'Synthetic success',
        recordedAt: '2026-08-20T01:01:00.000Z',
      },
    ],
  } as unknown as AppState;
}

describe('Integrations page', () => {
  it('states the one-way safety boundaries and filters local history without provider calls', async () => {
    const user = userEvent.setup();
    mocks.state.current = stateFixture();
    render(<IntegrationsPage />);

    expect(screen.getByText('Read Xero Items only')).toBeInTheDocument();
    expect(screen.getByText(/Quantity-on-hand, deletion and deactivation/)).toBeInTheDocument();
    expect(
      screen.getByText('External connections started from this page: none.'),
    ).toBeInTheDocument();
    expect(screen.getByText('item 2 of 3 at 2026-08-20T01:01:00.000Z')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('System'), 'xero');
    expect(screen.getByRole('cell', { name: 'Xero' })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'ServiceM8' })).not.toBeInTheDocument();
  });
});
