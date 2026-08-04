# Data privacy

The application is local-first. Business files are parsed in the browser. The production CSP sets `connect-src 'none'`. There is no backend, analytics, telemetry, remote database, external font, CDN, ServiceM8 API write or Xero API write.

Imported rows remain in memory by default. IndexedDB is limited to approved settings, profiles, aliases, run metadata and explicitly confirmed snapshots. Profiles store mapping and rule metadata, not raw business rows.

Operators can clear session data, delete profiles and aliases, delete run history and avoid snapshots. Generated diagnostic information must avoid raw business values.
