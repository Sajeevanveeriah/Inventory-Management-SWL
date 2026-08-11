# SWL Pricing and Inventory Control

## Windows desktop status

The repository contains one React frontend with a Tauri 2 desktop target. The packaged target is designed to open in its own native WebView2 window without starting the Node demonstration server or a loopback listener. The browser demonstration remains available through the existing Node adapter. Each release candidate must still pass the native process, listener and installed-window checks in `docs/RELEASE-CHECKLIST.md` before that behaviour is claimed for an artefact.

Desktop operational metadata is stored in SQLite under the per-user application local-data directory resolved by Tauri for `au.com.stanwoottonlocksmiths.swl-pricing`; it is never stored in the installation directory. Raw supplier and ServiceM8 import rows remain memory-only. Provider credentials are protected by Windows and are not stored in SQLite. Optional native search is disabled by default and manual evidence remains available offline.

The canonical package target is an unsigned NSIS current-user installer for Windows 10/11 x64. Packaging is configured for the Evergreen WebView2 offline installer, which increases installer size so first installation can work without network access. The Windows workflow is configured to prevalidate the official x64 payload and prove the embedded bytes and Microsoft Authenticode identity for each built artefact. Native Windows 10/11 installation and interactive acceptance are still release gates. Uninstall is designed to preserve application data, and the workflow is configured to check that boundary in a hosted-runner smoke; production signing, automatic updates, MSI distribution and installation on the real SWL computer are outside the current release boundary. An unsigned internal installer is expected to show a Windows SmartScreen or unknown-publisher warning.

New dated exports use `YYYYMMDD-<existing-remainder>.<ext>`. Existing files are never silently overwritten.

> **Outstanding security action.** A provider credential was committed to this repository's
> history before the current safeguards existed (`npm run check:secrets` reports the reachable
> blobs). The repository is private, but that key must be **rotated at the provider** and the old
> one revoked. The working tree is clean and `.gitignore` blocks `.env`; rotation is the only
> remaining step, and it cannot be done from inside the repository.

Development requires Node 22.22.2, npm, Rust 1.89.0 and the Windows MSVC build prerequisites. Install project dependencies with `npm ci`, verify with `npm run verify`, and build the Windows package on native Windows x64 with `npm run desktop:build`. The installed computer does not require Node.js, Rust, npm or a repository checkout.

> Competitor intelligence architecture, pricing evidence policy, provider setup and operations: [docs/COMPETITOR-INTELLIGENCE-ARCHITECTURE.md](docs/COMPETITOR-INTELLIGENCE-ARCHITECTURE.md).

A local-first application with Windows desktop and browser surfaces for **Stan Wootton
Locksmiths** that compares an untouched
supplier price export against the current ServiceM8 Materials & Services export, applies the
confirmed **30% markup on the GST-exclusive cost**, and produces a controlled, operator-reviewed
**ServiceM8 import CSV in ServiceM8's exact format** — together with change, exception, rollback
and audit reports.

> **Proprietary software.** Copyright © 2026 Stan Wootton Locksmiths. All rights reserved.
> See [LICENSE](LICENSE). No licence is granted by publication of this repository.

## The ServiceM8 round trip

The import file this application generates is a ServiceM8 Materials & Services CSV, produced so
that it is structurally indistinguishable from a genuine ServiceM8 export: the same nine columns
in the same order, the same value conventions, and the same CSV dialect (UTF-8 with no BOM, CRLF
on every line, quoting only where a field contains a comma, a quote or a line break). The writer
reproduces a genuine-shaped export byte-for-byte in test.

Each changed item is emitted by copying its original ServiceM8 row verbatim and replacing only
`Price` and `Purchase Cost`; every other column survives untouched. The rollback file is the same
format carrying the prior values, so an undo is a single import rather than a manual repair.

**GST is handled per row.** ServiceM8 records each material's price against one of two bases in
its `Price Includes Taxes` column, and a single marked-up number cannot serve both — writing the
GST-exclusive figure into a tax-inclusive row under-prices it by the whole GST rate. The markup is
therefore applied to the GST-exclusive cost, and GST is added only for rows that say their price
includes it. How the SUPPLIER quotes its costs is the one fact the files cannot answer, so the
operator states it in Configuration; until they do, a release gate blocks export.

**Do not open the generated CSV in a spreadsheet.** Opening and saving it rewrites long item
numbers and barcodes into scientific notation irreversibly — damage already visible in genuine
ServiceM8 exports, which the application detects and reports rather than matching on.

To verify the whole pipeline against real files on your own computer, without ever putting
business data in this repository:

```bash
SWL_VERIFY_SUPPLIER_CSV=/path/to/supplier.csv \
SWL_VERIFY_SERVICEM8_CSV=/path/to/servicem8-export.csv \
npm test -- real-file-verification
```

> **No production data in this repository.** Never commit real
> supplier exports, ServiceM8 exports, customer information, credentials or generated business
> outputs. Run `npm run check:data-safety` before committing; `.gitignore` also blocks common
> export patterns. All sample data in the app and tests is clearly fictional ("Fictionville").

## Operations hub revamp

The app uses a GitHub Pages-compatible hash-routed operations shell with these destinations: dashboard, new run, runs, inventory search, expansion catalogue, suppliers, mapping profiles, pricing rules, competitor search, source registry, exceptions, approvals, exports, integrations, audit, settings and help. The seven-stage run workflow remains inside the New run workspace.

Key operational capabilities:

- **Product search** (`#/inventory` and the topbar search, shortcut `/`): deterministic,
  exact-first ranked search across supplier codes, ServiceM8 item numbers and descriptions,
  with status filter chips. See `src/core/search.ts`.
- **Expansion catalogue** (`#/expansion`): retains the supplier's optional Category column and
  groups valid supplier-only products for future range planning. The page is read-only and does
  not bypass review: a new ServiceM8 item is emitted only after explicit operator approval.
- **Supplier profiles** (`#/suppliers`): save, apply, export, import (JSON) and delete mapping
  profiles through the selected platform adapter (IndexedDB for the web demonstration, SQLite for
  the Windows application).
- **Exceptions** (`#/exceptions`): searchable queue with exclude-with-reason for eligible rows;
  ambiguous and invalid rows stay blocked.
- **Approvals** (`#/approvals`): per-proposal approve and withdraw actions backed by the same
  reviewed decision state as the Review step.
- **Integrations** (`#/integrations`): honest adapter status for ServiceM8 (file handoff) and
  Xero (locked boundary). No live external writes are possible from the application.
- **Competitor search** (`#/competitors`): optional explicit internet search for a typed-in product
  name, part number, SKU, brand, partial description or barcode — no prior import required. The
  web demonstration calls its Node adapter on the same origin; the desktop adapter calls the Rust
  backend, which permits only the reviewed provider HTTPS endpoint and rejects redirects. Calls
  remain disabled until the operator stores and successfully validates the protected credential,
  enters a positive total ceiling and positive per-call reservation in integer cents, and then
  explicitly enables paid calls. The native budget pessimistically reserves the per-call amount
  before each request and reports quota exhaustion before a request could exceed the ceiling.
  Results carry title,
  AUD price, GST basis (or "unknown"),
  unit/pack size where determinable, seller/source domain, retrieval timestamp and a working
  source link. A lowest/median/highest price band with source counts sits above the results, and
  coverage gaps (empty and failed sources) are always disclosed. Not-configured, offline,
  provider failure, timeout, quota exhaustion, local rate limiting and zero results render as
  distinct visible states. Manual entry stays
  as the fallback. Attaching a result to a catalogue item stores reference information only: it
  is provably incapable of altering a cost or sell price (asserted byte-for-byte in tests).
- **Source registry** (`#/sources`): every competitor/supplier source with its access method
  and an enable/disable toggle, including the live provider.

## Windows desktop application (Tauri)

The same frontend is packaged as a Windows desktop shell built with Tauri 2 (`src-tauri/`):

- native input and output pickers using bounded Rust-owned grants; exports are chunked, written
  atomically and never silently overwrite an existing file;
- Rust-side filename sanitisation (Windows-invalid characters, reserved device names, path
  traversal) with unit tests;
- a reviewed imported Tauri API and a typed platform adapter; global Tauri injection is disabled;
- narrowly scoped custom permissions for native data, recovery, search and file operations;
- installer icons are a bundled square adaptation of the official SW Locksmiths brand mark from
  `https://www.swlocksmiths.com.au/wp-content/themes/swlocksmiths/img/logo.png`, reviewed on
  9 August 2026 (source SHA-256
  `7e99b6eec950f5f952d75043e9b903adbee4e3c65d18eee7a2726114b82db9f7`); no remote image is loaded
  at runtime;
- the browser build retains its Node adapter while the desktop build contains no Node server.

Build on Windows x64 with the exact Node/Rust toolchains and the documented Microsoft build
prerequisites. Accept a workflow-built installer only after its evidence proves that the embedded
Evergreen WebView2 payload matches the prevalidated Microsoft-signed x64 payload; the developer
machine still needs the normal Tauri Windows prerequisites:

```bash
npm ci
npm run desktop:build   # produces the canonical unsigned NSIS installer
npm run desktop:dev     # development shell
```

The desktop production build receives one Content Security Policy from Tauri and permits only
bundled resources plus the local IPC bridge. The web build uses its own CSP with
`connect-src 'self'` only.

### Internal installer, upgrade and recovery procedure

1. On a disposable or approved Windows 10/11 x64 standard-user profile, compare the downloaded
   installer's SHA-256 with `SHA256SUMS.txt`. Internal artefacts are unsigned: continue past an
   unknown-publisher or SmartScreen warning only when the file came from the authorised PR
   artefact and its checksum matches.
2. Run the NSIS installer as the current user, then launch **SWL Pricing and Inventory Control**
   from the Start Menu. Do not install Node.js or start the browser-demonstration server.
3. Before an upgrade, open **Settings > Backup and recovery** and create a verified local backup.
   The current UI retains verified backups inside application data; it does not import an arbitrary
   external backup file. For additional off-computer protection, close the application and copy the
   entire runtime-resolved data directory to an approved protected medium. Installing the newer
   current-user package over the existing package preserves that directory beneath
   `%LOCALAPPDATA%\au.com.stanwoottonlocksmiths.swl-pricing` and creates a verified automatic
   pre-migration backup before changing its schema.
4. If an upgrade launches but must be rolled back, preview and restore the verified pre-upgrade
   backup in **Backup and recovery**, close the application, uninstall the newer binaries, then
   reinstall the last accepted internal installer. Uninstall never doubles as data erasure.
5. If the upgraded application cannot reach its recovery screen, stop. Preserve the entire data
   directory and installer evidence unchanged for supervised recovery; do not open the newer
   database with an older executable or manually replace SQLite/WAL files. Reintroducing a whole
   off-computer directory copy is a supervised recovery action, not an in-app import in this
   release.

Application-data erasure is a separate in-app preview plus exact confirmation phrase. It creates a
verified backup first and is never performed by the uninstaller. On desktop it erases the native
SQLite/configuration store and protected provider credential in the displayed scope; it preserves
same-WebView legacy IndexedDB configuration as a non-authoritative migration source for later
previewed reimport.

Competitor evidence supports local manual records and the optional explicit provider path
described above. The nested Python prototype remains preserved as legacy reference material until
documented feature-parity criteria are met.

Configuration is represented by a versioned typed registry in `src/core/configRegistry.ts`; locked safety invariants cannot be changed by imported configuration.

## Privacy model

> **Network boundary.** The GitHub Pages build sends an authenticated, operator-initiated product
> query and the subsequently selected opaque product token only to its exact protected API origin.
> The optional local browser demonstration uses the Node adapter on its own origin. The installed
> desktop application does not bundle or start that server: desktop search is performed by Rust
> only through approved HTTPS provider hosts, and the WebView cannot contact provider endpoints
> directly.

- **Business file processing stays in the shared UI's memory.** Imported supplier and ServiceM8
  rows are never included in network requests. An explicit search sends only the operator's typed
  competitor query and, after exact selection, the opaque product token: through Rust on desktop,
  the exact protected API used by GitHub Pages, or the same-origin Node adapter in the local web
  demonstration. Pages also sends its memory-only bearer token as transport authentication.
- No analytics, no telemetry, no remote fonts and no CDN assets.
- The desktop CSP permits bundled resources and the Tauri IPC bridge only; the WebView cannot
  contact provider hosts. The local web demonstration permits its own origin; the Pages CSP adds
  only the exact protected API origin compiled into that build.
- Uploaded files stay in memory. **Imported business rows are never persisted.**
- The web demonstration stores operator-authored mapping profiles, approved aliases and settings
  in IndexedDB. The desktop adapter stores authorised operational records in SQLite under the
  stable per-user local-data directory. Raw imported rows remain memory-only on both platforms.
- "Clear active workflow" wipes the current imported files, mapping and review work but does not
  erase operational records, configuration or credentials. "Preview application data erasure…" shows an exact
  scope, creates a verified backup and requires the displayed confirmation phrase before deleting
  authorised local records; uninstall remains separate and preserves application data. Desktop
  reset preserves legacy WebView IndexedDB configuration outside the native-store erasure scope so
  it can be previewed for reimport.
- Raw records and sensitive values are never written to the browser console.

See [docs/DATA-PRIVACY.md](docs/DATA-PRIVACY.md).

## Business rules

- **Pricing**: `selling price = supplier cost × 1.30` (markup on cost, not gross margin).
  Example: supplier cost AUD 100.00 → selling price AUD 130.00. The floor is one named
  constant and one pure function (`MINIMUM_MARKUP_ON_COST`, `minimumSellPrice` in
  `src/core/money.ts`), unit-tested with `minimumSellPrice(100) === 130.00`.
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
   1. **ServiceM8 Materials & Services import CSV** (approved, valid changes only)
   2. Detailed change report (all records, before/after, formulas, decisions)
   3. Exceptions workbook (ambiguous / invalid / missing)
   4. Rollback copy of the original ServiceM8 export
   5. Human-readable audit summary (run id, file hashes, rules, totals, decisions)

Filenames are deterministic and sanitised:
`YYYYMMDD-<profile>_<purpose>_run-<id>.<ext>`.

**Formula injection is prevented**: generated cells are written as string-typed values and any
value beginning with `=`, `+`, `-`, `@`, tab or carriage return is neutralised with a leading
apostrophe and flagged.

### ServiceM8 import file

The generated handoff is a CSV in ServiceM8's Materials & Services format. It uses the genuine
nine-column contract or retains the loaded ServiceM8 export's complete compatible header row and
extra columns. Existing rows are copied from the original export with only approved cost and sell
values replaced. New rows use documented defaults, and the paired rollback CSV restores prior
values for existing items in one import. See
[docs/FILE-FORMAT-CONTRACT.md](docs/FILE-FORMAT-CONTRACT.md) for the tested round-trip contract.

## Browser deployment shape

The public frontend is a static GitHub Pages build with no provider integration. It contains no
SerpAPI key, access token or cost-control secret and makes no live competitor-search request.
Manual competitor evidence and the core comparison workflow remain available. The installed
desktop performs optional live search through its native Rust client and Windows protected
credential storage. Product discovery and merchant-offer retrieval remain separate calls, so
Google Shopping product candidates are never presented as competitor offers.

The repository also includes one small loopback Node server (`server/`) for local development:

- the browser calls its own origin only; the server performs outbound provider searches and
  returns normalised results;
- the server persists catalogue items, append-only price history, approval records, competitor
  reference prices and source-registry state in a JSON/JSONL directory store (`server/data/`,
  gitignored; configurable via `SWL_DATA_DIR`);
- it can serve the built SPA from `dist/` for supervised local use.

> **GitHub Pages remains session-only for operational records.** Approved catalogue records,
> approvals, price history, references and source changes remain in memory for the current tab and
> disappear on refresh. Operator-authored profiles, aliases and settings continue to use IndexedDB.
> Live provider search is deliberately unavailable in this static build.

### Live search provider keys

The supervised Node service supports two zero-per-call-cost adapters and the existing licensed
SerpAPI adapter behind `server/search/`. Set `SWL_SEARCH_PROVIDER=serper` with `SERPER_API_KEY`, or
set `SWL_SEARCH_PROVIDER=ebay` with `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` and
`EBAY_MARKETPLACE_ID=EBAY_AU`. The start scripts read these values from `.env` or the process
environment; credentials remain server-side. Serper's finite free credits and eBay's official API
quotas and terms still apply. Both adapters return direct AUD offers and visibly exclude results
without a supported delivered total.

For `SWL_SEARCH_PROVIDER=serpapi`, a key alone never authorises a paid call. The Node service also
requires `SWL_PAID_CALLS_ENABLED=true`, a positive integer
`SWL_PROVIDER_COST_CEILING_CENTS` and a positive integer
`SWL_PROVIDER_COST_PER_CALL_CENTS`. Missing, partial, malformed or non-positive configuration fails
closed. Deterministic fixtures are test-only, and GitHub Pages receives no provider configuration.

## Development and browser demonstration

Development requires exact Node.js 22.22.2 and the locked project dependencies. The installed
Windows application does not require Node.js, a repository checkout, a terminal or a browser.
The commands below are for development and the secondary browser demonstration only.

```bash
npm ci               # install the exact locked dependency graph
npm run seed         # seed realistic fictional sample data into server/data/
npm run server       # serves the app AND the API on http://127.0.0.1:8787 (.env auto-loaded)
npm run dev          # development server (proxies /api to the Node server)
npm run build        # type-check + production build (dist/)
npm run server:fixture  # offline deterministic provider for automated/local testing only
```

The `server` scripts allow only the exact loopback Vite development and preview origins in addition
to their own origin. Foreign origins, forged hosts, cross-site requests and non-JSON mutations are
rejected before request bodies or paid-search routes are processed.

Those controls protect the browser boundary, not against another process already running on the
same computer. The optional Node demonstration has no OS-user authentication: do not run it with
real operational data or a live provider credential on a shared or untrusted workstation. This
limitation does not affect the packaged desktop, which does not start or contact the Node server.

Configuration hydration fails closed. If settings, mappings, aliases, sources or the legacy
IndexedDB migration status cannot be validated, comparison, approval and export remain blocked
rather than silently substituting defaults. Web configuration imports are additive and reject
conflicting identifiers; reset confirmation is bound to the exact previewed snapshot so later
changes require a new preview.

Quality gates:

```bash
npm run typecheck      # TypeScript strict mode
npm run lint           # ESLint
npm run test           # Vitest unit + integration tests
npm run e2e            # Playwright end-to-end + accessibility tests (production build)
npm run e2e:desktop    # external WebDriver against a built production desktop executable
npm run check:data-safety  # detect likely business exports in the proposed tree
npm run check:secrets      # scan the proposed tree and reachable history without printing values
npm run check:pages        # validate a Pages-base production build
npm run check:desktop-boundaries  # validate CSP, capabilities and production driver absence
npm run verify         # typecheck + lint + test + build
```

### Dependencies (runtime)

| Package           | Purpose                                    | Licence        |
| ----------------- | ------------------------------------------ | -------------- |
| react / react-dom | UI framework                               | MIT            |
| papaparse         | CSV parsing                                | MIT            |
| exceljs           | XLSX read/write in-browser                 | MIT            |
| big.js            | Decimal-safe currency arithmetic           | MIT            |
| zod               | Schema validation for stored configuration | MIT            |
| idb               | Typed IndexedDB wrapper                    | ISC            |
| @tauri-apps/api   | Imported desktop IPC API                   | MIT/Apache-2.0 |

Desktop Rust dependencies are deliberately exact and locked in `src-tauri/Cargo.lock`:

| Crate                        |                    Exact version | Licence           | Desktop purpose                                                                                            |
| ---------------------------- | -------------------------------: | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| tauri / tauri-build          |                   2.11.5 / 2.6.3 | Apache-2.0 OR MIT | Native window, scoped IPC and NSIS build                                                                   |
| tauri-plugin-dialog          |                            2.7.2 | Apache-2.0 OR MIT | Native operator-selected input/output dialogs                                                              |
| tauri-plugin-single-instance |                            2.3.7 | Apache-2.0 OR MIT | One database-writing application instance                                                                  |
| rusqlite                     |                           0.37.0 | MIT               | Parameterised SQLite, transactions and backup API; bundled SQLite avoids a target-machine DLL prerequisite |
| reqwest                      |                           0.13.4 | Apache-2.0 OR MIT | Rust-owned allowlisted HTTPS provider client with Rustls                                                   |
| serde / serde_json           |                1.0.229 / 1.0.151 | Apache-2.0 OR MIT | Deny-unknown typed IPC and persisted JSON validation                                                       |
| uuid / base64 / sha2 / url   | 1.24.0 / 0.22.1 / 0.10.9 / 2.5.8 | Apache-2.0 OR MIT | Opaque grants, bounded chunks, SHA-256 integrity and URL validation                                        |
| quick-xml / zip              |                   0.41.0 / 8.2.0 | MIT               | Bounded native XLSX metadata and decompression-limit inspection                                            |

Dev/test: vite, typescript, vitest, @testing-library/*, fast-check, @playwright/test,
@axe-core/playwright, the external @wdio Tauri service, eslint + typescript-eslint and prettier.
Versions are pinned exactly in `package.json`; `tauri-driver` 2.0.6 is installed externally and
project-locally by Windows CI, never compiled into the application.

| Desktop test tool          | Exact version | Licence           | Boundary                                  |
| -------------------------- | ------------- | ----------------- | ----------------------------------------- |
| @wdio/cli and local runner | 9.30.1        | MIT               | Development/CI only                       |
| @wdio/globals              | 9.29.1        | MIT               | Development/CI only                       |
| @wdio/jasmine-framework    | 9.30.1        | MIT               | Development/CI only                       |
| @types/jasmine             | 5.1.15        | MIT               | Desktop-test TypeScript declarations only |
| @wdio/spec-reporter        | 9.30.1        | MIT               | Development/CI only                       |
| @wdio/tauri-service        | 1.3.0         | MIT               | External driver orchestration only        |
| tauri-driver               | 2.0.6         | Apache-2.0 OR MIT | External project-local CI executable only |

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
4. Import the generated `servicem8-import` CSV through ServiceM8 Materials & Services. A small trial
   import remains prudent before a large production run.
5. Never commit any of these files to this repository.

## Architecture, testing, releases

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — module layout and workflow diagram
- [docs/DATA-PRIVACY.md](docs/DATA-PRIVACY.md) — privacy guarantees and verification
- [docs/FILE-FORMAT-CONTRACT.md](docs/FILE-FORMAT-CONTRACT.md) — input/output contracts and limits
- [docs/TEST-STRATEGY.md](docs/TEST-STRATEGY.md) — test levels and how to run them
- [docs/RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md) — gates before shipping a build

## Current limitations

- Phase 1 has no ServiceM8 or Xero API integration (deliberate).
- Legacy `.xls` workbooks are not supported — re-save as `.xlsx`.
- Selecting a different worksheet re-reads the file from the in-memory copy; browsers may
  invalidate very large `File` handles if the file changes on disk mid-session.
- GST/tax transformations are intentionally not implemented.
- Hosted Windows Server 2025 compilation, production-binary WebDriver, the documented former-source
  1.0.0-to-1.1.0 migration smoke and installer lifecycle smoke do not replace the release
  checklist's interactive Windows 10/11 DPI, upgrade, restart, spreadsheet-open or complete visual
  acceptance. The former source's reviewed Cargo lock repair fixture and exact hashes are documented
  in [.github/fixtures/README.md](.github/fixtures/README.md).

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
