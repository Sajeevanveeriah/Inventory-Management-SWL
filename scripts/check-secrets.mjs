#!/usr/bin/env node
/** Scan the proposed tree and/or reachable Git blobs without printing secret values. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

const MAX_BYTES = 2 * 1024 * 1024;
const TEXT_PATH =
  /\.(?:c|cc|cert|cjs|cpp|crt|cs|css|cts|env|html|java|js|jsx|json|key|md|mjs|mts|pem|ps1|py|rs|sh|svg|toml|ts|tsx|txt|xml|ya?ml)$/i;
const ENV_PATH = /(?:^|\/)\.env(?:\.[^/]+)?$/i;
const PATTERNS = [
  {
    re: new RegExp(
      ["-----BEGIN ", "(?:RSA |EC |OPENSSH )?", "PRIVATE KEY-----"].join(""),
    ),
    why: "private key block",
  },
  {
    re: new RegExp(["\\bAKIA", "[0-9A-Z]{16}\\b"].join("")),
    why: "AWS access key id",
  },
  {
    re: new RegExp(["\\bgh", "[pousr]_[A-Za-z0-9]{30,}\\b"].join("")),
    why: "GitHub token",
  },
  {
    re: new RegExp(["\\bsk-", "[A-Za-z0-9_-]{20,}\\b"].join("")),
    why: "API secret key",
  },
  {
    re: new RegExp(["\\bAIza", "[A-Za-z0-9_-]{30,}\\b"].join("")),
    why: "Google API key",
  },
  {
    re: new RegExp(["\\bxox", "[abprs]-[A-Za-z0-9-]{20,}\\b"].join("")),
    why: "Slack token",
  },
  {
    re: new RegExp(
      ["\\b(?:sk|rk)_(?:live|test)_", "[A-Za-z0-9]{20,}\\b"].join(""),
    ),
    why: "Stripe key",
  },
  {
    re: new RegExp(["\\bsmk_", "[A-Za-z0-9]{16,}\\b"].join("")),
    why: "ServiceM8-style key",
  },
  {
    re: /\b(?:api[_-]?key|client[_-]?secret|password|access[_-]?token)\s*[:=]\s*["'][A-Za-z0-9/+_.=-]{16,}["']/i,
    why: "assigned credential",
  },
  {
    re: /\b(?:SERPAPI_KEY|SERVICEM8(?:_API)?_KEY|XERO_CLIENT_SECRET|PROVIDER_(?:API_KEY|TOKEN))\s*[:=]\s*(?:["'][A-Za-z0-9/+_.=-]{16,}["']|[A-Za-z0-9/+_=-]{16,})/i,
    why: "assigned provider credential",
  },
];
const PLACEHOLDER =
  /(?:example|fixture|placeholder|redacted|dummy|change[_ -]?me|not[_ -]?a[_ -]?real|replace[_ -]?with)/i;
const scopeArgument = process.argv.find((argument) =>
  argument.startsWith("--scope="),
);
const scope = scopeArgument?.slice("--scope=".length) ?? "all";
if (!["all", "current", "history"].includes(scope)) {
  console.error("Secret scan scope must be all, current or history.");
  process.exit(2);
}
const scanCurrent = scope === "all" || scope === "current";
const scanHistory = scope === "all" || scope === "history";

function git(args, options = {}) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    throw new Error(
      `Secret scan could not inspect Git metadata (${args[0]} failed).`,
      {
        cause: error,
      },
    );
  }
}

function isTextPath(file) {
  return TEXT_PATH.test(file) || ENV_PATH.test(file);
}

function inspect(content, label, findings) {
  for (const { re, why } of PATTERNS) {
    const match = content.match(re);
    if (match && !PLACEHOLDER.test(match[0]))
      findings.push(`${label}: matches ${why}`);
  }
}

const findings = [];
const currentFiles = new Set();
if (scanCurrent) {
  for (const file of [
    ...git(["ls-files"]).split("\n"),
    ...git(["diff", "--cached", "--name-only"]).split("\n"),
    ...git(["ls-files", "--others", "--exclude-standard"]).split("\n"),
  ]
    .map((candidate) => candidate.trim())
    .filter(Boolean)) {
    currentFiles.add(file);
  }
  for (const file of currentFiles) {
    if (!isTextPath(file)) continue;
    if (ENV_PATH.test(file) && !/\.env\.example$/iu.test(file)) {
      findings.push(`${file}: environment file requires credential review`);
    }
    // A staged deletion has no current content. Every existing candidate must be
    // readable; permission or I/O failures are scan failures, not silent skips.
    if (!existsSync(file)) continue;
    if (statSync(file).size <= MAX_BYTES)
      inspect(readFileSync(file, "utf8"), file, findings);
  }
}

const seen = new Set();
if (scanHistory) {
  const historicalObjects = git(["rev-list", "--objects", "--all"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of historicalObjects) {
    const separator = line.indexOf(" ");
    if (separator < 0) continue;
    const object = line.slice(0, separator);
    const file = line.slice(separator + 1);
    if (ENV_PATH.test(file) && !/\.env\.example$/iu.test(file)) {
      findings.push(
        `${file} (history blob ${object.slice(0, 12)}): historical environment file requires credential rotation review`,
      );
    }
    if (seen.has(object) || !isTextPath(file)) continue;
    seen.add(object);
    if (git(["cat-file", "-t", object]).trim() !== "blob") continue;
    const size = Number(git(["cat-file", "-s", object]).trim());
    if (!Number.isFinite(size) || size > MAX_BYTES) continue;
    const content = execFileSync("git", ["cat-file", "blob", object], {
      encoding: "utf8",
      maxBuffer: MAX_BYTES + 1024,
    });
    inspect(content, `${file} (history blob ${object.slice(0, 12)})`, findings);
  }
}

if (findings.length > 0) {
  console.error("Possible secrets detected (values NOT shown):");
  for (const finding of [...new Set(findings)]) console.error(`  - ${finding}`);
  process.exit(1);
}
console.log(
  `Secret scan passed for ${scope}: ${currentFiles.size} current paths and ${seen.size} unique history blobs checked.`,
);
