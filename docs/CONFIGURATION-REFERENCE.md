# Configuration reference

The application exposes a versioned TypeScript registry in `src/core/configRegistry.ts`. Each setting has a stable key, category, type, default value, range or enum, unit, supported scopes, confirmation flag, impact-preview flag, help text, audit mode, schema version, migration mode and locked status.

Scopes resolve in this order: run, product, category, supplier, global, default.

## Categories

- Pricing and tax: strategy, markup, floor, GST, rounding, fixed add, target margin, competitor strategies, approval thresholds and price freeze.
- File parsing: file types, CSV controls, encoding, row, sheet, cell and preview limits.
- File-role and mapping automation: profile confidence, sheet confidence, mapping confidence, trusted saved mapping use and suggestion confirmation.
- Matching: identifiers, aliases, normalisation, brand, GTIN, pack, fuzzy suggestions, ambiguity and duplicate handling.
- Validation: missing, zero, negative, currency, GST, outlier, staleness, stock, condition and required-review policies.
- Workflow and approvals: comparison automation, repeat-run controls, bulk limits, pagination, density and undo depth.
- Competitor evidence: approved local collection methods, validity, currency, GST, confidence, strategy, selection and floor behaviour.
- Output: candidate template, report shape, summary sheet and audit detail.
- Display and accessibility: theme, density, dates and timezone.
- Privacy and retention: metadata, snapshots, retention, profile and alias retention.
- Locked safety invariants: local processing, no external runtime calls, no production writes, no scraping, ambiguous and invalid blocking, missing-item non-deletion, formula protection, leading-zero preservation, no raw-row persistence by default, approved-valid-changed-only output, floor enforcement, no arbitrary expressions and no release action.

## Import and export

Configuration export uses `{ schemaVersion, values }`. Import rejects unknown keys, invalid enum values, out-of-range numbers and locked-setting overrides. Older unsupported schema versions reset to defaults rather than guessing.
