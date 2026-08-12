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

### The ServiceM8 Materials & Services contract

A genuine ServiceM8 export is a nine-column CSV. `src/core/servicem8Format.ts` is
the single authority on it:

| #   | Column                 | Notes                                              |
| --- | ---------------------- | -------------------------------------------------- |
| 1   | `Item Number`          | Import key. Matched against the supplier item code |
| 2   | `Name`                 | Item name                                          |
| 3   | `Purchase Cost`        | Frequently `0` in real exports                     |
| 4   | `Quantity In Stock`    | Never changed by this application                  |
| 5   | `Price`                | The selling price this application replaces        |
| 6   | `Price Includes Taxes` | `Yes` or `No` - the GST basis **of that row**      |
| 7   | `Tax Rate`             | e.g. `GST on Income`, or blank                     |
| 8   | `Item is Inventoried`  | Never changed by this application                  |
| 9   | `Barcode`              | Often damaged by spreadsheet round-tripping        |

**CSV dialect**, established by round-tripping a genuine export byte-for-byte
and asserted in `tests/servicem8Format.test.ts`:

- UTF-8 with **no** byte order mark;
- **CRLF** terminating every line, including the last;
- a field is quoted **only** when it contains `,`, `"`, CR or LF;
- an embedded `"` is escaped by doubling it.

### Conceptual fields (mapped by the operator - production column names are never assumed)

| Field                            | File      | Required |
| -------------------------------- | --------- | -------- |
| Supplier item code               | supplier  | yes      |
| Supplier description             | supplier  | yes      |
| Supplier cost                    | supplier  | yes      |
| Supplier barcode                 | supplier  | optional |
| ServiceM8 `Item Number`          | ServiceM8 | yes      |
| ServiceM8 `Name`                 | ServiceM8 | yes      |
| ServiceM8 `Price`                | ServiceM8 | yes      |
| ServiceM8 `Price Includes Taxes` | ServiceM8 | yes      |
| ServiceM8 `Purchase Cost`        | ServiceM8 | optional |
| ServiceM8 `Tax Rate`             | ServiceM8 | optional |
| ServiceM8 `Quantity In Stock`    | ServiceM8 | optional |
| ServiceM8 `Item is Inventoried`  | ServiceM8 | optional |
| ServiceM8 `Barcode`              | ServiceM8 | optional |

`Price Includes Taxes` is **mandatory** because it decides whether GST is added
to the marked-up cost; defaulting it would move the price by the whole GST rate.
`Purchase Cost` is optional because genuine exports routinely record zero.

Header-based suggestions are advisory and always require operator confirmation.

### Pricing

The markup is always applied to the **GST-exclusive** cost, because GST is
collected and remitted, not a cost of the business:

```
cost (ex GST)  ->  x (1 + markup/100)  ->  sell (ex GST)
                                       ->  x 1.10  ->  sell (incl GST)
```

Which of the two is written into `Price` is decided **per row** by that row's
own `Price Includes Taxes` value. How the SUPPLIER quotes its cost is the one
fact that cannot be read from the files, so the operator states it in
Configuration; until they do, export is blocked by a release gate.

### Real-world hazards this contract handles

| Hazard                                          | Behaviour                                                       |
| ----------------------------------------------- | --------------------------------------------------------------- |
| Same supplier code on many rows, identical cost | Folded into one proposal, with the folded rows named            |
| Same supplier code, **different** costs         | Every copy blocked as ambiguous - the right cost is undecidable |
| `P.O.A.` in a price column                      | Its own explanation; the item must be priced by hand            |
| `9.34368E+12` in an identifier or barcode       | Reported as spreadsheet damage; never matched on                |
| `Purchase Cost` of `0`                          | Not an error; the decision is made on the selling price         |
| Duplicate ServiceM8 item numbers                | Blocked as exceptions                                           |

### Monetary values

`100`, `100.5`, `1,234.56`, `$100.00`, `AUD 100.00`, `A$42` are accepted. Negative amounts,
empty values and non-numeric text are invalid. More than two decimal places is rounded half-up
and flagged as a warning.

## Outputs

Outputs are generated locally and named
`<yyyymmdd>-<profile>_<purpose>_run-<runid>.<ext>` with a sanitised profile name.

1. **`servicem8-import`** - a **CSV in ServiceM8's exact format**, not a workbook.
   - Contains **only approved, valid** price changes and new items. Never unchanged, excluded,
     ambiguous, invalid or missing records.
   - Each existing item is emitted by copying its ORIGINAL ServiceM8 row verbatim and replacing
     only `Price` and `Purchase Cost`. Every other column - including any column this application
     does not model - survives the round trip untouched.
   - New items fill the columns the mapping resolves and take documented defaults for the rest:
     `Quantity In Stock` `0`, `Item is Inventoried` `No`, and the tax basis and rate the ServiceM8
     account already uses most often (reported in the UI and audit summary).
   - The header row is the loaded export's own when it carries the whole contract, otherwise the
     canonical nine columns.
2. **`change-report`** - `Summary` totals plus `All records` with statuses, decisions, match
   methods, before/after values, cost movement, the pricing formula, source row references,
   exclusion reasons and validation messages.
3. **`exceptions`** - sheets `Ambiguous`, `Invalid`, `Missing from supplier` with explanations.
4. **`servicem8-rollback`** - a CSV in the SAME ServiceM8 format carrying the ORIGINAL values of
   exactly the rows this run changes, so importing it restores the prior state in one step. New
   items have no prior state and are listed in the audit summary instead.
5. **`audit-summary`** - human-readable text (see `docs/DATA-PRIVACY.md`).

### Format assurance

The generated import file is verified against a genuine ServiceM8 export, not assumed:

- `tests/servicem8Format.test.ts` proves the writer reproduces a genuine-shaped export
  byte-for-byte, and that the header contract resolves under reordering and re-casing.
- `tests/exports.test.ts` proves the generated file re-parses, carries ServiceM8's own header row,
  honours each row's GST basis, and leaves every unowned column untouched.
- `tests/real-file-verification.test.ts` runs the whole pipeline over REAL exports on the
  operator's own computer, on demand:

  ```bash
  SWL_VERIFY_SUPPLIER_CSV=/path/to/supplier.csv \
  SWL_VERIFY_SERVICEM8_CSV=/path/to/servicem8-export.csv \
  npm test -- real-file-verification
  ```

  It skips without those variables, so no business data is ever required by CI or a clean
  checkout.

A trial import into ServiceM8 remains the right final check before a large run, but the file's
structure is now proven rather than presumed.

### Supplier category and future expansion

`Category` is an optional supplier mapping. When present, it is retained on comparison records
and shown in the Inventory Search and Expansion Catalogue. The Expansion Catalogue contains only
valid supplier-only items and is deliberately read-only. Category membership never creates a
ServiceM8 row by itself; the existing explicit approval gate remains the only route to the import
candidate. Saved mapping profiles retain the optional column, so subsequent price-list runs do
not require it to be mapped again unless the supplier changes its layout.

### Formula-injection protection, and why the CSV is exempt

Text written to the XLSX **reports** is string-typed, and formula-like values are additionally
prefixed with `'` and counted, because people open those in a spreadsheet.

The ServiceM8 CSV is deliberately **not** neutralised. That apostrophe is a spreadsheet display
convention; ServiceM8's importer would store it as part of the value and corrupt the record. The
CSV is a machine handoff, so values are written verbatim and any formula-like value is reported
to the operator instead.

**Never open the generated CSV in Excel.** Doing so and saving rewrites long item numbers and
barcodes into scientific notation irreversibly - the same damage already visible in genuine
ServiceM8 exports. The application says so at the point of export.
