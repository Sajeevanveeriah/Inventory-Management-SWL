# Test strategy

Use Node 22. The repository records `.nvmrc` and package engines for this runtime because the jsdom and undici versions require it.

Commands:

- `npm ci`
- `npm run typecheck`
- `npm run lint`
- `npm run test`
- `npm run build`
- `npm run check:data-safety`
- `npm run e2e`

Vitest covers money, parsing, mapping, comparison, review, output eligibility, workbook generation, sanitisation, configuration, competitor logic and operational metadata. Playwright covers the production build, accessibility scans and screenshot capture when a real Chromium executable is available.

Browser recovery: inspect `CHROMIUM_PATH`, search system paths, inspect Playwright cache, try a system browser, try `npx playwright install chromium`, try apt or another temporary validation browser. Do not commit browser packages or lockfile changes for validation-only acquisition.
