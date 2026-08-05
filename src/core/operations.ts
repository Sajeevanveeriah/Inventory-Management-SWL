import type { ComparisonResult } from './compare';
import type { DecisionMap } from './review';
import { rowsForImport } from './output';
import { validateConfigImport, type ConfigValues } from './configRegistry';
import type { CompetitorObservation, ReviewState } from './competitors';

export type ExceptionSeverity = 'blocking' | 'warning' | 'info';
export interface OperationalException {
  id: string;
  type: string;
  severity: ExceptionSeverity;
  state: 'open' | 'resolved' | 'quarantined' | 'excluded';
  product: string;
  supplier: string;
  run: string;
  reason: string;
  evidence: string;
  suggestedResolution: string;
  requiredApproval: string;
  owner: string;
  ageDays: number;
  auditHistory: string[];
}

export interface ApprovalProposal {
  id: string;
  changeCount: number;
  exceptionCount: number;
  configurationVersion: string;
  fileHashes: string[];
  mappingProfile: string;
  pricingRuleVersion: string;
  oldValue: string;
  proposedValue: string;
  markup: string;
  percentageChange: string;
  exceptionState: string;
  reason: string;
  approver: string;
  localTimestamp: string;
  changeSetHash: string;
  approvable: boolean;
}

export interface RunMetadata {
  id: string;
  localTimestamp: string;
  inputFilenames: string[];
  fileHashes: string[];
  supplierProfile: string;
  mappingVersion: number;
  configurationVersion: string;
  recordTotals: Record<string, number>;
  matchMethodTotals: Record<string, number>;
  approvalTotals: Record<string, number>;
  exceptionTotals: Record<string, number>;
  outputFilenames: string[];
  validationOutcome: 'ready' | 'blocked' | 'draft';
  snapshotSaved: boolean;
}

export function deriveExceptions(
  comparison: ComparisonResult | null,
  owner = 'Unassigned',
): OperationalException[] {
  if (!comparison) return [];
  return comparison.rows
    .filter(
      (row) =>
        row.status === 'ambiguous' ||
        row.status === 'invalid' ||
        row.status === 'missing-from-supplier',
    )
    .map((row) => ({
      id: row.id,
      type: row.status,
      severity: row.status === 'missing-from-supplier' ? 'warning' : 'blocking',
      state: 'open',
      product: row.supplier?.code ?? row.s8?.itemNumber ?? row.id,
      supplier: row.supplier ? 'Loaded supplier' : 'ServiceM8 export',
      run: 'current-session',
      reason: row.messages.map((m) => m.message).join(' | ') || row.status,
      evidence: `Supplier row ${row.supplier?.sourceRow ?? 'n/a'}; ServiceM8 row ${row.s8?.sourceRow ?? 'n/a'}`,
      suggestedResolution:
        row.status === 'ambiguous'
          ? 'Confirm an alias, remap, exclude with reason, or leave blocked.'
          : row.status === 'invalid'
            ? 'Correct the source file or exclude with reason.'
            : 'Review only. Missing supplier items are never deleted automatically.',
      requiredApproval:
        row.status === 'missing-from-supplier'
          ? 'Review acknowledgement'
          : 'Reasoned operator decision',
      owner,
      ageDays: 0,
      auditHistory: row.messages.map((m) => `${m.severity}: ${m.message}`),
    }));
}

export function buildApprovalProposals(
  comparison: ComparisonResult | null,
  decisions: DecisionMap,
): ApprovalProposal[] {
  if (!comparison) return [];
  return comparison.rows
    .filter(
      (row) =>
        row.status === 'price-changed' ||
        row.status === 'new-item' ||
        row.status === 'ambiguous' ||
        row.status === 'invalid',
    )
    .map((row) => {
      const decision = decisions[row.id];
      const approvable = row.status === 'price-changed' || row.status === 'new-item';
      return {
        id: row.id,
        changeCount: row.status === 'price-changed' || row.status === 'new-item' ? 1 : 0,
        exceptionCount: row.status === 'ambiguous' || row.status === 'invalid' ? 1 : 0,
        configurationVersion: 'config-schema-1',
        fileHashes: ['local-session-hash'],
        mappingProfile: 'active local profile',
        pricingRuleVersion: `markup-${comparison.markupPercent}`,
        oldValue: row.s8?.existingSell ?? '',
        proposedValue: row.proposedSell ?? '',
        markup: `${comparison.markupPercent}%`,
        percentageChange: row.costDelta ?? '',
        exceptionState: row.status,
        reason: decision?.reason ?? row.messages[0]?.message ?? 'Pending review',
        approver: 'Local operator',
        localTimestamp: new Date().toISOString(),
        changeSetHash: `${row.id}:${row.proposedSell ?? 'blocked'}`,
        approvable,
      };
    });
}

export function buildRunMetadata(params: {
  comparison: ComparisonResult | null;
  decisions: DecisionMap;
  inputFilenames: string[];
  outputFilenames: string[];
  profileName: string;
  profileVersion: number;
  snapshotSaved?: boolean;
}): RunMetadata {
  const importRows = params.comparison
    ? rowsForImport(params.comparison.rows, params.decisions)
    : [];
  return {
    id: `local-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}`,
    localTimestamp: new Date().toISOString(),
    inputFilenames: params.inputFilenames,
    fileHashes: params.inputFilenames.map(
      (name) => `local-${name.length}-${name.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}`,
    ),
    supplierProfile: params.profileName,
    mappingVersion: params.profileVersion,
    configurationVersion: 'config-schema-1',
    recordTotals: params.comparison ? { ...params.comparison.totals } : {},
    matchMethodTotals: Object.fromEntries(
      ['exact-code', 'alias', 'none'].map((method) => [
        method,
        params.comparison?.rows.filter((row) => row.matchMethod === method).length ?? 0,
      ]),
    ),
    approvalTotals: {
      approved: Object.values(params.decisions).filter((d) => d.state === 'approved').length,
      excluded: Object.values(params.decisions).filter((d) => d.state === 'excluded').length,
      importEligible: importRows.length,
    },
    exceptionTotals: {
      blocking: deriveExceptions(params.comparison).filter((e) => e.severity === 'blocking').length,
      warning: deriveExceptions(params.comparison).filter((e) => e.severity === 'warning').length,
    },
    outputFilenames: params.outputFilenames,
    validationOutcome:
      importRows.length > 0
        ? 'ready'
        : deriveExceptions(params.comparison).some((e) => e.severity === 'blocking')
          ? 'blocked'
          : 'draft',
    snapshotSaved: params.snapshotSaved ?? false,
  };
}

export function parseCompetitorEvidenceRows(
  rows: Record<string, string>[],
  reviewState: ReviewState = 'accepted',
): { observations: CompetitorObservation[]; errors: string[] } {
  const errors: string[] = [];
  const observations: CompetitorObservation[] = [];
  rows.forEach((row, index) => {
    const sku = row.sku || row.SKU || row.itemNumber || '';
    const sourceName = row.sourceName || row.source || '';
    const price = row.price || row.observedPrice || '';
    if (!sku || !sourceName || !price) {
      errors.push(`row ${index + 1}: sku, sourceName and price are required`);
      return;
    }
    observations.push({
      sku,
      sourceName,
      approvedSource: (row.approvedSource ?? 'true') === 'true',
      observedAt: row.observedAt || new Date().toISOString(),
      price,
      currency: row.currency || 'AUD',
      gstBasis: (row.gstBasis as CompetitorObservation['gstBasis']) || 'unknown',
      shipping: row.shipping || '0',
      stockStatus: (row.stockStatus as CompetitorObservation['stockStatus']) || 'unknown',
      condition: (row.condition as CompetitorObservation['condition']) || 'unknown',
      packCompatible: (row.packCompatible ?? 'true') === 'true',
      productOnly: (row.productOnly ?? 'true') === 'true',
      matchConfidence: Number(row.matchConfidence ?? 0),
      reviewState,
      ...(row.url || row.sourceUrl ? { url: row.url || row.sourceUrl } : {}),
      ...(row.packSize ? { packSize: row.packSize } : {}),
    });
  });
  return { observations, errors };
}

export function validateConfigurationPayload(values: ConfigValues) {
  return validateConfigImport(values);
}
