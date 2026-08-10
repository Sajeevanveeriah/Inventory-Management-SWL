import type { ComparisonResult } from './compare';
import type { DecisionMap } from './review';
import type { ParsedTable } from './table';
import { ROUNDING_RULE_LABEL, formatAud } from './money';
import { rowsForImport } from './output';
import { STATUS_LABELS } from './statuses';
import type { SettingsChangeLogEntry } from './settings';

export const APP_NAME = 'SWL Pricing and Inventory Control';
export const APP_VERSION = '1.2.0';

export interface AuditInput {
  runId: string;
  startedAt: string;
  finishedAt: string;
  supplierTable: ParsedTable;
  s8Table: ParsedTable;
  profileName: string;
  profileVersion: number;
  comparison: ComparisonResult;
  decisions: DecisionMap;
  taxHandling: string;
  /** Tax basis and rate applied to items created by this run. */
  newItemConvention: string;
  /** Description of the file format the import output was written in. */
  importFormat: string;
  settingsChanges: SettingsChangeLogEntry[];
  outputFilenames: string[];
}

/**
 * Human-readable audit summary. Contains identifiers, statuses and totals —
 * never full raw source rows. It is generated locally and downloaded by the
 * operator; nothing is transmitted anywhere.
 */
export function buildAuditText(input: AuditInput): string {
  const { comparison, decisions } = input;
  const totals = comparison.totals;
  const importRows = rowsForImport(comparison.rows, decisions);
  const excluded = comparison.rows.filter((r) => decisions[r.id]?.state === 'excluded');
  const blocked = comparison.rows.filter((r) => r.status === 'ambiguous' || r.status === 'invalid');

  const lines: string[] = [];
  const push = (s = '') => lines.push(s);

  push(`${APP_NAME} — Audit summary`);
  push('='.repeat(60));
  push(`Application version: ${APP_VERSION}`);
  push(`Run identifier:      ${input.runId}`);
  push(`Started:             ${input.startedAt}`);
  push(`Finished:            ${input.finishedAt}`);
  push();
  push('Inputs');
  push('-'.repeat(60));
  push(`Supplier file:       ${input.supplierTable.fileName}`);
  push(`  SHA-256:           ${input.supplierTable.sha256}`);
  push(`  Sheet:             ${input.supplierTable.selectedSheet}`);
  push(`  Data rows:         ${input.supplierTable.rows.length}`);
  push(`ServiceM8 file:      ${input.s8Table.fileName}`);
  push(`  SHA-256:           ${input.s8Table.sha256}`);
  push(`  Sheet:             ${input.s8Table.selectedSheet}`);
  push(`  Data rows:         ${input.s8Table.rows.length}`);
  push(`Mapping profile:     ${input.profileName} (version ${input.profileVersion})`);
  push();
  push('Business rules');
  push('-'.repeat(60));
  push(
    `Markup:              ${comparison.markupPercent}% on supplier cost (selling price = cost × ${(1 + Number(comparison.markupPercent) / 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')})`,
  );
  push(`Rounding:            ${ROUNDING_RULE_LABEL}`);
  push(`Supplier cost basis: ${input.taxHandling}`);
  push(`ServiceM8 price basis: taken per row from that row's own "Price Includes Taxes" column`);
  push(`New item convention: ${input.newItemConvention}`);
  push(`Import file format:  ${input.importFormat}`);
  if (input.settingsChanges.length > 0) {
    push('Setting changes this session:');
    for (const c of input.settingsChanges) push(`  ${c.at}  ${c.change}`);
  } else {
    push('Setting changes this session: none');
  }
  push();
  push('Matching totals');
  push('-'.repeat(60));
  push(`Supplier records:        ${totals.supplierRecords}`);
  push(`ServiceM8 records:       ${totals.s8Records}`);
  push(`Exact identifier match:  ${totals.exactMatches}`);
  push(`Approved alias match:    ${totals.aliasMatches}`);
  push(`Unchanged:               ${totals.unchanged}`);
  push(`Price changed:           ${totals.priceChanged}`);
  push(`New items:               ${totals.newItems}`);
  push(`Missing from supplier:   ${totals.missingFromSupplier}`);
  push(`Ambiguous:               ${totals.ambiguous}`);
  push(`Invalid:                 ${totals.invalid}`);
  push(`Duplicate identifiers:   ${totals.duplicates}`);
  push(`Duplicate rows folded:   ${totals.duplicatesCollapsed}`);
  push(`Blocked from import:     ${totals.blocked}`);
  push();
  push(`Approved records (${importRows.length})`);
  push('-'.repeat(60));
  for (const r of importRows) {
    const id = r.s8?.itemNumber ?? r.supplier?.code ?? r.id;
    const kind = r.status === 'new-item' ? 'NEW' : 'PRICE';
    const before = r.s8?.existingSell != null ? formatAud(r.s8.existingSell) : 'no prior price';
    push(
      `  [${kind}] ${id} — cost ${formatAud(r.supplier?.cost ?? '0.00')}; price ${before} → ${formatAud(r.proposedSell ?? '0.00')} (${r.pricing?.explanation ?? r.matchMethod})`,
    );
  }
  if (importRows.length === 0) push('  (none)');
  push();
  push(`Excluded records (${excluded.length})`);
  push('-'.repeat(60));
  for (const r of excluded) {
    const id = r.supplier?.code ?? r.s8?.itemNumber ?? r.id;
    push(`  ${id} — ${decisions[r.id]?.reason ?? 'no reason recorded'}`);
  }
  if (excluded.length === 0) push('  (none)');
  push();
  push(`Blocking exceptions (${blocked.length})`);
  push('-'.repeat(60));
  for (const r of blocked) {
    const id =
      r.supplier?.code ??
      r.s8?.itemNumber ??
      `row ${r.supplier?.sourceRow ?? r.s8?.sourceRow ?? '?'}`;
    const firstError =
      r.messages.find((m) => m.severity === 'error')?.message ?? STATUS_LABELS[r.status];
    push(`  [${STATUS_LABELS[r.status]}] ${id} — ${firstError}`);
  }
  if (blocked.length === 0) push('  (none)');
  push();
  push('Generated outputs');
  push('-'.repeat(60));
  for (const f of input.outputFilenames) push(`  ${f}`);
  push();
  push(
    'This report was generated locally by SWL Pricing and Inventory Control. Raw imported rows and provider credentials are not included.',
  );
  return lines.join('\n');
}
