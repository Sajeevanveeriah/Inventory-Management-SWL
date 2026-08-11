import { z } from "zod";
import { APP_VERSION } from "../core/audit";
import { DEFAULT_SETTINGS, SettingsSchema } from "../core/settings";
import {
  centsToAud,
  type LiveHealth,
  type LiveSearchOutcome,
} from "../core/liveSearch";
import {
  defaultSources,
  withoutLegacySyntheticSources,
  type CompetitorSource,
} from "../core/sources";
import { sha256Hex } from "../io/hash";
import * as browserDb from "../storage/db";
import type {
  ApprovalRecord,
  BackupReason,
  BackupSummary,
  CatalogueItem,
  CompetitorReferenceRecord,
  ConfigurationEnvelope,
  ConfigurationPreview,
  PlatformErrorCode,
  PlatformResult,
  PlatformService,
  PriceHistoryVersion,
  ProviderStatus,
  ResetPreview,
  RestorePreview,
} from "./contracts";
import {
  canonicalConfigurationPayload,
  CONFIGURATION_SCHEMA_VERSION,
  platformFail,
  platformOk,
} from "./contracts";
import {
  AliasRecordSchema,
  ApprovalRecordSchema,
  CatalogueItemSchema,
  CompetitorObservationSchema,
  CompetitorReferenceRecordSchema,
  CompetitorSourceSchema,
  ConfigurationEnvelopeSchema,
  LiveHealthSchema,
  LiveSearchResultSchema,
  LiveSearchOutcomeSchema,
  MappingProfileSchema,
  PriceHistoryVersionSchema,
  PublishedChangeSchema,
} from "./schemas";

const MAX_CONFIGURATION_BYTES = 10 * 1024 * 1024;
const RESET_CONFIRMATION = "ERASE SWL LOCAL DATA";
// Longer than the API function's 20-second ceiling so a paid call cannot keep
// running after the browser has already encouraged the operator to retry.
const REQUEST_TIMEOUT_MS = 25_000;

const WebCatalogueItemSchema = z.object({
  id: z.string().min(1).max(128),
  sku: z.string().min(1).max(128).optional(),
  itemNumber: z.string().min(1).max(128).optional(),
  description: z.string().max(2000),
  costCents: z.number().int().min(0).max(1_000_000_000),
  sellPriceCents: z.number().int().min(0).max(1_000_000_000),
  gstBasis: z.enum(["inc-gst", "ex-gst", "unknown"]).optional(),
  updatedAt: z.string().min(1).max(64),
});

const WebSourceSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  accessMethod: z.enum(["live-api", "manual-entry", "file-import"]),
  automatedAccessNote: z.string().max(2000).optional(),
  note: z.string().max(2000).optional(),
  enabled: z.boolean(),
});

const SessionApprovedChangeSchema = z
  .object({
    item: CatalogueItemSchema,
    approvedBy: z.string().trim().min(1).max(128),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export interface WebPlatformOptions {
  /** Static Pages has no Node process; operational records are session-only. */
  sessionOnly?: boolean;
  /** Optional HTTPS origin for the protected live-search API used by Pages. */
  liveSearchApiOrigin?: string;
}

function canonicalApiOrigin(value: string | undefined): string | null {
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  return parsed.protocol === "https:" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.pathname === "/" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    parsed.origin === value
    ? parsed.origin
    : null;
}

function sanitisedFetchError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError")
    return "The request timed out.";
  return error instanceof TypeError
    ? "The application service is unavailable."
    : "The request could not be completed.";
}

async function requestJson<T>(
  url: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<PlatformResult<T>> {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...init?.headers,
      },
    });
    if (!response.ok) {
      let serviceMessage = "";
      let serviceCode = "";
      try {
        const errorBody: unknown = await response.json();
        if (
          errorBody &&
          typeof errorBody === "object" &&
          !Array.isArray(errorBody) &&
          "error" in errorBody &&
          typeof errorBody.error === "string" &&
          errorBody.error.length <= 256 &&
          ![...errorBody.error].some((character) => {
            const point = character.codePointAt(0);
            return point !== undefined && (point <= 31 || point === 127);
          })
        ) {
          serviceMessage = errorBody.error;
        }
        if (
          errorBody &&
          typeof errorBody === "object" &&
          !Array.isArray(errorBody) &&
          "code" in errorBody &&
          errorBody.code === "selection_expired"
        ) {
          serviceCode = errorBody.code;
        }
      } catch {
        // Status and a fixed local message remain sufficient if no safe error body exists.
      }
      const code: PlatformErrorCode =
        response.status === 410 && serviceCode === "selection_expired"
          ? "selection_expired"
          : response.status === 401 || response.status === 403
            ? "permission_denied"
            : response.status === 429 && /budget/iu.test(serviceMessage)
              ? "quota_exhausted"
              : [400, 413, 415, 422].includes(response.status)
                ? "invalid_input"
                : response.status === 409
                  ? "conflict"
                  : response.status === 429
                    ? "rate_limited"
                    : response.status === 503
                      ? "unavailable"
                      : "provider_error";
      return platformFail(
        code,
        serviceMessage ||
          `The application service rejected the request (${response.status}).`,
      );
    }
    const parsed = schema.safeParse(await response.json());
    return parsed.success
      ? platformOk(parsed.data)
      : platformFail(
          "integrity_failed",
          "The application service returned an invalid response.",
        );
  } catch (error) {
    return platformFail(
      error instanceof DOMException && error.name === "AbortError"
        ? "timeout"
        : "offline",
      sanitisedFetchError(error),
      true,
    );
  } finally {
    window.clearTimeout(timeout);
  }
}

export interface WebConfigurationStorage {
  loadSettings: typeof browserDb.loadSettings;
  saveSettings: typeof browserDb.saveSettings;
  listProfiles: typeof browserDb.listProfiles;
  saveProfile: typeof browserDb.saveProfile;
  deleteProfile: typeof browserDb.deleteProfile;
  listAliases: typeof browserDb.listAliases;
  saveAlias: typeof browserDb.saveAlias;
  deleteAlias: typeof browserDb.deleteAlias;
  deleteAllStoredData: typeof browserDb.deleteAllStoredData;
  readConfigurationSnapshot: typeof browserDb.readConfigurationSnapshot;
  replaceConfigurationSnapshot: typeof browserDb.replaceConfigurationSnapshot;
  deleteConfigurationSnapshotIfUnchanged: typeof browserDb.deleteConfigurationSnapshotIfUnchanged;
}

async function buildConfigurationEnvelope(
  storage: WebConfigurationStorage,
): Promise<ConfigurationEnvelope> {
  const data = await storage.readConfigurationSnapshot();
  const withoutHash = {
    schemaVersion: CONFIGURATION_SCHEMA_VERSION,
    application: "swl-pricing-inventory-control" as const,
    exportedAt: new Date().toISOString(),
    counts: {
      profiles: data.profiles.length,
      aliases: data.aliases.length,
      settings: 1 as const,
    },
    data,
  };
  const encoded = new TextEncoder().encode(
    canonicalConfigurationPayload(withoutHash),
  );
  return { ...withoutHash, sha256: await sha256Hex(encoded.buffer) };
}

async function validateEnvelope(
  serialised: string,
): Promise<PlatformResult<ConfigurationEnvelope>> {
  const bytes = new TextEncoder().encode(serialised);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CONFIGURATION_BYTES) {
    return platformFail(
      "invalid_input",
      "The configuration file size is outside the supported range.",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(serialised);
  } catch {
    return platformFail(
      "invalid_input",
      "The configuration file is not valid JSON.",
    );
  }
  const parsed = ConfigurationEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    const rawVersion =
      typeof value === "object" && value !== null && "schemaVersion" in value
        ? (value as { schemaVersion?: unknown }).schemaVersion
        : undefined;
    return platformFail(
      typeof rawVersion === "number" &&
        rawVersion !== CONFIGURATION_SCHEMA_VERSION
        ? "unsupported_version"
        : "invalid_input",
      typeof rawVersion === "number" &&
        rawVersion !== CONFIGURATION_SCHEMA_VERSION
        ? `Configuration schema version ${rawVersion} is not supported.`
        : "The configuration file failed schema validation.",
    );
  }
  const { sha256, ...withoutHash } = parsed.data;
  const digest = await sha256Hex(
    new TextEncoder().encode(canonicalConfigurationPayload(withoutHash)).buffer,
  );
  if (digest !== sha256) {
    return platformFail(
      "integrity_failed",
      "The configuration checksum does not match its contents.",
    );
  }
  if (
    parsed.data.counts.profiles !== parsed.data.data.profiles.length ||
    parsed.data.counts.aliases !== parsed.data.data.aliases.length
  ) {
    return platformFail(
      "integrity_failed",
      "The configuration record counts do not match its contents.",
    );
  }
  return platformOk(parsed.data);
}

function emptyRecordCounts() {
  return {
    catalogueItems: 0,
    approvals: 0,
    priceHistory: 0,
    competitorReferences: 0,
    sources: 0,
    profiles: 0,
    aliases: 0,
    settings: 0,
  };
}

function settingsEqual(
  left: browserDb.BrowserConfigurationSnapshot["settings"],
  right: browserDb.BrowserConfigurationSnapshot["settings"],
): boolean {
  return (
    left.markupPercent === right.markupPercent &&
    left.taxHandling === right.taxHandling &&
    left.theme === right.theme
  );
}

function configurationRecordEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function configurationConflicts(
  current: browserDb.BrowserConfigurationSnapshot,
  incoming: ConfigurationEnvelope["data"],
): ConfigurationPreview["conflicts"] {
  return {
    profiles: incoming.profiles.filter((candidate) => {
      const existing = current.profiles.find(
        (record) => record.id === candidate.id,
      );
      return (
        existing !== undefined && !configurationRecordEqual(existing, candidate)
      );
    }).length,
    aliases: incoming.aliases.filter((candidate) =>
      current.aliases.some(
        (existing) =>
          existing.supplierCode === candidate.supplierCode &&
          !configurationRecordEqual(existing, candidate),
      ),
    ).length,
    settings:
      !settingsEqual(current.settings, DEFAULT_SETTINGS) &&
      !settingsEqual(current.settings, incoming.settings)
        ? 1
        : 0,
  };
}

function conflictMessages(
  conflicts: ConfigurationPreview["conflicts"],
): string[] {
  const messages: string[] = [];
  if (conflicts.profiles > 0) {
    messages.push(
      `${conflicts.profiles} mapping profile identifier conflict(s) must be resolved.`,
    );
  }
  if (conflicts.aliases > 0) {
    messages.push(
      `${conflicts.aliases} approved alias identifier conflict(s) must be resolved.`,
    );
  }
  if (conflicts.settings > 0) {
    messages.push(
      "Current non-default settings differ from the incoming settings.",
    );
  }
  return messages;
}

function webProviderStatus(health: {
  provider: string;
  liveSearchConfigured: boolean;
  fixtureMode: boolean;
  paidCallsEnabled?: boolean;
  costCeilingAud?: string;
  costCeilingCents?: number;
  costPerCallCents?: number;
  spentCents?: number;
}): ProviderStatus {
  const paidCallsEnabled = health.fixtureMode
    ? false
    : health.paidCallsEnabled === true;
  return {
    provider: health.provider,
    state: health.fixtureMode
      ? "fixture"
      : health.liveSearchConfigured && paidCallsEnabled
        ? "configured"
        : "not_configured",
    paidCallsEnabled,
    costCeilingAud: health.costCeilingAud ?? "0.00",
    costCeilingCents: health.costCeilingCents ?? 0,
    costPerCallCents: health.costPerCallCents ?? 0,
    spentCents: health.spentCents ?? 0,
    credentialConfigured: health.liveSearchConfigured,
    credentialHint: null,
    lastValidatedAt: null,
  };
}

function webSessionTokenMissingStatus(): ProviderStatus {
  return {
    provider: "serpapi-google-shopping-au",
    state: "not_configured",
    paidCallsEnabled: false,
    costCeilingAud: "0.00",
    costCeilingCents: 0,
    costPerCallCents: 0,
    spentCents: 0,
    credentialConfigured: false,
    credentialHint: null,
    lastValidatedAt: null,
  };
}

export function createWebPlatformService(
  storage: WebConfigurationStorage = browserDb,
  options: WebPlatformOptions = {},
): PlatformService {
  const sessionOnly = options.sessionOnly === true;
  const liveSearchApiOrigin = canonicalApiOrigin(options.liveSearchApiOrigin);
  const liveSearchEnabled = !sessionOnly || liveSearchApiOrigin !== null;
  let sessionApiAccessToken: string | null = null;
  const liveUrl = (path: string) =>
    liveSearchApiOrigin === null ? path : `${liveSearchApiOrigin}${path}`;
  const liveRequestJson = <T>(
    path: string,
    schema: z.ZodType<T>,
    init?: RequestInit,
  ) =>
    requestJson(liveUrl(path), schema, {
      ...init,
      headers: {
        ...init?.headers,
        ...(sessionApiAccessToken
          ? { authorization: `Bearer ${sessionApiAccessToken}` }
          : {}),
      },
    });
  const importPreviews = new Map<string, ConfigurationEnvelope>();
  const resetPreviews = new Map<
    string,
    { preview: ResetPreview; snapshot: browserDb.BrowserConfigurationSnapshot }
  >();
  const backups = new Map<
    string,
    { summary: BackupSummary; envelope: ConfigurationEnvelope }
  >();
  const sessionCatalogue = new Map<string, CatalogueItem>();
  const sessionApprovals: ApprovalRecord[] = [];
  const sessionPriceHistory: PriceHistoryVersion[] = [];
  const sessionReferences: CompetitorReferenceRecord[] = [];
  let sessionSources = defaultSources();

  const publishSessionChanges: PlatformService["catalogue"]["publishApproved"] =
    async (changes) => {
      const parsed = z
        .array(SessionApprovedChangeSchema)
        .min(1)
        .max(10_000)
        .safeParse(changes);
      if (!parsed.success) {
        return platformFail(
          "invalid_input",
          "The approved catalogue batch is invalid.",
        );
      }
      const stagedCatalogue = new Map(sessionCatalogue);
      const batchIds = new Set<string>();
      const batchNumbers = new Set<string>();
      for (const change of parsed.data) {
        const { item } = change;
        if (batchIds.has(item.id) || batchNumbers.has(item.itemNumber)) {
          return platformFail(
            "conflict",
            "The approved batch contains a duplicate catalogue identifier.",
          );
        }
        batchIds.add(item.id);
        batchNumbers.add(item.itemNumber);
        const itemNumberOwner = [...stagedCatalogue.values()].find(
          (existing) =>
            existing.itemNumber === item.itemNumber && existing.id !== item.id,
        );
        if (itemNumberOwner) {
          return platformFail(
            "conflict",
            "The item number already belongs to another catalogue item.",
          );
        }
        // Integer cents and half-up rounding: cost * 1.30, rounded to cents.
        const minimumSellCents = Math.trunc((item.costCents * 130 + 50) / 100);
        if (item.sellPriceCents < minimumSellCents) {
          return platformFail(
            "invalid_input",
            "The proposed sell price is below the required 30 percent markup floor.",
          );
        }
        stagedCatalogue.set(item.id, item);
      }

      const published = parsed.data.map(({ item, approvedBy, reason }) => {
        const approvedAt = new Date().toISOString();
        const approval: ApprovalRecord = {
          id: crypto.randomUUID(),
          itemId: item.id,
          approvedBy,
          proposedSellCents: item.sellPriceCents,
          reason,
          approvedAt,
        };
        const priceHistory: PriceHistoryVersion = {
          id: crypto.randomUUID(),
          itemId: item.id,
          cost: centsToAud(item.costCents),
          sellPrice: centsToAud(item.sellPriceCents),
          costCents: item.costCents,
          sellPriceCents: item.sellPriceCents,
          approvalId: approval.id,
          recordedAt: approvedAt,
        };
        return { item, approval, priceHistory };
      });
      sessionCatalogue.clear();
      for (const [id, item] of stagedCatalogue) sessionCatalogue.set(id, item);
      sessionApprovals.push(...published.map(({ approval }) => approval));
      sessionPriceHistory.push(
        ...published.map(({ priceHistory }) => priceHistory),
      );
      return platformOk(published);
    };

  const createBackup = async (
    reason: BackupReason,
  ): Promise<PlatformResult<BackupSummary>> => {
    void reason;
    const envelope = await buildConfigurationEnvelope(storage);
    const id = crypto.randomUUID();
    const summary: BackupSummary = {
      id,
      filename: `${envelope.exportedAt.slice(0, 10).replaceAll("-", "")}-SWL-Web-Configuration.json`,
      createdAt: envelope.exportedAt,
      applicationVersion: APP_VERSION,
      schemaVersion: envelope.schemaVersion,
      sha256: envelope.sha256,
      recordCounts: {
        ...emptyRecordCounts(),
        profiles: envelope.counts.profiles,
        aliases: envelope.counts.aliases,
        settings: envelope.counts.settings,
      },
    };
    backups.set(id, { summary, envelope });
    return platformOk(summary);
  };

  const service: PlatformService = {
    kind: "web",
    capabilities: {
      nativeFiles: false,
      nativePersistence: false,
      protectedCredentials: false,
      recovery: true,
      liveSearch: liveSearchEnabled,
      sessionAccessToken: liveSearchApiOrigin !== null,
    },
    rawImportPersistence: "never",
    manualEvidencePersistence: "catalogue-reference-or-session",

    health: () =>
      !liveSearchEnabled
        ? Promise.resolve(
            platformOk({
              ok: true,
              provider: "manual-only",
              liveSearchConfigured: false,
              fixtureMode: false,
              schemaVersion: 1,
            }),
          )
        : (liveRequestJson("/api/health", LiveHealthSchema) as Promise<
            PlatformResult<LiveHealth>
          >),

    catalogue: {
      async list() {
        if (sessionOnly) return platformOk([...sessionCatalogue.values()]);
        const result = await requestJson(
          "/api/items",
          z.array(WebCatalogueItemSchema).max(100_000),
        );
        if (!result.ok) return result;
        const items = result.value.map((item) => {
          const itemNumber = item.itemNumber ?? item.sku;
          if (!itemNumber) return null;
          const canonical: CatalogueItem = {
            id: item.id,
            itemNumber,
            description: item.description,
            costCents: item.costCents,
            sellPriceCents: item.sellPriceCents,
            gstBasis: item.gstBasis ?? "unknown",
            updatedAt: item.updatedAt,
          };
          const parsed = CatalogueItemSchema.safeParse(canonical);
          return parsed.success ? parsed.data : null;
        });
        return items.some((item) => item === null)
          ? platformFail(
              "integrity_failed",
              "The catalogue contains an invalid record and cannot be loaded safely.",
            )
          : platformOk(items as CatalogueItem[]);
      },
      publishApproved: (changes) =>
        sessionOnly
          ? publishSessionChanges(changes)
          : requestJson(
              "/api/publish-approved-changes",
              z.array(PublishedChangeSchema),
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ changes }),
              },
            ),
    },
    approvals: {
      async list(itemId) {
        if (sessionOnly) {
          return platformOk(
            itemId
              ? sessionApprovals.filter((item) => item.itemId === itemId)
              : [...sessionApprovals],
          );
        }
        const result = await requestJson(
          "/api/approvals",
          z.array(ApprovalRecordSchema).max(500_000),
        );
        return result.ok
          ? platformOk(
              itemId
                ? result.value.filter((item) => item.itemId === itemId)
                : result.value,
            )
          : result;
      },
    },
    priceHistory: {
      list: (itemId) =>
        sessionOnly
          ? Promise.resolve(
              platformOk(
                itemId
                  ? sessionPriceHistory.filter((item) => item.itemId === itemId)
                  : [...sessionPriceHistory],
              ),
            )
          : requestJson(
              `/api/price-history${itemId ? `?itemId=${encodeURIComponent(itemId)}` : ""}`,
              z.array(PriceHistoryVersionSchema).max(1_000_000),
            ),
    },
    references: {
      list: (itemId) =>
        (sessionOnly
          ? Promise.resolve(
              platformOk(
                itemId
                  ? sessionReferences.filter((item) => item.itemId === itemId)
                  : [...sessionReferences],
              ),
            )
          : requestJson(
              `/api/references${itemId ? `?itemId=${encodeURIComponent(itemId)}` : ""}`,
              z.array(CompetitorReferenceRecordSchema).max(1_000_000),
            )) as ReturnType<PlatformService["references"]["list"]>,
      async attach(itemId, observation) {
        const parsed = z
          .union([LiveSearchResultSchema, CompetitorObservationSchema])
          .safeParse(observation);
        if (!parsed.success) {
          return platformFail(
            "invalid_input",
            "The competitor evidence contains unsupported or unsafe fields.",
          );
        }
        if (sessionOnly) {
          if (!sessionCatalogue.has(itemId)) {
            return platformFail(
              "conflict",
              "Competitor evidence requires an approved catalogue item.",
            );
          }
          const reference: CompetitorReferenceRecord = {
            id: crypto.randomUUID(),
            itemId,
            observation,
            attachedAt: new Date().toISOString(),
          };
          if (!CompetitorReferenceRecordSchema.safeParse(reference).success) {
            return platformFail(
              "invalid_input",
              "The competitor reference is invalid.",
            );
          }
          sessionReferences.push(reference);
          return platformOk(reference);
        }
        return requestJson("/api/references", CompetitorReferenceRecordSchema, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ itemId, observation: parsed.data }),
        }) as ReturnType<PlatformService["references"]["attach"]>;
      },
    },
    sources: {
      async list() {
        if (sessionOnly) return platformOk(structuredClone(sessionSources));
        const result = await requestJson(
          "/api/sources",
          z.array(WebSourceSchema).max(1000),
        );
        if (!result.ok) return result;
        if (result.value.length === 0) return platformOk(defaultSources());
        const sources: CompetitorSource[] = result.value.map((source) => ({
          id: source.id,
          name: source.name,
          accessMethod: source.accessMethod,
          automatedAccessNote: source.automatedAccessNote ?? source.note ?? "",
          enabled: source.enabled,
        }));
        const parsed = z.array(CompetitorSourceSchema).safeParse(sources);
        const productionSources = parsed.success
          ? withoutLegacySyntheticSources(parsed.data)
          : [];
        return parsed.success
          ? platformOk(
              productionSources.length === 0
                ? defaultSources()
                : productionSources,
            )
          : platformFail(
              "integrity_failed",
              "The source registry response is invalid.",
            );
      },
      async replace(sources) {
        if (sessionOnly) {
          const parsed = z
            .array(CompetitorSourceSchema)
            .max(1000)
            .safeParse(sources);
          if (
            !parsed.success ||
            new Set(parsed.data.map(({ id }) => id)).size !== parsed.data.length
          ) {
            return platformFail(
              "invalid_input",
              "The source registry is invalid.",
            );
          }
          sessionSources = structuredClone(parsed.data);
          return platformOk(structuredClone(sessionSources));
        }
        return requestJson("/api/sources", z.array(CompetitorSourceSchema), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(sources),
        });
      },
    },
    profiles: {
      async list() {
        try {
          return platformOk(await storage.listProfiles());
        } catch {
          return platformFail(
            "integrity_failed",
            "Stored mapping profiles could not be read safely.",
          );
        }
      },
      async save(profile) {
        const parsed = MappingProfileSchema.safeParse(profile);
        if (!parsed.success)
          return platformFail(
            "invalid_input",
            "The mapping profile is invalid.",
          );
        try {
          await storage.saveProfile(profile);
          return platformOk(profile);
        } catch {
          return platformFail(
            "integrity_failed",
            "The mapping profile could not be saved safely.",
          );
        }
      },
      async delete(id) {
        try {
          await storage.deleteProfile(id);
          return platformOk(undefined);
        } catch {
          return platformFail(
            "integrity_failed",
            "The mapping profile could not be deleted safely.",
          );
        }
      },
    },
    aliases: {
      async list() {
        try {
          return platformOk(await storage.listAliases());
        } catch {
          return platformFail(
            "integrity_failed",
            "Stored approved aliases could not be read safely.",
          );
        }
      },
      async save(alias) {
        const parsed = AliasRecordSchema.safeParse(alias);
        if (!parsed.success)
          return platformFail(
            "invalid_input",
            "The approved alias is invalid.",
          );
        try {
          await storage.saveAlias(alias);
          return platformOk(alias);
        } catch {
          return platformFail(
            "integrity_failed",
            "The approved alias could not be saved safely.",
          );
        }
      },
      async delete(supplierCode) {
        try {
          await storage.deleteAlias(supplierCode);
          return platformOk(undefined);
        } catch {
          return platformFail(
            "integrity_failed",
            "The approved alias could not be deleted safely.",
          );
        }
      },
    },
    settings: {
      async load() {
        try {
          return platformOk(await storage.loadSettings());
        } catch {
          return platformFail(
            "integrity_failed",
            "Stored settings could not be read safely.",
          );
        }
      },
      async save(settings) {
        const parsed = SettingsSchema.safeParse(settings);
        if (!parsed.success) {
          return platformFail("invalid_input", "The settings are invalid.");
        }
        try {
          await storage.saveSettings(parsed.data);
          return platformOk(parsed.data);
        } catch {
          return platformFail(
            "integrity_failed",
            "The settings could not be saved safely.",
          );
        }
      },
    },
    configuration: {
      async export() {
        return platformOk(await buildConfigurationEnvelope(storage));
      },
      async exportToSelectedFolder() {
        return platformFail(
          "unavailable",
          "Native folder export is available only in the Windows application.",
        );
      },
      async previewImport(serialised) {
        const validation = await validateEnvelope(serialised);
        if (!validation.ok) return validation;
        const current = await storage.readConfigurationSnapshot();
        const previewToken = crypto.randomUUID();
        importPreviews.set(previewToken, validation.value);
        const conflicts = configurationConflicts(
          current,
          validation.value.data,
        );
        const validationMessages = conflictMessages(conflicts);
        const preview: ConfigurationPreview = {
          previewToken,
          schemaVersion: validation.value.schemaVersion,
          counts: validation.value.counts,
          conflicts,
          valid: validationMessages.length === 0,
          validationMessages,
        };
        return platformOk(preview);
      },
      async applyImport(previewToken) {
        const envelope = importPreviews.get(previewToken);
        if (!envelope)
          return platformFail(
            "invalid_input",
            "The import preview has expired.",
          );
        const current = await storage.readConfigurationSnapshot();
        const conflicts = configurationConflicts(current, envelope.data);
        if (conflictMessages(conflicts).length > 0) {
          return platformFail(
            "conflict",
            "The live configuration now conflicts with this preview. No data was changed.",
          );
        }
        await createBackup("import");
        const merged = {
          profiles: [
            ...new Map(
              [...current.profiles, ...envelope.data.profiles].map(
                (profile) => [profile.id, profile],
              ),
            ).values(),
          ],
          aliases: [
            ...new Map(
              [...current.aliases, ...envelope.data.aliases].map((alias) => [
                alias.supplierCode,
                alias,
              ]),
            ).values(),
          ],
          settings: envelope.data.settings,
        };
        await storage.replaceConfigurationSnapshot(merged);
        importPreviews.delete(previewToken);
        return platformOk(envelope.counts);
      },
      async migrationStatus() {
        const snapshot = await storage.readConfigurationSnapshot();
        return platformOk({
          legacyConfigurationFound:
            snapshot.profiles.length > 0 ||
            snapshot.aliases.length > 0 ||
            JSON.stringify(snapshot.settings) !==
              JSON.stringify(DEFAULT_SETTINGS),
          alreadyImported: false,
          counts: {
            profiles: snapshot.profiles.length,
            aliases: snapshot.aliases.length,
            settings: 1,
          },
          valid: true,
          invalidCounts: { profiles: 0, aliases: 0, settings: 0 },
          validationMessages: [],
        });
      },
      async previewLegacyImport() {
        return platformFail(
          "unavailable",
          "Legacy import is only needed inside the Windows desktop application.",
        );
      },
    },
    recovery: {
      createBackup,
      async listBackups() {
        return platformOk([...backups.values()].map((entry) => entry.summary));
      },
      async previewRestore(backupId) {
        const selected = backupId
          ? backups.get(backupId)
          : [...backups.values()].at(-1);
        if (!selected) {
          return platformFail(
            "unavailable",
            "No browser configuration backup is available.",
          );
        }
        const preview: RestorePreview = {
          ...selected.summary,
          previewToken: selected.summary.id,
          integrityOk: true,
        };
        return platformOk(preview);
      },
      async restore(previewToken) {
        const backup = backups.get(previewToken);
        if (!backup)
          return platformFail(
            "invalid_input",
            "The restore preview has expired.",
          );
        await createBackup("restore");
        await storage.replaceConfigurationSnapshot(backup.envelope.data);
        return platformOk(backup.summary);
      },
      async previewReset() {
        const envelope = await buildConfigurationEnvelope(storage);
        const preview: ResetPreview = {
          resetToken: crypto.randomUUID(),
          confirmationPhrase: RESET_CONFIRMATION,
          scope: ["mapping profiles", "approved aliases", "settings"],
          recordCounts: {
            ...emptyRecordCounts(),
            profiles: envelope.counts.profiles,
            aliases: envelope.counts.aliases,
            settings: envelope.counts.settings,
          },
        };
        resetPreviews.clear();
        resetPreviews.set(preview.resetToken, {
          preview,
          snapshot: structuredClone(envelope.data),
        });
        return platformOk(preview);
      },
      async reset(resetToken, confirmation) {
        const pending = resetPreviews.get(resetToken);
        if (!pending || confirmation !== pending.preview.confirmationPhrase) {
          return platformFail(
            "invalid_input",
            "The reset confirmation did not match the preview.",
          );
        }
        const current = await storage.readConfigurationSnapshot();
        if (!configurationRecordEqual(current, pending.snapshot)) {
          resetPreviews.delete(resetToken);
          return platformFail(
            "conflict",
            "Stored configuration changed after the reset preview. Nothing was erased.",
          );
        }
        const backup = await createBackup("reset");
        if (!backup.ok) return backup;
        if (
          !(await storage.deleteConfigurationSnapshotIfUnchanged(
            pending.snapshot,
          ))
        ) {
          resetPreviews.delete(resetToken);
          return platformFail(
            "conflict",
            "Stored configuration changed after backup. Nothing was erased.",
          );
        }
        resetPreviews.delete(resetToken);
        return backup;
      },
    },
    search: {
      async status() {
        if (!liveSearchEnabled) {
          return platformOk({
            provider: "manual-only",
            state: "not_configured",
            paidCallsEnabled: false,
            costCeilingAud: "0.00",
            costCeilingCents: 0,
            costPerCallCents: 0,
            spentCents: 0,
            credentialConfigured: false,
            credentialHint: null,
            lastValidatedAt: null,
          });
        }
        if (liveSearchApiOrigin !== null && sessionApiAccessToken === null) {
          return platformOk(webSessionTokenMissingStatus());
        }
        const health = await service.health();
        return health.ok ? platformOk(webProviderStatus(health.value)) : health;
      },
      async query(query, candidateToken) {
        if (!liveSearchEnabled) {
          return {
            state: "not_configured",
            query,
            queryKind: query.trim() ? "free-text" : "empty",
            provider: "manual-only",
            candidates: [],
            results: [],
            band: null,
            detail:
              "The static Pages demonstration is manual-only and makes no network search request.",
          };
        }
        if (liveSearchApiOrigin !== null && sessionApiAccessToken === null) {
          return {
            state: "not_configured",
            query,
            queryKind: query.trim() ? "free-text" : "empty",
            provider: "serpapi-google-shopping-au",
            candidates: [],
            results: [],
            band: null,
            detail:
              "Enter the revocable SWL web API access token for this tab before searching.",
          };
        }
        const result = await liveRequestJson(
          "/api/competitor-search",
          LiveSearchOutcomeSchema,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              query,
              ...(candidateToken ? { candidateToken } : {}),
            }),
          },
        );
        if (result.ok) return result.value as LiveSearchOutcome;
        if (result.error.code === "permission_denied") {
          sessionApiAccessToken = null;
        }
        return {
          state:
            result.error.code === "timeout"
              ? "timeout"
              : result.error.code === "rate_limited"
                ? "rate_limited"
                : result.error.code === "conflict"
                  ? "search_in_progress"
                  : result.error.code === "selection_expired"
                    ? "selection_expired"
                    : result.error.code === "quota_exhausted"
                      ? "quota_exhausted"
                      : result.error.code === "invalid_input"
                        ? "invalid_query"
                        : result.error.code === "permission_denied"
                          ? "not_configured"
                          : result.error.code === "provider_error"
                            ? "provider_error"
                            : "server_unreachable",
          query,
          queryKind: query.trim() ? "free-text" : "empty",
          provider: "unknown",
          candidates: [],
          results: [],
          band: null,
          detail: result.error.message,
        };
      },
      setPaidCallsEnabled: async () =>
        platformFail(
          "unavailable",
          "Paid provider calls are configured on the web server.",
        ),
      async configureCredential(secret) {
        if (!/^[A-Za-z0-9_-]{43,256}$/u.test(secret)) {
          return platformFail(
            "invalid_input",
            "Enter the API access token issued for this application.",
          );
        }
        sessionApiAccessToken = secret;
        const status = await service.search.status();
        if (!status.ok) sessionApiAccessToken = null;
        return status;
      },
      validateCredential: async () => service.search.status(),
      async replaceCredential(secret) {
        sessionApiAccessToken = null;
        return service.search.configureCredential(secret);
      },
      async removeCredential() {
        sessionApiAccessToken = null;
        return platformOk(webSessionTokenMissingStatus());
      },
    },
    files: {
      async chooseInputFile() {
        return platformFail(
          "unavailable",
          "Browser input files are selected through the visible file control.",
        );
      },
      async chooseOutputDestination() {
        return platformFail(
          "unavailable",
          "Native output folders are available in the Windows application.",
        );
      },
      async saveOutputs() {
        return platformFail(
          "unavailable",
          "Native output folders are available in the Windows application.",
        );
      },
      async openVerifiedSource(url) {
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return platformFail("invalid_input", "The source link is invalid.");
        }
        if (parsed.protocol !== "https:") {
          return platformFail(
            "permission_denied",
            "Only verified HTTPS source links may be opened.",
          );
        }
        window.open(parsed.href, "_blank", "noopener,noreferrer");
        return platformOk(undefined);
      },
    },
  };

  return service;
}
