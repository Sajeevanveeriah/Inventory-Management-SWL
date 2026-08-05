// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createFixtureProvider } from '../server/search/fixtureProvider.mjs';
import { createSerpApiProvider } from '../server/search/serpapiProvider.mjs';
import {
  createRateLimiter,
  createSearchCache,
  createSearchService,
  priceBandCents,
} from '../server/search/service.mjs';
import { buildProviderQuery, classifyQuery } from '../server/search/normaliseQuery.mjs';

function fixtureService(overrides: Record<string, unknown> = {}) {
  return createSearchService({ provider: createFixtureProvider(), ...overrides });
}

describe('live search integration against the fixture provider (offline, no key)', () => {
  it('returns a successful multi-source result with band, coverage and timestamps', async () => {
    const outcome = await fixtureService().search('LW4570');
    expect(outcome.state).toBe('ok');
    expect(outcome.queryKind).toBe('identifier');
    expect(outcome.results.length).toBeGreaterThanOrEqual(3);
    expect(outcome.coverage.sourcesWithPrice).toBeGreaterThanOrEqual(3);
    for (const result of outcome.results) {
      expect(result.title).toBeTruthy();
      expect(result.priceAud).toMatch(/^\d+\.\d{2}$/);
      expect(result.currency).toBe('AUD');
      expect(['inc-gst', 'ex-gst', 'unknown']).toContain(result.gstBasis);
      expect(result.sourceDomain).toBeTruthy();
      expect(result.url).toMatch(/^https:\/\//);
      expect(result.retrievedAt).toBeTruthy();
    }
    expect(outcome.band).not.toBeNull();
    expect(outcome.band.lowestCents).toBeLessThanOrEqual(outcome.band.medianCents);
    expect(outcome.band.medianCents).toBeLessThanOrEqual(outcome.band.highestCents);
  });

  it('reports zero results as the distinct "empty" state', async () => {
    const outcome = await fixtureService().search('fixture-none');
    expect(outcome.state).toBe('empty');
    expect(outcome.results).toEqual([]);
    expect(outcome.band).toBeNull();
  });

  it('reports a provider timeout as the distinct "timeout" state', async () => {
    const outcome = await fixtureService().search('fixture-timeout');
    expect(outcome.state).toBe('timeout');
    expect(outcome.results).toEqual([]);
  });

  it('reports a provider error as the distinct "provider_error" state', async () => {
    const outcome = await fixtureService().search('fixture-error');
    expect(outcome.state).toBe('provider_error');
    expect(outcome.detail).toContain('HTTP 500');
  });

  it('reports quota exhaustion as the distinct "quota_exhausted" state', async () => {
    const outcome = await fixtureService().search('fixture-quota');
    expect(outcome.state).toBe('quota_exhausted');
  });

  it('reports a missing API key as "not_configured" without crashing', async () => {
    const service = createSearchService({ provider: createSerpApiProvider({}) });
    const outcome = await service.search('LW4570');
    expect(outcome.state).toBe('not_configured');
    expect(outcome.detail).toContain('SERPAPI_KEY');
  });

  it('honours the internal timeout with a slow provider', async () => {
    const service = createSearchService({
      provider: createFixtureProvider({ slowMs: 500 }),
      timeoutMs: 50,
    });
    const outcome = await service.search('fixture-slow');
    expect(outcome.state).toBe('timeout');
  });
});

describe('rate limiting and caching', () => {
  it('limits outbound provider calls and reports rate_limited distinctly', async () => {
    const service = fixtureService({ rateLimiter: createRateLimiter({ capacity: 2 }) });
    expect((await service.search('query one')).state).toBe('ok');
    expect((await service.search('query two')).state).toBe('ok');
    const third = await service.search('query three');
    expect(third.state).toBe('rate_limited');
  });

  it('serves repeat queries from cache with the original retrieval timestamp', async () => {
    let t = 0;
    const service = fixtureService({
      cache: createSearchCache({ now: () => t }),
      clock: () => '2026-08-05T00:00:00.000Z',
    });
    const first = await service.search('AB9053');
    t = 60_000;
    const second = await service.search('AB9053');
    expect(second.cached).toBe(true);
    expect(second.retrievedAt).toBe(first.retrievedAt);
  });
});

describe('query normalisation and classification', () => {
  it('detects identifiers, barcodes and free text without a type selector', () => {
    expect(classifyQuery('lw4570')).toBe('identifier');
    expect(classifyQuery('9312345678907')).toBe('barcode');
    expect(classifyQuery('lockwood deadlatch satin chrome')).toBe('free-text');
    expect(classifyQuery('')).toBe('empty');
  });
  it('quotes identifiers for the provider and passes free text through', () => {
    expect(buildProviderQuery('  LW4570 ').providerQuery).toBe('"LW4570"');
    expect(buildProviderQuery('lockwood  deadlatch').providerQuery).toBe('lockwood deadlatch');
  });
});

describe('price band in integer cents', () => {
  it('computes lowest, median and highest with half-up integer median', () => {
    const band = priceBandCents([
      { priceCents: 12995 },
      { priceCents: 14350 },
      { priceCents: 13900 },
      { priceCents: 26500 },
    ]);
    expect(band.lowest).toBe('129.95');
    expect(band.median).toBe('141.25');
    expect(band.highest).toBe('265.00');
    expect(band.pricedResults).toBe(4);
  });
});
