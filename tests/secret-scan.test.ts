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
  }, 30_000);

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
  }, 30_000);

  it("can exclude the owner-retained private environment file without weakening example-file scanning", () => {
    const directory = temporaryRepository();
    const privateValue = "syntheticPrivateToken123456";
    writeFileSync(join(directory, ".env"), `SERPAPI_KEY=${privateValue}\n`);
    writeFileSync(
      join(directory, ".env.example"),
      "SERPAPI_KEY=replace_with_serpapi_key\n",
    );
    execFileSync("git", ["add", ".env", ".env.example"], { cwd: directory });

    const output = execFileSync(
      process.execPath,
      [scanner, "--scope=current", "--exclude-private-env"],
      { cwd: directory, encoding: "utf8" },
    );

    expect(output).toContain("Secret scan passed for current");
    expect(output).not.toContain(privateValue);
  }, 30_000);
});
