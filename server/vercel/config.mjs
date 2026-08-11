function requiredText(env, name, minLength = 1) {
  const value = env[name];
  if (typeof value !== "string" || value.length < minLength) {
    throw new Error(`${name} is not configured.`);
  }
  return value;
}

function positiveInteger(env, name, maximum) {
  const value = requiredText(env, name);
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${name} is outside the supported range.`);
  }
  return parsed;
}

function canonicalHttpsOrigin(value, name) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} is invalid.`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== value
  ) {
    throw new Error(`${name} must be a canonical HTTPS origin.`);
  }
  return parsed.origin;
}

function serpApiKey(env) {
  const value = requiredText(env, "SERPAPI_KEY");
  if (!/^[A-Za-z0-9_-]{16,256}$/u.test(value)) {
    throw new Error("SERPAPI_KEY is invalid.");
  }
}

export function canonicalProviderLocation(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    [...value].some((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && (point <= 31 || point === 127);
    })
  ) {
    throw new Error("SERPAPI_LOCATION is invalid.");
  }
  const parts = value.split(",").map((part) => part.trim());
  if (
    parts.length < 3 ||
    parts.some((part) => part === "") ||
    parts.at(-1)?.toLowerCase() !== "australia"
  ) {
    throw new Error("SERPAPI_LOCATION must identify a place in Australia.");
  }
  return parts.join(", ");
}

export function currentMelbourneBudgetPeriod(now = Date.now) {
  const instant = now();
  if (!Number.isFinite(instant)) {
    throw new Error("The current time is invalid.");
  }
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(instant));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) {
    throw new Error("The Australia/Melbourne budget month is unavailable.");
  }
  return `${year}-${month}`;
}

export function assertCurrentBudgetPeriod(config, now = Date.now) {
  if (config.budgetPeriod !== currentMelbourneBudgetPeriod(now)) {
    throw new Error(
      "SWL_PROVIDER_BUDGET_PERIOD must equal the current Australia/Melbourne month.",
    );
  }
}

function budgetRetentionExpiresAtSeconds(period) {
  const [year, month] = period.split("-").map(Number);
  return Math.floor(Date.UTC(year, month + 1, 1) / 1_000);
}

export function readVercelConfig(env = process.env, now = Date.now) {
  serpApiKey(env);
  const providerLocation = canonicalProviderLocation(
    requiredText(env, "SERPAPI_LOCATION"),
  );
  const budgetPeriod = requiredText(env, "SWL_PROVIDER_BUDGET_PERIOD");
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(budgetPeriod)) {
    throw new Error("SWL_PROVIDER_BUDGET_PERIOD must use YYYY-MM.");
  }
  assertCurrentBudgetPeriod({ budgetPeriod }, now);
  if (env.SWL_PAID_CALLS_ENABLED !== "true") {
    throw new Error("Paid provider calls are disabled.");
  }
  const costCeilingCents = positiveInteger(
    env,
    "SWL_PROVIDER_COST_CEILING_CENTS",
    1_000_000_000,
  );
  const costPerCallCents = positiveInteger(
    env,
    "SWL_PROVIDER_COST_PER_CALL_CENTS",
    1_000_000_000,
  );
  if (costPerCallCents > costCeilingCents) {
    throw new Error("The per-call reservation exceeds the total ceiling.");
  }
  return Object.freeze({
    frontendOrigin: canonicalHttpsOrigin(
      requiredText(env, "SWL_FRONTEND_ORIGIN"),
      "SWL_FRONTEND_ORIGIN",
    ),
    accessTokenPepper: requiredText(env, "SWL_ACCESS_TOKEN_PEPPER", 32),
    redisUrl: canonicalHttpsOrigin(
      requiredText(env, "SWL_REDIS_REST_URL"),
      "SWL_REDIS_REST_URL",
    ),
    redisToken: requiredText(env, "SWL_REDIS_REST_TOKEN", 16),
    providerLocation,
    budgetPeriod,
    budgetRetentionExpiresAtSeconds:
      budgetRetentionExpiresAtSeconds(budgetPeriod),
    costCeilingCents,
    costPerCallCents,
    perUserPerMinute: positiveInteger(
      env,
      "SWL_SEARCH_PER_USER_PER_MINUTE",
      1_000,
    ),
    globalPerMinute: positiveInteger(
      env,
      "SWL_SEARCH_GLOBAL_PER_MINUTE",
      10_000,
    ),
    cacheTtlSeconds: positiveInteger(
      env,
      "SWL_SEARCH_CACHE_TTL_SECONDS",
      3_600,
    ),
  });
}
