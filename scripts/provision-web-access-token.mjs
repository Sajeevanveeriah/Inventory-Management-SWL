#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { Redis } from "@upstash/redis";
import { accessTokenKey } from "../server/vercel/auth.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const sub = argument("--sub");
const expiresAt = argument("--expires");
const tokenFile = argument("--token-file");
if (
  !sub ||
  !/^[A-Za-z0-9._-]{1,128}$/u.test(sub) ||
  !expiresAt ||
  !Number.isFinite(Date.parse(expiresAt)) ||
  Date.parse(expiresAt) <= Date.now() ||
  !tokenFile
) {
  throw new Error(
    "Usage: provision-web-access-token --sub <id> --expires <ISO timestamp> --token-file <path>",
  );
}

const redisUrl = process.env.SWL_REDIS_REST_URL;
const redisToken = process.env.SWL_REDIS_REST_TOKEN;
const pepper = process.env.SWL_ACCESS_TOKEN_PEPPER;
if (!redisUrl || !redisToken || !pepper || pepper.length < 32) {
  throw new Error(
    "Redis credentials and the access-token pepper are required.",
  );
}

const token = randomBytes(32).toString("base64url");
const redis = new Redis({ url: redisUrl, token: redisToken });
const ttlSeconds = Math.max(
  1,
  Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000),
);
const created = await redis.set(
  accessTokenKey(token, pepper),
  {
    sub,
    enabled: true,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  },
  { ex: ttlSeconds, nx: true },
);
if (created !== "OK") {
  throw new Error("The generated access-token key already exists in Redis.");
}

const resolved = path.resolve(tokenFile);
await writeFile(resolved, `${token}\n`, {
  encoding: "utf8",
  mode: 0o600,
  flag: "wx",
});
await chmod(resolved, 0o600);
console.log(`Provisioned one revocable web access token for ${sub}.`);
