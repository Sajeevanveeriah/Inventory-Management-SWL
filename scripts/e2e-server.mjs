#!/usr/bin/env node
/** Start the deterministic production-shape E2E server on every supported OS. */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";

const dataDir = ".e2e-data";
const seedDataDir = ".e2e-seed-data";
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
  ["server/index.mjs", "--port", "4173", "--fixture"],
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
