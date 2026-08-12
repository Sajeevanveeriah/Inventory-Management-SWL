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
- Output: ServiceM8 Materials & Services CSV, report shape, summary sheet and audit detail.
- Display and accessibility: theme, density, dates and timezone.
- Privacy and retention: metadata, snapshots, retention, profile and alias retention.
- Locked safety invariants: local business-file processing, no production writes, no scraping, ambiguous and invalid blocking, missing-item non-deletion, formula protection, leading-zero preservation, no raw-row persistence by default, approved-valid-changed-only output, floor enforcement, no arbitrary expressions and no release action. The only optional external runtime call is an explicit, budgeted competitor query through the reviewed native desktop adapter or supervised local Node adapter; it never includes imported rows, costs, sell prices, notes or customer data. Static GitHub Pages performs no provider search.

## Import and export

Configuration export uses the versioned checksummed envelope documented by the platform contract.
Import rejects unknown keys, invalid enum values, out-of-range numbers, conflicts and locked-setting
overrides. Unsupported or malformed versions leave live configuration unchanged and block the
workflow; they are never converted to defaults or silently discarded.

## Live-provider runtime controls

GitHub Pages contains no provider endpoint or credential. Desktop live search requires a credential
stored in Windows Credential Manager, successful validation, a positive total ceiling, a positive
per-call reservation and explicit paid-call enablement. The supervised local Node adapter selects
`serper`, `ebay` or `serpapi` with `SWL_SEARCH_PROVIDER`. Serper reads `SERPER_API_KEY`; eBay reads
`EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET`; both run without the paid-call budget while remaining
subject to provider quotas. SerpAPI retains the explicit paid-call controls documented in
`.env.example`.
