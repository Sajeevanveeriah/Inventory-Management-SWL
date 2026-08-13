#!/usr/bin/env node
/** Start the deterministic production-shape E2E server on every supported OS. */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";

// playwright.config.ts owns both paths so the browser fixture resets exactly
// the store this server reads. The defaults keep a direct run self-contained.
const dataDir = process.env.SWL_LOCAL_TEST_LIVE_DATA_DIR ?? ".e2e-data";
const seedDataDir = process.env.SWL_LOCAL_TEST_SEED_DATA_DIR ?? ".e2e-seed-data";
for (const directory of [dataDir, seedDataDir]) {
  rmSync(directory, { recursive: true, force: true });
}
const seed = spawnSync(
  process.execPath,
  ["server/seed.mjs", "--data-dir", seedDataDir],
  {
    stdio: "inherit",
  },
);
if (seed.status !== 0) process.exit(seed.status ?? 1);
cpSync(seedDataDir, dataDir, { recursive: true, errorOnExist: true });

const server = spawn(
  process.execPath,
  ["tests/support/fixture-server.mjs", "--port", "4173"],
  {
    env: { ...process.env, SWL_DATA_DIR: dataDir },
    stdio: "inherit",
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.kill(signal));
}
server.on("error", () => process.exit(1));
server.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
