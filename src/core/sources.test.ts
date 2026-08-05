import { describe, expect, it } from 'vitest';
import type { CompetitorObservation } from './competitors';
import {
  defaultSources,
  looksLikePartNumber,
  normaliseQuery,
  priceBand,
  searchEvidence,
  toggleSource,
} from './sources';

function obs(overrides: Partial<CompetitorObservation>): CompetitorObservation {
  return {
    sku: 'LW4570',
    sourceName: 'Manual operator entry',
    approvedSource: true,
    observedAt: '2026-08-01T00:00:00.000Z',
    price: '143.00',
    currency: 'AUD',
    gstBasis: 'inc-gst',
    shipping: '0',
    stockStatus: 'unknown',
    condition: 'new',
    packCompatible: true,
    productOnly: true,
    matchConfidence: 1,
    reviewState: 'accepted',
    ...overrides,
  };
}

describe('query normalisation', () => {
  it('normalises and classifies queries', () => {
    expect(normaliseQuery('  Lockwood   4570 ')).toBe('lockwood 4570');
    expect(looksLikePartNumber('LW4570')).toBe(true);
    expect(looksLikePartNumber('9312345678906')).toBe(true);
    expect(looksLikePartNumber('digital deadlatch')).toBe(false);
    expect(looksLikePartNumber('')).toBe(false);
  });
});

describe('searchEvidence', () => {
  const sources = defaultSources();

  it('searches every enabled source with one query and ranks exact SKU first', () => {
    const evidence = [
      obs({ sku: 'LW4570-EXTRA', sourceName: 'Fictionville Hardware Direct (example)' }),
      obs({ sku: 'LW4570' }),
    ];
    const outcome = searchEvidence(evidence, sources, 'lw4570');
    expect(outcome.queryKind).toBe('part-number');
    expect(outcome.results.map((r) => r.observation.sku)).toEqual(['LW4570', 'LW4570-EXTRA']);
  });

  it('always discloses enabled sources without results and disabled sources', () => {
    const outcome = searchEvidence([obs({})], sources, 'LW4570');
    expect(outcome.sourcesWithoutResults).toContain('Fictionville Security Supplies (example)');
    expect(outcome.disabledSources).toEqual(['Fictionville Auctions (example)']);
  });

  it('never returns evidence from a disabled source', () => {
    const disabled = toggleSource(sources, 'manual');
    const outcome = searchEvidence([obs({})], disabled, 'LW4570');
    expect(outcome.results).toHaveLength(0);
    expect(outcome.disabledSources).toContain('Manual operator entry');
  });

  it('is fully usable with an empty database', () => {
    const outcome = searchEvidence([], sources, 'anything');
    expect(outcome.results).toHaveLength(0);
    // Live provider + manual + two fictional file/manual sources are enabled.
    expect(outcome.sourcesWithoutResults).toHaveLength(4);
  });
});

describe('priceBand', () => {
  it('reports lowest, median and highest normalised ex-GST with source count', () => {
    const results = searchEvidence(
      [
        obs({ price: '110.00' }), // 100.00 ex GST
        obs({ price: '143.00', sourceName: 'Fictionville Hardware Direct (example)' }), // 130.00
        obs({ price: '165.00', sourceName: 'Fictionville Security Supplies (example)' }), // 150.00
      ],
      defaultSources(),
      'LW4570',
    ).results;
    const band = priceBand(results);
    expect(band).toEqual({
      lowest: '100.00',
      median: '130.00',
      highest: '150.00',
      sourceCount: 3,
      resultCount: 3,
    });
  });

  it('averages the middle pair for an even count and excludes unknown GST', () => {
    const results = searchEvidence(
      [
        obs({ price: '110.00' }),
        obs({ price: '132.00', sourceName: 'Fictionville Hardware Direct (example)' }),
        obs({ price: '999.00', gstBasis: 'unknown' }),
      ],
      defaultSources(),
      'LW4570',
    ).results;
    expect(results).toHaveLength(3);
    const band = priceBand(results);
    expect(band?.median).toBe('110.00');
    expect(band?.resultCount).toBe(2);
  });

  it('returns null when nothing has a normalisable price', () => {
    expect(priceBand([])).toBeNull();
  });
});
