# Data privacy

This tool processes commercially sensitive supplier and ServiceM8 data. The design goal is that
**business data cannot leave the operator's computer**, even in the presence of bugs.

## What happens to uploaded files

- Files are read with the browser File API into memory and parsed there.
- Parsed rows, matching results and review decisions live only in React state (memory).
- Closing or reloading the tab, or pressing **Clear session data**, discards them.
- Imported business rows are **never** written to IndexedDB, localStorage, cookies or anywhere
  else.

## What is stored (opt-in, this browser only)

IndexedDB database `swl-pricing-inventory`:

| Store      | Contents                                                       | Created when                                               |
| ---------- | -------------------------------------------------------------- | ---------------------------------------------------------- |
| `profiles` | Mapping profiles: profile name, header names, column positions | Operator clicks "Save as mapping profile"                  |
| `aliases`  | Approved supplier-code → item-number pairs                     | Operator approves an alias (demo aliases are session-only) |
| `settings` | Markup %, tax-handling selection, theme                        | Operator confirms a settings change                        |

**Delete saved profiles and aliases** (Privacy panel, with confirmation) clears all three stores.

## Enforcement layers

1. **No transmitting code**: the application contains no `fetch`, `XMLHttpRequest`, WebSocket or
   beacon calls with business data — there is no server to talk to.
2. **Content Security Policy** (production build): `connect-src 'none'` makes the browser refuse
   outbound requests from page code; `default-src 'none'` blocks everything not explicitly
   allowed; all scripts, styles and assets are same-origin and bundled.
3. **No remote assets**: system font stack, no CDN, no analytics, no telemetry, no error
   reporting service.
4. **Console hygiene**: raw records and monetary values are not logged. ESLint enforces
   `no-console` in application code.
5. **Repository hygiene**: `.gitignore` blocks spreadsheets and export-like filenames;
   `npm run check:data-safety` scans tracked/staged files for export-like names and secret
   patterns without printing file contents.

## Verification evidence

- `e2e/workflow.spec.ts` runs the complete workflow against the **production build** while
  recording every network request: the test fails if any request leaves
  `http://127.0.0.1:4173`, and it asserts no console line contains demo identifiers or prices.
- `tests/` verify that only approved, valid rows reach generated outputs and that audit output
  contains totals and identifiers rather than raw rows.

## What the audit report contains

Run identifier, timestamps, input filenames and locally computed SHA-256 hashes, sheet
selections, mapping profile name/version, matching totals, markup/tax/rounding settings,
approved records (identifier + amounts), exclusions with reasons, blocking exceptions and output
filenames. It is generated locally and only ever downloaded by the operator. It is not
telemetry; nothing is transmitted.
