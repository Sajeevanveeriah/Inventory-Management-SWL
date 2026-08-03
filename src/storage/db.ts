import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { z } from 'zod';
import type { MappingProfile } from '../core/mapping';
import { SettingsSchema, DEFAULT_SETTINGS, type Settings } from '../core/settings';

/**
 * Local browser storage (IndexedDB). ONLY three kinds of data are ever
 * persisted, all operator-authored configuration:
 *   - mapping profiles (column layouts, header names)
 *   - approved aliases (supplier code -> ServiceM8 item number)
 *   - settings (markup %, tax handling, theme)
 * Imported business rows are NEVER written to storage.
 */

export interface AliasRecord {
  /** Normalised supplier code (key). */
  supplierCode: string;
  /** Normalised ServiceM8 item number the operator approved. */
  itemNumber: string;
  approvedAt: string;
}

interface SwlDb extends DBSchema {
  profiles: { key: string; value: MappingProfile };
  aliases: { key: string; value: AliasRecord };
  settings: { key: string; value: Settings };
}

const DB_NAME = 'swl-pricing-inventory';
const DB_VERSION = 1;

const MappingSchema = z.record(z.string(), z.number().int().min(0));
const ProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.number().int().min(1),
  supplierMapping: MappingSchema,
  supplierHeaders: z.array(z.string()),
  servicem8Mapping: MappingSchema,
  servicem8Headers: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

let dbPromise: Promise<IDBPDatabase<SwlDb>> | null = null;

function db(): Promise<IDBPDatabase<SwlDb>> {
  dbPromise ??= openDB<SwlDb>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      database.createObjectStore('profiles');
      database.createObjectStore('aliases');
      database.createObjectStore('settings');
    },
  });
  return dbPromise;
}

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await (await db()).get('settings', 'settings');
    const parsed = SettingsSchema.safeParse(raw);
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await (await db()).put('settings', settings, 'settings');
}

export async function listProfiles(): Promise<MappingProfile[]> {
  try {
    const all = await (await db()).getAll('profiles');
    return all
      .filter((p) => ProfileSchema.safeParse(p).success)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export async function saveProfile(profile: MappingProfile): Promise<void> {
  await (await db()).put('profiles', profile, profile.id);
}

export async function deleteProfile(id: string): Promise<void> {
  await (await db()).delete('profiles', id);
}

export async function listAliases(): Promise<AliasRecord[]> {
  try {
    return await (await db()).getAll('aliases');
  } catch {
    return [];
  }
}

export async function saveAlias(alias: AliasRecord): Promise<void> {
  await (await db()).put('aliases', alias, alias.supplierCode);
}

export async function deleteAlias(supplierCode: string): Promise<void> {
  await (await db()).delete('aliases', supplierCode);
}

/** "Delete saved profiles and aliases" — wipes every persisted store. */
export async function deleteAllStoredData(): Promise<void> {
  const database = await db();
  await database.clear('profiles');
  await database.clear('aliases');
  await database.clear('settings');
}
