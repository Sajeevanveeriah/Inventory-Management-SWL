import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../state/store';
import type { PlatformService } from '../../platform/contracts';
import { SuppliersPage } from './SuppliersPage';

const mocks = vi.hoisted(() => ({
  state: { current: undefined as unknown },
  dispatch: vi.fn(),
  announce: vi.fn(),
  platform: { current: undefined as unknown },
}));

vi.mock('../../state/store', () => ({
  useAppState: () => mocks.state.current,
  useAppDispatch: () => mocks.dispatch,
}));
vi.mock('../../state/useActions', () => ({
  useActions: () => ({ announce: mocks.announce }),
}));
vi.mock('../../platform/context', () => ({
  usePlatform: () => mocks.platform.current,
}));

const product = {
  id: 'product-1',
  itemNumber: 'LOCK-1',
  description: 'Synthetic lock',
  itemKind: 'physical-product' as const,
  brandId: 'brand-1',
  markupOverridePercent: null,
  xeroReference: null,
  servicem8Reference: null,
  barcodeGtin: null,
  selectedOfferId: null,
  costCents: 2000,
  sellPriceCents: 3000,
  gstBasis: 'ex-gst' as const,
  sellPriceGstBasis: 'ex-gst' as const,
  updatedAt: '2026-08-20T00:00:00.000Z',
};
const brand = {
  id: 'brand-1',
  name: 'Synthetic Brand',
  markupHundredths: 3500,
  updatedAt: '2026-08-20T00:00:00.000Z',
};
const supplier = {
  id: 'supplier-1',
  name: 'Synthetic Supplier',
  active: true,
  externalReference: null,
  updatedAt: '2026-08-20T00:00:00.000Z',
};
const offer = {
  id: 'offer-1',
  productId: product.id,
  supplierId: supplier.id,
  supplierSku: 'SUP-LOCK-1',
  costCents: 2000,
  gstBasis: 'ex-gst' as const,
  currency: 'AUD' as const,
  active: true,
  isPreferred: true,
  validFrom: '2026-08-01',
  validUntil: null,
  provenanceType: 'manual' as const,
  provenanceReference: null,
  observedAt: '2026-08-20T00:00:00.000Z',
};

function stateFixture(): AppState {
  return {
    catalogueItems: [product],
    brands: [brand],
    catalogueSuppliers: [supplier],
    supplierOffers: [offer],
    offerSelections: [],
    settings: {
      markupPercent: '30',
      taxHandling: 'prices-ex-gst',
      theme: 'system',
      glassTint: 'clear',
    },
    settingsAudit: [],
    syncRuns: [],
    syncCheckpoints: [],
    syncItemOutcomes: [],
  } as unknown as AppState;
}

function platformFixture() {
  const select = vi.fn().mockResolvedValue({
    ok: true,
    value: {
      productId: product.id,
      offerId: offer.id,
      selectedBy: 'Operator',
      reason: 'Explicit selection in Products and suppliers',
      selectedAt: '2026-08-20T00:00:00.000Z',
    },
  });
  return {
    kind: 'web',
    catalogue: { list: vi.fn().mockResolvedValue({ ok: true, value: [product] }) },
    brands: {
      list: vi.fn().mockResolvedValue({ ok: true, value: [brand] }),
      save: vi.fn(),
    },
    suppliers: {
      list: vi.fn().mockResolvedValue({ ok: true, value: [supplier] }),
      save: vi.fn(),
    },
    offers: {
      list: vi.fn().mockResolvedValue({ ok: true, value: [offer] }),
      save: vi.fn(),
      listSelections: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      select,
    },
    productMetadata: { update: vi.fn() },
  } as unknown as PlatformService;
}

describe('Products and suppliers page', () => {
  beforeEach(() => {
    mocks.state.current = stateFixture();
    mocks.platform.current = platformFixture();
    mocks.dispatch.mockClear();
    mocks.announce.mockClear();
  });

  it('preserves an explicit zero markup and explains the separate publication floor', async () => {
    const user = userEvent.setup();
    render(<SuppliersPage />);

    await user.selectOptions(screen.getAllByLabelText('Product')[0]!, product.id);
    await user.type(screen.getByLabelText('Product markup %'), '0');

    expect(screen.getByRole('alert')).toHaveTextContent('separate 30% publication floor');
    expect(screen.getByText(/typed 0% is preserved/)).toBeInTheDocument();
  });

  it('requires confirmation before recording the explicit supplier offer selection', async () => {
    const user = userEvent.setup();
    const platform = mocks.platform.current as PlatformService;
    render(<SuppliersPage />);

    await user.click(screen.getByRole('button', { name: 'Select for pricing' }));
    expect(screen.getByRole('dialog', { name: 'Select this supplier offer' })).toBeInTheDocument();
    expect(platform.offers.select).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Select offer' }));
    expect(platform.offers.select).toHaveBeenCalledWith(
      expect.objectContaining({ productId: product.id, offerId: offer.id }),
    );
    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'catalogue-domain-loaded' }),
    );
  });

  it('refreshes the authoritative domain after a stale mutation conflict', async () => {
    const user = userEvent.setup();
    const platform = mocks.platform.current as PlatformService;
    const latestProduct = {
      ...product,
      description: 'Synthetic lock updated elsewhere',
      updatedAt: '2026-08-20T00:01:00.000Z',
    };
    vi.mocked(platform.productMetadata.update).mockResolvedValue({
      ok: false,
      error: {
        code: 'conflict',
        message: 'The product metadata update is stale.',
        retryable: false,
      },
    });
    vi.mocked(platform.catalogue.list).mockResolvedValue({ ok: true, value: [latestProduct] });

    render(<SuppliersPage />);
    await user.selectOptions(screen.getAllByLabelText('Product')[0]!, product.id);
    await user.click(screen.getByRole('button', { name: 'Save product rule' }));

    await waitFor(() =>
      expect(mocks.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'catalogue-domain-loaded',
          catalogueItems: [latestProduct],
        }),
      ),
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'This record changed elsewhere. The latest saved version is shown.',
    );
    expect(mocks.announce).toHaveBeenCalledWith(
      'This record changed elsewhere. The latest saved version is shown. Review it before saving again.',
    );
  });
});
