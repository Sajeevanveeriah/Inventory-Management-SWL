import type { PriceBasis } from './pricing';
import type { PriceProvenance } from './catalogue';

export interface SupplierOffer {
  id: string;
  productId: string;
  supplierId: string;
  supplierSku: string;
  costAmount: string;
  costBasis: PriceBasis;
  currency: 'AUD';
  active: boolean;
  preferred: boolean;
  observedAt: string;
  effectiveAt?: string | null;
  validUntil?: string | null;
  provenance: PriceProvenance;
}

/** Stable uniqueness key for product, supplier and that supplier's SKU. */
export function supplierOfferIdentityKey(
  offer: Pick<SupplierOffer, 'productId' | 'supplierId' | 'supplierSku'>,
): string {
  return JSON.stringify([offer.productId, offer.supplierId, offer.supplierSku]);
}

export type OfferSelectionMethod = 'explicit' | 'preferred' | 'sole-valid';
export type OfferSelectionBlockReason =
  | 'selected-offer-not-found'
  | 'selection-product-mismatch'
  | 'selected-offer-inactive'
  | 'selected-offer-stale'
  | 'no-valid-offers'
  | 'multiple-preferred-offers'
  | 'ambiguous-offers';

export type OfferSelectionResult =
  | {
      ok: true;
      offer: SupplierOffer;
      method: OfferSelectionMethod;
      explanation: string;
    }
  | {
      ok: false;
      reason: OfferSelectionBlockReason;
      explanation: string;
      candidateOfferIds: string[];
    };

export interface ResolveSupplierOfferInput {
  productId: string;
  offers: readonly SupplierOffer[];
  selectedOfferId?: string | null;
  asOf: string;
}

/**
 * Resolve one offer without price-based auto-selection. Precedence is an
 * explicit choice, exactly one valid preferred offer, then the sole valid
 * offer. Every ambiguous state blocks operator-visible progress.
 */
export function resolveSupplierOffer(input: ResolveSupplierOfferInput): OfferSelectionResult {
  if (input.selectedOfferId !== null && input.selectedOfferId !== undefined) {
    const selected = input.offers.find((offer) => offer.id === input.selectedOfferId);
    if (!selected) {
      return blocked('selected-offer-not-found', [], 'The selected supplier offer was not found');
    }
    if (selected.productId !== input.productId) {
      return blocked(
        'selection-product-mismatch',
        [selected.id],
        'The selected supplier offer belongs to another product',
      );
    }
    if (!selected.active) {
      return blocked(
        'selected-offer-inactive',
        [selected.id],
        'The selected supplier offer is inactive',
      );
    }
    if (isStale(selected, input.asOf)) {
      return blocked('selected-offer-stale', [selected.id], 'The selected supplier offer is stale');
    }
    return chosen(selected, 'explicit', 'Operator-selected supplier offer');
  }

  const valid = input.offers.filter(
    (offer) => offer.productId === input.productId && offer.active && !isStale(offer, input.asOf),
  );
  if (valid.length === 0) {
    return blocked('no-valid-offers', [], 'No active, current supplier offer is available');
  }

  const preferred = valid.filter((offer) => offer.preferred);
  if (preferred.length === 1) {
    return chosen(preferred[0]!, 'preferred', 'Exactly one active, current preferred offer');
  }
  if (preferred.length > 1) {
    return blocked(
      'multiple-preferred-offers',
      preferred.map((offer) => offer.id),
      'Multiple preferred offers require an explicit operator selection',
    );
  }
  if (valid.length === 1) {
    return chosen(valid[0]!, 'sole-valid', 'Only one active, current supplier offer is available');
  }
  return blocked(
    'ambiguous-offers',
    valid.map((offer) => offer.id),
    'Multiple valid offers require an explicit operator selection; price is never used to choose silently',
  );
}

function isStale(offer: SupplierOffer, asOf: string): boolean {
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs)) return true;
  if (offer.effectiveAt !== null && offer.effectiveAt !== undefined) {
    const effectiveAtMs = Date.parse(offer.effectiveAt);
    if (!Number.isFinite(effectiveAtMs) || effectiveAtMs > asOfMs) return true;
  }
  if (offer.validUntil !== null && offer.validUntil !== undefined) {
    const validUntilMs = Date.parse(offer.validUntil);
    if (!Number.isFinite(validUntilMs) || validUntilMs < asOfMs) return true;
  }
  return false;
}

function chosen(
  offer: SupplierOffer,
  method: OfferSelectionMethod,
  explanation: string,
): OfferSelectionResult {
  return { ok: true, offer, method, explanation: `${explanation}: ${offer.id}` };
}

function blocked(
  reason: OfferSelectionBlockReason,
  candidateOfferIds: string[],
  explanation: string,
): OfferSelectionResult {
  return { ok: false, reason, candidateOfferIds, explanation };
}
