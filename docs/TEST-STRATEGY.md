# Test strategy

Use exact Node 22.22.2. The repository records `.nvmrc` and package engines for this runtime
because the locked jsdom and undici versions require it. Rust uses the exact toolchain and
components in `rust-toolchain.toml`.

Commands:

- `npm ci`
- `npm run typecheck`
- `npm run lint`
- `npm run test`
- `npm run build`
- `npm run check:data-safety`
- `npm run check:secrets` (current tree plus reachable history; never prints matched values)
- `VITE_BASE=/Inventory-Management-SWL/ VITE_STATIC_DEMO=true npm run build && npm run check:pages`
- `npm run e2e`
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check`
- `cargo metadata --locked --manifest-path src-tauri/Cargo.toml --format-version 1`
- `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`
- `cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features`
- `npm run desktop:build`
- `npm run e2e:desktop` (Windows, after installing external `tauri-driver` 2.0.6)
- `npm run check:desktop-boundaries`

Vitest covers money, parsing, mapping, comparison, review, output eligibility, workbook generation, sanitisation, configuration, competitor logic and operational metadata. Playwright covers the production build, accessibility scans and screenshot capture when a real Chromium executable is available. Each browser case restores the same fixed fictional Node-store snapshot before it starts, and the suite uses one worker so append-only approval and history records cannot leak between cases.
Platform tests separately prove that the static Pages adapter completes synthetic approval/history
operations without a network call and that a refresh starts a new empty operational session. Node
origin tests prove the exact Vite proxy origins work while foreign, forged and cross-site requests
remain rejected without mutation.

The Windows workflow uses the installed Microsoft Edge only after verifying its Microsoft
Authenticode signature and passes its path through `CHROMIUM_PATH`. It explicitly installs the
external official `tauri-driver` 2.0.6 into a project-local tools directory, drives the production
desktop executable and scans the production output to prove the driver was not bundled. The same
workflow downloads the official Microsoft x64 Evergreen WebView2 offline installer from reviewed
HTTPS hosts, validates its x64 PE identity and Microsoft Authenticode signature before the bundle,
then proves the embedded bytes are identical. It builds the NSIS package, runs a scripted
current-user install/Start Menu launch/process/listener/data-preserving uninstall and reinstall
smoke and uploads checksum plus version/toolchain/lock metadata. Before the native run, exact
outbound-Internet firewall rules are applied to the production executable and every verified
Microsoft-signed WebView2 executable. Continuous process-tree TCP sampling covers the entire WDIO
run and fails closed on monitor errors, non-loopback listeners or non-loopback established
connections; local WebDriver IPC is reported separately. The rules and any temporarily enabled
firewall profile state are removed or restored in a `finally` block.
The install smoke also compares SHA-256 hashes and requires the first installed and reinstalled
executables to be byte-identical to the raw production binary driven by WDIO.

The current-tree secret scan is a fail-closed package gate. Reachable-history inspection runs as
an independent least-privilege job, so a historical finding keeps the overall workflow red while
the unrelated Windows test/package job can still produce diagnostic evidence. A finding reports
only its path, abbreviated blob identifier and category; it never prints the matched value.

The production-binary driver captures Windows Server 2025 WebView renders at 1366 x 768,
1920 x 1080 and the configured 390 x 600 minimum, plus themes, focus, workflow and deterministic
provider, backup, restore and reset states. Those captures are separately labelled and do not substitute for interactive
Windows 10/11 acceptance. DPI scaling at 125/150/200%, reduced motion, assistive-technology use,
restart, interactive lower-version upgrade on Windows 10/11, offline installation with WebView2
absent, spreadsheet opening and human inspection still require an authorised disposable Windows
10 or 11 environment. Separately, the hosted workflow builds immutable former PR head
`e36ec72ae8c53b0f9af7eeb0ef3f605b9f5dab9a` with its lockfile-installed Tauri CLI, installs and
launches that genuine 1.0.0 build, seeds exact synthetic records through a feature-gated stable-path
helper, installs 1.1.0 over it, and verifies the migrated IDs, relationships, manifest counts,
SQLite integrity and SHA-256-protected pre-migration backup before uninstall.
After the reset test proves zero records, the production UI creates a fresh nonzero synthetic
catalogue with approvals and append-only history in the same disposable profile. The test-only
read-only database acceptance helper records exact item identifiers and counts. Installer smoke
then proves those exact identifiers and counts across force-close, first uninstall, same-version
reinstall, reopen and second uninstall; it never substitutes an empty database for lifecycle
evidence.
Native provider tests prove that storing a protected credential alone cannot authorise a call.
Successful credential validation, positive operator-entered total-ceiling and per-call-reservation
cents, and explicit enablement are required; the per-call amount is reserved before dispatch and
insufficient remaining budget produces the quota-exhausted state without a provider request. The
Node demonstration separately retains its fail-closed three-environment-variable policy.
The Rust suite exercises native input/output grant boundaries, bounded reads and writes, checksum,
offset, conflict, abort, link/reparse and atomic-commit behaviour. External WebDriver cannot safely
control Windows `IFileDialog`; selecting and cancelling the real input/output dialogs, accepting the
native destination, confirming same-file conflict remains cancel-by-default, and opening all five
outputs in a local spreadsheet application remain interactive Windows 10/11 checks.
