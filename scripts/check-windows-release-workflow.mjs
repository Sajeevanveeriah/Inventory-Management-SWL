import { readFile } from 'node:fs/promises';

const workflowPath =
  process.env.SWL_RELEASE_WORKFLOW_PATH ?? '.github/workflows/windows-desktop.yml';
const workflow = await readFile(workflowPath, 'utf8');
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const packageLock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const cargoToml = await readFile('src-tauri/Cargo.toml', 'utf8');
const cargoLock = await readFile('src-tauri/Cargo.lock', 'utf8');
const tauriConfig = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
const audit = await readFile('src/core/audit.ts', 'utf8');

function matchVersion(content, pattern, label) {
  const value = content.match(pattern)?.[1];
  if (!value) throw new Error('Unable to resolve the ' + label + ' version.');
  return value;
}

const versions = new Map([
  ['package.json', packageJson.version],
  ['package-lock.json', packageLock.packages?.['']?.version],
  ['Cargo.toml', matchVersion(cargoToml, /^version\s*=\s*"([^"]+)"/m, 'Cargo.toml')],
  [
    'Cargo.lock',
    matchVersion(
      cargoLock,
      /\[\[package\]\]\s*\nname\s*=\s*"swl-pricing-desktop"\s*\nversion\s*=\s*"([^"]+)"/m,
      'Cargo.lock',
    ),
  ],
  ['tauri.conf.json', tauriConfig.version],
  ['audit.ts', matchVersion(audit, /APP_VERSION\s*=\s*['"]([^'"]+)['"]/, 'audit')],
]);

const expected = process.env.SWL_EXPECTED_RELEASE_VERSION ?? packageJson.version;
if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(expected)) {
  throw new Error('The expected release version is not strict stable SemVer.');
}
for (const [source, version] of versions) {
  if (version !== expected) {
    throw new Error(source + ' version ' + (version ?? '<missing>') + ' is not ' + expected + '.');
  }
}

const requiredFragments = [
  'pull_request:',
  'create_draft_release:',
  'release_version:',
  'draft-release:',
  'permissions:\n      contents: write',
  'gh release create $env:RELEASE_TAG',
  '--draft --verify-tag',
  'gh release view $env:RELEASE_TAG --json tagName,targetCommitish,isDraft,assets',
  'if (!$release.isDraft -or $release.tagName',
  '$remoteAssets.Count -ne 8',
  "'NATIVE-RENDER-SCOPE.json'",
  "'RENDER-EVIDENCE-SCOPE.txt'",
];
for (const fragment of requiredFragments) {
  if (!workflow.includes(fragment)) {
    throw new Error('Release workflow is missing required structure: ' + fragment);
  }
}

const releaseJob = workflow.slice(workflow.indexOf('\n  draft-release:'));
if (
  /--latest\b|--prerelease\b|gh\s+release\s+edit\b|gh\s+release\s+delete\b|git\s+tag\b|git\s+push\b/.test(
    releaseJob,
  )
) {
  throw new Error('Draft-release job contains a prohibited release or tag mutation.');
}

function assertManualOnlyRelease(candidate) {
  const candidateReleaseJob = candidate.slice(candidate.indexOf('\n  draft-release:'));
  if (
    /\n {2}push:/.test(candidate) ||
    candidateReleaseJob.includes("github.event_name == 'push'")
  ) {
    throw new Error('Tag pushes must not create or mutate a GitHub Release.');
  }
  if (
    !candidateReleaseJob.includes(
      "github.event_name == 'workflow_dispatch' && inputs.create_draft_release",
    )
  ) {
    throw new Error('Manual draft creation is not explicitly gated by its boolean approval input.');
  }
}
assertManualOnlyRelease(workflow);

const knownDefectiveTagPush = workflow.replace(
  '  workflow_dispatch:',
  "  push:\n    tags: ['v1.2.3']\n  workflow_dispatch:",
);
let defectiveRejected = false;
try {
  assertManualOnlyRelease(knownDefectiveTagPush);
} catch {
  defectiveRejected = true;
}
if (!defectiveRejected)
  throw new Error('The checker accepted a known-defective tag-push release trigger.');

console.log(
  'Windows release workflow passed: ' +
    expected +
    ', manual-only draft, 8 exact assets, defective tag trigger rejected.',
);
