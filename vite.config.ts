import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Content Security Policy for the production build only.
 *
 * Invariant change (authorised by the repository owner, August 2026): the
 * application is no longer no-network. The browser may call ITS OWN ORIGIN
 * ONLY (`connect-src 'self'`), which is the small bundled Node server that
 * performs live competitor searches through a licensed provider and owns
 * persistence. No third-party origin is ever reachable from the page.
 *
 * The policy is not applied in dev because Vite's HMR client requires inline
 * scripts and a WebSocket connection.
 */
const productionCsp = (desktop: boolean) =>
  [
    "default-src 'none'",
    "script-src 'self'",
    // 'unsafe-inline' applies to style ATTRIBUTES only (React sets element
    // style props); scripts stay fully locked down and React escapes all HTML.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    // Own origin only: the API lives on the same origin as the page. The
    // desktop (Tauri) build additionally reaches the local IPC bridge.
    desktop ? "connect-src 'self' ipc: http://ipc.localhost" : "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join('; ');

export default defineConfig(({ mode }) => ({
  // Local use serves from the root. Hosted deployments (e.g. GitHub Pages
  // project sites) set VITE_BASE, e.g. VITE_BASE=/Inventory-Management-SWL/.
  base: process.env.VITE_BASE ?? '/',
  plugins: [
    react(),
    {
      name: 'swl-production-csp',
      apply: 'build',
      transformIndexHtml(html) {
        return html.replace(
          '<!-- %PRODUCTION_CSP% -->',
          `<meta http-equiv="Content-Security-Policy" content="${productionCsp(mode === 'desktop')}" />`,
        );
      },
    },
  ],
  server: {
    // Dev: the SPA calls its own origin; Vite forwards /api to the Node server.
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  preview: {
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
}));
