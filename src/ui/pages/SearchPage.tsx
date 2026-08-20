import { useMemo, useState } from 'react';
import { CATALOGUE_ITEM_KINDS, catalogueKindLabel, type ItemKind } from '../../core/catalogue';
import { formatAmount } from '../../core/money';
import {
  searchCatalogue,
  searchRows,
  type CatalogueMatchMethod,
  type CataloguePriceResolution,
} from '../../core/search';
import { STATUS_LABELS, type BaseStatus } from '../../core/statuses';
import { buildCatalogueSearchRecords, useAppState } from '../../state/store';
import { StatusBadge } from '../StatusBadge';
import { EmptyState, Page } from './PageChrome';

const ALL_STATUSES = Object.keys(STATUS_LABELS) as BaseStatus[];

const MATCH_LABELS: Record<CatalogueMatchMethod, string> = {
  'xero-item-code': 'Xero item code',
  'servicem8-item-number': 'ServiceM8 item number',
  'supplier-sku': 'Supplier SKU',
  'approved-alias': 'Approved alias',
  'barcode-gtin': 'Barcode or GTIN',
  brand: 'Brand',
  description: 'Description only',
  none: 'All products',
};

function basisLabel(basis: 'including-gst' | 'excluding-gst'): string {
  return basis === 'including-gst' ? 'including GST' : 'excluding GST';
}

function markupSourceLabel(source: 'product' | 'brand' | 'global'): string {
  if (source === 'product') return 'product override';
  if (source === 'brand') return 'brand rule';
  return 'global default';
}

function observedLabel(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}

function PriceDetails({ price }: { price: CataloguePriceResolution }) {
  if (price.kind !== 'resolved') {
    const heading =
      price.kind === 'ambiguous'
        ? 'Price needs a supplier choice'
        : price.kind === 'identity-only'
          ? 'Price deliberately withheld'
          : 'Price unavailable';
    return (
      <div
        className={`search-price-state${price.kind === 'ambiguous' ? ' search-price-state-warning' : ''}`}
      >
        <strong>{heading}</strong>
        <p>{price.explanation}</p>
      </div>
    );
  }

  return (
    <>
      <dl className="detail-grid search-price-details">
        <div>
          <dt>Selected supplier</dt>
          <dd>{price.supplierName}</dd>
        </div>
        <div>
          <dt>Supplier SKU</dt>
          <dd className="mono">{price.supplierSku}</dd>
        </div>
        <div>
          <dt>Purchase cost</dt>
          <dd>
            {price.currency} {formatAmount(price.purchaseCost)} {basisLabel(price.costBasis)}
          </dd>
        </div>
        <div>
          <dt>Offer observed</dt>
          <dd>{observedLabel(price.observedAt)}</dd>
        </div>
        <div>
          <dt>Markup</dt>
          <dd>
            {price.markupPercent}% from {markupSourceLabel(price.markupSource)}
          </dd>
        </div>
        <div>
          <dt>Calculated sell price</dt>
          <dd>
            AUD {formatAmount(price.sellPrice)} {basisLabel(price.sellPriceBasis)}
          </dd>
        </div>
      </dl>
      <details>
        <summary>Why this price was selected</summary>
        <p>{price.explanation}</p>
        <p className="mono">Offer {price.offerId}</p>
      </details>
    </>
  );
}

/**
 * Search the persistent catalogue first. Description similarity can identify a
 * possible product, but the page never attaches a price to that match alone.
 * The current comparison remains available as a clearly labelled fallback for
 * operators who have not yet published a persistent catalogue.
 */
export function SearchPage({
  query,
  onQueryChange,
  goToNewRun,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  goToNewRun: () => void;
}) {
  const state = useAppState();
  const [kinds, setKinds] = useState<Set<ItemKind>>(new Set());
  const [statuses, setStatuses] = useState<Set<BaseStatus>>(new Set());
  const [searchAsOf] = useState(() => new Date().toISOString());
  const comparisonRows = state.comparison?.rows ?? null;
  const catalogueRecords = useMemo(
    () => buildCatalogueSearchRecords(state, searchAsOf),
    [searchAsOf, state],
  );
  const useCatalogue = catalogueRecords.length > 0;
  const catalogueHits = useMemo(
    () => searchCatalogue(catalogueRecords, query, kinds),
    [catalogueRecords, kinds, query],
  );
  const comparisonHits = useMemo(
    () => (comparisonRows ? searchRows(comparisonRows, query, { statuses }) : []),
    [comparisonRows, query, statuses],
  );

  const toggleKind = (kind: ItemKind) => {
    setKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const toggleStatus = (status: BaseStatus) => {
    setStatuses((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  if (!useCatalogue && comparisonRows === null) {
    return (
      <Page
        title="Find a product"
        lead="Find products, services and labour by their known details."
      >
        <EmptyState
          title="No product data is ready"
          detail="Start a run to inspect supplier data, or add products and supplier offers to the catalogue."
          action={
            <button type="button" className="btn btn-primary" onClick={goToNewRun}>
              Start a run
            </button>
          }
        />
      </Page>
    );
  }

  const visibleCount = useCatalogue ? catalogueHits.length : comparisonHits.length;
  const totalCount = useCatalogue ? catalogueRecords.length : (comparisonRows?.length ?? 0);

  return (
    <Page
      title="Find a product"
      lead={
        useCatalogue
          ? 'Search the catalogue and see the exact supplier offer and markup behind each available price.'
          : 'Search the current run. Publish reviewed products to keep supplier and price history.'
      }
    >
      <section className="card">
        <div className="search-bar">
          <input
            className="global-search"
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search item code, supplier SKU, barcode, brand or description"
            aria-label="Search products by item code, supplier SKU, barcode, brand or description"
          />
        </div>
        {useCatalogue ? (
          <div className="chip-row" role="group" aria-label="Filter by product type">
            {CATALOGUE_ITEM_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                className={`chip${kinds.has(kind) ? ' chip-active' : ''}`}
                aria-pressed={kinds.has(kind)}
                onClick={() => toggleKind(kind)}
              >
                {catalogueKindLabel(kind)}
              </button>
            ))}
            {kinds.size > 0 && (
              <button type="button" className="chip chip-clear" onClick={() => setKinds(new Set())}>
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <div className="chip-row" role="group" aria-label="Filter by review status">
            {ALL_STATUSES.map((status) => (
              <button
                key={status}
                type="button"
                className={`chip${statuses.has(status) ? ' chip-active' : ''}`}
                aria-pressed={statuses.has(status)}
                onClick={() => toggleStatus(status)}
              >
                {STATUS_LABELS[status]}
              </button>
            ))}
            {statuses.size > 0 && (
              <button
                type="button"
                className="chip chip-clear"
                onClick={() => setStatuses(new Set())}
              >
                Clear filters
              </button>
            )}
          </div>
        )}
        <p className="result-count" role="status" aria-live="polite">
          {visibleCount} of {totalCount}{' '}
          {useCatalogue ? 'catalogue products' : 'current-run records'}
        </p>
      </section>

      {visibleCount === 0 ? (
        <EmptyState
          title="No matching products"
          detail="Check the spelling, clear the filters, or search a shorter part of a known identifier."
        />
      ) : useCatalogue ? (
        <ul className="search-results-list" aria-label="Catalogue search results">
          {catalogueHits.map((hit) => (
            <li key={hit.document.productId} className="card search-result-card">
              <div className="search-result-heading">
                <div>
                  <p className="eyebrow">{catalogueKindLabel(hit.document.kind)}</p>
                  <h2>{hit.document.description || hit.document.name}</h2>
                </div>
                <span className="status-pill">Matched: {MATCH_LABELS[hit.matchedOn]}</span>
              </div>
              <dl className="detail-grid search-identity-details">
                <div>
                  <dt>Product</dt>
                  <dd className="mono">{hit.document.name}</dd>
                </div>
                <div>
                  <dt>Brand</dt>
                  <dd>{hit.document.brandName ?? 'Not set'}</dd>
                </div>
                <div>
                  <dt>Xero item code</dt>
                  <dd className="mono">{hit.document.xeroItemCode ?? 'Not linked'}</dd>
                </div>
                <div>
                  <dt>ServiceM8 item number</dt>
                  <dd className="mono">{hit.document.servicem8ItemNumber ?? 'Not linked'}</dd>
                </div>
                <div>
                  <dt>Barcode or GTIN</dt>
                  <dd className="mono">{hit.document.barcodeGtin ?? 'Not set'}</dd>
                </div>
              </dl>
              <PriceDetails price={hit.price} />
            </li>
          ))}
        </ul>
      ) : (
        <div
          className="table-scroll"
          role="region"
          aria-label="Current-run search results"
          tabIndex={0}
        >
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Supplier code</th>
                <th scope="col">ServiceM8 item</th>
                <th scope="col">Description</th>
                <th scope="col">Supplier cost</th>
                <th scope="col">Proposed sell</th>
                <th scope="col">Matched on</th>
              </tr>
            </thead>
            <tbody>
              {comparisonHits.map(({ row, matchedOn }) => (
                <tr key={row.id}>
                  <td data-label="Status">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="mono" data-label="Supplier code">
                    {row.supplier?.code ?? '-'}
                  </td>
                  <td className="mono" data-label="ServiceM8 item">
                    {row.s8?.itemNumber ?? '-'}
                  </td>
                  <td data-label="Description">
                    {row.supplier?.description || row.s8?.description || '-'}
                  </td>
                  <td className="num" data-label="Supplier cost">
                    {row.supplier?.cost ? formatAmount(row.supplier.cost) : '-'}
                  </td>
                  <td className="num" data-label="Proposed sell">
                    {row.proposedSell ? formatAmount(row.proposedSell) : '-'}
                  </td>
                  <td data-label="Matched on">{query.trim() === '' ? '-' : matchedOn}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}
