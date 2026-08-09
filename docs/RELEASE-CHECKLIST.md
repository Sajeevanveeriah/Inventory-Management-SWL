# Release checklist

Complete every item before shipping a build of SWL Pricing and Inventory Control.

## Automated gates

- [ ] Exact Node 22.22.2 and Rust 1.89.0 toolchains are active
- [ ] `npm ci` installs only the locked dependency graph
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm run test` passes (unit + integration)
- [ ] `npm run build` succeeds
- [ ] `npm run e2e` passes (end-to-end + axe accessibility, against the production build)
- [ ] `npm run check:data-safety` reports no findings
- [ ] The current-tree secret scan reports no findings before packaging
- [ ] The independent reachable-history scan reports no findings; any historical `.env` finding is
      treated as requiring credential review and rotation without displaying its contents
- [ ] The Pages-base build passes `npm run check:pages`
- [ ] `cargo metadata --locked` accepts the committed `src-tauri/Cargo.lock`
- [ ] `cargo fmt --manifest-path src-tauri/Cargo.toml --check` passes
- [ ] Locked Clippy passes for every target and feature with warnings denied
- [ ] All locked Rust targets and features pass, including migration, backup, restore and negative tests
- [ ] `npm run desktop:build` produces exactly one current-user NSIS installer
- [ ] External `tauri-driver` 2.0.6 drives the production desktop executable; no embedded driver is used
- [ ] `npm run check:desktop-boundaries` confirms scoped permissions, CSP and driver absence
- [ ] The official x64 WebView2 payload is validated before bundling and the embedded bytes, version,
      SHA-256 and valid Microsoft Authenticode identity match it exactly
- [ ] Installer filename, byte size, SHA-256 and actual signing status are recorded
- [ ] Scripted Windows install, Start Menu launch and uninstall smoke passes without Node, a terminal,
      external browser, listener, unexpected egress or production WebDriver marker
- [ ] The complete production-binary WDIO run uses exact outbound-Internet deny rules plus continuous
      process-tree TCP evidence and leaves nonzero synthetic catalogue, approval and history records
- [ ] Exact synthetic identifiers and counts survive force-close, uninstall, same-version reinstall,
      reopen and a second uninstall
- [ ] Installed and reinstalled executable SHA-256 values exactly match the production binary driven
      by WDIO
- [ ] The `e36ec72ae8c53b0f9af7eeb0ef3f605b9f5dab9a` version 1.0.0 source, built with its
      reviewed hash-bound Cargo lock repair fixture, creates the former schema; exact synthetic
      catalogue/approval/history records survive the 1.1.0 launch migration; and the verified
      pre-migration backup preserves their IDs and counts

## Data recovery and security

- [ ] Every migration, import, restore, reset or destructive operation creates a verified backup
- [ ] Backup metadata includes schema version, application version, time, counts and SHA-256
- [ ] Restore validates a temporary database before atomic replacement
- [ ] A failed migration or restore leaves the prior database usable
- [ ] Foreign keys prevent orphan history, approval and competitor-reference records
- [ ] Approval and price history remain append-only; money remains integer cents
- [ ] Same-profile IndexedDB migration and versioned browser export/native import are previewed
- [ ] Malformed, oversized, unsupported and conflicting imports leave live data unchanged
- [ ] Credentials are absent from SQLite, source, logs, backups, exports and artefacts
- [ ] Native search requires a successfully validated protected credential, explicit enablement,
      positive total-ceiling and per-call-reservation cents, and enforces pessimistic reservation,
      quota state, HTTPS host allowlisting, redirect rejection and response limits
- [ ] Unrelated-file, traversal, overwrite, undeclared-command, process and origin tests fail safely
- [ ] Test-only WebDriver dependencies and endpoints are absent from production output

## Installed Windows 10/11 verification

- [ ] Install offline in a clean standard-user profile and launch from the Start Menu
- [ ] Confirm one native window opens with no terminal, browser, Node process or localhost listener
- [ ] Load the synthetic demonstration and walk all seven steps
- [ ] Confirm AUD 100.00 → AUD 130.00 at the default 30% markup (visible in a formula box)
- [ ] Confirm `00123` keeps its leading zeroes end-to-end (review table and import workbook)
- [ ] Confirm ambiguous/invalid rows show no approve control and bulk approval skips them
- [ ] Confirm the missing-from-supplier item appears only in the exceptions workbook
- [ ] Open every generated file in a spreadsheet application; check headers, formats and the
      neutralised formula cell
- [ ] Exercise the real native input and output dialogs, including cancel and same-file conflict;
      do not substitute a browser file input or a test-only production hook
- [ ] Keyboard-only pass: complete the demo workflow without a mouse
- [ ] Zoom to 200%: no clipped controls or unreachable actions
- [ ] Dark theme spot-check on review + checklist screens
- [ ] Production preview with browser devtools **Network** tab open through a full workflow:
      zero external requests (only the local origin)
- [ ] Browser console: no business values logged
- [ ] "Clear session data" and previewed, phrase-confirmed application-data erasure behave as described
- [ ] Close, reopen, force-close and restart Windows; verify exact stored counts and history
- [ ] Repeat the genuine lower-version upgrade interactively on disposable Windows 10/11 after
      backup; verify no data loss (hosted Server 2025 evidence is necessary but not a substitute)
- [ ] Uninstall and reinstall; verify business data is preserved by default
- [ ] Run double-confirmed erase; verify only the documented application data is removed
- [ ] Capture network/process evidence for the complete offline workflow

## Desktop visual and accessibility matrix

- [ ] 1366 x 768 and 1920 x 1080 at 100% scaling
- [ ] 125%, 150% and 200% Windows scaling plus configured minimum window size
- [ ] Light and dark themes, keyboard-only use, visible focus and reduced motion
- [ ] All seven workflow stages
- [ ] Empty, loading, populated, validation, offline and provider states
- [ ] Backup, restore and same-file conflict states
- [ ] No clipping, overlap, horizontal overflow, colour-only meaning or unreachable action
- [ ] Every reported screenshot was captured from the rendered desktop application and inspected

## Repository hygiene

- [ ] No real supplier/ServiceM8 files, generated outputs, secrets or `.env` files in git status
- [ ] README and docs match current behaviour (no documented-but-unimplemented features)
- [ ] One version matches `package.json`, Cargo.toml, tauri.conf.json, `APP_VERSION` and About UI
- [ ] PR evidence names the final head and contains no claims from a failed or earlier run
- [ ] Unsigned internal artefacts are labelled truthfully; SmartScreen warning is documented
- [ ] No merge, deployment, release, signing or public distribution occurs under this checklist
