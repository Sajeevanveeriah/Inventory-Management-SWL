# Competitor evidence

> **Invariant change (authorised by the repository owner, August 2026).** Competitor evidence is
> no longer local-only. Live competitor search is performed through a licensed shopping-search
> API (SerpAPI Google Shopping, Australian region, AUD) behind the platform boundary: Rust owns
> desktop requests, and `server/search/` owns web-demonstration requests. Direct scraping remains
> prohibited, as do crawling, competitor browser automation, authentication bypass, CAPTCHA
> bypass and paywall bypass. Outbound calls are bounded and rate limited; results carry a visible
> retrieval timestamp, and provider clients identify themselves honestly.

Allowed inputs are now: live provider search, manual entry, paste, operator-provided CSV/XLSX
evidence and review of existing records. The desktop application still starts when no protected
credential is configured. Paid native calls remain disabled until the operator stores and
successfully validates the credential, enters a positive total ceiling and positive per-call
reservation in integer cents, and explicitly enables calls. The native budget pessimistically
reserves the per-call amount before each request and returns the quota-exhausted state before a
request could exceed the ceiling. Provider failure, timeout, quota exhaustion and empty results
are four distinct visible states; manual evidence remains usable in all of them.

Every live result carries: product title, price in AUD, GST basis (`inc-gst`, `ex-gst` or
honestly `unknown`), unit or pack size where determinable, seller or source domain, retrieval
timestamp and a working link to the source page. A lowest/median/highest price band with source
counts is shown above results; coverage gaps are always disclosed.

Attaching a result to a catalogue item stores **reference information only**. Both platform
adapters prevent that action from writing catalogue prices or append-only price history, and tests
assert those records do not change across an attachment.

The TypeScript domain supports product-linked observations with source, URL/reference fields,
GST basis, shipping, stock, condition, pack compatibility, confidence and review state.
Recommendations normalise eligible observations to AUD ex GST, select the lowest valid accepted
observation by default and enforce the cost floor.

Exception states: OK, COMPETITOR_BELOW_FLOOR, LOW_CONFIDENCE, UNKNOWN_GST, UNAPPROVED_SOURCE,
STALE_OBSERVATION, NO_VALID_OBSERVATION, MISSING_COST and AMBIGUOUS_MATCH.
