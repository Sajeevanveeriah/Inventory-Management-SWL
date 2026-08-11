import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveHealth, LiveSearchOutcome } from "../core/liveSearch";
import { DEFAULT_SETTINGS } from "../core/settings";
import type { MappingProfile } from "../core/mapping";
import type { BrowserConfigurationSnapshot } from "../storage/db";
import * as legacyBrowserDb from "../storage/db";
import { sha256Hex } from "../io/hash";
import type { GeneratedOutput } from "../io/exportWorkbooks";
import { createDesktopPlatformService, type InvokeFunction } from "./desktop";
import { createPlatformService, detectPlatformKind } from "./index";
import { canonicalConfigurationPayload, type AliasRecord } from "./contracts";
import { createWebPlatformService, type WebConfigurationStorage } from "./web";

const OPERATIONAL_OUTPUT_FILENAMES = [
  "20260809-Test-Workbook.xlsx",
  "20260809-Change-Report.xlsx",
  "20260809-Exceptions.xlsx",
  "20260809-Rollback.xlsx",
  "20260809-Audit-Summary.txt",
] as const;

const SYNTHETIC_LIVE_HEALTH = {
  ok: true,
  provider: "serpapi-google-shopping-au",
  liveSearchConfigured: true,
  fixtureMode: false,
  paidCallsEnabled: true,
  costCeilingAud: "10.00",
  costCeilingCents: 1_000,
  costPerCallCents: 5,
  spentCents: 0,
  schemaVersion: 1,
} satisfies LiveHealth;

function syntheticEmptyLiveSearch(query: string): LiveSearchOutcome {
  return {
    state: "empty",
    query,
    queryKind: "identifier",
    provider: "serpapi-google-shopping-au",
    candidates: [],
    results: [],
    band: null,
    retrievedAt: "2026-08-11T00:00:00.000Z",
    cached: false,
    detail: "Synthetic strict-schema API response.",
    coverage: {
      providerQueried: "serpapi-google-shopping-au",
      sourcesWithPrice: 0,
      sourceDomains: [],
      pricedResults: 0,
      providerCandidates: 0,
      parsedOffers: 0,
      comparableOffers: 0,
      excludedOffers: 0,
    },
  };
}

function syntheticOperationalOutputs(firstSize = 1): GeneratedOutput[] {
  return OPERATIONAL_OUTPUT_FILENAMES.map((filename, index) => ({
    filename,
    kind: index === 4 ? "audit" : "import",
    label: "Synthetic output",
    blob: new Blob([new Uint8Array(index === 0 ? firstSize : 1)]),
    sanitizedCells: 0,
  }));
}

function memoryStorage(initial: BrowserConfigurationSnapshot): {
  storage: WebConfigurationStorage;
  snapshot: () => BrowserConfigurationSnapshot;
} {
  let value = structuredClone(initial);
  const storage: WebConfigurationStorage = {
    async loadSettings() {
      return structuredClone(value.settings);
    },
    async saveSettings(settings) {
      value.settings = structuredClone(settings);
    },
    async listProfiles() {
      return structuredClone(value.profiles);
    },
    async saveProfile(profile) {
      value.profiles = [
        ...value.profiles.filter((item) => item.id !== profile.id),
        structuredClone(profile),
      ];
    },
    async deleteProfile(id) {
      value.profiles = value.profiles.filter((item) => item.id !== id);
    },
    async listAliases() {
      return structuredClone(value.aliases);
    },
    async saveAlias(alias) {
      value.aliases = [
        ...value.aliases.filter(
          (item) => item.supplierCode !== alias.supplierCode,
        ),
        structuredClone(alias),
      ];
    },
    async deleteAlias(supplierCode) {
      value.aliases = value.aliases.filter(
        (item) => item.supplierCode !== supplierCode,
      );
    },
    async deleteAllStoredData() {
      value = {
        profiles: [],
        aliases: [],
        settings: structuredClone(DEFAULT_SETTINGS),
      };
    },
    async readConfigurationSnapshot() {
      return structuredClone(value);
    },
    async replaceConfigurationSnapshot(snapshot) {
      value = structuredClone(snapshot);
    },
    async deleteConfigurationSnapshotIfUnchanged(expected) {
      if (JSON.stringify(value) !== JSON.stringify(expected)) return false;
      value = {
        profiles: [],
        aliases: [],
        settings: structuredClone(DEFAULT_SETTINGS),
      };
      return true;
    },
  };
  return { storage, snapshot: () => structuredClone(value) };
}

describe("platform selection", () => {
  it("selects desktop only for the Tauri runtime and fails closed when IPC is unavailable", async () => {
    expect(detectPlatformKind({ protocol: "tauri:", hostname: "" })).toBe(
      "desktop",
    );
    expect(
      detectPlatformKind({ protocol: "https:", hostname: "example.test" }),
    ).toBe("web");

    const service = createPlatformService({
      location: { protocol: "tauri:", hostname: "tauri.localhost" },
      invoke: async () =>
        Promise.reject(new Error("C:\\Users\\operator\\secret.db")),
    });
    expect(service.kind).toBe("desktop");
    const health = await service.health();
    expect(health.ok).toBe(false);
    if (!health.ok) {
      expect(health.error.code).toBe("unavailable");
      expect(health.error.message).not.toContain("operator");
      expect(health.error.message).not.toContain("secret.db");
    }
  });

  it("uses a no-network session store for the static Pages demonstration", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("Static Pages must not call the Node adapter.");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const service = createPlatformService({
      location: { protocol: "https:", hostname: "example.github.io" },
      staticDemo: true,
    });
    const item = {
      id: "static-000123",
      itemNumber: "000123",
      description: "Synthetic static demonstration lock",
      costCents: 10_000,
      sellPriceCents: 13_000,
      gstBasis: "unknown" as const,
      updatedAt: "2026-08-09T00:00:00.000Z",
    };

    expect(service.capabilities.liveSearch).toBe(false);
    expect(
      await service.catalogue.publishApproved([
        {
          item,
          approvedBy: "Demonstration operator",
          reason: "Explicit synthetic approval",
        },
      ]),
    ).toMatchObject({ ok: true, value: [{ item }] });
    expect(await service.catalogue.list()).toMatchObject({
      ok: true,
      value: [item],
    });
    expect(await service.approvals.list(item.id)).toMatchObject({
      ok: true,
      value: [expect.objectContaining({ itemId: item.id })],
    });
    expect(await service.priceHistory.list(item.id)).toMatchObject({
      ok: true,
      value: [
        expect.objectContaining({
          itemId: item.id,
          costCents: 10_000,
          sellPriceCents: 13_000,
        }),
      ],
    });
    expect(await service.search.query("LW4570")).toMatchObject({
      state: "not_configured",
      provider: "manual-only",
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    const refreshed = createPlatformService({
      location: { protocol: "https:", hostname: "example.github.io" },
      staticDemo: true,
    });
    expect(await refreshed.catalogue.list()).toEqual({ ok: true, value: [] });
  });
});

describe("web live-search adapter boundary", () => {
  it("keeps the static Pages API token in memory and confines search requests to the exact API origin", async () => {
    const apiOrigin = "https://search-api.example.test";
    const accessToken = "t".repeat(43);
    const candidateToken = "synthetic-stage-two-token";
    const requests: Array<{
      url: string;
      method: string;
      headers: Headers;
      body: string | null;
    }> = [];
    const localStorageAccess = vi.spyOn(window, "localStorage", "get");
    const sessionStorageAccess = vi.spyOn(window, "sessionStorage", "get");
    const storageGet = vi.spyOn(Storage.prototype, "getItem");
    const storageSet = vi.spyOn(Storage.prototype, "setItem");
    const storageRemove = vi.spyOn(Storage.prototype, "removeItem");
    const storageClear = vi.spyOn(Storage.prototype, "clear");
    const indexedDbOpen = vi.fn();
    const indexedDbDelete = vi.fn();
    vi.stubGlobal("indexedDB", {
      open: indexedDbOpen,
      deleteDatabase: indexedDbDelete,
    });
    const fetchSpy = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        const headers = new Headers(init?.headers);
        requests.push({
          url,
          method: init?.method ?? "GET",
          headers,
          body: typeof init?.body === "string" ? init.body : null,
        });
        const authorised =
          headers.get("authorization") === `Bearer ${accessToken}`;
        if (url === `${apiOrigin}/api/health`) {
          return authorised
            ? new Response(JSON.stringify(SYNTHETIC_LIVE_HEALTH), {
                status: 200,
                headers: { "content-type": "application/json" },
              })
            : new Response("{}", {
                status: 401,
                headers: { "content-type": "application/json" },
              });
        }
        if (url === `${apiOrigin}/api/competitor-search`) {
          return new Response(
            JSON.stringify(syntheticEmptyLiveSearch("LW4570")),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        throw new Error(`Unexpected synthetic request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchSpy);

    const service = createWebPlatformService(undefined, {
      sessionOnly: true,
      liveSearchApiOrigin: apiOrigin,
    });
    expect(service.capabilities).toMatchObject({
      liveSearch: true,
      sessionAccessToken: true,
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    expect(await service.health()).toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
    expect(await service.search.status()).toMatchObject({
      ok: true,
      value: { state: "not_configured", credentialConfigured: false },
    });
    expect(requests.map((request) => request.url)).toEqual([
      `${apiOrigin}/api/health`,
    ]);
    expect(
      requests.every(
        (request) => request.headers.get("authorization") === null,
      ),
    ).toBe(true);

    expect(await service.search.query("LW4570")).toMatchObject({
      state: "not_configured",
      candidates: [],
      results: [],
    });
    expect(requests).toHaveLength(1);

    expect(await service.search.configureCredential(accessToken)).toMatchObject(
      {
        ok: true,
        value: { state: "configured", credentialConfigured: true },
      },
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]?.headers.get("authorization")).toBe(
      `Bearer ${accessToken}`,
    );

    expect(await service.search.query("LW4570", candidateToken)).toMatchObject({
      state: "empty",
      query: "LW4570",
    });
    const searchRequest = requests[2];
    expect(searchRequest).toBeDefined();
    expect(searchRequest?.url).toBe(`${apiOrigin}/api/competitor-search`);
    expect(searchRequest?.method).toBe("POST");
    expect(searchRequest?.headers.get("authorization")).toBe(
      `Bearer ${accessToken}`,
    );
    expect(searchRequest?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(searchRequest?.body ?? "null")).toEqual({
      query: "LW4570",
      candidateToken,
    });

    for (const request of requests) {
      const parsed = new URL(request.url);
      expect(parsed.origin).toBe(apiOrigin);
      expect(parsed.search).toBe("");
      expect(parsed.hash).toBe("");
      expect(request.url).not.toContain("LW4570");
      expect(request.url).not.toContain(candidateToken);
      expect(request.url).not.toContain(accessToken);
      expect(request.body ?? "").not.toContain(accessToken);
      expect(
        [...request.headers.entries()]
          .filter(([name]) => name !== "authorization")
          .flat()
          .join(" "),
      ).not.toContain(accessToken);
    }

    expect(await service.search.removeCredential()).toMatchObject({
      ok: true,
      value: { state: "not_configured", credentialConfigured: false },
    });
    expect(requests).toHaveLength(3);
    expect(await service.health()).toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
    expect(requests[3]?.headers.get("authorization")).toBeNull();

    expect(localStorageAccess).not.toHaveBeenCalled();
    expect(sessionStorageAccess).not.toHaveBeenCalled();
    expect(storageGet).not.toHaveBeenCalled();
    expect(storageSet).not.toHaveBeenCalled();
    expect(storageRemove).not.toHaveBeenCalled();
    expect(storageClear).not.toHaveBeenCalled();
    expect(indexedDbOpen).not.toHaveBeenCalled();
    expect(indexedDbDelete).not.toHaveBeenCalled();
  });

  it("maps an expired product selection distinctly and does not call it an in-progress search", async () => {
    const apiOrigin = "https://search-api.example.test";
    const accessToken = "t".repeat(43);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === `${apiOrigin}/api/health`) {
          return new Response(JSON.stringify(SYNTHETIC_LIVE_HEALTH), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            error: "The product selection expired or changed.",
            code: "selection_expired",
          }),
          {
            status: 410,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );

    const service = createWebPlatformService(undefined, {
      sessionOnly: true,
      liveSearchApiOrigin: apiOrigin,
    });
    expect(await service.search.configureCredential(accessToken)).toMatchObject(
      {
        ok: true,
      },
    );
    expect(
      await service.search.query("LW4570", "expired-candidate-token"),
    ).toMatchObject({
      state: "selection_expired",
      detail: "The product selection expired or changed.",
    });
  });

  it("fails closed for constructible API URLs that are not an exact HTTPS origin", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const invalidOrigins = [
      "http://search-api.example.test",
      "https://user:password@search-api.example.test",
      "https://search-api.example.test/api",
      "https://search-api.example.test?redirect=https://evil.example.test",
      "https://search-api.example.test#fragment",
      "https://search-api.example.test@evil.example.test",
    ];

    for (const liveSearchApiOrigin of invalidOrigins) {
      expect(() => new URL(liveSearchApiOrigin)).not.toThrow();
      const service = createWebPlatformService(undefined, {
        sessionOnly: true,
        liveSearchApiOrigin,
      });
      expect(service.capabilities).toMatchObject({
        liveSearch: false,
        sessionAccessToken: false,
      });
      expect(await service.health()).toMatchObject({
        ok: true,
        value: { provider: "manual-only", liveSearchConfigured: false },
      });
      expect(await service.search.status()).toMatchObject({
        ok: true,
        value: { state: "not_configured" },
      });
      expect(await service.search.query("LW4570")).toMatchObject({
        state: "not_configured",
        candidates: [],
        results: [],
      });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("desktop adapter command mapping", () => {
  it("preserves the native selection-expired state", async () => {
    const service = createDesktopPlatformService(<T>(command: string) => {
      expect(command).toBe("search_competitors");
      return Promise.resolve({
        state: "selection_expired",
        query: "LW4570",
        queryKind: "identifier",
        provider: "serpapi-google-shopping-au",
        candidates: [],
        results: [],
        band: null,
        detail: "The selected product candidate expired.",
      } as T);
    });

    expect(
      await service.search.query("LW4570", "expired-candidate-token"),
    ).toMatchObject({
      state: "selection_expired",
      detail: "The selected product candidate expired.",
    });
  });

  it("uses narrowly named IPC commands and validates their DTOs", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> =
      [];
    const invoke: InvokeFunction = async <T>(
      command: string,
      args?: Record<string, unknown>,
    ) => {
      calls.push(args ? { command, args } : { command });
      const responses: Record<string, unknown> = {
        desktop_health: {
          ok: true,
          provider: "fixture",
          liveSearchConfigured: false,
          fixtureMode: true,
          schemaVersion: 1,
        },
        list_catalogue_items: [],
        publish_approved_changes: [
          {
            item: {
              id: "000123",
              itemNumber: "000123",
              description: "Synthetic lock",
              costCents: 10_000,
              sellPriceCents: 13_000,
              gstBasis: "unknown",
              updatedAt: "2026-08-09T00:00:00.000Z",
            },
            approval: {
              id: "approval-1",
              itemId: "000123",
              approvedBy: "Local operator",
              proposedSellCents: 13_000,
              reason: "Explicit operator approval",
              approvedAt: "2026-08-09T00:00:00.000Z",
            },
            priceHistory: {
              id: "history-1",
              itemId: "000123",
              cost: "100.00",
              sellPrice: "130.00",
              costCents: 10_000,
              sellPriceCents: 13_000,
              approvalId: "approval-1",
              recordedAt: "2026-08-09T00:00:00.000Z",
            },
          },
        ],
        list_mapping_profiles: [],
        list_aliases: [],
        list_sources: [],
        load_settings: DEFAULT_SETTINGS,
        provider_status: {
          provider: "fixture",
          state: "fixture",
          paidCallsEnabled: false,
          costCeilingAud: "0.00",
          costCeilingCents: 0,
          costPerCallCents: 0,
          spentCents: 0,
          credentialConfigured: false,
          credentialHint: null,
          lastValidatedAt: null,
        },
        search_competitors: {
          state: "empty",
          query: "LW4570",
          queryKind: "identifier",
          provider: "fixture",
          candidates: [],
          results: [],
          band: null,
        },
        set_provider_paid_calls: {
          provider: "fixture",
          state: "fixture",
          paidCallsEnabled: true,
          costCeilingAud: "10.00",
          costCeilingCents: 1_000,
          costPerCallCents: 5,
          spentCents: 0,
          credentialConfigured: true,
          credentialHint: "stored in Windows",
          lastValidatedAt: "2026-08-09T00:00:00.000Z",
        },
      };
      return responses[command] as T;
    };
    const service = createDesktopPlatformService(invoke);
    await service.health();
    await service.catalogue.list();
    await service.catalogue.publishApproved([
      {
        item: {
          id: "000123",
          itemNumber: "000123",
          description: "Synthetic lock",
          costCents: 10_000,
          sellPriceCents: 13_000,
          gstBasis: "unknown",
          updatedAt: "2026-08-09T00:00:00.000Z",
        },
        approvedBy: "Local operator",
        reason: "Explicit operator approval",
      },
    ]);
    await service.profiles.list();
    await service.aliases.list();
    const sources = await service.sources.list();
    await service.settings.load();
    await service.search.status();
    const paidCalls = await service.search.setPaidCallsEnabled(true, 1_000, 5);
    await service.search.query("LW4570");
    await service.search.query("LW4570", "synthetic-stage-two-token");
    expect(paidCalls).toMatchObject({
      ok: true,
      value: { paidCallsEnabled: true },
    });
    expect(sources).toMatchObject({
      ok: true,
      value: expect.arrayContaining([
        expect.objectContaining({
          id: "manual",
          accessMethod: "manual-entry",
          enabled: true,
        }),
      ]),
    });
    expect(calls.map((call) => call.command)).toEqual([
      "desktop_health",
      "list_catalogue_items",
      "publish_approved_changes",
      "list_mapping_profiles",
      "list_aliases",
      "list_sources",
      "load_settings",
      "provider_status",
      "set_provider_paid_calls",
      "search_competitors",
      "search_competitors",
    ]);
    expect(calls.slice(-2).map((call) => call.args)).toEqual([
      { query: "LW4570", candidateToken: null },
      { query: "LW4570", candidateToken: "synthetic-stage-two-token" },
    ]);
    expect(
      calls.find((call) => call.command === "set_provider_paid_calls")?.args,
    ).toEqual({
      enabled: true,
      costCeilingCents: 1_000,
      costPerCallCents: 5,
    });
    expect(calls.some((call) => call.command === "append_approval")).toBe(
      false,
    );
    expect(calls.some((call) => call.command === "append_price_history")).toBe(
      false,
    );
  });

  it("fails an approval batch through one atomic IPC command without sequential fallbacks", async () => {
    const calls: string[] = [];
    const service = createDesktopPlatformService(<T>(command: string) => {
      calls.push(command);
      return Promise.reject<T>(new Error("Synthetic transactional rejection"));
    });
    const result = await service.catalogue.publishApproved([
      {
        item: {
          id: "000123",
          itemNumber: "000123",
          description: "Synthetic lock",
          costCents: 10_000,
          sellPriceCents: 13_000,
          gstBasis: "unknown",
          updatedAt: "2026-08-09T00:00:00.000Z",
        },
        approvedBy: "Local operator",
        reason: "Explicit operator approval",
      },
    ]);
    expect(result).toMatchObject({ ok: false });
    expect(calls).toEqual(["publish_approved_changes"]);
    expect(calls).not.toContain("upsert_catalogue_items");
    expect(calls).not.toContain("append_approval");
    expect(calls).not.toContain("append_price_history");
  });

  it("rejects invalid search and credential arguments before IPC", async () => {
    const calls: string[] = [];
    const service = createDesktopPlatformService(async <T>(command: string) => {
      calls.push(command);
      return undefined as T;
    });
    expect((await service.search.query(` ${"x".repeat(512)}`)).state).toBe(
      "invalid_query",
    );
    expect(await service.search.configureCredential(" short ")).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(
      await service.search.setPaidCallsEnabled(true, 100, 101),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(calls).toEqual([]);
  });

  it("rejects untyped competitor evidence before IPC without persisting it", async () => {
    const calls: string[] = [];
    const service = createDesktopPlatformService(async <T>(command: string) => {
      calls.push(command);
      return undefined as T;
    });
    const unsafeObservation = {
      title: "Synthetic lock",
      priceCents: 9_500,
      priceAud: "95.00",
      currency: "AUD",
      gstBasis: "inc-gst",
      packSize: null,
      seller: "Fictionville Security Supplies",
      sourceDomain: "fictionville-security.example.com.au",
      url: "https://fictionville-security.example.com.au/product/lw4570",
      retrievedAt: "2026-08-09T00:00:00.000Z",
      supplierCostCents: 10_000,
      apiKey: "not-a-real-placeholder",
    };

    expect(
      await service.references.attach("LW4570", unsafeObservation as never),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(calls).toEqual([]);
  });

  it("saves desktop configuration through a native grant and validates the filename before IPC", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> =
      [];
    const filename = "20260809-SWL-Configuration.json";
    const service = createDesktopPlatformService(
      async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push(args ? { command, args } : { command });
        if (command === "choose_output_destination") {
          return {
            grantId: "configuration-grant",
            displayName: "Selected folder",
          } as T;
        }
        if (command === "export_configuration_to_folder") return filename as T;
        return undefined as T;
      },
    );

    expect(
      await service.configuration.exportToSelectedFolder("configuration.json"),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(calls).toEqual([]);
    expect(
      await service.configuration.exportToSelectedFolder(filename),
    ).toEqual({
      ok: true,
      value: filename,
    });
    expect(calls).toEqual([
      { command: "choose_output_destination" },
      {
        command: "export_configuration_to_folder",
        args: { grantId: "configuration-grant", filename },
      },
    ]);
  });

  it("streams a workbook in bounded 256 KiB chunks with length and SHA metadata", async () => {
    const appended: Array<{ offset: number; bytes: number }> = [];
    const calls: string[] = [];
    const filenames = [...OPERATIONAL_OUTPUT_FILENAMES];
    const invoke: InvokeFunction = async <T>(
      command: string,
      args?: Record<string, unknown>,
    ) => {
      calls.push(command);
      if (command === "reserve_export_batch") {
        expect(args?.files).toHaveLength(5);
        return { batchId: "c9bd9ec1-9084-44ea-9bd6-d0f836c8a778" } as T;
      }
      if (command === "begin_export_file") {
        expect(args?.batchId).toBe("c9bd9ec1-9084-44ea-9bd6-d0f836c8a778");
        expect(args?.sha256).toMatch(/^[a-f0-9]{64}$/);
        return {
          sessionId: `session-${String(args?.filename)}`,
          conflict: false,
        } as T;
      }
      if (command === "append_export_chunk") {
        const base64 = String(args?.base64Data ?? "");
        const offset = Number(args?.offset);
        const bytes = atob(base64).length;
        appended.push({ offset, bytes });
        return (offset + bytes) as T;
      }
      if (command === "commit_export_file") return "prepared-output" as T;
      if (command === "commit_export_batch") return filenames as T;
      return null as T;
    };
    const service = createDesktopPlatformService(invoke);
    const result = await service.files.saveOutputs(
      { grantId: "grant-1", displayName: "Selected output folder" },
      syntheticOperationalOutputs(600 * 1024),
    );
    expect(result).toEqual({
      ok: true,
      value: { written: filenames, failed: [] },
    });
    expect(appended.slice(0, 3)).toEqual([
      { offset: 0, bytes: 256 * 1024 },
      { offset: 256 * 1024, bytes: 256 * 1024 },
      { offset: 512 * 1024, bytes: 88 * 1024 },
    ]);
    expect(appended).toHaveLength(7);
    expect(
      Math.max(...appended.map((chunk) => chunk.bytes)),
    ).toBeLessThanOrEqual(256 * 1024);
    expect(calls).toContain("reserve_export_batch");
    expect(calls).toContain("commit_export_batch");
    expect(calls).not.toContain("abort_export_batch");
    expect(calls).not.toContain("write_export_file");
  });

  it("fails the complete export before streaming when the batch reservation finds a conflict", async () => {
    const calls: string[] = [];
    const invoke: InvokeFunction = async <T>(
      command: string,
      args?: Record<string, unknown>,
    ) => {
      calls.push(command);
      if (command === "reserve_export_batch") {
        const files = args?.files as Array<{ filename: string }>;
        expect(files[1]?.filename).toBe("20260809-Change-Report.xlsx");
        throw Object.assign(new Error("The second output already exists."), {
          code: "conflict",
          retryable: false,
        });
      }
      return undefined as T;
    };

    const result = await createDesktopPlatformService(invoke).files.saveOutputs(
      { grantId: "grant-1", displayName: "Selected output folder" },
      syntheticOperationalOutputs(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.written).toEqual([]);
      expect(result.value.failed).toHaveLength(5);
      expect(
        result.value.failed.every((failure) => failure.code === "conflict"),
      ).toBe(true);
    }
    expect(calls).toEqual(["reserve_export_batch"]);
  });

  it("aborts the complete batch and reports no writes when the final batch commit fails", async () => {
    const calls: string[] = [];
    const batchId = "c9bd9ec1-9084-44ea-9bd6-d0f836c8a778";
    const invoke: InvokeFunction = async <T>(
      command: string,
      args?: Record<string, unknown>,
    ) => {
      calls.push(command);
      if (command === "reserve_export_batch") return { batchId } as T;
      if (command === "begin_export_file") {
        return {
          sessionId: `session-${String(args?.filename)}`,
          conflict: false,
        } as T;
      }
      if (command === "append_export_chunk") {
        return (Number(args?.offset) +
          atob(String(args?.base64Data)).length) as T;
      }
      if (command === "commit_export_file") return "prepared-output" as T;
      if (command === "commit_export_batch") {
        throw Object.assign(new Error("The export batch failed."), {
          code: "integrity_failed",
          retryable: false,
        });
      }
      if (command === "abort_export_batch") {
        expect(args).toEqual({ batchId });
        return undefined as T;
      }
      return undefined as T;
    };

    const result = await createDesktopPlatformService(invoke).files.saveOutputs(
      { grantId: "grant-1", displayName: "Selected output folder" },
      syntheticOperationalOutputs(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.written).toEqual([]);
      expect(result.value.failed).toHaveLength(5);
      expect(
        result.value.failed.every(
          (failure) => failure.code === "integrity_failed",
        ),
      ).toBe(true);
    }
    expect(
      calls.filter((command) => command === "abort_export_batch"),
    ).toHaveLength(1);
    expect(
      calls.filter((command) => command === "begin_export_file"),
    ).toHaveLength(5);
    expect(
      calls.filter((command) => command === "commit_export_file"),
    ).toHaveLength(5);
  });

  it("reads a native input grant in bounded chunks and always releases it", async () => {
    const length = 300 * 1024;
    const reads: Array<{ offset: number; length: number }> = [];
    const calls: string[] = [];
    const invoke: InvokeFunction = async <T>(
      command: string,
      args?: Record<string, unknown>,
    ) => {
      calls.push(command);
      if (command === "choose_input_file") {
        expect(args).toEqual({ role: "supplier" });
        return {
          grantId: "input-grant-1",
          displayName: "synthetic-supplier.csv",
          length,
          extension: "csv",
        } as T;
      }
      if (command === "read_input_chunk") {
        const offset = Number(args?.offset);
        const requested = Number(args?.length);
        reads.push({ offset, length: requested });
        return btoa("x".repeat(requested)) as T;
      }
      return undefined as T;
    };
    const result =
      await createDesktopPlatformService(invoke).files.chooseInputFile(
        "supplier",
      );
    expect(result.ok).toBe(true);
    if (!result.ok || result.value === null) return;
    expect(result.value.name).toBe("synthetic-supplier.csv");
    expect(result.value.size).toBe(length);
    expect(reads).toEqual([
      { offset: 0, length: 256 * 1024 },
      { offset: 256 * 1024, length: 44 * 1024 },
    ]);
    expect(Math.max(...reads.map((read) => read.length))).toBeLessThanOrEqual(
      256 * 1024,
    );
    expect(calls.at(-1)).toBe("release_input_grant");
  });

  it("releases a native input grant after a failed chunk read", async () => {
    const calls: string[] = [];
    const service = createDesktopPlatformService(async <T>(command: string) => {
      calls.push(command);
      if (command === "choose_input_file") {
        return {
          grantId: "input-grant-2",
          displayName: "synthetic-supplier.csv",
          length: 10,
          extension: "csv",
        } as T;
      }
      if (command === "read_input_chunk")
        throw new Error("Synthetic read failure");
      return undefined as T;
    });
    const result = await service.files.chooseInputFile("supplier");
    expect(result).toMatchObject({ ok: false });
    expect(calls).toEqual([
      "choose_input_file",
      "read_input_chunk",
      "release_input_grant",
    ]);
  });

  it("binds migration status to the exact inspected legacy envelope", async () => {
    const baseSnapshot: BrowserConfigurationSnapshot = {
      profiles: [],
      aliases: [],
      settings: DEFAULT_SETTINGS,
    };
    const inspect = vi
      .spyOn(legacyBrowserDb, "inspectConfigurationForMigration")
      .mockResolvedValueOnce({
        legacyConfigurationFound: true,
        valid: true,
        counts: { profiles: 0, aliases: 0, settings: 1 },
        invalidCounts: { profiles: 0, aliases: 0, settings: 0 },
        validationMessages: [],
        snapshot: baseSnapshot,
      })
      .mockResolvedValueOnce({
        legacyConfigurationFound: true,
        valid: true,
        counts: { profiles: 0, aliases: 0, settings: 1 },
        invalidCounts: { profiles: 0, aliases: 0, settings: 0 },
        validationMessages: [],
        snapshot: {
          ...baseSnapshot,
          settings: { ...DEFAULT_SETTINGS, theme: "dark" },
        },
      });
    const envelopes: Array<Record<string, unknown>> = [];
    const service = createDesktopPlatformService(
      async <T>(command: string, args?: Record<string, unknown>) => {
        expect(command).toBe("configuration_migration_status");
        expect(args).toHaveProperty("legacySerialised");
        const serialised = args?.legacySerialised;
        expect(typeof serialised).toBe("string");
        envelopes.push(
          JSON.parse(String(serialised)) as Record<string, unknown>,
        );
        return {
          legacyConfigurationFound: false,
          alreadyImported: envelopes.length === 1,
          counts: { profiles: 0, aliases: 0, settings: 1 },
          valid: true,
          invalidCounts: { profiles: 0, aliases: 0, settings: 0 },
          validationMessages: [],
        } as T;
      },
    );

    const importedA = await service.configuration.migrationStatus();
    const distinctB = await service.configuration.migrationStatus();

    expect(inspect).toHaveBeenCalledTimes(2);
    expect(importedA).toMatchObject({
      ok: true,
      value: { legacyConfigurationFound: true, alreadyImported: true },
    });
    expect(distinctB).toMatchObject({
      ok: true,
      value: { legacyConfigurationFound: true, alreadyImported: false },
    });
    expect(envelopes[0]).not.toEqual(envelopes[1]);
  });

  it("accepts conflict-free and idempotent native configuration previews", async () => {
    let previewCount = 0;
    const service = createDesktopPlatformService(async <T>(command: string) => {
      expect(command).toBe("preview_configuration_import");
      previewCount += 1;
      return {
        previewToken: `preview-${previewCount}`,
        schemaVersion: 1,
        counts: { profiles: 0, aliases: 0, settings: 1 },
        conflicts: { profiles: 0, aliases: 0, settings: 0 },
        valid: true,
        validationMessages:
          previewCount === 1
            ? []
            : ["This configuration was already imported."],
      } as T;
    });

    const fresh = await service.configuration.previewImport("{}");
    const idempotent = await service.configuration.previewImport("{}");

    expect(fresh).toMatchObject({
      ok: true,
      value: { conflicts: { profiles: 0, aliases: 0, settings: 0 } },
    });
    expect(idempotent).toMatchObject({
      ok: true,
      value: {
        valid: true,
        conflicts: { profiles: 0, aliases: 0, settings: 0 },
      },
    });
  });
});

describe("web configuration transfer", () => {
  const profile: MappingProfile = {
    id: "profile-demo",
    name: "Synthetic supplier",
    version: 1,
    supplierMapping: { supplierCode: 0, supplierCost: 1 },
    supplierHeaders: ["SKU", "Cost"],
    servicem8Mapping: { itemNumber: 0 },
    servicem8Headers: ["Item Number"],
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
  };
  const alias: AliasRecord = {
    supplierCode: "SYN-001",
    itemNumber: "000123",
    approvedAt: "2026-08-09T00:00:00.000Z",
  };

  it("uses the cross-runtime canonical checksum regardless of object insertion order", async () => {
    const withoutHash = {
      schemaVersion: 1 as const,
      application: "swl-pricing-inventory-control" as const,
      exportedAt: "2026-08-09T00:00:00.000Z",
      counts: { profiles: 1, aliases: 1, settings: 1 },
      data: {
        profiles: [
          {
            ...profile,
            supplierMapping: { supplierCost: 1, supplierCode: 0 },
          },
        ],
        aliases: [alias],
        settings: {
          markupPercent: "30",
          taxHandling: "prices-inc-gst" as const,
          theme: "dark" as const,
        },
      },
    };
    const payload = canonicalConfigurationPayload(withoutHash);
    const digest = await sha256Hex(new TextEncoder().encode(payload).buffer);

    expect(digest).toBe(
      "ce4e8f4d1ac8f70c3056420ddbb5a6c8faea8ea8a17993a9e5e97ac7ec7ce7a4",
    );
    expect(payload.indexOf('"supplierCode":0')).toBeLessThan(
      payload.indexOf('"supplierCost":1'),
    );
  });

  it("imports non-default settings and treats an exact repeated import idempotently", async () => {
    const nonDefaultSettings = { ...DEFAULT_SETTINGS, theme: "dark" as const };
    const memory = memoryStorage({
      profiles: [profile],
      aliases: [alias],
      settings: nonDefaultSettings,
    });
    const service = createWebPlatformService(memory.storage);
    const exported = await service.configuration.export();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const serialised = JSON.stringify(exported.value, null, 2);

    await memory.storage.deleteAllStoredData();
    const firstPreview = await service.configuration.previewImport(serialised);
    expect(firstPreview.ok).toBe(true);
    if (!firstPreview.ok) return;
    expect(firstPreview.value.counts).toEqual({
      profiles: 1,
      aliases: 1,
      settings: 1,
    });
    expect(memory.snapshot().profiles).toHaveLength(0);
    expect(
      (await service.configuration.applyImport(firstPreview.value.previewToken))
        .ok,
    ).toBe(true);
    expect(memory.snapshot()).toEqual(exported.value.data);

    const secondPreview = await service.configuration.previewImport(serialised);
    expect(secondPreview.ok).toBe(true);
    if (!secondPreview.ok) return;
    expect(secondPreview.value.conflicts).toEqual({
      profiles: 0,
      aliases: 0,
      settings: 0,
    });
    expect(secondPreview.value.valid).toBe(true);
    expect(secondPreview.value.validationMessages).toHaveLength(0);
    expect(
      (
        await service.configuration.applyImport(
          secondPreview.value.previewToken,
        )
      ).ok,
    ).toBe(true);
    expect(memory.snapshot()).toEqual(exported.value.data);
  });

  it("adds disjoint imported records without deleting existing browser configuration", async () => {
    const incomingStore = memoryStorage({
      profiles: [profile],
      aliases: [alias],
      settings: { ...DEFAULT_SETTINGS, theme: "dark" },
    });
    const incoming = await createWebPlatformService(
      incomingStore.storage,
    ).configuration.export();
    expect(incoming.ok).toBe(true);
    if (!incoming.ok) return;
    const existingProfile = {
      ...profile,
      id: "profile-existing",
      name: "Existing synthetic profile",
    };
    const existingAlias = {
      ...alias,
      supplierCode: "SYN-EXISTING",
      itemNumber: "000999",
    };
    const target = memoryStorage({
      profiles: [existingProfile],
      aliases: [existingAlias],
      settings: DEFAULT_SETTINGS,
    });
    const service = createWebPlatformService(target.storage);
    const preview = await service.configuration.previewImport(
      JSON.stringify(incoming.value),
    );
    expect(preview).toMatchObject({
      ok: true,
      value: {
        valid: true,
        conflicts: { profiles: 0, aliases: 0, settings: 0 },
      },
    });
    if (!preview.ok) return;
    expect(
      (await service.configuration.applyImport(preview.value.previewToken)).ok,
    ).toBe(true);
    expect(target.snapshot()).toEqual({
      profiles: [existingProfile, profile],
      aliases: [existingAlias, alias],
      settings: incoming.value.data.settings,
    });
  });

  it("rejects a stale web reset preview without erasing same-count or added data", async () => {
    const memory = memoryStorage({
      profiles: [profile],
      aliases: [alias],
      settings: DEFAULT_SETTINGS,
    });
    const service = createWebPlatformService(memory.storage);
    const preview = await service.recovery.previewReset();
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    await memory.storage.saveProfile({
      ...profile,
      name: "Changed after preview",
    });
    const before = memory.snapshot();
    expect(
      await service.recovery.reset(
        preview.value.resetToken,
        preview.value.confirmationPhrase,
      ),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(memory.snapshot()).toEqual(before);
  });

  it("detects all conflict classes and rechecks them before applying without mutation", async () => {
    const source = memoryStorage({
      profiles: [profile],
      aliases: [alias],
      settings: { ...DEFAULT_SETTINGS, theme: "dark" },
    });
    const exported = await createWebPlatformService(
      source.storage,
    ).configuration.export();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    const conflicting = memoryStorage({
      profiles: [{ ...profile, name: "Existing profile" }],
      aliases: [{ ...alias, itemNumber: "009999" }],
      settings: { ...DEFAULT_SETTINGS, taxHandling: "prices-ex-gst" },
    });
    const conflictingService = createWebPlatformService(conflicting.storage);
    const beforeConflict = conflicting.snapshot();
    const conflictPreview =
      await conflictingService.configuration.previewImport(
        JSON.stringify(exported.value),
      );
    expect(conflictPreview.ok).toBe(true);
    if (!conflictPreview.ok) return;
    expect(conflictPreview.value).toMatchObject({
      conflicts: { profiles: 1, aliases: 1, settings: 1 },
      valid: false,
    });
    expect(conflictPreview.value.validationMessages).toHaveLength(3);
    expect(
      await conflictingService.configuration.applyImport(
        conflictPreview.value.previewToken,
      ),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(conflicting.snapshot()).toEqual(beforeConflict);

    const changedAfterPreview = memoryStorage({
      profiles: [],
      aliases: [],
      settings: DEFAULT_SETTINGS,
    });
    const changedService = createWebPlatformService(
      changedAfterPreview.storage,
    );
    const cleanPreview = await changedService.configuration.previewImport(
      JSON.stringify(exported.value),
    );
    expect(cleanPreview).toMatchObject({ ok: true, value: { valid: true } });
    if (!cleanPreview.ok) return;
    await changedAfterPreview.storage.saveProfile({
      ...profile,
      name: "Added after preview",
    });
    const beforeApply = changedAfterPreview.snapshot();
    expect(
      await changedService.configuration.applyImport(
        cleanPreview.value.previewToken,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(changedAfterPreview.snapshot()).toEqual(beforeApply);
  });

  it("rejects unsupported versions and checksum changes without mutating live data", async () => {
    const memory = memoryStorage({
      profiles: [profile],
      aliases: [alias],
      settings: DEFAULT_SETTINGS,
    });
    const service = createWebPlatformService(memory.storage);
    const before = memory.snapshot();
    const unsupported = await service.configuration.previewImport(
      JSON.stringify({
        schemaVersion: 999,
        application: "swl-pricing-inventory-control",
      }),
    );
    expect(unsupported).toMatchObject({
      ok: false,
      error: { code: "unsupported_version" },
    });

    const exported = await service.configuration.export();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const corrupted = await service.configuration.previewImport(
      JSON.stringify({ ...exported.value, sha256: "0".repeat(64) }),
    );
    expect(corrupted).toMatchObject({
      ok: false,
      error: { code: "integrity_failed" },
    });
    expect(memory.snapshot()).toEqual(before);
  });

  it("rejects unknown envelope and nested fields without stripping or mutating them", async () => {
    const memory = memoryStorage({
      profiles: [profile],
      aliases: [alias],
      settings: DEFAULT_SETTINGS,
    });
    const service = createWebPlatformService(memory.storage);
    const exported = await service.configuration.export();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const before = memory.snapshot();
    const variants: unknown[] = [
      { ...exported.value, futureEnvelopeField: true },
      {
        ...exported.value,
        counts: { ...exported.value.counts, futureCount: 1 },
      },
      {
        ...exported.value,
        data: {
          ...exported.value.data,
          profiles: [{ ...profile, futureProfileField: true }],
        },
      },
      {
        ...exported.value,
        data: {
          ...exported.value.data,
          aliases: [{ ...alias, futureAliasField: true }],
        },
      },
      {
        ...exported.value,
        data: {
          ...exported.value.data,
          settings: { ...exported.value.data.settings, futureSetting: true },
        },
      },
    ];

    for (const variant of variants) {
      expect(
        await service.configuration.previewImport(JSON.stringify(variant)),
      ).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(memory.snapshot()).toEqual(before);
    }
  });
});

describe("web persisted-data integrity", () => {
  it("fails the complete catalogue when any returned record is malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              id: "valid",
              itemNumber: "000123",
              description: "Synthetic lock",
              costCents: 10_000,
              sellPriceCents: 13_000,
              gstBasis: "unknown",
              updatedAt: "2026-08-09T00:00:00.000Z",
            },
            {
              id: "invalid",
              description: "Missing exact identifier",
              costCents: 10_000,
              sellPriceCents: 13_000,
              updatedAt: "2026-08-09T00:00:00.000Z",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    expect(await createWebPlatformService().catalogue.list()).toMatchObject({
      ok: false,
      error: { code: "integrity_failed" },
    });
  });

  it("propagates a source-registry server failure instead of masking it with defaults", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("{}", {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    expect(await createWebPlatformService().sources.list()).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
