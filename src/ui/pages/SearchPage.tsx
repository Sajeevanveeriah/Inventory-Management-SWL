import { useMemo, useState } from "react";
import { searchRows } from "../../core/search";
import { STATUS_LABELS, type BaseStatus } from "../../core/statuses";
import { useAppState } from "../../state/store";
import { StatusBadge } from "../StatusBadge";
import { EmptyState, Page } from "./PageChrome";

const ALL_STATUSES = Object.keys(STATUS_LABELS) as BaseStatus[];

/**
 * Inventory and product search across the loaded supplier and ServiceM8 data.
 * Exact identifier matches rank first; description matches are token-based
 * with a deterministic fuzzy fallback. Similarity never creates a match in
 * the comparison itself — this page is read-only search and navigation.
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
  const [statuses, setStatuses] = useState<Set<BaseStatus>>(new Set());
  const rows = state.comparison?.rows ?? null;

  const hits = useMemo(
    () => (rows ? searchRows(rows, query, { statuses }) : []),
    [rows, query, statuses],
  );

  const toggleStatus = (status: BaseStatus) => {
    setStatuses((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  if (rows === null) {
    return (
      <Page title="Inventory search">
        <EmptyState
          title="No comparison data loaded"
          detail="Search works across the supplier and ServiceM8 files of the current run. Start a run or load the fictional demonstration data first."
          action={
            <button
              type="button"
              className="btn btn-primary"
              onClick={goToNewRun}
            >
              Start a run
            </button>
          }
        />
      </Page>
    );
  }

  return (
    <Page title="Inventory search">
      <section className="card">
        <div className="search-bar">
          <input
            className="global-search"
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search supplier code, ServiceM8 item number or description"
            aria-label="Search products by code, item number or description"
          />
        </div>
        <div
          className="chip-row"
          role="group"
          aria-label="Filter by record status"
        >
          {ALL_STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              className={`chip${statuses.has(status) ? " chip-active" : ""}`}
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
        <p className="result-count" role="status">
          {hits.length} of {rows.length} records
          {query.trim() !== "" && " · ranked exact-first"}
        </p>
      </section>

      {hits.length === 0 ? (
        <EmptyState
          title="No matching products"
          detail="No supplier code, item number or description matched. Check the spelling, clear status filters, or search a shorter fragment of the code."
        />
      ) : (
        <div
          className="table-scroll"
          role="region"
          aria-label="Search results"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Supplier code</th>
                <th scope="col">ServiceM8 item</th>
                <th scope="col">Description</th>
                <th scope="col">Supplier category</th>
                <th scope="col">Current cost</th>
                <th scope="col">Supplier cost</th>
                <th scope="col">Proposed sell</th>
                <th scope="col">Matched on</th>
              </tr>
            </thead>
            <tbody>
              {hits.map(({ row, matchedOn }) => (
                <tr key={row.id}>
                  <td>
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="mono">{row.supplier?.code ?? "-"}</td>
                  <td className="mono">{row.s8?.itemNumber ?? "-"}</td>
                  <td>
                    {row.supplier?.description || row.s8?.description || "-"}
                  </td>
                  <td>{row.supplier?.category || "-"}</td>
                  <td className="num">{row.s8?.existingCost ?? "-"}</td>
                  <td className="num">{row.supplier?.cost ?? "-"}</td>
                  <td className="num">{row.proposedSell ?? "-"}</td>
                  <td>{query.trim() === "" ? "-" : matchedOn}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}
