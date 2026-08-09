import { sanitizeFilenamePart } from "./sanitize";

/** Short, unambiguous run identifier (crypto-random, base32-like). */
export function newRunId(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTVWXYZ0123456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

export type OutputPurpose =
  | "import-candidate"
  | "change-report"
  | "exceptions"
  | "rollback"
  | "audit-summary";

/** Calendar-date prefix in the operator's local timezone. */
export function datePrefix(date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

/**
 * Deterministic, sanitised output filename:
 *   <yyyymmdd>-<profile>_<purpose>_run-<id>.<ext>
 */
export function outputFilename(
  date: Date,
  profileName: string,
  purpose: OutputPurpose,
  runId: string,
  extension: "xlsx" | "txt",
): string {
  return `${datePrefix(date)}-${sanitizeFilenamePart(profileName)}_${purpose}_run-${runId}.${extension}`;
}
