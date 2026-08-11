#!/usr/bin/env node
/** Validate the GitHub Pages production build without starting a server. */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const base = process.env.PAGES_BASE ?? "/Inventory-Management-SWL/";
if (!/^\/[A-Za-z0-9._/-]+\/$/.test(base) || base.includes("..")) {
  throw new Error(
    "PAGES_BASE must be a safe absolute project path ending in /.",
  );
}

const root = path.resolve("dist");
const indexPath = path.join(root, "index.html");
if (!existsSync(indexPath))
  throw new Error("dist/index.html is missing. Build Pages first.");
const index = readFileSync(indexPath, "utf8");

if (!index.includes("Content-Security-Policy")) {
  throw new Error("The Pages index is missing the production CSP.");
}
const configuredApiOrigin = process.env.VITE_LIVE_SEARCH_API_ORIGIN ?? "";
if (
  process.env.VITE_REQUIRE_LIVE_SEARCH_API_ORIGIN === "true" &&
  configuredApiOrigin === ""
) {
  throw new Error(
    "VITE_LIVE_SEARCH_API_ORIGIN is required for this Pages build.",
  );
}
if (configuredApiOrigin) {
  const parsed = new globalThis.URL(configuredApiOrigin);
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== configuredApiOrigin ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error(
      "The configured live-search API origin is not canonical HTTPS.",
    );
  }
}
const cspContent =
  index.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ??
  "";
const connectDirective = cspContent
  .split(";")
  .map((directive) => directive.trim())
  .find((directive) => directive.startsWith("connect-src "));
const expectedConnectDirective = `connect-src 'self'${
  configuredApiOrigin ? ` ${configuredApiOrigin}` : ""
}`;
if (connectDirective !== expectedConnectDirective) {
  throw new Error(
    `The Pages CSP connect boundary is invalid: ${connectDirective ?? "missing"}`,
  );
}
for (const forbidden of [
  "unsafe-eval",
  "script-src *",
  "font-src *",
  "connect-src *",
]) {
  if (index.includes(forbidden))
    throw new Error(`The Pages CSP contains forbidden value: ${forbidden}`);
}

const refs = [...index.matchAll(/(?:src|href)="([^"]+)"/g)].map(
  (match) => match[1],
);
const localRefs = refs.filter(
  (ref) => !ref.startsWith("#") && !ref.startsWith("data:"),
);
if (localRefs.length === 0)
  throw new Error("The Pages index contains no local assets.");

for (const ref of localRefs) {
  if (/^[a-z]+:/i.test(ref) || ref.startsWith("//")) {
    throw new Error(`Remote production asset is forbidden: ${ref}`);
  }
  if (!ref.startsWith(base) && !ref.startsWith("./")) {
    throw new Error(
      `Production asset is outside the Pages base ${base}: ${ref}`,
    );
  }
  const relative = (
    ref.startsWith(base) ? ref.slice(base.length) : ref.slice(2)
  ).split(/[?#]/, 1)[0];
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Production asset escapes dist: ${ref}`);
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error(`Referenced production asset is missing: ${ref}`);
  }
}

function allFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    return entry.isDirectory() ? allFiles(candidate) : [candidate];
  });
}

const javascript = allFiles(root)
  .filter((file) => file.endsWith(".js"))
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");
const routes = [
  "#/dashboard",
  "#/new-run",
  "#/runs",
  "#/inventory",
  "#/expansion",
  "#/suppliers",
  "#/mapping-profiles",
  "#/pricing-rules",
  "#/competitors",
  "#/sources",
  "#/exceptions",
  "#/approvals",
  "#/exports",
  "#/integrations",
  "#/audit",
  "#/settings",
  "#/help",
];
for (const route of routes) {
  if (!javascript.includes(route))
    throw new Error(`Compiled hash route is missing: ${route}`);
}

console.log(
  `Pages build check passed: ${localRefs.length} local assets and ${routes.length} hash routes.`,
);
