import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Content Security Policy for the production build only.
 *
 * The application is a fully static, local-first tool: every script and style
 * is bundled by Vite and served from the same origin. `connect-src 'none'`
 * blocks fetch/XHR/WebSocket/beacon at the browser level so business data can
 * never leave the page, even if a dependency misbehaved.
 *
 * The policy is not applied in dev because Vite's HMR client requires inline
 * scripts and a WebSocket connection.
 */
const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  // 'unsafe-inline' applies to style ATTRIBUTES only (React sets element
  // style props); scripts stay fully locked down and React escapes all HTML.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
].join('; ');

export default defineConfig({
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
          `<meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />`,
        );
      },
    },
  ],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
