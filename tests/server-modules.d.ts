/**
 * The server component is plain Node ESM (.mjs files under server/) with no
 * TypeScript build step. Tests exercise it directly; this wildcard declaration
 * keeps the strict client typecheck green without duplicating server types.
 */
declare module '*.mjs';
