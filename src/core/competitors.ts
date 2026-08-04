import Big from 'big.js';

export type ReviewState = 'accepted' | 'rejected' | 'quarantined';
export type CompetitorException = 'OK' | 'COMPETITOR_BELOW_FLOOR' | 'LOW_CONFIDENCE' | 'UNKNOWN_GST' | 'UNAPPROVED_SOURCE' | 'STALE_OBSERVATION' | 'NO_VALID_OBSERVATION' | 'MISSING_COST' | 'AMBIGUOUS_MATCH';
export type RecommendationStrategy = 'MATCH' | 'UNDERCUT_AMOUNT' | 'UNDERCUT_PERCENT' | 'MAINTAIN_FLOOR';

export interface CompetitorObservation {
  sku: string;
  sourceName: string;
  approvedSource: boolean;
  observedAt: string;
  price: string;
  currency: 'AUD' | string;
  gstBasis: 'inc-gst' | 'ex-gst' | 'unknown';
  shipping: string;
  stockStatus: 'in-stock' | 'out-of-stock' | 'unknown';
  condition: 'new' | 'used' | 'unknown';
  packCompatible: boolean;
  productOnly: boolean;
  matchConfidence: number;
  reviewState: ReviewState;
  ambiguousMatch?: boolean;
}

export interface CompetitiveRecommendation {
  exception: CompetitorException;
  normalisedCompetitorEx?: string;
  floorEx?: string;
  targetEx?: string;
  recommendedEx?: string;
  blocked: boolean;
  reason: string;
}

function money(value: string | number) {
  return new Big(value || 0).round(2, Big.roundHalfUp);
}

export function normaliseObservationEx(observation: CompetitorObservation, gstRate = '0.10') {
  const price = money(observation.price).plus(money(observation.shipping));
  if (observation.gstBasis === 'unknown') return null;
  if (observation.gstBasis === 'inc-gst') return price.div(new Big(1).plus(gstRate)).round(2, Big.roundHalfUp);
  return price.round(2, Big.roundHalfUp);
}

export function recommendCompetitivePrice(params: {
  costEx?: string;
  observations: CompetitorObservation[];
  strategy?: RecommendationStrategy;
  undercutAmount?: string;
  undercutPercent?: string;
  validityDays?: number;
  now?: string;
}): CompetitiveRecommendation {
  const strategy = params.strategy ?? 'MATCH';
  const validityDays = params.validityDays ?? 30;
  const now = new Date(params.now ?? new Date().toISOString());
  if (!params.costEx) return { exception: 'MISSING_COST', blocked: true, reason: 'Active product cost is missing.' };
  const cost = money(params.costEx);
  const floor = cost.times(1.3).round(2, Big.roundHalfUp);
  const eligible = params.observations.flatMap((observation) => {
    if (observation.ambiguousMatch) return [];
    if (!observation.approvedSource || observation.currency !== 'AUD' || observation.gstBasis === 'unknown' || observation.matchConfidence < 0.8 || observation.reviewState !== 'accepted' || !observation.packCompatible || observation.condition !== 'new' || !observation.productOnly) return [];
    const ageDays = (now.getTime() - new Date(observation.observedAt).getTime()) / 86400000;
    if (ageDays > validityDays) return [];
    const normalised = normaliseObservationEx(observation);
    return normalised ? [normalised] : [];
  });
  if (!eligible.length) return { exception: 'NO_VALID_OBSERVATION', floorEx: floor.toFixed(2), blocked: true, reason: 'No valid accepted competitor observation is eligible.' };
  const lowest = eligible.sort((a, b) => a.cmp(b))[0] as Big;
  const target = strategy === 'UNDERCUT_AMOUNT' ? lowest.minus(params.undercutAmount ?? '1').round(2, Big.roundHalfUp) : strategy === 'UNDERCUT_PERCENT' ? lowest.times(new Big(1).minus(params.undercutPercent ?? '0.05')).round(2, Big.roundHalfUp) : strategy === 'MAINTAIN_FLOOR' ? floor : lowest;
  const recommended = (floor.gt(target) ? floor : target).round(2, Big.roundHalfUp);
  const belowFloor = target.lt(floor);
  return { exception: belowFloor ? 'COMPETITOR_BELOW_FLOOR' : 'OK', normalisedCompetitorEx: lowest.toFixed(2), floorEx: floor.toFixed(2), targetEx: target.toFixed(2), recommendedEx: recommended.toFixed(2), blocked: belowFloor, reason: belowFloor ? 'Competitor target is below the configured cost floor.' : 'Recommendation passes the cost floor.' };
}
