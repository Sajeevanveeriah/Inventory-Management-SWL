import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type { LiveHealth, LiveSearchOutcome } from "../core/liveSearch";
import { DEFAULT_SETTINGS, SettingsSchema } from "../core/settings";
import { defaultSources } from "../core/sources";
import { sha256Hex } from "../io/hash";
import type { GeneratedOutput } from "../io/exportWorkbooks";
import * as legacyBrowserDb from "../storage/db";
import type {
  BackupReason,
  ConfigurationEnvelope,
  InputFileRole,
  PlatformErrorCode,
  PlatformResult,
  PlatformSaveResult,
  PlatformService,
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
  BackupSummarySchema,
  BeginExportSchema,
  CatalogueItemSchema,
  CompetitorObservationSchema,
  CompetitorReferenceRecordSchema,
  CompetitorSourceSchema,
  ConfigurationEnvelopeSchema,
  ConfigurationMigrationStatusSchema,
  ConfigurationPreviewSchema,
  LiveHealthSchema,
  LiveSearchResultSchema,
  LiveSearchOutcomeSchema,
  MappingProfileSchema,
  InputFileGrantSchema,
  OutputDestinationGrantSchema,
  PriceHistoryVersionSchema,
  PublishedChangeSchema,
  ProviderStatusSchema,
  ResetPreviewSchema,
  RestorePreviewSchema,
} from "./schemas";

const EXPORT_CHUNK_BYTES = 256 * 1024;
const MAX_EXPORT_BYTES = 50 * 1024 * 1024;
const INPUT_CHUNK_BYTES = 256 * 1024;
const MAX_CONFIGURATION_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_DATA_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_SEARCH_QUERY_BYTES = 512;
const MAX_CREDENTIAL_BYTES = 1024;
const CONFIGURATION_EXPORT_FILENAME =
  /^\d{8}-[A-Za-z0-9][A-Za-z0-9_-]{0,198}\.json$/;
const ExportBatchReservationSchema = z
  .object({ batchId: z.string().uuid() })
  .strict();

interface PreparedExport {
  output: GeneratedOutput;
  length: number;
  sha256: string;
}

export type InvokeFunction = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

function errorResult<T>(error: unknown): PlatformResult<T> {
  if (typeof error === "object" && error !== null && "code" in error) {
    const candidate = error as {
      code?: unknown;
      message?: unknown;
      retryable?: unknown;
    };
    const allowed: PlatformErrorCode[] = [
      "cancelled",
      "conflict",
      "integrity_failed",
      "invalid_input",
      "not_configured",
      "offline",
      "permission_denied",
      "provider_error",
      "quota_exhausted",
      "rate_limited",
      "timeout",
      "unavailable",
      "unsupported_version",
    ];
    if (allowed.includes(candidate.code as PlatformErrorCode)) {
      return platformFail(
        candidate.code as PlatformErrorCode,
        typeof candidate.message === "string"
          ? candidate.message.slice(0, 300)
          : "The desktop operation failed.",
        candidate.retryable === true,
      );
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const code: PlatformErrorCode = lower.includes("exist")
    ? "conflict"
    : lower.includes("cancel")
      ? "cancelled"
      : lower.includes("offline")
        ? "offline"
        : lower.includes("timeout")
          ? "timeout"
          : "unavailable";
  return platformFail(
    code,
    "The desktop operation could not be completed.",
    code !== "conflict",
  );
}

async function invokeParsed<T>(
  invoke: InvokeFunction,
  command: string,
  schema: z.ZodType<T>,
  args?: Record<string, unknown>,
): Promise<PlatformResult<T>> {
  try {
    const raw = await invoke<unknown>(command, args);
    const parsed = schema.safeParse(raw);
    return parsed.success
      ? platformOk(parsed.data)
      : platformFail(
          "integrity_failed",
          "The desktop service returned an invalid response.",
        );
  } catch (error) {
    return errorResult(error);
  }
}

async function invokeVoid(
  invoke: InvokeFunction,
  command: string,
  args?: Record<string, unknown>,
): Promise<PlatformResult<void>> {
  try {
    await invoke<unknown>(command, args);
    return platformOk(undefined);
  } catch (error) {
    return errorResult(error);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const blockSize = 32 * 1024;
  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    const block = bytes.subarray(
      offset,
      Math.min(offset + blockSize, bytes.length),
    );
    for (const value of block) binary += String.fromCharCode(value);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function validCredential(secret: string): boolean {
  const byteLength = new TextEncoder().encode(secret).byteLength;
  return (
    byteLength >= 8 &&
    byteLength <= MAX_CREDENTIAL_BYTES &&
    secret.trim() === secret &&
    !hasControlCharacter(secret)
  );
}

async function chooseAndReadInputFile(
  invoke: InvokeFunction,
  role: InputFileRole,
): Promise<PlatformResult<File | null>> {
  const selected = await invokeParsed(
    invoke,
    "choose_input_file",
    InputFileGrantSchema.nullable(),
    { role },
  );
  if (!selected.ok) return selected;
  if (selected.value === null) return platformOk(null);
  const grant = selected.value;
  const maxBytes =
    role === "configuration"
      ? MAX_CONFIGURATION_INPUT_BYTES
      : MAX_DATA_INPUT_BYTES;
  const expectedExtensions =
    role === "configuration" ? ["json"] : ["csv", "xlsx"];
  if (
    grant.length > maxBytes ||
    !expectedExtensions.includes(grant.extension)
  ) {
    await invokeVoid(invoke, "release_input_grant", { grantId: grant.grantId });
    return platformFail(
      "invalid_input",
      "The selected input file is outside the supported range.",
    );
  }

  const parts: BlobPart[] = [];
  let failure: PlatformResult<File> | null = null;
  let released: PlatformResult<void>;
  try {
    for (let offset = 0; offset < grant.length; offset += INPUT_CHUNK_BYTES) {
      const length = Math.min(INPUT_CHUNK_BYTES, grant.length - offset);
      const chunk = await invokeParsed(
        invoke,
        "read_input_chunk",
        z
          .string()
          .min(4)
          .max((INPUT_CHUNK_BYTES * 4) / 3 + 8),
        { grantId: grant.grantId, offset, length },
      );
      if (!chunk.ok) {
        failure = chunk;
        break;
      }
      const bytes = base64ToBytes(chunk.value);
      if (bytes === null || bytes.byteLength !== length) {
        failure = platformFail(
          "integrity_failed",
          "The native input byte count did not match the selected file.",
        );
        break;
      }
      parts.push(bytes);
    }
  } finally {
    released = await invokeVoid(invoke, "release_input_grant", {
      grantId: grant.grantId,
    });
  }
  if (failure !== null) return failure;
  if (!released.ok) return released;
  const mime =
    grant.extension === "csv"
      ? "text/csv"
      : grant.extension === "json"
        ? "application/json"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return platformOk(new File(parts, grant.displayName, { type: mime }));
}

async function legacyConfigurationEnvelope(
  data: legacyBrowserDb.BrowserConfigurationSnapshot,
): Promise<ConfigurationEnvelope> {
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
  const bytes = new TextEncoder().encode(
    canonicalConfigurationPayload(withoutHash),
  );
  return { ...withoutHash, sha256: await sha256Hex(bytes.buffer) };
}

async function saveOneOutput(
  invoke: InvokeFunction,
  batchId: string,
  grantId: string,
  prepared: PreparedExport,
): Promise<PlatformResult<string>> {
  const { output, length, sha256 } = prepared;
  const buffer = await output.blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength !== length) {
    return platformFail(
      "integrity_failed",
      "The output file changed during export preparation.",
    );
  }
  const begin = await invokeParsed(
    invoke,
    "begin_export_file",
    BeginExportSchema,
    {
      batchId,
      grantId,
      filename: output.filename,
      length,
      sha256,
    },
  );
  if (!begin.ok) return begin;
  const sessionId = begin.value.sessionId;
  try {
    for (
      let offset = 0;
      offset < bytes.byteLength;
      offset += EXPORT_CHUNK_BYTES
    ) {
      const chunk = bytes.subarray(
        offset,
        Math.min(offset + EXPORT_CHUNK_BYTES, bytes.byteLength),
      );
      const appended = await invokeParsed(
        invoke,
        "append_export_chunk",
        z.number().int().min(1).max(MAX_EXPORT_BYTES),
        {
          sessionId,
          offset,
          base64Data: bytesToBase64(chunk),
        },
      );
      if (!appended.ok) {
        await invokeVoid(invoke, "abort_export_file", { sessionId });
        return appended;
      }
      if (appended.value !== offset + chunk.byteLength) {
        await invokeVoid(invoke, "abort_export_file", { sessionId });
        return platformFail(
          "integrity_failed",
          "The desktop export byte count did not match.",
        );
      }
    }
    const committed = await invokeParsed(
      invoke,
      "commit_export_file",
      z.string().min(1).max(512),
      {
        sessionId,
      },
    );
    if (!committed.ok)
      await invokeVoid(invoke, "abort_export_file", { sessionId });
    return committed;
  } catch (error) {
    await invokeVoid(invoke, "abort_export_file", { sessionId });
    return errorResult(error);
  }
}

export function createDesktopPlatformService(
  invoke: InvokeFunction = tauriInvoke,
): PlatformService {
  const service: PlatformService = {
    kind: "desktop",
    capabilities: {
      nativeFiles: true,
      nativePersistence: true,
      protectedCredentials: true,
      recovery: true,
      liveSearch: true,
    },
    rawImportPersistence: "never",
    manualEvidencePersistence: "catalogue-reference-or-session",

    appearance: {
      setTheme: (theme) =>
        invokeVoid(invoke, "plugin:app|set_app_theme", {
          theme: theme === "system" ? null : theme,
        }),
    },

    health: () =>
      invokeParsed(invoke, "desktop_health", LiveHealthSchema) as Promise<
        PlatformResult<LiveHealth>
      >,
    catalogue: {
      list: () =>
        invokeParsed(
          invoke,
          "list_catalogue_items",
          z.array(CatalogueItemSchema),
        ),
      async publishApproved(changes) {
        if (changes.length === 0 || changes.length > 50_000) {
          return platformFail(
            "invalid_input",
            "The approval batch size is outside the supported range.",
          );
        }
        const result = await invokeParsed(
          invoke,
          "publish_approved_changes",
          z.array(PublishedChangeSchema).max(50_000),
          { changes },
        );
        if (!result.ok) return result;
        const responseIds = result.value.map((entry) => entry.item.id);
        const requestedIds = changes.map((entry) => entry.item.id);
        return result.value.length === changes.length &&
          responseIds.every((id, index) => id === requestedIds[index])
          ? result
          : platformFail(
              "integrity_failed",
              "The approval publication response was incomplete.",
            );
      },
    },
    approvals: {
      list: (itemId) =>
        invokeParsed(invoke, "list_approvals", z.array(ApprovalRecordSchema), {
          itemId: itemId ?? null,
        }),
    },
    priceHistory: {
      list: (itemId) =>
        invokeParsed(
          invoke,
          "list_price_history",
          z.array(PriceHistoryVersionSchema),
          {
            itemId: itemId ?? null,
          },
        ),
    },
    references: {
      list: (itemId) =>
        invokeParsed(
          invoke,
          "list_competitor_references",
          z.array(CompetitorReferenceRecordSchema),
          {
            itemId: itemId ?? null,
          },
        ) as ReturnType<PlatformService["references"]["list"]>,
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
        return invokeParsed(
          invoke,
          "attach_competitor_reference",
          CompetitorReferenceRecordSchema,
          { itemId, observation: parsed.data },
        ) as ReturnType<PlatformService["references"]["attach"]>;
      },
    },
    sources: {
      async list() {
        const result = await invokeParsed(
          invoke,
          "list_sources",
          z.array(CompetitorSourceSchema),
        );
        return result.ok && result.value.length === 0
          ? platformOk(defaultSources())
          : result;
      },
      replace: (sources) =>
        invokeParsed(
          invoke,
          "replace_sources",
          z.array(CompetitorSourceSchema),
          { sources },
        ),
    },
    profiles: {
      list: () =>
        invokeParsed(
          invoke,
          "list_mapping_profiles",
          z.array(MappingProfileSchema),
        ),
      save: (profile) =>
        invokeParsed(invoke, "save_mapping_profile", MappingProfileSchema, {
          profile,
        }),
      delete: (id) => invokeVoid(invoke, "delete_mapping_profile", { id }),
    },
    aliases: {
      list: () =>
        invokeParsed(invoke, "list_aliases", z.array(AliasRecordSchema)),
      save: (alias) =>
        invokeParsed(invoke, "save_alias", AliasRecordSchema, { alias }),
      delete: (supplierCode) =>
        invokeVoid(invoke, "delete_alias", { supplierCode }),
    },
    settings: {
      load: () =>
        invokeParsed(invoke, "load_settings", z.unknown()).then((result) => {
          if (!result.ok) return result;
          const parsed = SettingsSchema.safeParse(result.value);
          return parsed.success
            ? platformOk(parsed.data)
            : platformFail(
                "integrity_failed",
                "The stored settings are invalid.",
              );
        }),
      save: async (settings) => {
        const result = await invokeVoid(invoke, "save_settings", { settings });
        return result.ok ? platformOk(settings) : result;
      },
    },
    configuration: {
      export: () =>
        invokeParsed(
          invoke,
          "export_configuration",
          ConfigurationEnvelopeSchema,
        ),
      async exportToSelectedFolder(filename) {
        if (!CONFIGURATION_EXPORT_FILENAME.test(filename)) {
          return platformFail(
            "invalid_input",
            "The configuration export filename is invalid.",
          );
        }
        const destination = await invokeParsed(
          invoke,
          "choose_output_destination",
          OutputDestinationGrantSchema.nullable(),
        );
        if (!destination.ok) return destination;
        if (destination.value === null) return platformOk(null);
        return invokeParsed(
          invoke,
          "export_configuration_to_folder",
          z.string().max(260),
          {
            grantId: destination.value.grantId,
            filename,
          },
        );
      },
      previewImport: (serialised) => {
        const byteLength = new TextEncoder().encode(serialised).byteLength;
        return byteLength === 0 || byteLength > MAX_CONFIGURATION_INPUT_BYTES
          ? Promise.resolve(
              platformFail(
                "invalid_input",
                "The configuration import size is outside the supported range.",
              ),
            )
          : invokeParsed(
              invoke,
              "preview_configuration_import",
              ConfigurationPreviewSchema,
              {
                serialised,
              },
            );
      },
      applyImport: (previewToken) =>
        invokeParsed(
          invoke,
          "apply_configuration_import",
          z.object({
            profiles: z.number().int().min(0),
            aliases: z.number().int().min(0),
            settings: z.number().int().min(0).max(1),
          }),
          { previewToken },
        ),
      async migrationStatus() {
        let inspection: Awaited<
          ReturnType<typeof legacyBrowserDb.inspectConfigurationForMigration>
        >;
        try {
          inspection = await legacyBrowserDb.inspectConfigurationForMigration();
        } catch {
          const native = await invokeParsed(
            invoke,
            "configuration_migration_status",
            ConfigurationMigrationStatusSchema,
            { legacySerialised: null },
          );
          if (!native.ok) return native;
          return platformOk({
            ...native.value,
            legacyConfigurationFound: true,
            valid: false,
            invalidCounts: { profiles: 0, aliases: 0, settings: 0 },
            validationMessages: [
              "The legacy WebView configuration could not be read. No records were migrated.",
            ],
          });
        }
        const legacySerialised =
          inspection.legacyConfigurationFound &&
          inspection.valid &&
          inspection.snapshot !== null
            ? JSON.stringify(
                await legacyConfigurationEnvelope(inspection.snapshot),
              )
            : null;
        const native = await invokeParsed(
          invoke,
          "configuration_migration_status",
          ConfigurationMigrationStatusSchema,
          { legacySerialised },
        );
        if (!native.ok) return native;
        return platformOk({
          ...native.value,
          legacyConfigurationFound: inspection.legacyConfigurationFound,
          valid: inspection.valid,
          invalidCounts: inspection.invalidCounts,
          validationMessages: inspection.validationMessages,
          counts: inspection.legacyConfigurationFound
            ? inspection.counts
            : native.value.counts,
        });
      },
      async previewLegacyImport() {
        let inspection: Awaited<
          ReturnType<typeof legacyBrowserDb.inspectConfigurationForMigration>
        >;
        try {
          inspection = await legacyBrowserDb.inspectConfigurationForMigration();
        } catch {
          return platformFail(
            "integrity_failed",
            "The legacy WebView configuration could not be read. No records were migrated.",
          );
        }
        if (!inspection.valid || inspection.snapshot === null) {
          return platformFail(
            "integrity_failed",
            inspection.validationMessages[0] ??
              "The legacy WebView configuration failed validation. No records were migrated.",
          );
        }
        const envelope = await legacyConfigurationEnvelope(inspection.snapshot);
        if (
          envelope.counts.profiles === 0 &&
          envelope.counts.aliases === 0 &&
          JSON.stringify(envelope.data.settings) ===
            JSON.stringify(DEFAULT_SETTINGS)
        ) {
          return platformFail(
            "unavailable",
            "No legacy WebView configuration was found.",
          );
        }
        return service.configuration.previewImport(JSON.stringify(envelope));
      },
    },
    recovery: {
      createBackup: (reason: BackupReason) =>
        invokeParsed(invoke, "create_backup", BackupSummarySchema, { reason }),
      listBackups: () =>
        invokeParsed(invoke, "list_backups", z.array(BackupSummarySchema)),
      previewRestore: (backupId) =>
        invokeParsed(invoke, "preview_restore", RestorePreviewSchema, {
          backupId: backupId ?? null,
        }),
      restore: (previewToken) =>
        invokeParsed(invoke, "restore_backup", BackupSummarySchema, {
          previewToken,
        }),
      previewReset: () =>
        invokeParsed(invoke, "preview_reset", ResetPreviewSchema),
      reset: (resetToken, confirmation) =>
        invokeParsed(invoke, "reset_application_data", BackupSummarySchema, {
          resetToken,
          confirmation,
        }),
    },
    search: {
      status: () =>
        invokeParsed(invoke, "provider_status", ProviderStatusSchema),
      async query(query) {
        const queryBytes = new TextEncoder().encode(query).byteLength;
        if (
          query.trim() === "" ||
          query.trim() !== query ||
          queryBytes > MAX_SEARCH_QUERY_BYTES ||
          hasControlCharacter(query)
        ) {
          return {
            state: "invalid_query",
            query: "",
            queryKind: "empty",
            provider: "native",
            results: [],
            band: null,
            detail:
              "Enter a product identifier or search phrase within the supported range.",
          };
        }
        const result = await invokeParsed(
          invoke,
          "search_competitors",
          LiveSearchOutcomeSchema,
          {
            query,
          },
        );
        if (result.ok) return result.value as LiveSearchOutcome;
        return {
          state:
            result.error.code === "not_configured"
              ? "not_configured"
              : result.error.code === "offline"
                ? "offline"
                : result.error.code === "timeout"
                  ? "timeout"
                  : result.error.code === "quota_exhausted"
                    ? "quota_exhausted"
                    : result.error.code === "rate_limited"
                      ? "rate_limited"
                      : "provider_error",
          query,
          queryKind: query.trim() ? "free-text" : "empty",
          provider: "native",
          results: [],
          band: null,
          detail: result.error.message,
        };
      },
      setPaidCallsEnabled: (enabled, costCeilingCents, costPerCallCents) => {
        if (
          enabled &&
          (!Number.isSafeInteger(costCeilingCents) ||
            !Number.isSafeInteger(costPerCallCents) ||
            (costCeilingCents ?? 0) <= 0 ||
            (costCeilingCents ?? 0) > 1_000_000_000 ||
            (costPerCallCents ?? 0) <= 0 ||
            (costPerCallCents ?? 0) > (costCeilingCents ?? 0))
        ) {
          return Promise.resolve(
            platformFail(
              "invalid_input",
              "Enter a valid positive provider budget and per-call reservation.",
            ),
          );
        }
        return invokeParsed(
          invoke,
          "set_provider_paid_calls",
          ProviderStatusSchema,
          {
            enabled,
            costCeilingCents: enabled ? costCeilingCents : null,
            costPerCallCents: enabled ? costPerCallCents : null,
          },
        );
      },
      configureCredential: (secret) =>
        validCredential(secret)
          ? invokeParsed(
              invoke,
              "configure_provider_credential",
              ProviderStatusSchema,
              { secret },
            )
          : Promise.resolve(
              platformFail(
                "invalid_input",
                "The provider credential is outside the supported range.",
              ),
            ),
      validateCredential: () =>
        invokeParsed(
          invoke,
          "validate_provider_credential",
          ProviderStatusSchema,
        ),
      replaceCredential: (secret) =>
        validCredential(secret)
          ? invokeParsed(
              invoke,
              "replace_provider_credential",
              ProviderStatusSchema,
              { secret },
            )
          : Promise.resolve(
              platformFail(
                "invalid_input",
                "The provider credential is outside the supported range.",
              ),
            ),
      removeCredential: () =>
        invokeParsed(
          invoke,
          "remove_provider_credential",
          ProviderStatusSchema,
        ),
    },
    files: {
      chooseInputFile: (role) => chooseAndReadInputFile(invoke, role),
      chooseOutputDestination: () =>
        invokeParsed(
          invoke,
          "choose_output_destination",
          OutputDestinationGrantSchema.nullable(),
        ),
      async saveOutputs(destination, outputs) {
        if (outputs.length !== 5) {
          return platformFail(
            "invalid_input",
            "Exactly five operational outputs must be saved together.",
          );
        }

        const prepared: PreparedExport[] = [];
        for (const output of outputs) {
          if (output.blob.size === 0 || output.blob.size > MAX_EXPORT_BYTES) {
            return platformFail(
              "invalid_input",
              "An output file size is outside the supported range.",
            );
          }
          const buffer = await output.blob.arrayBuffer();
          prepared.push({
            output,
            length: buffer.byteLength,
            sha256: await sha256Hex(buffer),
          });
        }

        const reservation = await invokeParsed(
          invoke,
          "reserve_export_batch",
          ExportBatchReservationSchema,
          {
            grantId: destination.grantId,
            files: prepared.map(({ output, length, sha256 }) => ({
              filename: output.filename,
              length,
              sha256,
            })),
          },
        );
        if (!reservation.ok) {
          return platformOk({
            written: [],
            failed: outputs.map((output) => ({
              filename: output.filename,
              error: reservation.error.message,
              code: reservation.error.code,
            })),
          });
        }

        const { batchId } = reservation.value;
        for (const item of prepared) {
          const result = await saveOneOutput(
            invoke,
            batchId,
            destination.grantId,
            item,
          );
          if (!result.ok) {
            await invokeVoid(invoke, "abort_export_batch", { batchId });
            return platformOk({
              written: [],
              failed: outputs.map((output) => ({
                filename: output.filename,
                error: result.error.message,
                code: result.error.code,
              })),
            });
          }
        }

        const committed = await invokeParsed(
          invoke,
          "commit_export_batch",
          z.array(z.string().min(1).max(512)).length(5),
          { batchId },
        );
        if (!committed.ok) {
          await invokeVoid(invoke, "abort_export_batch", { batchId });
          return platformOk({
            written: [],
            failed: outputs.map((output) => ({
              filename: output.filename,
              error: committed.error.message,
              code: committed.error.code,
            })),
          });
        }

        const expected = new Set(outputs.map((output) => output.filename));
        const actual = new Set(committed.value);
        if (
          expected.size !== 5 ||
          actual.size !== 5 ||
          [...expected].some((name) => !actual.has(name))
        ) {
          return platformFail(
            "integrity_failed",
            "The desktop export confirmation did not match the five requested files.",
          );
        }
        const value: PlatformSaveResult = {
          written: outputs.map((output) => output.filename),
          failed: [],
        };
        return platformOk(value);
      },
      openVerifiedSource: (url) =>
        invokeVoid(invoke, "open_verified_source", { url }),
    },
  };

  return service;
}

/** Narrow compatibility type used by UI tests and the adapter context. */
export type DesktopHealth = LiveHealth;
