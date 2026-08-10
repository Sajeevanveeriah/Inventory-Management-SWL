import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scanner = join(repositoryRoot, "scripts", "check-secrets.mjs");
const temporaryDirectories: string[] = [];

function temporaryRepository(): string {
  const directory = mkdtempSync(join(tmpdir(), "swl-secret-scan-"));
  temporaryDirectories.push(directory);
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("secret scanner placeholder handling", () => {
  it("accepts explicit replace-with placeholders in a tracked example file", () => {
    const directory = temporaryRepository();
    writeFileSync(
      join(directory, ".env.example"),
      "SERPAPI_KEY=replace_with_serpapi_key\n" +
        "EBAY_CLIENT_SECRET=replace_with_ebay_client_secret\n",
    );
    execFileSync("git", ["add", ".env.example"], { cwd: directory });

    const output = execFileSync(
      process.execPath,
      [scanner, "--scope=current"],
      { cwd: directory, encoding: "utf8" },
    );

    expect(output).toContain("Secret scan passed for current");
  });

  it("still rejects an assigned token-shaped value without displaying it", () => {
    const directory = temporaryRepository();
    const syntheticValue = "syntheticTokenValue123456";
    writeFileSync(
      join(directory, ".env.example"),
      `SERPAPI_KEY=${syntheticValue}\n`,
    );
    execFileSync("git", ["add", ".env.example"], { cwd: directory });

    const result = spawnSync(process.execPath, [scanner, "--scope=current"], {
      cwd: directory,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("matches assigned provider credential");
    expect(result.stderr).not.toContain(syntheticValue);
  });
});
