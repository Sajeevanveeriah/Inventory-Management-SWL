# Competitor evidence

> **Invariant change (authorised by the repository owner, August 2026).** Competitor evidence is
> no longer local-only. Live competitor search is performed **server-side through a licensed
> shopping-search API** (SerpAPI Google Shopping, Australian region, AUD) behind a swappable
> provider interface (`server/search/`). Direct scraping of retailer websites remains
> prohibited, as do crawling, competitor browser automation, authentication bypass, CAPTCHA
> bypass and paywall bypass. Outbound calls are rate limited, cached server-side with a visible
> retrieval timestamp, and identify the client honestly in request headers.

Allowed inputs are now: live provider search, manual entry, paste, operator-provided CSV/XLSX
evidence and review of existing records. If no API key is configured the application still
starts; the search surface states that live search is not configured and how to configure it.
Provider failure, timeout, quota exhaustion and empty results are four distinct visible states.

Every live result carries: product title, price in AUD, GST basis (`inc-gst`, `ex-gst` or
honestly `unknown`), unit or pack size where determinable, seller or source domain, retrieval
timestamp and a working link to the source page. A lowest/median/highest price band with source
counts is shown above results; coverage gaps are always disclosed.

Attaching a result to a catalogue item stores **reference information only**. The server store's
reference path never touches the catalogue or price-history files, and a test asserts the
catalogue file stays byte-identical across an attach.

The TypeScript domain supports product-linked observations with source, URL/reference fields,
GST basis, shipping, stock, condition, pack compatibility, confidence and review state.
Recommendations normalise eligible observations to AUD ex GST, select the lowest valid accepted
observation by default and enforce the cost floor.

Exception states: OK, COMPETITOR_BELOW_FLOOR, LOW_CONFIDENCE, UNKNOWN_GST, UNAPPROVED_SOURCE,
STALE_OBSERVATION, NO_VALID_OBSERVATION, MISSING_COST and AMBIGUOUS_MATCH.
