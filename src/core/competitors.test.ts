import { describe, expect, it } from 'vitest';
import {
  normaliseObservationEx,
  recommendCompetitivePrice,
  type CompetitorObservation,
} from './competitors';

const base: CompetitorObservation = {
  sku: '00123',
  sourceName: 'Example Locks',
  approvedSource: true,
  observedAt: '2026-08-01T00:00:00.000Z',
  price: '143.00',
  currency: 'AUD',
  gstBasis: 'inc-gst',
  shipping: '0',
  stockStatus: 'in-stock',
  condition: 'new',
  packCompatible: true,
  productOnly: true,
  matchConfidence: 0.91,
  reviewState: 'accepted',
};

describe('competitor recommendations', () => {
  it('normalises AUD GST-inclusive observations to ex GST', () => {
    expect(normaliseObservationEx(base)?.toFixed(2)).toBe('130.00');
  });

  it('blocks below-floor competitor recommendations', () => {
    const recommendation = recommendCompetitivePrice({
      costEx: '100.00',
      observations: [{ ...base, price: '110.00' }],
      now: '2026-08-04T00:00:00.000Z',
    });
    expect(recommendation.exception).toBe('COMPETITOR_BELOW_FLOOR');
    expect(recommendation.recommendedEx).toBe('130.00');
    expect(recommendation.blocked).toBe(true);
  });

  it('excludes stale and low-confidence observations', () => {
    const recommendation = recommendCompetitivePrice({
      costEx: '100.00',
      observations: [{ ...base, matchConfidence: 0.2 }],
      now: '2026-08-04T00:00:00.000Z',
    });
    expect(recommendation.exception).toBe('NO_VALID_OBSERVATION');
  });
});
