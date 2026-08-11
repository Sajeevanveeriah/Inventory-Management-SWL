# Configuration reference

The application exposes a versioned TypeScript registry in `src/core/configRegistry.ts`. Each setting has a stable key, category, type, default value, range or enum, unit, supported scopes, confirmation flag, impact-preview flag, help text, audit mode, schema version, migration mode and locked status.

Scopes resolve in this order: run, product, category, supplier, global, default.

## Categories

- Pricing and tax: strategy, markup, floor, GST, rounding, fixed add, target margin, competitor strategies, approval thresholds and price freeze.
- File parsing: file types, CSV controls, encoding, row, sheet, cell and preview limits.
- File-role and mapping automation: profile confidence, sheet confidence, mapping confidence, trusted saved mapping use and suggestion confirmation.
- Matching: identifiers, aliases, normalisation, brand, GTIN, pack, fuzzy suggestions, ambiguity and duplicate handling.
- Validation: missing, zero, negative, currency, GST, outlier, staleness, stock, condition and required-review policies.
- Workflow and approvals: comparison automation, repeat-run controls, bulk limits, pagination, density and undo depth for reversible exclusions. Once published, approvals and their price-history versions are append-only and cannot be withdrawn through session undo controls.
- Competitor evidence: approved local collection methods, validity, currency, GST, confidence, strategy, selection and floor behaviour.
- Output: candidate template, report shape, summary sheet and audit detail.
- Display and accessibility: theme, density, dates and timezone.
- Privacy and retention: metadata, snapshots, retention, profile and alias retention.
- Locked safety invariants: local business-file processing, no production writes, no scraping, ambiguous and invalid blocking, missing-item non-deletion, formula protection, leading-zero preservation, no raw-row persistence by default, approved-valid-changed-only output, floor enforcement, no arbitrary expressions and no release action. The only optional external runtime call is an explicit, budgeted competitor query through the reviewed native desktop adapter, local Node adapter or protected API-only web adapter; it never includes imported rows, costs, sell prices, notes or customer data.

## Import and export

Configuration export uses the versioned checksummed envelope documented by the platform contract.
Import rejects unknown keys, invalid enum values, out-of-range numbers, conflicts and locked-setting
overrides. Unsupported or malformed versions leave live configuration unchanged and block the
workflow; they are never converted to defaults or silently discarded.

## Live-provider runtime controls

GitHub Pages contains only the canonical HTTPS origin of the protected API. SerpAPI and Redis
credentials, the token pepper, rate controls and paid-call controls are server-side variables in the
API-only runtime. The browser access token is entered for one tab and remains in memory only.

The Vercel budget period is an operator-approved calendar month. `SWL_PROVIDER_BUDGET_PERIOD` must
equal the current `YYYY-MM` in `Australia/Melbourne`; stale or future values fail closed before
Redis reservation or provider work. A new month therefore requires an explicit ceiling review and
configuration update. The prior Redis ledger is retained beyond the active period so expiry cannot
re-authorise the same named allowance.
