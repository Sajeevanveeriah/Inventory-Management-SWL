# Data privacy

> **Invariant change (authorised by the repository owner, August 2026).** The previous
> "no network, local-first" invariant is retired. The application now includes a small bundled
> Node server (`server/`) that performs live competitor searches through a licensed search
> provider and persists pricing history. The browser may connect to **its own origin only**
> (`connect-src 'self'`); no third-party origin is ever reachable from the page.

What still holds:

- Business files (supplier and ServiceM8 exports) are parsed in the browser and their rows are
  never transmitted anywhere. The only text that leaves the machine is the operator's typed
  competitor search query, forwarded server-side to the licensed provider with an honest user
  agent.
- There is no analytics, telemetry, remote database, external font, CDN asset, ServiceM8 API
  write or Xero API write.
- IndexedDB in the browser is limited to operator-authored configuration: mapping profiles,
  approved aliases and settings.

What the server persists (in `server/data/`, gitignored, configurable via `SWL_DATA_DIR`):

- catalogue items;
- price history as append-only versions (JSONL; the store exposes no update or delete);
- approval records with who and when;
- competitor reference prices attached to items;
- source registry state.

Secrets are never persisted by the store. Provider keys live only in the server environment
(`.env`, ignored by git; `.env.example` carries placeholders only).

Operators can clear session data, delete profiles and aliases, and avoid snapshots. Generated
diagnostic information must avoid raw business values.
