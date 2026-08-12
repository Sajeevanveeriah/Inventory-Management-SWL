import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Content Security Policy for the production build only.
 *
 * Browser deployments may call only their own origin. GitHub Pages is static
 * and has no provider integration; the desktop bundle receives its separate
 * network policy from Tauri.
 *
 * The policy is not applied in dev because Vite's HMR client requires inline
 * scripts and a WebSocket connection.
 */
const productionCsp = () =>
  [
    "default-src 'none'",
    "script-src 'self'",
    // 'unsafe-inline' applies to style ATTRIBUTES only (React sets element
    // style props); scripts stay fully locked down and React escapes all HTML.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join("; ");

export default defineConfig(({ mode }) => ({
  // The no-install test launchers must not load repository .env files. Their
  // fixture providers and data directories are supplied explicitly instead.
  envDir: process.env.SWL_LOCAL_TEST === "1" ? false : undefined,
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
          `<meta http-equiv="Content-Security-Policy" content="${productionCsp()}" />`,
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
