# Configuration reference

`SETTING_DEFINITIONS` in `src/core/settings.ts` is the single authoritative definition for every
adjustable global setting. The runtime schema, defaults and settings editor consume the same four
definitions.

## Adjustable global settings

- `markupPercent`: global markup from 30% to 999.99%, with a 0.01% step. It applies only when the
  product and its brand have no override.
- `taxHandling`: whether supplier purchase costs exclude GST, include GST or are not yet
  configured. Pricing and export remain blocked while this fact is not configured.
- `theme`: system, light or dark.
- `glassTint`: clear or blue tinted glass.

Changing a pricing setting requires confirmation, persists through the active platform service,
creates an audit record and invalidates any stale comparison result. Appearance changes persist but
do not alter business data.

## Catalogue pricing rules

Product and brand markups are typed catalogue records, not global settings. Precedence is fixed:

1. product override;
2. brand override;
3. global markup.

`null` means fall through to the next level. An explicit numeric zero remains an explicit rule; it
is then rejected by the separate 30% minimum markup-on-cost floor. Supplier costs and sell prices
are normalised to their confirmed GST-exclusive basis before the floor is evaluated.

## Locked behaviour

File-size limits, mapping safety, identifier normalisation, ambiguity blocking, formula protection,
leading-zero preservation, selected-offer requirements, no silent cheapest-offer selection, the 30%
floor, provider direction and release controls are implementation invariants. They are not editable
settings and cannot be changed by a configuration import.

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
