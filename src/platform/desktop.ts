import type { GeneratedOutput } from '../io/exportWorkbooks';
import { invoke } from '@tauri-apps/api/core';

/**
 * Desktop gateway for the Tauri Windows shell.
 *
 * The shared bundle imports the reviewed Tauri API package, while runtime
 * protocol detection ensures browser builds never attempt an IPC invocation.
 *
 * All file writing happens in Rust (`src-tauri/src/lib.rs`), which sanitises
 * filenames and rejects path traversal. The frontend only ever passes the
 * folder handle returned by the native picker plus a plain filename.
 */

/** True when running inside the packaged desktop shell. */
export function isDesktop(): boolean {
  return window.location.protocol === 'tauri:' || window.location.hostname === 'tauri.localhost';
}

/** Open the native folder picker. Returns the chosen path, or null on cancel. */
export async function chooseOutputFolder(): Promise<string | null> {
  if (!isDesktop()) return null;
  return invoke<string | null>('choose_output_folder');
}

export interface DesktopSaveResult {
  written: string[];
  failed: { filename: string; error: string }[];
}

export interface DesktopHealth {
  ok: boolean;
  provider: string;
  liveSearchConfigured: boolean;
  fixtureMode: boolean;
  schemaVersion: number;
}

/** Read native service health without making an HTTP request. */
export async function readDesktopHealth(): Promise<DesktopHealth | null> {
  if (!isDesktop()) return null;
  return invoke<DesktopHealth>('desktop_health');
}

/** Write every generated output into the chosen folder via the native shell. */
export async function saveOutputsToFolder(
  folder: string,
  outputs: readonly GeneratedOutput[],
): Promise<DesktopSaveResult> {
  if (!isDesktop())
    return {
      written: [],
      failed: outputs.map((o) => ({ filename: o.filename, error: 'Desktop shell unavailable.' })),
    };
  const written: string[] = [];
  const failed: { filename: string; error: string }[] = [];
  for (const output of outputs) {
    try {
      const bytes = new Uint8Array(await output.blob.arrayBuffer());
      const path = await invoke<string>('write_export_file', {
        folder,
        filename: output.filename,
        contents: Array.from(bytes),
      });
      written.push(path);
    } catch (err) {
      failed.push({ filename: output.filename, error: sanitiseError(err) });
    }
  }
  return { written, failed };
}

function sanitiseError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Native errors can embed absolute paths; keep only the final message part.
  return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
}
