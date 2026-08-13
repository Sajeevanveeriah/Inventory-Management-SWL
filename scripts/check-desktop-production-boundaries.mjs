#!/usr/bin/env node
/** Static production-boundary checks for the Tauri bundle and capability. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const tauri = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const capability = JSON.parse(readFileSync('src-tauri/capabilities/default.json', 'utf8'));
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const packageLock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const cargoManifest = readFileSync('src-tauri/Cargo.toml', 'utf8');
const cargoLock = readFileSync('src-tauri/Cargo.lock', 'utf8');
const auditSource = readFileSync('src/core/audit.ts', 'utf8');

function requireBoundary(condition, message) {
  if (!condition) throw new Error(message);
}

requireBoundary(tauri.app?.withGlobalTauri === false, 'withGlobalTauri must remain false.');
requireBoundary(
  JSON.stringify(tauri.bundle?.targets) === JSON.stringify(['nsis']),
  'NSIS must be the sole canonical bundle target.',
);
requireBoundary(
  tauri.bundle?.windows?.nsis?.installMode === 'currentUser',
  'NSIS must use current-user installation.',
);
requireBoundary(
  tauri.bundle?.windows?.webviewInstallMode?.type === 'offlineInstaller',
  'WebView2 must use offlineInstaller mode.',
);

const csp = tauri.app?.security?.csp;
requireBoundary(typeof csp === 'string' && csp.length > 0, 'Tauri CSP must be explicit.');
for (const forbidden of ['unsafe-eval', 'script-src *', 'font-src *', 'connect-src *', 'https:']) {
  requireBoundary(!csp.includes(forbidden), `Tauri CSP contains forbidden value: ${forbidden}`);
}
requireBoundary(csp.includes("script-src 'self'"), 'Tauri CSP must restrict scripts to self.');
requireBoundary(
  csp.includes('connect-src ipc: http://ipc.localhost'),
  'Tauri CSP must restrict connections to the local IPC bridge.',
);

const permissions = capability.permissions ?? [];
const forbiddenPermission = /^(?:dialog:default|shell(?::|$)|process(?::|$)|fs(?::|$)|http(?::|$))/;
for (const permission of permissions) {
  requireBoundary(
    !forbiddenPermission.test(permission),
    `Capability contains forbidden broad permission: ${permission}`,
  );
}
const requiredPermissionGroups = [
  'allow-swl-read',
  'allow-swl-write',
  'allow-swl-recovery',
  'allow-swl-search',
  'allow-swl-files',
];
const requiredPermissions = ['core:app:allow-set-app-theme', ...requiredPermissionGroups];
requireBoundary(
  JSON.stringify([...permissions].sort()) === JSON.stringify([...requiredPermissions].sort()),
  'The main capability must contain only the five reviewed SWL groups and native theme permission.',
);
for (const required of requiredPermissionGroups) {
  requireBoundary(
    permissions.some(
      (permission) => permission === required || permission.endsWith(`:${required}`),
    ),
    `Capability is missing explicit permission group: ${required}`,
  );
}

const permissionSource = readFileSync('src-tauri/permissions/swl.toml', 'utf8');
const permissionCommands = [
  ...permissionSource.matchAll(/commands\.allow\s*=\s*\[([\s\S]*?)\]/g),
].flatMap((match) => [...match[1].matchAll(/"([a-z][a-z0-9_]*)"/g)].map((entry) => entry[1]));
const manifestSource = readFileSync('src-tauri/build.rs', 'utf8');
const manifestBlock = manifestSource.match(/const COMMANDS:[\s\S]*?=\s*&\[([\s\S]*?)\];/);
requireBoundary(manifestBlock, 'The Tauri build command manifest could not be read.');
const manifestCommands = [...manifestBlock[1].matchAll(/"([a-z][a-z0-9_]*)"/g)].map(
  (entry) => entry[1],
);
const backendSource = readFileSync('src-tauri/src/backend.rs', 'utf8');
const handlerBlock = backendSource.match(/tauri::generate_handler!\s*\[([\s\S]*?)\]\s*\)/);
requireBoundary(handlerBlock, 'The Tauri invoke handler could not be read.');
const handlerCommands = [...handlerBlock[1].matchAll(/\b([a-z][a-z0-9_]*)\b/g)].map(
  (entry) => entry[1],
);
const desktopAdapterSource = readFileSync('src/platform/desktop.ts', 'utf8');
const frontendInvokedCommands = manifestCommands.filter((command) =>
  new RegExp(`['"]${command}['"]`).test(desktopAdapterSource),
);

function requireUniqueExact(actual, expected, label) {
  requireBoundary(new Set(actual).size === actual.length, `${label} contains a duplicate command.`);
  requireBoundary(
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort()),
    `${label} is not an exact match for the reviewed Tauri command manifest.`,
  );
}

requireUniqueExact(handlerCommands, manifestCommands, 'Invoke handler');
requireUniqueExact(permissionCommands, frontendInvokedCommands, 'Custom permissions');
for (const command of permissionCommands) {
  requireBoundary(
    manifestCommands.includes(command),
    `Custom permission exposes an unregistered command: ${command}`,
  );
}
for (const removedCommand of ['append_approval', 'append_price_history', 'shell_info']) {
  requireBoundary(
    !manifestCommands.includes(removedCommand) && !permissionCommands.includes(removedCommand),
    `Removed direct-write or diagnostic command must not be registered or exposed: ${removedCommand}`,
  );
}

for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
  requireBoundary(
    !/\bnpx\s+(?:-y|--yes)\b/.test(command),
    `Script ${name} downloads a mutable executable.`,
  );
}

function allFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    return entry.isDirectory() ? allFiles(candidate) : [candidate];
  });
}

const desktopIndex = path.join('dist', 'index.html');
requireBoundary(existsSync(desktopIndex), 'Desktop dist is missing. Build it before this check.');
requireBoundary(
  !readFileSync(desktopIndex, 'utf8').includes('http-equiv="Content-Security-Policy"'),
  'Desktop dist contains a second meta CSP; Tauri must supply the single effective policy.',
);

const productionFiles = [
  ...allFiles('dist'),
  'src-tauri/Cargo.lock',
  ...allFiles('src-tauri/target/release').filter(
    (file) =>
      path.dirname(file) === path.join('src-tauri', 'target', 'release') && file.endsWith('.exe'),
  ),
].filter(existsSync);
const forbiddenDriver =
  /tauri-plugin-wdio-webdriver|tauri-plugin-wdio|tauri-driver|@wdio\/|"webdriverio"/i;
for (const file of productionFiles) {
  requireBoundary(
    !/^(?:swl-db-acceptance|swl-legacy-seed)\.exe$/i.test(path.basename(file)),
    `Production input contains a test-only database acceptance helper: ${file}`,
  );
  const content = readFileSync(file, 'utf8');
  requireBoundary(
    !forbiddenDriver.test(content),
    `Production input contains WebDriver marker: ${file}`,
  );
}

for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
  requireBoundary(
    !/^(?:@wdio\/|webdriverio$|tauri-driver$|tauri-plugin-wdio)/i.test(dependency),
    `Production dependency contains a test driver: ${dependency}`,
  );
}

function tomlPackageVersion(source) {
  const packageSection = source.match(/\[package\]([\s\S]*?)(?:\n\[|$)/);
  return packageSection?.[1].match(/^version\s*=\s*"([^"]+)"/m)?.[1];
}

const versions = {
  package: packageJson.version,
  packageLock: packageLock.packages?.['']?.version,
  cargo: tomlPackageVersion(cargoManifest),
  cargoLock: cargoLock.match(
    /\[\[package\]\]\s*\nname = "swl-pricing-desktop"\s*\nversion = "([^"]+)"/,
  )?.[1],
  tauri: tauri.version,
  audit: auditSource.match(/APP_VERSION\s*=\s*["']([^"']+)["']/)?.[1],
};
requireBoundary(
  Object.values(versions).every((version) => version === packageJson.version),
  `Application versions are inconsistent: ${JSON.stringify(versions)}`,
);

console.log(
  `Desktop production-boundary check passed: ${permissions.length} scoped permissions and ${productionFiles.length} production inputs.`,
);
