import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureProvider } from './search/fixtureProvider.mjs';
import { createSerpApiProvider } from './search/serpapiProvider.mjs';
import { createSearchService } from './search/service.mjs';
import { optionalProviderRegistry, publicProviderStatus } from './search/providerRegistry.mjs';
import {
  createStore,
  FloorViolationError,
  MissingApprovalError,
  MissingCatalogueItemError,
} from './store/store.mjs';

/**
 * The small server component. The browser calls this origin only; this server
 * performs the outbound provider searches and owns persistence. It also serves
 * the built SPA from dist/ so production runs as a single origin.
 *
 * Environment:
 *   PORT                 listen port (default 8787)
 *   SWL_DATA_DIR         persistence directory (default server/data)
 *   SWL_SEARCH_PROVIDER  "serpapi" (default) or "fixture" (offline testing)
 *   SERPAPI_KEY          SerpAPI key; without it live search reports
 *                        not_configured but the application still runs.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const port = Number(argValue('--port') ?? process.env.PORT ?? 8787);
const dataDir = process.env.SWL_DATA_DIR ?? join(HERE, 'data');
const useFixture = args.includes('--fixture') || process.env.SWL_SEARCH_PROVIDER === 'fixture';
const provider = useFixture ? createFixtureProvider() : createSerpApiProvider();
const searchService = createSearchService({ provider });
const store = createStore(dataDir);
const distDir = join(HERE, '..', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw === '' ? {} : JSON.parse(raw);
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  if (route === 'GET /api/health') {
    return sendJson(res, 200, {
      ok: true,
      provider: provider.name,
      liveSearchConfigured: provider.configured && !useFixture,
      fixtureMode: useFixture,
    });
  }
  if (route === 'GET /api/providers') {
    return sendJson(res, 200, [provider, ...optionalProviderRegistry()].map(publicProviderStatus));
  }
  if (route === 'GET /api/competitor-search') {
    const outcome = await searchService.search(url.searchParams.get('q') ?? '');
    return sendJson(res, 200, outcome);
  }
  if (route === 'GET /api/items') return sendJson(res, 200, store.listItems());
  if (req.method === 'PUT' && /^\/api\/items\/[^/]+$/.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.split('/').pop());
    const body = await readBody(req);
    return sendJson(res, 200, store.putItem({ ...body, id }));
  }
  if (route === 'GET /api/price-history') {
    return sendJson(res, 200, store.listPriceHistory(url.searchParams.get('itemId') ?? undefined));
  }
  if (route === 'POST /api/price-history') {
    const body = await readBody(req);
    try {
      return sendJson(res, 201, store.appendPriceVersion(body));
    } catch (error) {
      if (error instanceof FloorViolationError || error instanceof MissingApprovalError) {
        return sendJson(res, 422, { error: error.message });
      }
      throw error;
    }
  }
  if (route === 'GET /api/approvals') return sendJson(res, 200, store.listApprovals());
  if (route === 'POST /api/approvals') {
    const body = await readBody(req);
    if (!body.itemId || !body.approvedBy) {
      return sendJson(res, 422, { error: 'itemId and approvedBy are required' });
    }
    return sendJson(res, 201, store.appendApproval(body));
  }
  if (route === 'GET /api/references') {
    return sendJson(res, 200, store.listReferences(url.searchParams.get('itemId') ?? undefined));
  }
  if (route === 'POST /api/references') {
    const body = await readBody(req);
    if (!body.itemId || !body.observation) {
      return sendJson(res, 422, { error: 'itemId and observation are required' });
    }
    try {
      return sendJson(res, 201, store.appendReference(body));
    } catch (error) {
      if (error instanceof MissingCatalogueItemError) {
        return sendJson(res, 422, { error: error.message });
      }
      throw error;
    }
  }
  if (route === 'GET /api/sources') return sendJson(res, 200, store.getSources());
  if (req.method === 'PUT' && url.pathname === '/api/sources') {
    return sendJson(res, 200, store.putSources(await readBody(req)));
  }
  return sendJson(res, 404, { error: `No such API route: ${route}` });
}

function serveStatic(res, url) {
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const path = normalize(join(distDir, rel));
  if (!path.startsWith(distDir) || !existsSync(path) || !statSync(path).isFile()) {
    // Hash routing: unknown paths fall back to the SPA shell.
    const index = join(distDir, 'index.html');
    if (!existsSync(index)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('dist/ not built. Run: npm run build');
    }
    res.writeHead(200, { 'content-type': MIME['.html'] });
    return res.end(readFileSync(index));
  }
  res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
  return res.end(readFileSync(path));
}

export const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((error) => {
      sendJson(res, 500, { error: String(error?.message ?? error) });
    });
    return;
  }
  serveStatic(res, url);
});

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(
      `Port ${port} is already in use: another copy of this server is probably running. ` +
        `Open http://127.0.0.1:${port} in the browser, or start this one on another port: npm run server -- --port 8790`,
    );
    process.exit(1);
  }
  throw error;
});

server.listen(port, '127.0.0.1', () => {
  console.log(
    `SWL server listening on http://127.0.0.1:${port} | provider=${provider.name} configured=${provider.configured} | data=${dataDir}`,
  );
});
