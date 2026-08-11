import { createHmac } from "node:crypto";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,256}$/u;

export function accessTokenKey(token, pepper) {
  const digest = createHmac("sha256", pepper).update(token).digest("hex");
  return `swl:auth:token:${digest}`;
}

export async function authenticateRequest(
  request,
  redis,
  config,
  now = Date.now,
) {
  const authorization = request.headers.get("authorization");
  if (!authorization) return { ok: false, status: 401 };
  const match = /^Bearer ([A-Za-z0-9_-]+)$/u.exec(authorization);
  if (!match || !TOKEN_PATTERN.test(match[1])) {
    return { ok: false, status: 403 };
  }
  const record = await redis.get(
    accessTokenKey(match[1], config.accessTokenPepper),
  );
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    record.enabled !== true ||
    typeof record.sub !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/u.test(record.sub) ||
    typeof record.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(record.expiresAt)) ||
    Date.parse(record.expiresAt) <= now()
  ) {
    return { ok: false, status: 403 };
  }
  return { ok: true, sub: record.sub };
}
