import { Redis } from "@upstash/redis";
import { createSerpApiProvider } from "../search/serpapiProvider.mjs";
import { createSearchService } from "../search/service.mjs";
import { readVercelConfig } from "./config.mjs";
import { createRedisControls } from "./redisControls.mjs";

let runtime;

const REDIS_ONLY_RATE_LIMITER = Object.freeze({
  tryTake: () => true,
});

const REDIS_ONLY_CACHE = Object.freeze({
  get: () => null,
  set: () => undefined,
});

export function createVercelSearchService(provider, config) {
  return createSearchService({
    provider,
    rateLimiter: REDIS_ONLY_RATE_LIMITER,
    cache: REDIS_ONLY_CACHE,
    paidCallBudget: {
      reserve: () => ({ state: "enabled", authorised: true }),
      status: () => ({
        enabled: true,
        state: "enabled",
        ceilingCents: config.costCeilingCents,
        perCallCents: config.costPerCallCents,
        reservedCents: 0,
      }),
    },
  });
}

export function getVercelRuntime() {
  if (runtime) return runtime;
  const config = readVercelConfig(process.env);
  const redis = new Redis({ url: config.redisUrl, token: config.redisToken });
  const provider = createSerpApiProvider(process.env);
  const searchService = createVercelSearchService(provider, config);
  runtime = {
    config,
    redis,
    provider,
    searchService,
    controls: createRedisControls(redis, config),
  };
  return runtime;
}
