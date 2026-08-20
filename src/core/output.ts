import type { ComparisonResult, ComparisonRow } from './compare';
import type { DecisionMap } from './review';
import { isBlocked } from './statuses';
import type { ServiceM8LayoutMatch } from './servicem8Format';
import { SERVICEM8_COLUMNS } from './servicem8Format';

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
    // A proposal without a full derivation cannot be written safely.
    if (
      row.pricing === null ||
      row.targetBasis === null ||
      row.pricingProvenance === null ||
      row.pricing.floor?.blocked === true
    )
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
  /** Resolution of the loaded ServiceM8 header row against the contract. */
  layout: ServiceM8LayoutMatch;
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
  const missingPriceProvenance = approvedRows.filter(
    (row) =>
      (row.status === 'price-changed' || row.status === 'new-item') &&
      (row.pricingProvenance === null || row.pricing?.floor?.blocked === true),
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
      id: 'price-provenance',
      label: 'Every approved price has a selected offer and markup source',
      ok: missingPriceProvenance.length === 0,
      blocking: true,
      detail:
        missingPriceProvenance.length === 0
          ? 'Every approved price identifies its supplier offer and product, brand or global markup rule.'
          : `${missingPriceProvenance.length} approved row(s) have unresolved or below-floor pricing provenance.`,
      repair:
        'Choose a valid supplier offer and repair any below-floor product or brand markup before approval.',
    },
    {
      id: 'gst-basis',
      label: 'Supplier GST basis confirmed',
      ok: comparison.costBasisConfirmed,
      blocking: true,
      detail: comparison.costBasisConfirmed
        ? `Supplier costs are treated as ${comparison.costBasis === 'including-gst' ? 'GST-inclusive' : 'GST-exclusive'}, and each ServiceM8 price uses that row's own tax basis.`
        : 'The supplier’s GST basis has not been confirmed. Reading it wrongly moves every generated price by the full GST rate.',
      repair: 'Open Settings and state whether the supplier costs include or exclude GST.',
    },
    {
      id: 'servicem8-contract',
      label: 'ServiceM8 column contract satisfied',
      ok: input.layout.usable,
      blocking: true,
      detail: input.layout.usable
        ? input.layout.complete
          ? `All ${SERVICEM8_COLUMNS.length} ServiceM8 columns are present, so the generated file carries the complete contract.`
          : `The essential ServiceM8 columns are present. Missing optional columns: ${input.layout.missing.join(', ')}.`
        : `The loaded ServiceM8 file is missing required columns: ${input.layout.missing.join(', ')}.`,
      repair:
        'Load the Materials & Services export straight from ServiceM8, without editing its header row.',
    },
    {
      id: 'tax-basis-per-row',
      label: 'Every exported row has a known tax basis',
      ok: importRows.every((row) => row.targetBasis !== null),
      blocking: true,
      detail: importRows.every((row) => row.targetBasis !== null)
        ? 'Each approved row carries the GST basis its ServiceM8 record uses.'
        : 'One or more approved rows have no determinable GST basis.',
      repair:
        'Clear the approval on rows whose “Price Includes Taxes” value is missing or unreadable.',
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
      detail: `Markup ${input.markupPercent}% on the GST-exclusive cost; supplier basis: ${input.taxHandling}. New items: ${
        comparison.newItemConvention.includesTaxes ? 'price includes GST' : 'price excludes GST'
      }, tax rate “${comparison.newItemConvention.taxRate}”.`,
    },
  ];
  return gates;
}

export function checklistPasses(gates: GateResult[]): boolean {
  return gates.every((g) => g.ok || !g.blocking);
}
