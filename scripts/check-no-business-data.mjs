#!/usr/bin/env node
/**
 * Pre-commit-safe repository check: detects likely business exports and
 * secrets among files proposed for commit, including untracked non-ignored files,
 * without uploading or
 * printing their contents. Run with:  npm run check:data-safety
 *
 * Exit code 0 = clean, 1 = findings that must be reviewed before committing.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

const ALLOWED_DATA_PATHS = [/^tests\/fixtures\//, /^src\/demo\//];

const SUSPICIOUS_NAME = [
  { re: /\.(xlsx|xls|csv)$/i, why: "spreadsheet export" },
  { re: /servicem8/i, why: "ServiceM8 export name" },
  { re: /supplier.*(price|list|export)/i, why: "supplier export name" },
  { re: /(price-?list)/i, why: "price list name" },
  { re: /\.(pem|key|p12|pfx)$/i, why: "private key material" },
  // .env.example is the committed placeholder template; real env files stay blocked.
  { re: /^\.env(?!\.example$)(\..+)?$/, why: "environment file" },
  {
    re: /(credential|secret)s?.*\.(json|ya?ml|txt)$/i,
    why: "credential file name",
  },
  {
    re: /(?:^|\/)(?:\d{8}-.+[-_])?(?:rollback|import-candidate|change-report|exceptions|audit-summary)(?:-|_)/i,
    why: "generated output",
  },
];

const SUSPICIOUS_CONTENT = [
  {
    re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    why: "private key block",
  },
  { re: /\bAKIA[0-9A-Z]{16}\b/, why: "AWS access key id" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, why: "GitHub token" },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/, why: "API secret key" },
  { re: /smk_[A-Za-z0-9]{16,}/, why: "ServiceM8-style API key" },
];

const TEXT_EXTENSIONS =
  /\.(ts|tsx|js|mjs|cjs|json|md|css|html|yml|yaml|txt|csv)$/i;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

const files = new Set(
  [
    ...git(["ls-files"]).split("\n"),
    ...git(["diff", "--cached", "--name-only"]).split("\n"),
    ...git(["ls-files", "--others", "--exclude-standard"]).split("\n"),
  ]
    .map((f) => f.trim())
    .filter(Boolean),
);
// A tracked file staged for deletion can still exist locally when it becomes
// ignored (for example .env). Audit the proposed tracked result, not that
// intentionally retained local file.
const deletedFromIndex = new Set(
  git(["diff", "--cached", "--diff-filter=D", "--name-only"])
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean),
);
for (const file of deletedFromIndex) files.delete(file);

const findings = [];
for (const file of files) {
  const allowed = ALLOWED_DATA_PATHS.some((re) => re.test(file));
  for (const { re, why } of SUSPICIOUS_NAME) {
    if (re.test(file) && !(allowed && /spreadsheet|price list/.test(why))) {
      findings.push(`${file}: filename looks like ${why}`);
    }
  }
  if (TEXT_EXTENSIONS.test(file)) {
    if (!existsSync(file)) continue;
    try {
      if (statSync(file).size > 2 * 1024 * 1024) continue;
      const content = readFileSync(file, "utf8");
      for (const { re, why } of SUSPICIOUS_CONTENT) {
        if (re.test(content)) findings.push(`${file}: content matches ${why}`);
      }
    } catch (error) {
      throw new Error(`Data-safety check could not inspect ${file}.`, {
        cause: error,
      });
    }
  }
}

if (findings.length > 0) {
  console.error(
    "Possible business data or secrets detected (contents NOT shown):",
  );
  for (const f of findings) console.error(`  - ${f}`);
  console.error(
    "\nReal supplier exports, ServiceM8 exports, generated outputs and secrets must never be committed to this repository.",
  );
  process.exit(1);
}
console.log(
  `Data-safety check passed: ${files.size} proposed paths, no suspicious names or content.`,
);
