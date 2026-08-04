# SWL Pricing and Inventory Control

A local-first browser application for **Stan Wootton Locksmiths** that compares an untouched
supplier price export against the current ServiceM8 Materials & Services export, applies the
confirmed **30% markup on cost**, and produces a controlled, operator-reviewed candidate import
file — together with change, exception, rollback and audit reports.

> **No production data in this repository.** This is a public repository. Never commit real
> supplier exports, ServiceM8 exports, customer information, credentials or generated business
> outputs. Run `npm run check:data-safety` before committing; `.gitignore` also blocks common
> export patterns. All sample data in the app and tests is clearly fictional ("Fictionville").


## Operations hub revamp

The app now uses a GitHub Pages-compatible hash-routed operations shell with these destinations: dashboard, new run, runs, inventory, suppliers, mapping profiles, pricing rules, competitors, exceptions, approvals, exports, audit, settings and help. The seven-stage run workflow remains inside the New run workspace.

Competitor evidence is integrated into the TypeScript application as local-only manual or imported evidence. The nested Python prototype remains preserved as legacy reference material until documented feature-parity criteria are met.

Configuration is represented by a versioned typed registry in `src/core/configRegistry.ts`; locked safety invariants cannot be changed by imported configuration.

## Privacy model

- **All processing happens in the browser tab.** There is no backend, no cloud database, no
  authentication service, no analytics, no telemetry, no remote fonts and no CDN assets.
- The production build ships a restrictive Content Security Policy including
  `connect-src 'none'`, so the browser itself refuses any network transmission of page data.
  This is verified by an automated end-to-end test that monitors network activity against the
  production build.
- Uploaded files stay in memory. **Imported business rows are never persisted.**
- Only three kinds of operator-authored configuration can be stored (IndexedDB, this browser
  only): mapping profiles, approved aliases, and settings (markup %, tax selection, theme).
- "Clear session data" wipes in-memory work; "Delete saved profiles and aliases" (with
  confirmation) wipes everything stored.
- Raw records and sensitive values are never written to the browser console.

See [docs/DATA-PRIVACY.md](docs/DATA-PRIVACY.md).

## Business rules

- **Pricing**: `selling price = supplier cost × 1.30` (markup on cost, not gross margin).
  Example: supplier cost AUD 100.00 → selling price AUD 130.00.
- Decimal-safe arithmetic via [big.js] — never binary floats. Rounding is **half-up to
  2 decimal places**, shown in the UI and audit report. Currency is displayed as AUD.
- The original supplier cost is preserved separately from the calculated selling price, and the
  formula is shown wherever a proposed price appears.
- **Tax (GST) is never inferred or altered.** A clearly labelled tax-handling setting exists but
  applies no transformation under any option; the selection is recorded in the audit report.
- Changing markup or tax settings requires explicit confirmation and is recorded in the audit
  report; it invalidates the current comparison.

### Matching hierarchy (deterministic, safety-first)

1. Exact normalised supplier code → ServiceM8 item number (trim + case-insensitive only;
   punctuation, internal spacing and **leading zeroes are preserved exactly**).
2. Exact match through a previously operator-approved alias.
3. Description similarity produces **suggestions for manual review only** — never an automatic
   match. A near-identical description on an unmatched code blocks the record as _ambiguous_.

Duplicate identifiers in either file, and uncertain matches, are blocked as exceptions.

### Record statuses

| Status                | Meaning                                  | Behaviour                                  |
| --------------------- | ---------------------------------------- | ------------------------------------------ |
| Unchanged             | Supplier cost equals existing cost       | Excluded from import output by default     |
| Price changed         | Supplier cost differs                    | Proposed price calculated and presented    |
| New item              | Supplier code absent from ServiceM8      | Requires explicit approval                 |
| Missing from supplier | ServiceM8 item absent from supplier file | Flagged only — **never deleted**           |
| Ambiguous             | Duplicates / uncertain matches           | Blocked from import                        |
| Invalid               | Missing or malformed required value      | Blocked, with the exact error shown        |
| Excluded              | Operator excluded with a reason          | Preserved in the audit report              |
| Approved              | Operator approved the change             | Included only if all validation gates pass |

## The workflow

1. **Start** — rules summary, saved profiles, demo mode.
2. **Add files** — drag-and-drop or file picker for the supplier export and ServiceM8 export
   (CSV or XLSX; limits: 25 MB/file, 50,000 rows, 100 columns, 20 sheets).
3. **Map columns** — confirmed column mapping with automatic suggestions, sample values,
   duplicate-mapping detection and saveable supplier-specific profiles.
4. **Validate & compare** — deterministic classification with a visual pipeline of counts.
5. **Review** — searchable, sortable, filterable workspace with status tabs, bulk approve /
   exclude (with reasons), undo/redo, decision history and per-row detail (before/after values,
   markup formula, match method, messages, source rows).
6. **Pre-export checks** — release checklist; export stays disabled until every blocking gate
   passes (no approved ambiguous/invalid records, no duplicate identifiers, valid prices, …).
7. **Export** — five locally generated downloads:
   1. **Candidate ServiceM8 import workbook** (approved, valid changes only)
   2. Detailed change report (all records, before/after, formulas, decisions)
   3. Exceptions workbook (ambiguous / invalid / missing)
   4. Rollback copy of the original ServiceM8 export
   5. Human-readable audit summary (run id, file hashes, rules, totals, decisions)

Filenames are deterministic and sanitised:
`<date>_<profile>_<purpose>_run-<id>.<ext>`.

**Formula injection is prevented**: generated cells are written as string-typed values and any
value beginning with `=`, `+`, `-`, `@`, tab or carriage return is neutralised with a leading
apostrophe and flagged.

### "Candidate" import file

The genuine ServiceM8 import template has not yet been supplied, so production column names are
never invented. When a ServiceM8 export is loaded, the import workbook **adapts its exact headers
and column order** (price-change rows re-emit the original row with only cost/sell replaced).
The output is labelled a _candidate_ import file until it is validated against a real ServiceM8
import template — see [docs/FILE-FORMAT-CONTRACT.md](docs/FILE-FORMAT-CONTRACT.md) for the
adaptation workflow.

## Getting started

Prerequisites: Node.js ≥ 20.19 and npm (no global installs required).

```bash
npm install          # install pinned dependencies (see below)
npm run dev          # development server
npm run build        # type-check + production build (dist/)
npm run preview      # serve the production build locally
```

Quality gates:

```bash
npm run typecheck      # TypeScript strict mode
npm run lint           # ESLint
npm run test           # Vitest unit + integration tests
npm run e2e            # Playwright end-to-end + accessibility tests (production build)
npm run check:data-safety  # detect likely business exports/secrets in git
npm run verify         # typecheck + lint + test + build
```

### Dependencies (runtime)

| Package           | Purpose                                    | Licence |
| ----------------- | ------------------------------------------ | ------- |
| react / react-dom | UI framework                               | MIT     |
| papaparse         | CSV parsing                                | MIT     |
| exceljs           | XLSX read/write in-browser                 | MIT     |
| big.js            | Decimal-safe currency arithmetic           | MIT     |
| zod               | Schema validation for stored configuration | MIT     |
| idb               | Typed IndexedDB wrapper                    | ISC     |

Dev/test: vite, typescript, vitest, @testing-library/*, fast-check, @playwright/test,
@axe-core/playwright, eslint + typescript-eslint, prettier. Versions are pinned exactly in
`package.json`.

## Demonstration mode

"Load synthetic demonstration" on the start screen loads clearly fictional _Fictionville_
data covering every scenario: unchanged, price increase, price decrease, new item, missing item,
duplicate identifiers, ambiguous description match, missing cost, invalid currency, an
identifier with leading zeroes (`00123`), a formula-injection attempt, an approved alias and an
excludable record. A "Fictional demo data" badge is shown while active.

## Using genuine files safely

1. Export the supplier price list and the ServiceM8 Materials & Services list; do **not** edit them.
2. Load both files, map the columns, and save a supplier-specific mapping profile.
3. Review, approve and export as above. Keep the rollback workbook and audit summary.
4. Validate the candidate import file against a real ServiceM8 import template (or a small trial
   import) before importing in bulk.
5. Never commit any of these files to this repository.

## Architecture, testing, releases

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — module layout and workflow diagram
- [docs/DATA-PRIVACY.md](docs/DATA-PRIVACY.md) — privacy guarantees and verification
- [docs/FILE-FORMAT-CONTRACT.md](docs/FILE-FORMAT-CONTRACT.md) — input/output contracts and limits
- [docs/TEST-STRATEGY.md](docs/TEST-STRATEGY.md) — test levels and how to run them
- [docs/RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md) — gates before shipping a build

## Current limitations

- The import output is a **candidate** file until verified against a genuine ServiceM8 import
  template; exact ServiceM8 import requirements cannot be proven without it.
- Phase 1 has no ServiceM8 or Xero API integration (deliberate).
- Legacy `.xls` workbooks are not supported — re-save as `.xlsx`.
- Selecting a different worksheet re-reads the file from the in-memory copy; browsers may
  invalidate very large `File` handles if the file changes on disk mid-session.
- GST/tax transformations are intentionally not implemented.

## Troubleshooting

| Symptom                                          | Cause / fix                                                                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| "not a supported file type"                      | Only `.csv`/`.xlsx`. Re-save `.xls` files as `.xlsx`.                                                             |
| "too large / too many rows/columns/sheets"       | Defensive limits — split the export or remove unused sheets.                                                      |
| "empty header row"                               | The first row of the sheet must contain column headings.                                                          |
| Cost shown as invalid                            | Values must be numeric AUD amounts (`100`, `$100.00`, `1,234.56`); negatives are rejected.                        |
| Comparison reset after changing mapping/settings | Intentional: business-rule changes invalidate results; decisions on unchanged rows are carried forward on re-run. |
| Export button disabled                           | A blocking gate on the Pre-export checks step is failing; the checklist explains the repair.                      |

[big.js]: https://github.com/MikeMcl/big.js
