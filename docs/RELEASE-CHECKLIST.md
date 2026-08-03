# Release checklist

Complete every item before shipping a build of SWL Pricing and Inventory Control.

## Automated gates

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm run test` passes (unit + integration)
- [ ] `npm run build` succeeds
- [ ] `npm run e2e` passes (end-to-end + axe accessibility, against the production build)
- [ ] `npm run check:data-safety` reports no findings

## Manual verification

- [ ] Load the synthetic demonstration and walk all seven steps
- [ ] Confirm AUD 100.00 → AUD 130.00 at the default 30% markup (visible in a formula box)
- [ ] Confirm `00123` keeps its leading zeroes end-to-end (review table and import workbook)
- [ ] Confirm ambiguous/invalid rows show no approve control and bulk approval skips them
- [ ] Confirm the missing-from-supplier item appears only in the exceptions workbook
- [ ] Open every generated file in a spreadsheet application; check headers, formats and the
      neutralised formula cell
- [ ] Keyboard-only pass: complete the demo workflow without a mouse
- [ ] Zoom to 200%: no clipped controls or unreachable actions
- [ ] Dark theme spot-check on review + checklist screens
- [ ] Production preview with browser devtools **Network** tab open through a full workflow:
      zero external requests (only the local origin)
- [ ] Browser console: no business values logged
- [ ] "Clear session data" and "Delete saved profiles and aliases" behave as described

## Repository hygiene

- [ ] No real supplier/ServiceM8 files, generated outputs, secrets or `.env` files in git status
- [ ] README and docs match current behaviour (no documented-but-unimplemented features)
- [ ] Version bumped in `package.json` and `src/core/audit.ts` (`APP_VERSION`) if releasing
