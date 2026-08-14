import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(repositoryRoot, 'node_modules', '@wdio', 'tauri-service');
const packageMetadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));

if (packageMetadata.version !== '1.3.0') {
  throw new Error('The reviewed Tauri service compatibility patch requires version 1.3.0.');
}

const original = 'const match = versionOutput.match(/MSEdgeDriver ([\\d.]+)/);';
const replacement =
  'const match = versionOutput.trim().match(/^Microsoft Edge WebDriver ([\\d.]+) \\([0-9a-f]{40}\\)$/);';
const targets = [
  {
    path: join(packageRoot, 'dist', 'esm', 'index.js'),
    originalSha256: '9f40744cff59af6adfc7d324064de1493aafaa32e88827e1dec5e8f11439b593',
    patchedSha256: '27ff45e1807cd8be99a9b8410b903be036e4aba0d76afb03fa6d97ea4ca9a1ff',
  },
  {
    path: join(packageRoot, 'dist', 'cjs', 'index.js'),
    originalSha256: '34c47d9b676c0f73870889c49f8ccc612591f42b9a221c9ec305497ac94bfe10',
    patchedSha256: 'e5cf999920b1eb105e84593c784f177b01dbcdb09a4f354eb1c2a6da9db11be6',
  },
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

for (const target of targets) {
  const originalBytes = readFileSync(target.path);
  if (sha256(originalBytes) !== target.originalSha256) {
    throw new Error('The installed Tauri service bytes differ from the reviewed input.');
  }

  const source = originalBytes.toString('utf8');
  if (source.split(original).length !== 2) {
    throw new Error('The reviewed Tauri service parser target is not unique.');
  }
  const patchedBytes = Buffer.from(source.replace(original, replacement), 'utf8');
  if (sha256(patchedBytes) !== target.patchedSha256) {
    throw new Error('The Tauri service compatibility patch output hash is incorrect.');
  }

  writeFileSync(target.path, patchedBytes);
  if (sha256(readFileSync(target.path)) !== target.patchedSha256) {
    throw new Error('The Tauri service compatibility patch was not persisted exactly.');
  }
}
