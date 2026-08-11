import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPaidCallBudgetFromEnvironment,
  createSearchService,
} from "./search/service.mjs";
import { centsToAmount } from "./lib/moneyCents.mjs";
import {
  createProviderFromEnvironment,
  optionalProviderRegistry,
  publicProviderStatus,
} from "./search/providerRegistry.mjs";
import {
  createStore,
  FloorViolationError,
  MissingCatalogueItemError,
  PublicationValidationError,
} from "./store/store.mjs";

/**
 * The small server component. The browser calls this origin only; this server
 * performs the outbound provider searches and owns persistence. It also serves
 * the built SPA from dist/ so production runs as a single origin.
 *
 * Environment:
 *   PORT                 listen port (default 8787)
 *   SWL_DATA_DIR         persistence directory (default server/data)
 *   SWL_SEARCH_PROVIDER  serpapi, serper or ebay (auto-selects configured free provider when omitted)
 *   SERPAPI_KEY          SerpAPI key; never sufficient by itself to authorise a paid call.
 *   SERPER_API_KEY       Serper Shopping key; finite free credits apply.
 *   EBAY_CLIENT_ID / EBAY_CLIENT_SECRET  eBay Browse application credentials.
 *   SWL_PAID_CALLS_ENABLED                 exact "true" opt-in; default false
 *   SWL_PROVIDER_COST_CEILING_CENTS        positive integer total process budget
 *   SWL_PROVIDER_COST_PER_CALL_CENTS       positive integer reserved before each call
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const argValues = (name) =>
  args.flatMap((value, index) =>
    value === name && typeof args[index + 1] === "string"
      ? [args[index + 1]]
      : [],
  );

const port = Number(argValue("--port") ?? process.env.PORT ?? 8787);
const dataDir = process.env.SWL_DATA_DIR ?? join(HERE, "data");
if (
  args.includes("--fixture") ||
  process.env.SWL_SEARCH_PROVIDER === "fixture"
) {
  throw new Error(
    "Fixture search is unavailable from the production server entry point.",
  );
}
const testProviderFactory =
  globalThis.__SWL_TEST_ONLY_SEARCH_PROVIDER_FACTORY__;
delete globalThis.__SWL_TEST_ONLY_SEARCH_PROVIDER_FACTORY__;
const fixtureMode = typeof testProviderFactory === "function";
const provider = fixtureMode
  ? testProviderFactory()
  : createProviderFromEnvironment(process.env);
const paidCallBudget = createPaidCallBudgetFromEnvironment(process.env);
const searchService = createSearchService({ provider, paidCallBudget });
const store = createStore(dataDir);
const distDir = resolve(process.env.SWL_DIST_DIR ?? join(HERE, "..", "dist"));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};
const MAX_API_BODY_BYTES = 25 * 1024 * 1024;
const STATIC_SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};
const EXPECTED_WEB_ORIGIN = `http://127.0.0.1:${port}`;
const TRUSTED_WEB_ORIGINS = new Set([EXPECTED_WEB_ORIGIN]);
for (const candidate of argValues("--trusted-origin")) {
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("A trusted development origin is invalid.");
  }
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    parsed.port === "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== candidate
  ) {
    throw new Error(
      "Trusted development origins must be canonical loopback HTTP origins.",
    );
  }
  TRUSTED_WEB_ORIGINS.add(parsed.origin);
}
const JSON_MUTATION_ROUTES = new Set([
  "POST /api/competitor-search",
  "POST /api/publish-approved-changes",
  "POST /api/references",
  "PUT /api/sources",
]);
const SENSITIVE_API_PATHS = new Set([
  "/api/competitor-search",
  "/api/publish-approved-changes",
  "/api/references",
  "/api/sources",
]);

class RequestBodyError extends Error {
  constructor(status) {
    super("The request body is invalid.");
    this.status = status;
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.byteLength;
    if (length > MAX_API_BODY_BYTES) throw new RequestBodyError(413);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new RequestBodyError(400);
  }
}

function requestBoundaryFailure(req, url) {
  if (req.headers.host !== `127.0.0.1:${port}`) {
    return { status: 403, error: "The request origin was rejected." };
  }
  if (!SENSITIVE_API_PATHS.has(url.pathname)) return null;

  const origin = req.headers.origin;
  const fetchSite = req.headers["sec-fetch-site"];
  const exactOrigin =
    typeof origin === "string" && TRUSTED_WEB_ORIGINS.has(origin);
  const sameOriginFetch = fetchSite === "same-origin";
  if (
    !sameOriginFetch ||
    (origin !== undefined && !exactOrigin) ||
    (JSON_MUTATION_ROUTES.has(`${req.method} ${url.pathname}`) && !exactOrigin)
  ) {
    return { status: 403, error: "The request origin was rejected." };
  }

  if (JSON_MUTATION_ROUTES.has(`${req.method} ${url.pathname}`)) {
    const contentType = req.headers["content-type"];
    if (
      typeof contentType !== "string" ||
      contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json"
    ) {
      return { status: 415, error: "A JSON request body is required." };
    }
  }
  return null;
}

async function handleApi(req, res, url) {
  const boundaryFailure = requestBoundaryFailure(req, url);
  if (boundaryFailure) {
    return sendJson(res, boundaryFailure.status, {
      error: boundaryFailure.error,
    });
  }
  const route = `${req.method} ${url.pathname}`;
  if (route === "GET /api/health") {
    const paidPolicy = paidCallBudget.status();
    return sendJson(res, 200, {
      ok: true,
      provider: provider.name,
      liveSearchConfigured: provider.configured && !fixtureMode,
      fixtureMode,
      requiresPaidCall: provider.requiresPaidCall === true,
      paidCallsEnabled:
        !fixtureMode &&
        provider.requiresPaidCall === true &&
        paidPolicy.state === "enabled",
      costCeilingAud: centsToAmount(paidPolicy.ceilingCents),
      costCeilingCents: paidPolicy.ceilingCents,
      costPerCallCents: paidPolicy.perCallCents,
      spentCents: paidPolicy.reservedCents,
      paidPolicyState: fixtureMode ? "fixture" : paidPolicy.state,
    });
  }
  if (route === "GET /api/providers") {
    const providers = [provider, ...optionalProviderRegistry()].filter(
      (candidate, index, all) =>
        all.findIndex((entry) => entry.name === candidate.name) === index,
    );
    return sendJson(res, 200, providers.map(publicProviderStatus));
  }
  if (route === "POST /api/competitor-search") {
    const body = await readBody(req);
    const keys =
      body && typeof body === "object" && !Array.isArray(body)
        ? Object.keys(body).sort()
        : [];
    const expected =
      body?.candidateToken === undefined
        ? ["query"]
        : ["candidateToken", "query"];
    if (
      keys.length !== expected.length ||
      keys.some((key, index) => key !== expected[index]) ||
      typeof body.query !== "string" ||
      body.query !== body.query.trim() ||
      body.query.length === 0 ||
      body.query.length > 512 ||
      (body.candidateToken !== undefined &&
        (typeof body.candidateToken !== "string" ||
          body.candidateToken.length === 0 ||
          body.candidateToken.length > 8192))
    ) {
      return sendJson(res, 422, {
        error: "The search request is outside the supported range.",
      });
    }
    const outcome = await searchService.search(body.query, body.candidateToken);
    return sendJson(res, 200, outcome);
  }
  if (route === "GET /api/items") return sendJson(res, 200, store.listItems());
  if (route === "POST /api/publish-approved-changes") {
    const body = await readBody(req);
    try {
      return sendJson(res, 201, store.publishApprovedChanges(body.changes));
    } catch (error) {
      if (
        error instanceof FloorViolationError ||
        error instanceof PublicationValidationError
      ) {
        return sendJson(res, 422, { error: error.message });
      }
      throw error;
    }
  }
  if (route === "GET /api/price-history") {
    return sendJson(
      res,
      200,
      store.listPriceHistory(url.searchParams.get("itemId") ?? undefined),
    );
  }
  if (route === "GET /api/approvals")
    return sendJson(res, 200, store.listApprovals());
  if (route === "GET /api/references") {
    return sendJson(
      res,
      200,
      store.listReferences(url.searchParams.get("itemId") ?? undefined),
    );
  }
  if (route === "POST /api/references") {
    const body = await readBody(req);
    if (!body.itemId || !body.observation) {
      return sendJson(res, 422, {
        error: "itemId and observation are required",
      });
    }
    try {
      return sendJson(res, 201, store.appendReference(body));
    } catch (error) {
      if (
        error instanceof MissingCatalogueItemError ||
        error instanceof PublicationValidationError
      ) {
        return sendJson(res, 422, { error: error.message });
      }
      throw error;
    }
  }
  if (route === "GET /api/sources")
    return sendJson(res, 200, store.getSources());
  if (req.method === "PUT" && url.pathname === "/api/sources") {
    try {
      return sendJson(res, 200, store.putSources(await readBody(req)));
    } catch (error) {
      if (error instanceof PublicationValidationError) {
        return sendJson(res, 422, { error: error.message });
      }
      throw error;
    }
  }
  return sendJson(res, 404, { error: `No such API route: ${route}` });
}

function serveStatic(res, url) {
  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const path = normalize(join(distDir, rel));
  if (
    (path !== distDir && !path.startsWith(`${distDir}${sep}`)) ||
    !existsSync(path) ||
    !statSync(path).isFile()
  ) {
    // Hash routing: unknown paths fall back to the SPA shell.
    const index = join(distDir, "index.html");
    if (!existsSync(index)) {
      res.writeHead(404, {
        ...STATIC_SECURITY_HEADERS,
        "content-type": "text/plain; charset=utf-8",
      });
      return res.end("dist/ not built. Run: npm run build");
    }
    res.writeHead(200, {
      ...STATIC_SECURITY_HEADERS,
      "content-type": MIME[".html"],
    });
    return res.end(readFileSync(index));
  }
  res.writeHead(200, {
    ...STATIC_SECURITY_HEADERS,
    "content-type": MIME[extname(path)] ?? "application/octet-stream",
  });
  return res.end(readFileSync(path));
}

export const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((error) => {
      if (error instanceof RequestBodyError) {
        sendJson(res, error.status, { error: "The request body is invalid." });
      } else {
        sendJson(res, 500, {
          error: "The application service could not complete the request.",
        });
      }
    });
    return;
  }
  serveStatic(res, url);
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(
      `Port ${port} is already in use: another copy of this server is probably running. ` +
        `Open http://127.0.0.1:${port} in the browser, or start this one on another port: npm run server -- --port 8790`,
    );
    process.exit(1);
  }
  throw error;
});

server.listen(port, "127.0.0.1", () => {
  console.log(
    `SWL server listening on http://127.0.0.1:${port} | provider=${provider.name} configured=${provider.configured}`,
  );
});
