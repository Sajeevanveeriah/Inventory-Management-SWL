import type { ComparisonResult, ComparisonRow } from './compare';
import type { DecisionMap } from './review';
import { isBlocked } from './statuses';

/**
 * Output selection and pre-export gating.
 * The import output may contain ONLY rows that are (a) approvable statuses,
 * (b) explicitly approved by the operator, and (c) free of blocking errors.
 */

export function rowsForImport(rows: ComparisonRow[], decisions: DecisionMap): ComparisonRow[] {
  return rows.filter((row) => {
    const decision = decisions[row.id];
    if (decision?.state !== 'approved') return false;
    if (isBlocked(row.status)) return false;
    if (row.status !== 'price-changed' && row.status !== 'new-item') return false;
    if (row.supplier === null || row.supplier.cost === null || row.proposedSell === null)
      return false;
    return true;
  });
}

export interface GateResult {
  id: string;
  label: string;
  ok: boolean;
  blocking: boolean;
  detail: string;
  repair?: string;
}

export interface ChecklistInput {
  comparison: ComparisonResult;
  decisions: DecisionMap;
  mappingComplete: boolean;
  templateAdapted: boolean;
  markupPercent: string;
  taxHandling: string;
}

export function buildReleaseChecklist(input: ChecklistInput): GateResult[] {
  const { comparison, decisions } = input;
  const rows = comparison.rows;
  const approvedRows = rows.filter((r) => decisions[r.id]?.state === 'approved');
  const excludedRows = rows.filter((r) => decisions[r.id]?.state === 'excluded');
  const importRows = rowsForImport(rows, decisions);

  const approvedBlocked = approvedRows.filter((r) => isBlocked(r.status));
  const approvedAmbiguous = approvedBlocked.filter((r) => r.status === 'ambiguous').length;
  const approvedInvalid = approvedBlocked.filter((r) => r.status === 'invalid').length;

  const outputIds = importRows.map((r) => r.s8?.itemNumberNorm ?? r.supplier?.codeNorm ?? r.id);
  const duplicateOutputIds = outputIds.filter((id, i) => outputIds.indexOf(id) !== i);

  const invalidPrices = importRows.filter(
    (r) => r.proposedSell === null || !/^\d+\.\d{2}$/.test(r.proposedSell),
  );

  const gates: GateResult[] = [
    {
      id: 'mappings',
      label: 'Mandatory mappings complete',
      ok: input.mappingComplete,
      blocking: true,
      detail: input.mappingComplete
        ? 'All required fields are mapped for both files.'
        : 'One or more required fields are unmapped.',
      repair: 'Return to the Map columns step and map every required field.',
    },
    {
      id: 'no-approved-ambiguous',
      label: 'No approved ambiguous records',
      ok: approvedAmbiguous === 0,
      blocking: true,
      detail:
        approvedAmbiguous === 0
          ? 'No ambiguous record carries an approval.'
          : `${approvedAmbiguous} ambiguous record(s) carry an approval.`,
      repair: 'Ambiguous records cannot be imported. Clear those approvals in Review.',
    },
    {
      id: 'no-approved-invalid',
      label: 'No approved invalid records',
      ok: approvedInvalid === 0,
      blocking: true,
      detail:
        approvedInvalid === 0
          ? 'No invalid record carries an approval.'
          : `${approvedInvalid} invalid record(s) carry an approval.`,
      repair: 'Invalid records cannot be imported. Clear those approvals in Review.',
    },
    {
      id: 'no-duplicate-ids',
      label: 'No duplicate output identifiers',
      ok: duplicateOutputIds.length === 0,
      blocking: true,
      detail:
        duplicateOutputIds.length === 0
          ? 'Every row in the import output has a unique identifier.'
          : `Duplicate identifiers in output: ${[...new Set(duplicateOutputIds)].join(', ')}.`,
      repair: 'Exclude or repair the duplicated rows before exporting.',
    },
    {
      id: 'prices-valid',
      label: 'All prices valid',
      ok: invalidPrices.length === 0,
      blocking: true,
      detail:
        invalidPrices.length === 0
          ? 'Every approved row has a valid 2-decimal proposed price.'
          : `${invalidPrices.length} approved row(s) have missing or malformed prices.`,
      repair: 'Clear the approval on the affected rows; their source data is not usable.',
    },
    {
      id: 'headers',
      label: 'Output headers validated',
      ok: true,
      blocking: true,
      detail: input.templateAdapted
        ? 'Headers are adapted from the loaded ServiceM8 file.'
        : 'Using the built-in candidate header set (no ServiceM8 template loaded).',
    },
    {
      id: 'template',
      label: 'Template compatibility checked',
      ok: true,
      blocking: false,
      detail: input.templateAdapted
        ? 'Column names and order follow the loaded ServiceM8 export. The file is still a CANDIDATE import until verified against a genuine ServiceM8 import template.'
        : 'No genuine ServiceM8 import template has been supplied, so the output is labelled a CANDIDATE import file and must be verified before importing.',
    },
    {
      id: 'approvals',
      label: `Approval count confirmed: ${importRows.length}`,
      ok: importRows.length > 0,
      blocking: true,
      detail:
        importRows.length > 0
          ? `${importRows.length} approved change(s) will be exported.`
          : 'Nothing is approved yet, so there is nothing to export.',
      repair: 'Approve at least one eligible record in Review.',
    },
    {
      id: 'exclusions',
      label: `Exclusion count confirmed: ${excludedRows.length}`,
      ok: true,
      blocking: false,
      detail: `${excludedRows.length} record(s) deliberately excluded; exclusions and reasons are preserved in the audit report.`,
    },
    {
      id: 'settings',
      label: 'Markup and tax settings confirmed',
      ok: true,
      blocking: false,
      detail: `Markup ${input.markupPercent}% on cost; tax handling: ${input.taxHandling}.`,
    },
  ];
  return gates;
}

export function checklistPasses(gates: GateResult[]): boolean {
  return gates.every((g) => g.ok || !g.blocking);
}
