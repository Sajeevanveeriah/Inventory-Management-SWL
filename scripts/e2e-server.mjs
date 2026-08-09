#!/usr/bin/env node
/** Start the deterministic production-shape E2E server on every supported OS. */
import { spawn, spawnSync } from "node:child_process";

const dataDir = ".e2e-data";
const seed = spawnSync(
  process.execPath,
  ["server/seed.mjs", "--data-dir", dataDir],
  {
    stdio: "inherit",
  },
);
if (seed.status !== 0) process.exit(seed.status ?? 1);

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
