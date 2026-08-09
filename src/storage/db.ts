import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { MappingProfile } from "../core/mapping";
import {
  SettingsSchema,
  DEFAULT_SETTINGS,
  type Settings,
} from "../core/settings";
import type { AliasRecord } from "../platform/contracts";
import { AliasRecordSchema, MappingProfileSchema } from "../platform/schemas";

export type { AliasRecord } from "../platform/contracts";

/**
 * Local browser storage (IndexedDB). ONLY three kinds of data are ever
 * persisted, all operator-authored configuration:
 *   - mapping profiles (column layouts, header names)
 *   - approved aliases (supplier code -> ServiceM8 item number)
 *   - settings (markup %, tax handling, theme)
 * Imported business rows are NEVER written to storage.
 */

interface SwlDb extends DBSchema {
  profiles: { key: string; value: MappingProfile };
  aliases: { key: string; value: AliasRecord };
  settings: { key: string; value: Settings };
}

const DB_NAME = "swl-pricing-inventory";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<SwlDb>> | null = null;

function db(): Promise<IDBPDatabase<SwlDb>> {
  dbPromise ??= openDB<SwlDb>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      database.createObjectStore("profiles");
      database.createObjectStore("aliases");
      database.createObjectStore("settings");
    },
  });
  return dbPromise;
}

export async function loadSettings(): Promise<Settings> {
  const raw = await (await db()).get("settings", "settings");
  if (raw === undefined) return DEFAULT_SETTINGS;
  const parsed = SettingsSchema.safeParse(raw);
  if (!parsed.success) throw new Error("stored settings failed validation");
  return parsed.data;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await (await db()).put("settings", settings, "settings");
}

export async function listProfiles(): Promise<MappingProfile[]> {
  const all = await (await db()).getAll("profiles");
  const profiles: MappingProfile[] = [];
  for (const profile of all) {
    const parsed = MappingProfileSchema.safeParse(profile);
    if (!parsed.success)
      throw new Error("stored mapping profile failed validation");
    profiles.push(parsed.data);
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveProfile(profile: MappingProfile): Promise<void> {
  await (await db()).put("profiles", profile, profile.id);
}

export async function deleteProfile(id: string): Promise<void> {
  await (await db()).delete("profiles", id);
}

export async function listAliases(): Promise<AliasRecord[]> {
  const all = await (await db()).getAll("aliases");
  const aliases: AliasRecord[] = [];
  for (const alias of all) {
    const parsed = AliasRecordSchema.safeParse(alias);
    if (!parsed.success)
      throw new Error("stored approved alias failed validation");
    aliases.push(parsed.data);
  }
  return aliases;
}

export async function saveAlias(alias: AliasRecord): Promise<void> {
  await (await db()).put("aliases", alias, alias.supplierCode);
}

export async function deleteAlias(supplierCode: string): Promise<void> {
  await (await db()).delete("aliases", supplierCode);
}

/** "Delete saved profiles and aliases" — wipes every persisted store. */
export async function deleteAllStoredData(): Promise<void> {
  const database = await db();
  await database.clear("profiles");
  await database.clear("aliases");
  await database.clear("settings");
}

export interface BrowserConfigurationSnapshot {
  profiles: MappingProfile[];
  aliases: AliasRecord[];
  settings: Settings;
}

export interface BrowserConfigurationInspection {
  legacyConfigurationFound: boolean;
  valid: boolean;
  counts: { profiles: number; aliases: number; settings: 1 };
  invalidCounts: { profiles: number; aliases: number; settings: number };
  validationMessages: string[];
  snapshot: BrowserConfigurationSnapshot | null;
}

const MAX_MIGRATION_BYTES = 10 * 1024 * 1024;
const MAX_MIGRATION_PROFILES = 1_000;
const MAX_MIGRATION_ALIASES = 100_000;

/** Pure validation used before any one-time WebView-to-native migration. */
export function inspectConfigurationValues(
  rawProfiles: readonly unknown[],
  profileKeys: readonly IDBValidKey[],
  rawAliases: readonly unknown[],
  aliasKeys: readonly IDBValidKey[],
  rawSettings: unknown,
): BrowserConfigurationInspection {
  const messages: string[] = [];
  const profiles: MappingProfile[] = [];
  const aliases: AliasRecord[] = [];
  let invalidProfiles = 0;
  let invalidAliases = 0;
  for (const [index, raw] of rawProfiles.entries()) {
    const parsed = MappingProfileSchema.safeParse(raw);
    if (!parsed.success || profileKeys[index] !== parsed.data.id) {
      invalidProfiles += 1;
    } else {
      profiles.push(parsed.data);
    }
  }
  for (const [index, raw] of rawAliases.entries()) {
    const parsed = AliasRecordSchema.safeParse(raw);
    if (!parsed.success || aliasKeys[index] !== parsed.data.supplierCode) {
      invalidAliases += 1;
    } else {
      aliases.push(parsed.data);
    }
  }
  const parsedSettings =
    rawSettings === undefined ? null : SettingsSchema.safeParse(rawSettings);
  const invalidSettings =
    parsedSettings !== null && !parsedSettings.success ? 1 : 0;

  if (rawProfiles.length > MAX_MIGRATION_PROFILES) {
    messages.push(
      `The legacy profile count exceeds ${MAX_MIGRATION_PROFILES}.`,
    );
  }
  if (rawAliases.length > MAX_MIGRATION_ALIASES) {
    messages.push(`The legacy alias count exceeds ${MAX_MIGRATION_ALIASES}.`);
  }
  if (invalidProfiles > 0) {
    messages.push(
      `${invalidProfiles} legacy mapping profile record(s) failed validation.`,
    );
  }
  if (invalidAliases > 0) {
    messages.push(
      `${invalidAliases} legacy approved alias record(s) failed validation.`,
    );
  }
  if (invalidSettings > 0) {
    messages.push("The legacy settings record failed validation.");
  }
  try {
    const byteLength = new TextEncoder().encode(
      JSON.stringify({
        profiles: rawProfiles,
        aliases: rawAliases,
        settings: rawSettings,
      }),
    ).byteLength;
    if (byteLength > MAX_MIGRATION_BYTES) {
      messages.push(
        "The legacy configuration exceeds the 10 MiB migration limit.",
      );
    }
  } catch {
    messages.push("The legacy configuration could not be encoded safely.");
  }

  const identifiers = new Set<string>();
  for (const profile of profiles) {
    if (identifiers.has(profile.id)) {
      messages.push(
        "The legacy configuration contains duplicate profile identifiers.",
      );
      break;
    }
    identifiers.add(profile.id);
  }
  const supplierCodes = new Set<string>();
  for (const alias of aliases) {
    if (supplierCodes.has(alias.supplierCode)) {
      messages.push(
        "The legacy configuration contains duplicate alias identifiers.",
      );
      break;
    }
    supplierCodes.add(alias.supplierCode);
  }

  const settings = parsedSettings?.success
    ? parsedSettings.data
    : DEFAULT_SETTINGS;
  const legacyConfigurationFound =
    rawProfiles.length > 0 ||
    rawAliases.length > 0 ||
    rawSettings !== undefined;
  const valid = messages.length === 0;
  return {
    legacyConfigurationFound,
    valid,
    counts: {
      profiles: rawProfiles.length,
      aliases: rawAliases.length,
      settings: 1,
    },
    invalidCounts: {
      profiles: invalidProfiles,
      aliases: invalidAliases,
      settings: invalidSettings,
    },
    validationMessages: messages,
    snapshot: valid
      ? {
          profiles: profiles.sort((left, right) =>
            left.name.localeCompare(right.name),
          ),
          aliases,
          settings,
        }
      : null,
  };
}

/** Strict, non-mutating inspection for one-time WebView-to-native migration. */
export async function inspectConfigurationForMigration(): Promise<BrowserConfigurationInspection> {
  const database = await db();
  const transaction = database.transaction(
    ["profiles", "aliases", "settings"],
    "readonly",
  );
  const profileStore = transaction.objectStore("profiles");
  const aliasStore = transaction.objectStore("aliases");
  const settingsStore = transaction.objectStore("settings");
  const [rawProfiles, profileKeys, rawAliases, aliasKeys, rawSettings] =
    await Promise.all([
      profileStore.getAll(),
      profileStore.getAllKeys(),
      aliasStore.getAll(),
      aliasStore.getAllKeys(),
      settingsStore.get("settings"),
    ]);
  await transaction.done;
  return inspectConfigurationValues(
    rawProfiles,
    profileKeys,
    rawAliases,
    aliasKeys,
    rawSettings,
  );
}

/** Read only the operator-authored configuration stores, never imported rows. */
export async function readConfigurationSnapshot(): Promise<BrowserConfigurationSnapshot> {
  const [profiles, aliases, settings] = await Promise.all([
    listProfiles(),
    listAliases(),
    loadSettings(),
  ]);
  return { profiles, aliases, settings };
}

/** Replace configuration atomically after a separate validated preview. */
export async function replaceConfigurationSnapshot(
  snapshot: BrowserConfigurationSnapshot,
): Promise<void> {
  const database = await db();
  const transaction = database.transaction(
    ["profiles", "aliases", "settings"],
    "readwrite",
  );
  await Promise.all([
    transaction.objectStore("profiles").clear(),
    transaction.objectStore("aliases").clear(),
    transaction.objectStore("settings").clear(),
  ]);
  for (const profile of snapshot.profiles) {
    await transaction.objectStore("profiles").put(profile, profile.id);
  }
  for (const alias of snapshot.aliases) {
    await transaction.objectStore("aliases").put(alias, alias.supplierCode);
  }
  await transaction.objectStore("settings").put(snapshot.settings, "settings");
  await transaction.done;
}

/**
 * Clear configuration only when it is byte-for-byte the strictly validated
 * snapshot the operator previewed. The comparison and clear share one IDB
 * read/write transaction, so another tab cannot substitute same-count data.
 */
export async function deleteConfigurationSnapshotIfUnchanged(
  expected: BrowserConfigurationSnapshot,
): Promise<boolean> {
  const database = await db();
  const transaction = database.transaction(
    ["profiles", "aliases", "settings"],
    "readwrite",
  );
  const profileStore = transaction.objectStore("profiles");
  const aliasStore = transaction.objectStore("aliases");
  const settingsStore = transaction.objectStore("settings");
  const [rawProfiles, profileKeys, rawAliases, aliasKeys, rawSettings] =
    await Promise.all([
      profileStore.getAll(),
      profileStore.getAllKeys(),
      aliasStore.getAll(),
      aliasStore.getAllKeys(),
      settingsStore.get("settings"),
    ]);
  const inspection = inspectConfigurationValues(
    rawProfiles,
    profileKeys,
    rawAliases,
    aliasKeys,
    rawSettings,
  );
  if (
    !inspection.valid ||
    inspection.snapshot === null ||
    JSON.stringify(inspection.snapshot) !== JSON.stringify(expected)
  ) {
    await transaction.done;
    return false;
  }
  await Promise.all([
    profileStore.clear(),
    aliasStore.clear(),
    settingsStore.clear(),
  ]);
  await transaction.done;
  return true;
}
