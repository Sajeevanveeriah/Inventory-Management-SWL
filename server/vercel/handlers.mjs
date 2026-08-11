import { TextEncoder } from "node:util";
import { authenticateRequest } from "./auth.mjs";
import { assertCurrentBudgetPeriod } from "./config.mjs";
import { validateCacheableSearchOutcome } from "./outcomeValidation.mjs";
import {
  allowedOrigin,
  jsonResponse,
  preflightResponse,
} from "./responses.mjs";
import { requestCacheKey } from "./redisControls.mjs";

const MAX_REQUEST_BYTES = 16 * 1024;
const TERMINAL_CACHEABLE_STATES = new Set([
  "selection_required",
  "ok",
  "empty",
  "no_comparable_offers",
]);

function boundaryResponse(request, config, method) {
  const origin = allowedOrigin(request, config.frontendOrigin);
  if (origin === null) {
    return { response: jsonResponse(403, { error: "Origin rejected." }) };
  }
  if (request.method === "OPTIONS") {
    const requestedMethod = request.headers.get(
      "access-control-request-method",
    );
    const requestedHeaders = (
      request.headers.get("access-control-request-headers") ?? ""
    )
      .split(",")
      .map((header) => header.trim().toLowerCase())
      .filter(Boolean)
      .sort();
    const expectedHeaders =
      method === "POST" ? ["authorization", "content-type"] : ["authorization"];
    if (
      requestedMethod !== method ||
      requestedHeaders.length !== expectedHeaders.length ||
      requestedHeaders.some(
        (header, index) => header !== expectedHeaders[index],
      )
    ) {
      return {
        response: jsonResponse(403, { error: "Preflight rejected." }, origin),
      };
    }
    return { response: preflightResponse(origin, method) };
  }
  if (request.method !== method) {
    return {
      response: jsonResponse(405, { error: "Method rejected." }, origin),
    };
  }
  return { origin };
}

async function authenticated(request, runtime, origin) {
  try {
    const result = await authenticateRequest(
      request,
      runtime.redis,
      runtime.config,
    );
    return result.ok
      ? result
      : {
          response: jsonResponse(
            result.status,
            { error: "API access token rejected." },
            origin,
          ),
        };
  } catch {
    return {
      response: jsonResponse(
        503,
        { error: "Access control is unavailable." },
        origin,
      ),
    };
  }
}

async function parseSearchRequest(request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (
    contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json"
  ) {
    return { error: "A JSON request body is required.", status: 415 };
  }
  const declared = request.headers.get("content-length");
  if (
    declared &&
    (!/^\d+$/u.test(declared) || Number(declared) > MAX_REQUEST_BYTES)
  ) {
    return { error: "The request body is too large.", status: 413 };
  }
  let text;
  try {
    text = await request.text();
  } catch {
    return { error: "The request body could not be read.", status: 400 };
  }
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    return { error: "The request body is too large.", status: 413 };
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { error: "The request body is invalid JSON.", status: 400 };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "The request body is invalid.", status: 400 };
  }
  const keys = Object.keys(body).sort();
  const expected =
    body.candidateToken === undefined ? ["query"] : ["candidateToken", "query"];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    typeof body.query !== "string" ||
    body.query !== body.query.trim() ||
    body.query.length === 0 ||
    body.query.length > 512 ||
    [...body.query].some((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && (point <= 31 || point === 127);
    }) ||
    (body.candidateToken !== undefined &&
      (typeof body.candidateToken !== "string" ||
        body.candidateToken.length === 0 ||
        body.candidateToken.length > 8192 ||
        [...body.candidateToken].some((character) => {
          const point = character.codePointAt(0);
          return point !== undefined && (point <= 31 || point === 127);
        })))
  ) {
    return {
      error: "The search request is outside the supported range.",
      status: 422,
    };
  }
  return { value: body };
}

function parseCachedOutcome(raw) {
  if (typeof raw !== "string") {
    throw new Error("The cached outcome is not a JSON string.");
  }
  const outcome = validateCacheableSearchOutcome(JSON.parse(raw));
  return { ...outcome, cached: true };
}

function staleBudgetResponse(runtime, origin, now) {
  try {
    assertCurrentBudgetPeriod(runtime.config, now);
    return null;
  } catch {
    return jsonResponse(
      503,
      { error: "The provider budget period is stale." },
      origin,
    );
  }
}

export function createHealthHandler(getRuntime, now = Date.now) {
  return async function health(request) {
    let runtime;
    try {
      runtime = await getRuntime();
    } catch {
      return jsonResponse(503, { error: "The API is not configured." });
    }
    const boundary = boundaryResponse(request, runtime.config, "GET");
    if (boundary.response) return boundary.response;
    const stale = staleBudgetResponse(runtime, boundary.origin, now);
    if (stale) return stale;
    const auth = await authenticated(request, runtime, boundary.origin);
    if (auth.response) return auth.response;
    let budget;
    try {
      budget = await runtime.controls.status();
    } catch {
      return jsonResponse(
        503,
        { error: "Budget status is unavailable." },
        boundary.origin,
      );
    }
    const paidCallsEnabled =
      runtime.provider.configured === true &&
      budget.reservedCents <=
        runtime.config.costCeilingCents - runtime.config.costPerCallCents;
    return jsonResponse(
      200,
      {
        ok: true,
        provider: runtime.provider.name,
        liveSearchConfigured: runtime.provider.configured,
        fixtureMode: false,
        paidCallsEnabled,
        costCeilingAud: (runtime.config.costCeilingCents / 100).toFixed(2),
        costCeilingCents: runtime.config.costCeilingCents,
        costPerCallCents: runtime.config.costPerCallCents,
        spentCents: budget.reservedCents,
        paidPolicyState: paidCallsEnabled ? "enabled" : "exhausted",
        schemaVersion: 2,
      },
      boundary.origin,
    );
  };
}

export function createCompetitorSearchHandler(getRuntime, now = Date.now) {
  return async function competitorSearch(request) {
    let runtime;
    try {
      runtime = await getRuntime();
    } catch {
      return jsonResponse(503, { error: "The API is not configured." });
    }
    const boundary = boundaryResponse(request, runtime.config, "POST");
    if (boundary.response) return boundary.response;
    const stale = staleBudgetResponse(runtime, boundary.origin, now);
    if (stale) return stale;
    const auth = await authenticated(request, runtime, boundary.origin);
    if (auth.response) return auth.response;
    const parsed = await parseSearchRequest(request);
    if (!parsed.value) {
      return jsonResponse(
        parsed.status,
        { error: parsed.error },
        boundary.origin,
      );
    }
    const { query, candidateToken } = parsed.value;
    let selection;
    if (candidateToken !== undefined) {
      try {
        selection = await runtime.controls.selectCandidate(
          query,
          candidateToken,
        );
      } catch {
        return jsonResponse(
          503,
          { error: "Product selection validation is unavailable." },
          boundary.origin,
        );
      }
      if (selection.state === "missing") {
        return jsonResponse(
          410,
          {
            error: "The product selection expired or was not issued.",
            code: "selection_expired",
          },
          boundary.origin,
        );
      }
      if (selection.state !== "selected") {
        return jsonResponse(
          503,
          { error: "The cached product selection is invalid." },
          boundary.origin,
        );
      }
    }
    const cacheKey = requestCacheKey(
      query,
      candidateToken,
      runtime.config.providerLocation,
    );
    let control;
    try {
      control = await runtime.controls.authorise(
        auth.sub,
        cacheKey,
        selection
          ? {
              discoveryKey: selection.discoveryKey,
              discoveryDigest: selection.discoveryDigest,
              providerLocation: selection.providerLocation,
            }
          : undefined,
      );
    } catch {
      return jsonResponse(
        503,
        { error: "Search controls are unavailable." },
        boundary.origin,
      );
    }
    if (control.state === "cache") {
      try {
        return jsonResponse(
          200,
          parseCachedOutcome(control.cached),
          boundary.origin,
        );
      } catch {
        return jsonResponse(
          503,
          { error: "The cached search result is invalid." },
          boundary.origin,
        );
      }
    }
    if (control.state === "in_progress") {
      return jsonResponse(
        409,
        {
          error: "An identical search is in progress.",
          code: "search_in_progress",
        },
        boundary.origin,
      );
    }
    if (control.state === "candidate_missing") {
      return jsonResponse(
        410,
        {
          error: "The product selection expired or changed.",
          code: "selection_expired",
        },
        boundary.origin,
      );
    }
    if (["user_rate", "global_rate"].includes(control.state)) {
      return jsonResponse(
        429,
        { error: "The search rate limit was reached." },
        boundary.origin,
      );
    }
    if (control.state === "budget") {
      return jsonResponse(
        429,
        { error: "The provider budget ceiling was reached." },
        boundary.origin,
      );
    }
    if (control.state !== "authorised") {
      return jsonResponse(
        503,
        { error: "Search was not authorised." },
        boundary.origin,
      );
    }

    let outcome;
    try {
      outcome =
        candidateToken === undefined
          ? await runtime.searchService.search(query, candidateToken)
          : await runtime.searchService.search(
              query,
              candidateToken,
              selection.candidate,
            );
      if (TERMINAL_CACHEABLE_STATES.has(outcome.state)) {
        await runtime.controls.complete(
          cacheKey,
          control.lockKey,
          control.owner,
          outcome,
        );
      } else {
        await runtime.controls.release(control.lockKey, control.owner);
      }
    } catch {
      try {
        await runtime.controls.release(control.lockKey, control.owner);
      } catch {
        // The lock has a short expiry and reservations are deliberately retained.
      }
      return jsonResponse(
        502,
        { error: "The provider request could not be completed." },
        boundary.origin,
      );
    }
    return jsonResponse(200, outcome, boundary.origin);
  };
}
