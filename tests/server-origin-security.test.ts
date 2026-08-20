// @vitest-environment node
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { PublishedChangeSchema } from '../src/platform/schemas';

type Response = {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
};
type FixtureChild = ChildProcessByStdio<null, Readable, Readable>;

const children = new Set<FixtureChild>();
const temporaryDirectories = new Set<string>();

async function reserveLoopbackPort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === 'string') {
    reservation.close();
    throw new Error('A loopback test port could not be reserved.');
  }
  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function startFixtureServer(
  port: number,
  dataDirectory: string,
  trustedOrigins: readonly string[] = [],
  distDirectory?: string,
) {
  const child = spawn(
    process.execPath,
    [
      'tests/support/fixture-server.mjs',
      '--port',
      String(port),
      ...trustedOrigins.flatMap((origin) => ['--trusted-origin', origin]),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        SWL_DATA_DIR: dataDirectory,
        ...(distDirectory === undefined ? {} : { SWL_DIST_DIR: distDirectory }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.add(child);
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-2_000);
  });
  child.stdout.setEncoding('utf8');
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`The fixture server did not start. ${stderr}`));
    }, 5_000);
    const onOutput = (chunk: string) => {
      if (!chunk.includes('SWL server listening on')) return;
      clearTimeout(timeout);
      child.off('exit', onExit);
      child.stdout.off('data', onOutput);
      resolve();
    };
    const onExit = (code: number | null) => {
      clearTimeout(timeout);
      child.stdout.off('data', onOutput);
      reject(
        new Error(`The fixture server exited before listening (code ${String(code)}). ${stderr}`),
      );
    };
    child.stdout.on('data', onOutput);
    child.once('exit', onExit);
  });
  return child;
}

async function stopChild(child: FixtureChild) {
  children.delete(child);
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill();
  });
}

function apiRequest({
  port,
  path,
  method = 'GET',
  headers = {},
  body,
}: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          host: `127.0.0.1:${port}`,
          connection: 'close',
          ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body).toString() }),
          ...headers,
        },
      },
      (res) => {
        res.setEncoding('utf8');
        let responseBody = '';
        res.on('data', (chunk: string) => {
          responseBody += chunk;
        });
        res.once('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: responseBody,
            headers: res.headers,
          });
        });
      },
    );
    req.once('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

afterEach(async () => {
  await Promise.all([...children].map(stopChild));
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe('Node loopback request boundary', () => {
  it('denies framing and MIME sniffing for the shell and SPA fallback', async () => {
    const port = await reserveLoopbackPort();
    const root = mkdtempSync(join(tmpdir(), 'swl-static-security-test-'));
    const dataDirectory = join(root, 'data');
    const distDirectory = join(root, 'dist');
    mkdirSync(dataDirectory);
    mkdirSync(distDirectory);
    writeFileSync(
      join(distDirectory, 'index.html'),
      '<!doctype html><title>Synthetic SWL shell</title>',
    );
    temporaryDirectories.add(root);
    const child = await startFixtureServer(port, dataDirectory, [], distDirectory);

    for (const path of ['/', '/synthetic-spa-fallback']) {
      const response = await apiRequest({ port, path });
      expect(response.status).toBe(200);
      expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.body).toContain('Synthetic SWL shell');
    }
    const api = await apiRequest({ port, path: '/api/health' });
    expect(api.headers['x-content-type-options']).toBe('nosniff');
    expect(api.headers['x-frame-options']).toBe('DENY');
    await stopChild(child);
  });

  it('accepts the exact schema-4 web publication contract and returns resolved history', async () => {
    const port = await reserveLoopbackPort();
    const dataDirectory = mkdtempSync(join(tmpdir(), 'swl-publication-contract-test-'));
    temporaryDirectories.add(dataDirectory);
    const child = await startFixtureServer(port, dataDirectory);
    const origin = `http://127.0.0.1:${port}`;
    const change = {
      item: {
        id: 'CONTRACT-ITEM',
        itemNumber: 'CONTRACT-ITEM',
        description: 'Synthetic schema-4 contract item',
        itemKind: 'physical-product',
        brandId: null,
        markupOverridePercent: null,
        xeroReference: null,
        servicem8Reference: 'CONTRACT-ITEM',
        barcodeGtin: null,
        selectedOfferId: 'offer-CONTRACT-ITEM',
        costCents: 10_000,
        sellPriceCents: 13_000,
        gstBasis: 'ex-gst',
        sellPriceGstBasis: 'ex-gst',
        updatedAt: '2026-08-20T00:00:00.000Z',
      },
      approvedBy: 'Synthetic operator',
      reason: 'Schema-4 boundary contract test',
      pricingProvenance: {
        selectedOfferId: 'offer-CONTRACT-ITEM',
        supplierId: 'supplier-contract',
        supplierName: 'Synthetic contract supplier',
        supplierSku: 'SUPPLIER-CONTRACT-ITEM',
        costGstBasis: 'ex-gst',
        currency: 'AUD',
        markupPercent: '30',
        markupSource: 'global',
        markupSourceId: null,
        brandId: null,
        itemKind: 'physical-product',
        sellPriceGstBasis: 'ex-gst',
        explanation: 'Untrusted client explanation',
        ruleVersion: 'pricing-rule-v1',
      },
    };
    const response = await apiRequest({
      port,
      path: '/api/publish-approved-changes',
      method: 'POST',
      headers: {
        origin,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ changes: [change] }),
    });
    expect(response.status).toBe(201);
    const parsed = PublishedChangeSchema.array().parse(JSON.parse(response.body));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      item: {
        id: 'CONTRACT-ITEM',
        selectedOfferId: 'offer-CONTRACT-ITEM',
        sellPriceGstBasis: 'ex-gst',
      },
      priceHistory: {
        selectedOfferId: 'offer-CONTRACT-ITEM',
        supplierId: 'supplier-contract',
        appliedMarkupHundredths: 3_000,
        provenanceState: 'resolved',
        ruleVersion: 'pricing-rule-v1',
      },
    });
    expect(parsed[0]?.priceHistory.pricingExplanation).not.toContain(
      'Untrusted client explanation',
    );
    await stopChild(child);
  });

  it('rejects forged hosts, cross-site/no-cors calls and non-JSON mutations without changing data', async () => {
    const port = await reserveLoopbackPort();
    const dataDirectory = mkdtempSync(join(tmpdir(), 'swl-origin-test-'));
    temporaryDirectories.add(dataDirectory);
    const trustedDevelopmentOrigin = 'http://localhost:5173';
    const trustedNumericDevelopmentOrigin = 'http://127.0.0.1:5173';
    const child = await startFixtureServer(port, dataDirectory, [
      trustedDevelopmentOrigin,
      trustedNumericDevelopmentOrigin,
    ]);
    const origin = `http://127.0.0.1:${port}`;
    const sameOriginHeaders = {
      origin,
      'sec-fetch-site': 'same-origin',
    };

    expect((await apiRequest({ port, path: '/api/health' })).status).toBe(200);
    expect(
      (
        await apiRequest({
          port,
          path: '/api/health',
          headers: { host: `localhost:${port}` },
        })
      ).status,
    ).toBe(403);

    expect(
      (
        await apiRequest({
          port,
          path: '/api/competitor-search',
          method: 'POST',
          headers: {
            origin,
            'sec-fetch-site': 'same-origin',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ query: 'fixture-none' }),
        })
      ).status,
    ).toBe(200);
    for (const headers of [
      {},
      {
        origin: 'https://hostile.example.test',
        'sec-fetch-site': 'cross-site',
      },
      { 'sec-fetch-site': 'cross-site' },
    ]) {
      expect(
        (
          await apiRequest({
            port,
            path: '/api/competitor-search',
            method: 'POST',
            headers: {
              ...headers,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ query: 'fixture-none' }),
          })
        ).status,
      ).toBe(403);
    }

    const sources = JSON.stringify([
      {
        id: 'synthetic-manual-source',
        name: 'Synthetic manual source',
        accessMethod: 'manual-entry',
        automatedAccessNote: 'No automated access',
        enabled: true,
      },
    ]);
    const validMutation = await apiRequest({
      port,
      path: '/api/sources',
      method: 'PUT',
      headers: {
        origin: trustedDevelopmentOrigin,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json; charset=utf-8',
      },
      body: sources,
    });
    expect(validMutation.status).toBe(200);
    const sourcePath = join(dataDirectory, 'source-registry.json');
    expect(existsSync(sourcePath)).toBe(true);
    const acceptedBytes = readFileSync(sourcePath).toString('base64');
    expect(
      (
        await apiRequest({
          port,
          path: '/api/sources',
          method: 'PUT',
          headers: {
            origin: trustedNumericDevelopmentOrigin,
            'sec-fetch-site': 'same-origin',
            'content-type': 'application/json',
          },
          body: sources,
        })
      ).status,
    ).toBe(200);

    const rejectedMutations = [
      {
        path: '/api/sources',
        method: 'PUT',
        headers: {
          origin: 'https://hostile.example.test',
          'sec-fetch-site': 'cross-site',
          'content-type': 'application/json',
        },
        body: '[]',
        status: 403,
      },
      {
        path: '/api/sources',
        method: 'PUT',
        headers: {
          'sec-fetch-site': 'cross-site',
          'content-type': 'text/plain',
        },
        body: '[]',
        status: 403,
      },
      {
        path: '/api/sources',
        method: 'PUT',
        headers: {
          ...sameOriginHeaders,
          'content-type': 'text/plain',
        },
        body: '[]',
        status: 415,
      },
      {
        path: '/api/sources',
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '[]',
        status: 403,
      },
      {
        path: '/api/publish-approved-changes',
        method: 'POST',
        headers: {
          origin: 'https://hostile.example.test',
          'sec-fetch-site': 'cross-site',
          'content-type': 'application/json',
        },
        body: '{"changes":[]}',
        status: 403,
      },
      {
        path: '/api/references',
        method: 'POST',
        headers: {
          origin: 'https://hostile.example.test',
          'sec-fetch-site': 'cross-site',
          'content-type': 'application/json',
        },
        body: '{}',
        status: 403,
      },
    ];
    for (const requestCase of rejectedMutations) {
      const response = await apiRequest({ port, ...requestCase });
      expect(response.status).toBe(requestCase.status);
      expect(readFileSync(sourcePath).toString('base64')).toBe(acceptedBytes);
    }

    expect(
      (
        await apiRequest({
          port,
          path: '/api/sources',
          method: 'OPTIONS',
          headers: {
            origin: 'https://hostile.example.test',
            'sec-fetch-site': 'cross-site',
          },
        })
      ).status,
    ).toBe(403);

    await stopChild(child);
  }, 15_000);
});
