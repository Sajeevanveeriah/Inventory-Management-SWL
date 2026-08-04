# Migration from Python prototype

The nested `swl_competitor_search_prototype` remains legacy reference material. It is not used by the root application runtime and must not be deleted until feature parity, migration tests and documentation are complete.

Migrated into TypeScript: local competitor observation entities, eligibility rules, GST-exclusive normalisation, stale and confidence checks, review states, recommendation strategies and cost-floor blocking.

Deprecation criteria: manual entry, local file import, persistence, review, recommendation, exception routing, tests, accessibility checks and documentation must all pass in the root application before removing the prototype in a separately authorised change.
