# SWL interface map

```mermaid
flowchart LR
  Shell[Application shell] --> Search[Global product search]
  Search --> Inventory[Inventory search]
  Shell --> Overview[Overview]
  Shell --> Catalogue[Catalogue]
  Shell --> Pricing[Pricing]
  Shell --> Review[Review]
  Shell --> System[System]

  Overview --> Dashboard[Dashboard]
  Overview --> NewRun[New run]
  Overview --> Runs[Runs]
  Catalogue --> Inventory
  Catalogue --> Suppliers[Suppliers]
  Catalogue --> MappingProfiles[Mapping profiles]
  Pricing --> PricingRules[Pricing rules]
  Pricing --> Competitors[Competitor search]
  Pricing --> Sources[Source registry]
  Review --> Exceptions[Exceptions]
  Review --> Approvals[Approvals]
  Review --> Exports[Exports]
  System --> Integrations[Integrations]
  System --> Audit[Audit]
  System --> Configuration[Configuration]
  System --> Help[Help]

  NewRun --> Start[1 Start]
  Start --> Files[2 Add files]
  Files --> Mapping[3 Map columns]
  Mapping --> Validate[4 Validate and compare]
  Validate --> ReviewRows[5 Review]
  ReviewRows --> Checks[6 Pre-export checks]
  Checks --> Export[7 Export]
  ReviewRows --> Exceptions
  ReviewRows --> Approvals
  Approvals --> Checks
  Checks --> Exports

  Competitors --> Adapter{Platform adapter}
  Adapter -->|Web demo| Node[Node ESM server]
  Adapter -->|Desktop| Rust[Scoped Tauri commands]
  Node -->|licensed provider| Provider[Shopping search provider]
  Rust -->|allowlisted HTTPS| Provider
  Competitors --> Manual[Manual reference fallback]
  Competitors --> Sources
```

Text equivalent: the persistent desktop rail or mobile menu exposes five route groups containing
all 16 surfaces. The global product search opens Inventory search. New run contains the seven
ordered stages Start, Add files, Map columns, Validate and compare, Review, Pre-export checks and
Export. Review feeds the Exceptions and Approvals workspaces; approved eligible rows proceed
through pre-export checks to the five candidate outputs. Competitor search uses the typed platform
adapter: the web demonstration calls its same-origin Node service, while the desktop calls scoped
Rust commands and only the Rust backend may reach the allowlisted provider. Manual reference
fallback and source-registry access remain available.

## Validation matrix

| Area                |                                                     Required nodes | Repository implementation                                |
| ------------------- | -----------------------------------------------------------------: | -------------------------------------------------------- |
| Shell               | Navigation, global search, run status, privacy, theme and settings | `src/App.tsx`                                            |
| Routes              |                                                                 16 | Hash route table and grouped navigation in `src/App.tsx` |
| Run workflow        |                                                           7 stages | `STEP_ORDER`, `STEP_TITLES` and `src/ui/steps/`          |
| Operational review  |                          Review, exceptions, approvals and exports | Route pages and run steps under `src/ui/`                |
| Competitor boundary |        Web to own-origin Node; desktop to scoped Rust provider IPC | `src/platform/`, `server/`, `src-tauri/src/backend.rs`   |

The map was reconciled with the live route table and workflow step order. It deliberately shows competitor evidence as an input to review rather than to pricing calculation or export mutation.
