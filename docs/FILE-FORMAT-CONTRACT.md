# File format contract

## Inputs

Two files are required per comparison:

| Input            | Description                                                  |
| ---------------- | ------------------------------------------------------------ |
| Supplier export  | The price list exactly as the supplier provides it           |
| ServiceM8 export | The current Materials & Services export (or import template) |

Accepted formats: **CSV** (UTF-8) and **XLSX**. Legacy `.xls` is rejected with guidance to
re-save as `.xlsx`.

### Structural requirements

- The first non-empty row of the selected sheet is the header row and must contain headings.
- At least one data row must follow.
- Multi-sheet workbooks are supported; the operator selects the sheet to use.

### Defensive limits (`src/io/limits.ts`)

| Limit                    | Value  | Reason                                        |
| ------------------------ | ------ | --------------------------------------------- |
| File size                | 25 MB  | Bounds memory use and zip-decompression abuse |
| Data rows per sheet      | 50,000 | Bounds processing time                        |
| Columns per sheet        | 100    | Bounds mapping UI and memory                  |
| Sheets per workbook      | 20     | Bounds workbook abuse                         |
| Characters kept per cell | 2,000  | Truncated with a warning                      |

Files beyond a limit are rejected with the specific limit named. Corrupted, password-protected
or fake XLSX files are rejected with a re-export suggestion.

### Cell handling

- Every value becomes a **string**; leading zeroes and punctuation in text cells are preserved
  verbatim (`00123` stays `00123`).
- Formula cells are **never executed**; the last calculated value stored in the file is used and
  a warning is shown.
- Rich text is flattened; hyperlink cells use their display text; error cells become blank.
- Values beginning with `=`, `+`, `-`, `@`, tab or carriage return are flagged as formula-like
  on input and neutralised on output.

### Conceptual fields (mapped by the operator — production column names are never assumed)

| Field                  | File      | Required |
| ---------------------- | --------- | -------- |
| Supplier item code     | supplier  | yes      |
| Supplier description   | supplier  | yes      |
| Supplier cost          | supplier  | yes      |
| ServiceM8 item number  | ServiceM8 | yes      |
| ServiceM8 description  | ServiceM8 | yes      |
| Existing cost          | ServiceM8 | yes      |
| Existing selling price | ServiceM8 | optional |

Header-based suggestions are advisory and always require operator confirmation.

### Monetary values

`100`, `100.5`, `1,234.56`, `$100.00`, `AUD 100.00`, `A$42` are accepted. Negative amounts,
empty values and non-numeric text are invalid. More than two decimal places is rounded half-up
and flagged as a warning.

## Outputs

All outputs are XLSX (audit summary is plain text), generated locally, named
`<yyyymmdd>-<profile>_<purpose>_run-<runid>.<ext>` with a sanitised profile name.

1. **`import-candidate`** — sheet `Import` plus `Summary`.
   - Contains **only approved, valid** price changes and new items. Never unchanged, excluded,
     ambiguous, invalid or missing records.
   - **Template adaptation**: when the ServiceM8 export is mapped, its exact header row and
     column order are reused. Price-change rows re-emit the original ServiceM8 row with only the
     cost and sell columns replaced; new-item rows fill only the mapped columns. When a genuine
     ServiceM8 import template is supplied in future, loading it as the ServiceM8-side file
     makes it control column names and ordering.
   - Amount cells are numeric with a `0.00` format; identifiers are string cells.
2. **`change-report`** — `Summary` totals plus `All records` with statuses, decisions, match
   methods, before/after values, cost movement, the pricing formula, source row references,
   exclusion reasons and validation messages.
3. **`exceptions`** — sheets `Ambiguous`, `Invalid`, `Missing from supplier` with explanations.
4. **`rollback`** — the ServiceM8 values and layout as loaded, with mandatory formula-like text
   neutralisation (plus an `About` sheet with the original filename and SHA-256), so the prior
   state can be reviewed and restored safely.
5. **`audit-summary`** — human-readable text (see `docs/DATA-PRIVACY.md`).

### "Import-ready" vs "candidate"

The generated file is labelled **candidate** because exact ServiceM8 import requirements cannot
be proven without the real ServiceM8 import template. The remaining validation step is:
perform a small trial import in ServiceM8 (or supply the official template as the ServiceM8-side
file) and confirm the header names, ordering and value formats are accepted. Until then, treat
the output as requiring that verification.

### Formula-injection protection

Text values written to any workbook are string-typed cells; formula-like values are additionally
prefixed with `'` and counted, and the count is shown next to the generated file.
