import type { ComparisonRow } from "./compare";

export interface ExpansionItem {
  rowId: string;
  code: string;
  description: string;
  category: string;
  supplierCost: string | null;
  proposedSell: string | null;
  barcode: string;
}

export interface ExpansionCategory {
  name: string;
  items: ExpansionItem[];
}

/**
 * Build a read-only future range from valid supplier-only comparison rows.
 * Approval remains solely in the review workflow, so appearing here never
 * causes a ServiceM8 import.
 */
export function buildExpansionCatalogue(
  rows: ComparisonRow[],
): ExpansionCategory[] {
  const byCategory = new Map<string, ExpansionItem[]>();

  for (const row of rows) {
    if (row.status !== "new-item" || row.supplier === null) continue;
    const category = row.supplier.category?.trim() || "Uncategorised";
    const items = byCategory.get(category) ?? [];
    items.push({
      rowId: row.id,
      code: row.supplier.code,
      description: row.supplier.description,
      category,
      supplierCost: row.supplier.cost,
      proposedSell: row.proposedSell,
      barcode: row.supplier.barcode,
    });
    byCategory.set(category, items);
  }

  return [...byCategory.entries()]
    .map(([name, items]) => ({
      name,
      items: [...items].sort((a, b) =>
        a.code.localeCompare(b.code, undefined, { numeric: true }),
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
