# Data privacy

## Catalogue-wide competitor queries

Only the minimum operator-entered product identifier or query may leave the machine through a
configured provider. Supplier cost, current sell price, private notes, customer data and complete
imported rows must not be included in provider queries. Provider retrieval is finite and
authorised evidence collection, not exhaustive web coverage.

The secondary web demonstration uses the existing Node adapter on its own origin. The installed
desktop application does not start or contain that server and does not open a loopback port.
Optional desktop search is executed by Rust after explicit operator action, through exact
allowlisted HTTPS hosts. The WebView cannot contact provider endpoints directly.

The GitHub Pages build is explicitly session-only. It makes no `/api` or live-provider request;
operational catalogue, approval/history, reference and source records exist only in the current tab
and are discarded on refresh. Profiles, aliases and settings remain the only IndexedDB records.

What still holds:

- Business files (supplier and ServiceM8 exports) are parsed in the shared UI memory and their rows
  are never included in network requests. The only business text permitted to leave the machine is
  the operator's typed competitor query: through the native Rust provider client on desktop, or
  through the same-origin Node adapter in the web demonstration.
- There is no analytics, telemetry, remote database, external font, CDN asset, ServiceM8 API
  write or Xero API write.
- IndexedDB in the browser is limited to operator-authored configuration: mapping profiles,
  approved aliases and settings. The desktop application stores authorised operational records
  in SQLite under Tauri's stable per-user application local-data directory.

What the web-demonstration server persists (in `server/data/`, gitignored, configurable via
`SWL_DATA_DIR`):

- catalogue items;
- price history as append-only versions (JSONL; the store exposes no update or delete);
- approval records with who and when;
- competitor reference prices attached to items;
- source registry state.

The loopback server's Host, Origin and Fetch Metadata checks prevent ordinary cross-site browser
requests, but they are not OS-user authentication. A different local process can forge browser
headers. Run the optional Node demonstration with synthetic data and fixture search on shared or
untrusted computers; do not treat it as a multi-user service. The installed desktop never starts
or contacts this server.

Secrets are never persisted in SQLite, backups or exports. Browser-demonstration keys live only
in the server environment. Desktop credentials use Windows-protected credential storage and the
complete value is never returned to the WebView, logs or CI artefacts. Storing a desktop
credential does not authorise a paid request: successful validation, operator-entered positive
total-ceiling and per-call-reservation cents, and explicit enablement are all required. The native
budget reserves the per-call amount before dispatch and reports quota exhaustion before the
configured ceiling could be exceeded.

Raw imported rows remain memory-only by default. Desktop backups contain schema and application
versions, creation time, record counts and a verified checksum, but exclude credentials and raw
imports. Uninstall preserves desktop business data; erasure is a separate double-confirmed
operation with an exact scope summary. Desktop erasure clears the native SQLite/configuration store
and protected credential in that scope, while preserving same-WebView legacy IndexedDB
configuration as a non-authoritative migration source for later previewed reimport. Generated
diagnostic information must avoid raw business values.

The desktop data directory is resolved at runtime through Tauri's per-user application-local-data
API for identifier `au.com.stanwoottonlocksmiths.swl-pricing`; it is not the installation folder,
current working directory or WebView profile. The Recovery UI previews backups and restores.
Restore validates checksum, metadata, counts and SQLite integrity in a temporary database before
replacement. If migration or restore validation fails, the prior database remains the live store.
The current Recovery UI manages verified backups inside application data and does not import an
arbitrary external backup file. Before a production upgrade, close the application and copy the
entire runtime-resolved data directory to approved protected storage for supervised recovery.
Uninstall does not substitute for backup and does not erase this directory.

Configuration loading is fail-closed: malformed or unavailable persisted settings, mappings,
aliases, source state or legacy-migration evidence blocks the operational workflow. Browser
configuration imports merge disjoint records and reject conflicts rather than deleting records
that were absent from the import. A browser reset token is valid only for the exact configuration
snapshot shown in its preview; any intervening change requires a fresh preview and confirmation.
