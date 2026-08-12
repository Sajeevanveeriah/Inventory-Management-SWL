import type { FieldDefinition, FieldKey } from './fields';

/** Map from conceptual field to source column index. */
export type ColumnMapping = Partial<Record<FieldKey, number>>;

export interface MappingSuggestion {
  field: FieldKey;
  columnIndex: number;
  confidence: 'high' | 'medium';
  reason: string;
}

/**
 * Suggest column mappings from header names. Suggestions are advisory only -
 * the operator must confirm every mapping before it is used.
 */
export function suggestMappings(headers: string[], fields: FieldDefinition[]): MappingSuggestion[] {
  const suggestions: MappingSuggestion[] = [];
  const taken = new Set<number>();
  for (const field of fields) {
    let best: { index: number; exact: boolean } | null = null;
    for (let i = 0; i < headers.length; i += 1) {
      if (taken.has(i)) continue;
      const header = (headers[i] ?? '').trim();
      if (header === '') continue;
      const exact = header.toLowerCase() === field.label.toLowerCase();
      const matches = exact || field.suggestPatterns.some((p) => p.test(header));
      if (matches && (best === null || (exact && !best.exact))) {
        best = { index: i, exact };
      }
    }
    if (best !== null) {
      taken.add(best.index);
      suggestions.push({
        field: field.key,
        columnIndex: best.index,
        confidence: best.exact ? 'high' : 'medium',
        reason: best.exact
          ? `Header “${headers[best.index]}” matches the field name exactly.`
          : `Header “${headers[best.index]}” looks like ${fieldLabel(fields, field.key)}.`,
      });
    }
  }
  return suggestions;
}

function fieldLabel(fields: FieldDefinition[], key: FieldKey): string {
  return fields.find((f) => f.key === key)?.label ?? key;
}

export interface MappingIssue {
  severity: 'error' | 'warning';
  message: string;
}

/** Validate a mapping: every required field mapped, no column used twice. */
export function validateMapping(
  mapping: ColumnMapping,
  fields: FieldDefinition[],
  headers: string[],
): MappingIssue[] {
  const issues: MappingIssue[] = [];
  for (const field of fields) {
    const col = mapping[field.key];
    if (col === undefined) {
      if (field.required) {
        issues.push({
          severity: 'error',
          message: `Required field “${field.label}” has no source column mapped.`,
        });
      }
    } else if (col < 0 || col >= headers.length) {
      issues.push({
        severity: 'error',
        message: `Field “${field.label}” is mapped to a column that no longer exists.`,
      });
    }
  }
  const byColumn = new Map<number, FieldKey[]>();
  for (const field of fields) {
    const col = mapping[field.key];
    if (col === undefined) continue;
    byColumn.set(col, [...(byColumn.get(col) ?? []), field.key]);
  }
  for (const [col, keys] of byColumn) {
    if (keys.length > 1) {
      const labels = keys.map((k) => `“${fieldLabel(fields, k)}”`).join(' and ');
      issues.push({
        severity: 'error',
        message: `Column “${headers[col] ?? `#${col + 1}`}” is mapped to more than one field: ${labels}. Each column may serve only one field.`,
      });
    }
  }
  return issues;
}

/** A saved, named mapping profile for one supplier + ServiceM8 layout pair. */
export interface MappingProfile {
  id: string;
  name: string;
  version: number;
  supplierMapping: ColumnMapping;
  supplierHeaders: string[];
  servicem8Mapping: ColumnMapping;
  servicem8Headers: string[];
  createdAt: string;
  updatedAt: string;
}
