# Architecture

```mermaid
flowchart LR
  Files[Local CSV/XLSX files] --> Parse[Browser parser]
  Parse --> Map[Mapping and profiles]
  Map --> Compare[Deterministic comparison]
  Compare --> Review[Exceptions and approvals]
  Review --> Export[Candidate workbooks]
  Config[Typed configuration registry] --> Map
  Config --> Compare
  Config --> Export
  Competitors[Competitor evidence] --> Review
  Store[IndexedDB metadata only] --> Map
  Store --> Config
  Browser[SPA] -->|own origin /api| Server[Node server]
  Server -->|licensed provider API| Live[Live shopping search]
  Server --> Data[JSON/JSONL store: items, price history, approvals, references, sources]
```

Text equivalent: local files enter browser-only parsing, confirmed mappings and profiles feed deterministic comparison, configuration supplies safe rules, competitor evidence is reviewed locally, approved valid changes generate candidate outputs, and IndexedDB stores only approved metadata. The browser additionally calls its own origin's small Node server (`server/`), which performs live competitor searches through a licensed provider (rate limited, cached, honest user agent) and persists catalogue items, append-only price history, approval records, competitor references and source-registry state to a JSON/JSONL directory store.

The React shell uses hash routes. GitHub Pages alone can serve the static SPA, but the full application (live search plus persistence) needs the Node server (`npm run server`), which also serves `dist/` in production as a single origin. Domain modules under `src/core` hold parsing-adjacent logic, comparison, pricing, output eligibility, configuration, competitor recommendations, operational exceptions, proposals and run metadata. UI route components call those modules and do not perform spreadsheet algorithms directly.

## Desktop shell (Windows)

`src-tauri/` packages the identical web bundle as a Tauri 2 Windows application. The frontend
detects the shell through the injected `window.__TAURI__` global (`src/platform/desktop.ts`)
and, when present, offers a native output-folder workflow on the Export step. The Rust side
exposes exactly three commands: `choose_output_folder` (native picker), `write_export_file`
(sanitised filename, traversal-guarded write into the chosen folder) and `shell_info`. The
desktop build uses `vite build --mode desktop`, which relaxes the Content Security Policy only
enough to reach the local Tauri IPC bridge; the web build permits `connect-src 'self'` only. Product
search lives in `src/core/search.ts` (deterministic exact-first ranking) and is exercised by
unit and end-to-end tests.
