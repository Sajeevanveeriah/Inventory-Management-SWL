#!/usr/bin/env node
/** Scan the proposed tree and/or reachable Git blobs without printing secret values. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

const MAX_BYTES = 2 * 1024 * 1024;
const TEXT_PATH =
  /\.(?:c|cc|cert|cjs|cpp|crt|cs|css|cts|env|html|java|js|jsx|json|key|md|mjs|mts|pem|ps1|py|rs|sh|svg|toml|ts|tsx|txt|xml|ya?ml)$/i;
const ENV_PATH = /(?:^|\/)\.env(?:\.[^/]+)?$/i;
const PATTERNS = [
  {
    re: new RegExp(['-----BEGIN ', '(?:RSA |EC |OPENSSH )?', 'PRIVATE KEY-----'].join('')),
    why: 'private key block',
  },
  {
    re: new RegExp(['\\bAKIA', '[0-9A-Z]{16}\\b'].join('')),
    why: 'AWS access key id',
  },
  {
    re: new RegExp(['\\bgh', '[pousr]_[A-Za-z0-9]{30,}\\b'].join('')),
    why: 'GitHub token',
  },
  {
    re: new RegExp(['\\bsk-', '[A-Za-z0-9_-]{20,}\\b'].join('')),
    why: 'API secret key',
  },
  {
    re: new RegExp(['\\bAIza', '[A-Za-z0-9_-]{30,}\\b'].join('')),
    why: 'Google API key',
  },
  {
    re: new RegExp(['\\bxox', '[abprs]-[A-Za-z0-9-]{20,}\\b'].join('')),
    why: 'Slack token',
  },
  {
    re: new RegExp(['\\b(?:sk|rk)_(?:live|test)_', '[A-Za-z0-9]{20,}\\b'].join('')),
    why: 'Stripe key',
  },
  {
    re: new RegExp(['\\bsmk_', '[A-Za-z0-9]{16,}\\b'].join('')),
    why: 'ServiceM8-style key',
  },
  {
    re: /\b(?:api[_-]?key|client[_-]?secret|password|access[_-]?token)\s*[:=]\s*["'][A-Za-z0-9/+_.=-]{16,}["']/i,
    why: 'assigned credential',
  },
  {
    re: /\b(?:SERPAPI_KEY|SERPER_API_KEY|EBAY_CLIENT_ID|EBAY_CLIENT_SECRET|SERVICEM8(?:_API)?_KEY|XERO_CLIENT_SECRET|PROVIDER_(?:API_KEY|TOKEN))\s*[:=]\s*(?:["'][A-Za-z0-9/+_.=-]{16,}["']|[A-Za-z0-9/+_.=-]{16,})/i,
    why: 'assigned provider credential',
  },
];
const APPROVED_PLACEHOLDER =
  /^(?:example|fixture|placeholder|redacted|dummy|change[_ -]?me|not[_ -]?a[_ -]?real(?:[_ -][a-z0-9]+)*|replace[_ -]?with(?:[_ -][a-z0-9]+)+|your(?:[_ -][a-z0-9]+)+)$/i;
const TEST_ONLY_PLACEHOLDER = /^(?:fixture|synthetic)(?:[_ -][a-z0-9]+)+$/i;
const scopeArgument = process.argv.find((argument) => argument.startsWith('--scope='));
const scope = scopeArgument?.slice('--scope='.length) ?? 'all';
if (!['all', 'current', 'history'].includes(scope)) {
  console.error('Secret scan scope must be all, current or history.');
  process.exit(2);
}
const scanCurrent = scope === 'all' || scope === 'current';
const scanHistory = scope === 'all' || scope === 'history';
const excludePrivateEnv = process.argv.includes('--exclude-private-env');
// Report-only still scans and still prints every finding; it just does not fail
// the run. It exists for the reachable history, whose exposure is already
// public and cannot be withdrawn without rewriting published commits. Leave it
// off for the proposed tree so a newly added credential is still blocked.
const reportOnly = process.argv.includes('--report-only');

function git(args, options = {}) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    throw new Error(`Secret scan could not inspect Git metadata (${args[0]} failed).`, {
      cause: error,
    });
  }
}

function isTextPath(file) {
  return TEXT_PATH.test(file) || ENV_PATH.test(file);
}

function isTestSource(label) {
  return (
    /^(?:desktop-e2e|e2e|tests)\//u.test(label) ||
    /(?:^|\/)[^/]+\.test\.[cm]?[jt]sx?(?:\s|$|\()/u.test(label)
  );
}

function isApprovedPlaceholder(match, label) {
  const separator = match.search(/[:=]/u);
  if (separator < 0) return false;
  const assignedValue = match.slice(separator + 1).trim();
  const unquotedValue =
    assignedValue.length >= 2 &&
    ((assignedValue.startsWith('"') && assignedValue.endsWith('"')) ||
      (assignedValue.startsWith("'") && assignedValue.endsWith("'")))
      ? assignedValue.slice(1, -1)
      : assignedValue;
  if (APPROVED_PLACEHOLDER.test(unquotedValue)) return true;
  return isTestSource(label) && TEST_ONLY_PLACEHOLDER.test(unquotedValue);
}

function inspect(content, label, findings) {
  for (const { re, why } of PATTERNS) {
    const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
    for (const match of content.matchAll(new RegExp(re.source, flags))) {
      if (!isApprovedPlaceholder(match[0], label)) findings.push(`${label}: matches ${why}`);
    }
  }
}

const findings = [];
const currentFiles = new Set();
if (scanCurrent) {
  const indexedEntries = git(['ls-files', '--stage', '-z'])
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const match = /^(\d+) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/u.exec(entry);
      if (!match) throw new Error('Secret scan could not parse a Git index entry.');
      return { object: match[2], file: match[4] };
    });
  for (const { object, file } of indexedEntries) {
    currentFiles.add(file);
    if (!isTextPath(file)) continue;
    if (excludePrivateEnv && ENV_PATH.test(file) && !/\.env\.example$/iu.test(file)) continue;
    if (ENV_PATH.test(file) && !/\.env\.example$/iu.test(file)) {
      findings.push(`${file}: environment file requires credential review`);
    }
    const size = Number(git(['cat-file', '-s', object]).trim());
    if (!Number.isFinite(size) || size > MAX_BYTES) continue;
    inspect(git(['cat-file', 'blob', object], { maxBuffer: MAX_BYTES + 1024 }), file, findings);
  }
  const untrackedFiles = git(['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean);
  for (const file of untrackedFiles) {
    currentFiles.add(file);
    if (!isTextPath(file)) continue;
    if (excludePrivateEnv && ENV_PATH.test(file) && !/\.env\.example$/iu.test(file)) continue;
    if (ENV_PATH.test(file) && !/\.env\.example$/iu.test(file)) {
      findings.push(`${file}: environment file requires credential review`);
    }
    // Untracked candidates have no index object, so their proposed content is
    // read from the worktree. I/O failures remain scan failures.
    if (!existsSync(file)) continue;
    if (statSync(file).size <= MAX_BYTES) inspect(readFileSync(file, 'utf8'), file, findings);
  }
}

const seen = new Set();
if (scanHistory) {
  const historicalRecords = git([
    'log',
    '--all',
    '--raw',
    '--root',
    '-m',
    '--no-renames',
    '--no-abbrev',
    '--format=',
    '-z',
  ]).split('\0');
  for (let index = 0; index < historicalRecords.length;) {
    const metadata = historicalRecords[index++].trim();
    if (!metadata) continue;
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ ([0-9a-f]+) [A-Z]$/u.exec(metadata);
    if (!match) throw new Error('Secret scan could not parse a historical diff entry.');
    const file = historicalRecords[index++];
    if (file === undefined) throw new Error('Secret scan found a historical entry without a path.');
    const [, , newMode, object] = match;
    if (newMode === '000000' || newMode === '160000') continue;
    if (ENV_PATH.test(file) && !/\.env\.example$/iu.test(file)) {
      findings.push(
        `${file} (history blob ${object.slice(0, 12)}): historical environment file requires credential rotation review`,
      );
    }
    if (!isTextPath(file)) continue;
    const pathPolicyClass = isTestSource(file) ? 'test' : 'production';
    const policyKey = `${object}\0${pathPolicyClass}`;
    if (seen.has(policyKey)) continue;
    seen.add(policyKey);
    const size = Number(git(['cat-file', '-s', object]).trim());
    if (!Number.isFinite(size) || size > MAX_BYTES) continue;
    const content = git(['cat-file', 'blob', object], { maxBuffer: MAX_BYTES + 1024 });
    inspect(content, `${file} (history blob ${object.slice(0, 12)})`, findings);
  }
}

if (findings.length > 0) {
  const report = reportOnly ? console.log : console.error;
  report('Possible secrets detected (values NOT shown):');
  for (const finding of [...new Set(findings)]) report(`  - ${finding}`);
  if (!reportOnly) process.exit(1);
  report(
    'Reported without failing because --report-only was requested. Nothing above is fixed, ' +
      'and any credential listed here stays readable to anyone who clones the repository.',
  );
  process.exit(0);
}
console.log(
  `Secret scan passed for ${scope}: ${currentFiles.size} current paths and ${seen.size} history policy scans checked.`,
);
