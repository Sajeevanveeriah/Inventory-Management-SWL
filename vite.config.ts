import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Content Security Policy for the production build only.
 *
 * Invariant change (authorised by the repository owner, August 2026): the
 * application is no longer no-network. Local deployments call their own
 * origin; GitHub Pages may also call one exact HTTPS live-search API origin.
 * The provider credential remains in the backend and no retailer origin is
 * reachable from the page.
 *
 * The policy is not applied in dev because Vite's HMR client requires inline
 * scripts and a WebSocket connection.
 */
function canonicalLiveSearchApiOrigin(): string | null {
  const value = process.env.VITE_LIVE_SEARCH_API_ORIGIN;
  if (!value) {
    if (process.env.VITE_REQUIRE_LIVE_SEARCH_API_ORIGIN === "true") {
      throw new Error(
        "VITE_LIVE_SEARCH_API_ORIGIN is required for this production build.",
      );
    }
    return null;
  }
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== value
  ) {
    throw new Error(
      "VITE_LIVE_SEARCH_API_ORIGIN must be a canonical HTTPS origin.",
    );
  }
  return parsed.origin;
}

const productionCsp = (liveSearchApiOrigin: string | null) =>
  [
    "default-src 'none'",
    "script-src 'self'",
    // 'unsafe-inline' applies to style ATTRIBUTES only (React sets element
    // style props); scripts stay fully locked down and React escapes all HTML.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    // GitHub Pages remains the frontend. Only the exact protected API origin
    // may be added; the desktop bundle receives its policy from Tauri.
    `connect-src 'self'${liveSearchApiOrigin ? ` ${liveSearchApiOrigin}` : ""}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join("; ");

export default defineConfig(({ mode }) => ({
  // Local use serves from the root. Hosted deployments (e.g. GitHub Pages
  // project sites) set VITE_BASE, e.g. VITE_BASE=/Inventory-Management-SWL/.
  base: process.env.VITE_BASE ?? "/",
  plugins: [
    react(),
    {
      name: "swl-production-csp",
      apply: "build",
      transformIndexHtml(html) {
        if (mode === "desktop") {
          return html.replace("<!-- %PRODUCTION_CSP% -->", "");
        }
        return html.replace(
          "<!-- %PRODUCTION_CSP% -->",
          `<meta http-equiv="Content-Security-Policy" content="${productionCsp(canonicalLiveSearchApiOrigin())}" />`,
        );
      },
    },
  ],
  server: {
    // Dev: the SPA calls its own origin; Vite forwards /api to the Node server.
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
  preview: {
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
  },
}));
