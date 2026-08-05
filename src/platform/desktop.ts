import type { GeneratedOutput } from '../io/exportWorkbooks';

/**
 * Desktop gateway for the Tauri Windows shell.
 *
 * The web build never loads any Tauri code: the shell injects its API onto
 * `window.__TAURI__` (withGlobalTauri), so this module is dependency-free and
 * degrades safely to browser behaviour when the global is absent.
 *
 * All file writing happens in Rust (`src-tauri/src/lib.rs`), which sanitises
 * filenames and rejects path traversal. The frontend only ever passes the
 * folder handle returned by the native picker plus a plain filename.
 */

interface TauriGlobal {
  core: { invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> };
}

function tauri(): TauriGlobal | null {
  const candidate = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  return candidate && typeof candidate.core?.invoke === 'function' ? candidate : null;
}

/** True when running inside the packaged desktop shell. */
export function isDesktop(): boolean {
  return tauri() !== null;
}

/** Open the native folder picker. Returns the chosen path, or null on cancel. */
export async function chooseOutputFolder(): Promise<string | null> {
  const api = tauri();
  if (!api) return null;
  return api.core.invoke<string | null>('choose_output_folder');
}

export interface DesktopSaveResult {
  written: string[];
  failed: { filename: string; error: string }[];
}

/** Write every generated output into the chosen folder via the native shell. */
export async function saveOutputsToFolder(
  folder: string,
  outputs: readonly GeneratedOutput[],
): Promise<DesktopSaveResult> {
  const api = tauri();
  if (!api)
    return {
      written: [],
      failed: outputs.map((o) => ({ filename: o.filename, error: 'Desktop shell unavailable.' })),
    };
  const written: string[] = [];
  const failed: { filename: string; error: string }[] = [];
  for (const output of outputs) {
    try {
      const bytes = new Uint8Array(await output.blob.arrayBuffer());
      const path = await api.core.invoke<string>('write_export_file', {
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
