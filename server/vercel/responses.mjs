const BASE_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});

function corsHeaders(origin, method) {
  return origin
    ? {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": method
          ? `${method}, OPTIONS`
          : "GET, POST, OPTIONS",
        "access-control-allow-headers": "Authorization, Content-Type",
        "access-control-max-age": "600",
        vary: "Origin",
      }
    : { vary: "Origin" };
}

export function jsonResponse(status, body, origin) {
  return new globalThis.Response(JSON.stringify(body), {
    status,
    headers: {
      ...BASE_HEADERS,
      ...corsHeaders(origin),
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export function preflightResponse(origin, method) {
  return new globalThis.Response(null, {
    status: 204,
    headers: { ...BASE_HEADERS, ...corsHeaders(origin, method) },
  });
}

export function allowedOrigin(request, configuredOrigin) {
  const origin = request.headers.get("origin");
  return origin === configuredOrigin ? origin : null;
}
