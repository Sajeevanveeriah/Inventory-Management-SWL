# Test strategy

All test data is synthetic and clearly fictional ("Fictionville"). No real business data may
appear in tests or fixtures.

## Levels

### Unit (Vitest, `src/core/*.test.ts`)

Pure business logic:

- Currency parsing (formats, rejects, >2dp rounding flags)
- Decimal-safe markup (`100.00 → 130.00` at 30%), half-up rounding, float-trap cases
- Property-based tests (fast-check) for markup and parsing round-trips
- Identifier normalisation: leading zeroes, punctuation, internal spacing preserved
- Exact matching, alias matching and precedence, duplicate and ambiguity blocking
- Status classification for every status, totals consistency
- Approval eligibility: bulk approval can never touch ambiguous/invalid/unchanged/missing
- Undo/redo/reset, decision history, carry-forward across comparison re-runs
- Import-output filtering (only approved + valid), release-checklist gates
- Formula-injection detection/neutralisation, filename sanitisation
- Audit report totals and content boundaries

### Integration (Vitest, `tests/*.test.ts(x)`)

- CSV and XLSX parsing through real PapaParse/ExcelJS (multi-sheet selection, formula cells,
  rich text, corrupted files, defensive limits)
- Full demo pipeline: parse → extract → compare → assert every expected status
- Export generation with re-parsing of all generated workbooks (structure, headers, membership
  rules, number formats, neutralised cells, audit content)
- jsdom app tests: demo walk-through to the review workspace, mapping suggestions, blocked rows
  exposing no approve control, unsupported-file rejection, export gating

### End-to-end (Playwright, `e2e/*.spec.ts`, production build)

`npm run e2e` builds and serves the production bundle, then:

- Complete synthetic workflow: load demo → map → validate (exact totals) → review every status →
  approve/exclude with confirmations → checklist → export → download and structurally verify all
  five files → clear session
- Verifies blocked records cannot be approved (no controls; bulk approval count stays 0)
- Settings changes require confirmation and re-price the comparison
- Keyboard-only operation: skip link, row navigation, selection, detail opening
- **Privacy**: every network request during the whole flow must stay on the local origin, and no
  console line may contain demo identifiers or prices

### Accessibility (Playwright + axe-core)

Automated WCAG 2.2 AA scans (`e2e/a11y.spec.ts`) on: start, files (including error state),
mapping, validate, review (light and dark), checklist, export (including generated state), and
the settings/privacy dialogs. Serious/critical findings fail the build. Keyboard flows are
covered by the E2E suite; manual verification is repeated before releases
(see RELEASE-CHECKLIST).

### Security-focused tests

Formula injection (input flagging, output neutralisation), malformed workbooks, unexpected cell
types, oversized files, duplicate identifiers, filename sanitisation, no-network verification,
console hygiene, and no unintended persistence (session clear returns to a clean start).

## Running

```bash
npm run test        # unit + integration
npm run e2e         # end-to-end + accessibility (production build)
npm run verify      # typecheck + lint + test + build
```
