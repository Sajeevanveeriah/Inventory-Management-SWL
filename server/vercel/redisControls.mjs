import { createHash, randomBytes } from "node:crypto";
import { normaliseQuery } from "../search/normaliseQuery.mjs";
import { canonicalProviderLocation } from "./config.mjs";
import { validateCacheableSearchOutcome } from "./outcomeValidation.mjs";

const MAX_CENTS = 1_000_000_000;
const MAX_CANDIDATE_TOKEN_CHARACTERS = 8_192;
const MAX_CANDIDATES = 100;
const JSON_STRING_PREFIX = "swl-json-v1:";

const READ_DISCOVERY_SCRIPT = `
local discovery = redis.call('GET', KEYS[1])
if not discovery then return nil end
return '${JSON_STRING_PREFIX}' .. discovery
`;

const AUTHORISE_SCRIPT = `
if ARGV[9] ~= '' then
  local discovery = redis.call('GET', KEYS[6])
  if not discovery or redis.sha1hex(discovery) ~= ARGV[9] then
    return {'candidate_missing'}
  end
end
local user_count = redis.call('INCR', KEYS[1])
if user_count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
if user_count > tonumber(ARGV[2]) then return {'user_rate'} end
local cached = redis.call('GET', KEYS[4])
if cached then return {'cache', '${JSON_STRING_PREFIX}' .. cached} end
local locked = redis.call('SET', KEYS[5], ARGV[7], 'NX', 'PX', ARGV[8])
if not locked then return {'in_progress'} end
local reserved = tonumber(redis.call('HGET', KEYS[3], 'reservedCents') or '0')
if reserved + tonumber(ARGV[5]) > tonumber(ARGV[4]) then
  if redis.call('GET', KEYS[5]) == ARGV[7] then redis.call('DEL', KEYS[5]) end
  return {'budget'}
end
local global_count = redis.call('INCR', KEYS[2])
if global_count == 1 then redis.call('EXPIRE', KEYS[2], ARGV[1]) end
if global_count > tonumber(ARGV[3]) then
  if redis.call('GET', KEYS[5]) == ARGV[7] then redis.call('DEL', KEYS[5]) end
  return {'global_rate'}
end
redis.call('HINCRBY', KEYS[3], 'reservedCents', ARGV[5])
redis.call('HINCRBY', KEYS[3], 'providerCalls', 1)
redis.call('EXPIREAT', KEYS[3], ARGV[6])
return {'authorised'}
`;

const COMPLETE_SCRIPT = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
redis.call('DEL', KEYS[2])
return 1
`;

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

export function requestCacheKey(query, candidateToken = "", providerLocation) {
  const canonicalLocation = canonicalProviderLocation(providerLocation);
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        normaliseQuery(query).toLowerCase(),
        canonicalLocation,
        candidateToken,
      ]),
    )
    .digest("hex");
  return `swl:cache:immersive-v3:${digest}`;
}

function matchingQuery(value) {
  return normaliseQuery(value).toLowerCase();
}

function unwrapJsonString(value) {
  if (typeof value !== "string" || !value.startsWith(JSON_STRING_PREFIX)) {
    throw new Error("Redis returned an invalid JSON string result.");
  }
  return value.slice(JSON_STRING_PREFIX.length);
}

function boundedText(value, maximum) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    ![...value].some((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && (point <= 31 || point === 127);
    })
  );
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function validCandidate(value) {
  if (
    !hasExactKeys(value, [
      "brand",
      "condition",
      "displayedPrice",
      "multipleSources",
      "packSize",
      "position",
      "priceCents",
      "productId",
      "productUrl",
      "title",
      "token",
    ]) ||
    !boundedText(value.token, MAX_CANDIDATE_TOKEN_CHARACTERS) ||
    !boundedText(value.title, 1_000) ||
    (value.brand !== null && !boundedText(value.brand, 256)) ||
    (value.productId !== null && !boundedText(value.productId, 256)) ||
    (value.displayedPrice !== null && !boundedText(value.displayedPrice, 64)) ||
    !boundedText(value.productUrl, 2_048) ||
    (value.priceCents !== null &&
      (!Number.isSafeInteger(value.priceCents) ||
        value.priceCents < 0 ||
        value.priceCents > MAX_CENTS)) ||
    typeof value.multipleSources !== "boolean" ||
    (value.packSize !== null && !boundedText(value.packSize, 256)) ||
    !["new", "used", "unknown"].includes(value.condition) ||
    !Number.isSafeInteger(value.position) ||
    value.position < 0 ||
    value.position > 10_000
  ) {
    return false;
  }
  let productUrl;
  try {
    productUrl = new URL(value.productUrl);
  } catch {
    return false;
  }
  const host = productUrl.hostname.toLowerCase();
  return (
    productUrl.protocol === "https:" &&
    productUrl.username === "" &&
    productUrl.password === "" &&
    (host === "google.com" ||
      host.endsWith(".google.com") ||
      host === "google.com.au" ||
      host.endsWith(".google.com.au"))
  );
}

function selectCachedCandidate(raw, query, candidateToken) {
  if (raw === null) return { state: "missing" };
  if (typeof raw !== "string") return { state: "invalid" };
  let outcome;
  try {
    outcome = validateCacheableSearchOutcome(JSON.parse(raw));
  } catch {
    return { state: "invalid" };
  }
  if (
    !outcome ||
    typeof outcome !== "object" ||
    Array.isArray(outcome) ||
    outcome.state !== "selection_required" ||
    typeof outcome.query !== "string" ||
    matchingQuery(outcome.query) !== matchingQuery(query) ||
    !Array.isArray(outcome.candidates) ||
    outcome.candidates.length === 0 ||
    outcome.candidates.length > MAX_CANDIDATES ||
    outcome.candidates.some((candidate) => !validCandidate(candidate))
  ) {
    return { state: "invalid" };
  }
  const candidate = outcome.candidates.find(
    (value) => value.token === candidateToken,
  );
  return candidate ? { state: "selected", candidate } : { state: "missing" };
}

export function createRedisControls(redis, config, now = Date.now) {
  const providerLocation = canonicalProviderLocation(config.providerLocation);
  return {
    async status() {
      const value = await redis.hgetall(`swl:budget:${config.budgetPeriod}`);
      const reservedCents = Number(value?.reservedCents ?? 0);
      const providerCalls = Number(value?.providerCalls ?? 0);
      if (
        !Number.isSafeInteger(reservedCents) ||
        reservedCents < 0 ||
        !Number.isSafeInteger(providerCalls) ||
        providerCalls < 0
      ) {
        throw new Error("Redis returned invalid budget status.");
      }
      return { reservedCents, providerCalls };
    },
    async selectCandidate(query, candidateToken) {
      const discoveryKey = requestCacheKey(query, "", providerLocation);
      const result = await redis.eval(
        READ_DISCOVERY_SCRIPT,
        [discoveryKey],
        [],
      );
      if (result === null) return { state: "missing" };
      let raw;
      try {
        raw = unwrapJsonString(result);
      } catch {
        return { state: "invalid" };
      }
      const selected = selectCachedCandidate(raw, query, candidateToken);
      if (selected.state !== "selected") return selected;
      return {
        ...selected,
        discoveryKey,
        discoveryDigest: createHash("sha1").update(raw).digest("hex"),
        providerLocation,
      };
    },
    async authorise(sub, cacheKey, selection) {
      const minute = Math.floor(now() / 60_000);
      const owner = randomBytes(18).toString("base64url");
      if (
        selection !== undefined &&
        (!selection ||
          typeof selection !== "object" ||
          selection.providerLocation !== providerLocation ||
          !/^swl:cache:immersive-v3:[a-f0-9]{64}$/u.test(
            selection.discoveryKey,
          ) ||
          !/^[a-f0-9]{40}$/u.test(selection.discoveryDigest))
      ) {
        throw new Error(
          "The discovery selection proof or provider location is invalid.",
        );
      }
      const result = await redis.eval(
        AUTHORISE_SCRIPT,
        [
          `swl:rate:user:${sub}:${minute}`,
          `swl:rate:global:${minute}`,
          `swl:budget:${config.budgetPeriod}`,
          cacheKey,
          `swl:flight:${cacheKey.slice(cacheKey.lastIndexOf(":") + 1)}`,
          selection?.discoveryKey ?? cacheKey,
        ],
        [
          120,
          config.perUserPerMinute,
          config.globalPerMinute,
          config.costCeilingCents,
          config.costPerCallCents,
          config.budgetRetentionExpiresAtSeconds,
          owner,
          18_000,
          selection?.discoveryDigest ?? "",
        ],
      );
      if (!Array.isArray(result) || typeof result[0] !== "string") {
        throw new Error("Redis returned an invalid control result.");
      }
      let cached = null;
      if (result[0] === "cache") {
        try {
          cached = unwrapJsonString(result[1]);
        } catch {
          throw new Error("Redis returned an invalid control result.");
        }
      }
      const lockKey = `swl:flight:${cacheKey.slice(cacheKey.lastIndexOf(":") + 1)}`;
      return {
        state: result[0],
        cached,
        owner,
        lockKey,
      };
    },
    async complete(cacheKey, lockKey, owner, outcome) {
      const validated = validateCacheableSearchOutcome(outcome);
      const completed = await redis.eval(
        COMPLETE_SCRIPT,
        [cacheKey, lockKey],
        [owner, JSON.stringify(validated), config.cacheTtlSeconds],
      );
      if (completed !== 1) {
        throw new Error("The search result lock expired before completion.");
      }
    },
    async release(lockKey, owner) {
      await redis.eval(RELEASE_SCRIPT, [lockKey], [owner]);
    },
  };
}
