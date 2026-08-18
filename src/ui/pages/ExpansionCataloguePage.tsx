import { useMemo, useState } from 'react';
import { buildExpansionCatalogue } from '../../core/expansion';
import { formatAmount } from '../../core/money';
import { useAppState } from '../../state/store';
import { EmptyState, Page } from './PageChrome';

const PAGE_SIZE = 100;
const ENABLED_CATEGORIES_KEY = 'swl-expansion-enabled-categories-v1';

function storedEnabledCategories(): Set<string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(ENABLED_CATEGORIES_KEY) ?? '[]');
    if (!Array.isArray(value) || value.length > 500) return new Set();
    return new Set(
      value.filter(
        (entry): entry is string =>
          typeof entry === 'string' && entry.length > 0 && entry.length <= 256,
      ),
    );
  } catch {
    return new Set();
  }
}

export function ExpansionCataloguePage({ goToNewRun }: { goToNewRun: () => void }) {
  const state = useAppState();
  const [query, setQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [requestedPage, setRequestedPage] = useState(1);
  const [enabledCategories, setEnabledCategories] = useState<Set<string>>(storedEnabledCategories);
  const catalogue = useMemo(
    () => buildExpansionCatalogue(state.comparison?.rows ?? []),
    [state.comparison],
  );
  const items = useMemo(() => catalogue.flatMap((category) => category.items), [catalogue]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      if (selectedCategory !== 'all' && item.category !== selectedCategory) return false;
      if (needle === '') return true;
      return `${item.code} ${item.description} ${item.category} ${item.barcode}`
        .toLowerCase()
        .includes(needle);
    });
  }, [items, query, selectedCategory]);
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount);
  const pageStart = (page - 1) * PAGE_SIZE;
  const pageItems = visible.slice(pageStart, pageStart + PAGE_SIZE);
  const setCategoryEnabled = (category: string, enabled: boolean) => {
    setEnabledCategories((current) => {
      const next = new Set(current);
      if (enabled) next.add(category);
      else next.delete(category);
      try {
        window.localStorage.setItem(ENABLED_CATEGORIES_KEY, JSON.stringify([...next].sort()));
      } catch {
        // The in-session switch still works when browser storage is unavailable.
      }
      return next;
    });
  };

  return (
    <Page
      title="Expansion catalogue"
      lead="Supplier products that are not in ServiceM8 yet, every category out of scope until switched on."
      primary={
        <button type="button" className="btn btn-primary" onClick={goToNewRun}>
          Review in current run
        </button>
      }
    >
      <section className="expansion-hero card">
        <div>
          <span className="eyebrow">Future range planning</span>
          <h2>Supplier range, separated from today&apos;s ServiceM8 catalogue</h2>
          <p>
            Supplier-only products are carried across with every category explicitly out of scope.
            Switch on a category only when SWL is ready to review it; no item is imported until an
            operator also approves it in the run review.
          </p>
        </div>
        <div className="expansion-safety" aria-label="Import safety status">
          <span className="pill pill-ok">Safe by default</span>
          <strong>0 automatic additions</strong>
          <span>Approval is always required</span>
        </div>
      </section>

      {state.comparison === null ? (
        <EmptyState
          title="Load supplier and ServiceM8 files first"
          detail="Start a run and map the optional Category column. The app will then separate supplier-only products here without changing ServiceM8."
          action={
            <button type="button" className="btn btn-primary" onClick={goToNewRun}>
              Start a run
            </button>
          }
        />
      ) : (
        <>
          <div className="metric-row" role="group" aria-label="Expansion catalogue summary">
            <div className="metric-card">
              <span className="metric-label">Out-of-scope categories</span>
              <strong className="metric-value">
                {catalogue.filter((category) => !enabledCategories.has(category.name)).length}
              </strong>
              <span className="metric-state">off by default</span>
            </div>
            <div className="metric-card">
              <span className="metric-label">Supplier-only products</span>
              <strong className="metric-value">{items.length}</strong>
              <span className="metric-state">not yet in ServiceM8</span>
            </div>
            <div className="metric-card">
              <span className="metric-label">Automatic additions</span>
              <strong className="metric-value">0</strong>
              <span className="metric-state pill pill-ok">explicit approval gate</span>
            </div>
          </div>

          <section className="card" aria-labelledby="category-scope-title">
            <div className="integration-head">
              <div>
                <span className="eyebrow">Supplier list scope</span>
                <h2 id="category-scope-title">Category switches</h2>
              </div>
              <span className="pill">No automatic imports</span>
            </div>
            <p className="muted">
              Every supplier category starts out of scope. Enabling one only makes it available for
              a later reviewed run and is remembered on this computer.
            </p>
            <div
              className="table-scroll"
              role="region"
              aria-label="Supplier category scope switches"
              tabIndex={0}
            >
              <table>
                <thead>
                  <tr>
                    <th scope="col">Supplier category</th>
                    <th scope="col" className="num">
                      Products
                    </th>
                    <th scope="col">Scope</th>
                    <th scope="col">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {catalogue.map((category) => {
                    const enabled = enabledCategories.has(category.name);
                    return (
                      <tr key={category.name}>
                        <td>{category.name}</td>
                        <td className="num">{category.items.length}</td>
                        <td>
                          <span className={enabled ? 'pill pill-ok' : 'pill'}>
                            {enabled ? 'Enabled for later review' : 'Out of scope'}
                          </span>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-sm"
                            aria-pressed={enabled}
                            onClick={() => setCategoryEnabled(category.name, !enabled)}
                          >
                            {enabled ? 'Switch off' : 'Enable for review'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card expansion-controls">
            <div className="field">
              <label htmlFor="expansion-search">Search future products</label>
              <input
                id="expansion-search"
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setRequestedPage(1);
                }}
                placeholder="Product code, description, category or barcode"
              />
            </div>
            <div className="field">
              <label htmlFor="expansion-category">Supplier category</label>
              <select
                id="expansion-category"
                value={selectedCategory}
                onChange={(event) => {
                  setSelectedCategory(event.target.value);
                  setRequestedPage(1);
                }}
              >
                <option value="all">All categories</option>
                {catalogue.map((category) => (
                  <option key={category.name} value={category.name}>
                    {category.name} ({category.items.length})
                  </option>
                ))}
              </select>
            </div>
            <p className="result-count" role="status">
              {visible.length === 0 ? 0 : pageStart + 1}-
              {Math.min(pageStart + PAGE_SIZE, visible.length)} of {visible.length} matching future
              products ({items.length} total)
            </p>
          </section>

          {visible.length === 0 ? (
            <EmptyState
              title="No future products match"
              detail="Clear the category filter or shorten the search term."
            />
          ) : (
            <div
              className="table-scroll"
              role="region"
              aria-label="Expansion catalogue"
              tabIndex={0}
            >
              <table>
                <thead>
                  <tr>
                    <th scope="col">Supplier category</th>
                    <th scope="col">Product code</th>
                    <th scope="col">Description</th>
                    <th scope="col" className="num">
                      Supplier cost
                    </th>
                    <th scope="col" className="num">
                      Proposed sell
                    </th>
                    <th scope="col">Import status</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((item) => (
                    <tr key={item.rowId}>
                      <td>
                        <span className="category-tag">{item.category}</span>
                      </td>
                      <td className="mono">{item.code}</td>
                      <td>{item.description || '-'}</td>
                      <td className="num">
                        {item.supplierCost === null ? '-' : formatAmount(item.supplierCost)}
                      </td>
                      <td className="num">
                        {item.proposedSell === null ? '-' : formatAmount(item.proposedSell)}
                      </td>
                      <td>
                        <span
                          className={enabledCategories.has(item.category) ? 'pill pill-ok' : 'pill'}
                        >
                          {enabledCategories.has(item.category)
                            ? 'Enabled - approval required'
                            : 'Out of scope'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {pageCount > 1 && (
                <nav className="expansion-pagination" aria-label="Expansion catalogue pages">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={page === 1}
                    onClick={() => setRequestedPage(page - 1)}
                  >
                    Previous
                  </button>
                  <span>
                    Page {page} of {pageCount}
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={page === pageCount}
                    onClick={() => setRequestedPage(page + 1)}
                  >
                    Next
                  </button>
                </nav>
              )}
            </div>
          )}
        </>
      )}
    </Page>
  );
}
