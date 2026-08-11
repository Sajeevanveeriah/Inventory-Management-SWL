# Competitor intelligence architecture

Accessed 9 August 2026. This system accounts for local catalogue coverage. It is not exhaustive web coverage and no provider has unlimited lawful coverage.

## Data flow

```text
local catalogue -> identity query -> provider contract -> raw evidence store
                                      | fixture / authorised feed (high volume)
                                      | SerpAPI / optional official providers
raw evidence -> deterministic match -> basis normalisation -> seller dedupe/outliers
             -> versioned policy -> recommendation or explicit review state
             -> human review -> separate confirmation -> append-only price history
```

In prose: only minimum product identifiers and variant terms enter discovery; the second stage sends the opaque exact-product token. GitHub Pages also uses its memory-only bearer token to authenticate to the protected API. Supplier cost, current sell price, private notes, customer data and complete imported rows do not leave the machine. Raw evidence remains linked to its query and retrieval run. Matching, normalisation and exclusions run before the pricing policy. The policy can produce a review state with no recommendation. An operator must review, then separately confirm, any application.

## Canonical offer schema v1

This is a future interoperability contract, not an implemented current-release import surface.
The current application supports manual evidence and explicit single-result reference attachment;
it does not expose a CSV, XLSX or JSON competitor-offer importer.

| Field                                                   |              Required | Meaning                                                          |
| ------------------------------------------------------- | --------------------: | ---------------------------------------------------------------- |
| `schemaVersion`                                         |                   yes | `1`                                                              |
| `sourceId`, `externalOfferId`                           |                   yes | Stable import identity                                           |
| `retrievedAt`                                           |                   yes | ISO 8601 timestamp including timezone                            |
| `seller`, `sourceUrl`                                   |                   yes | Provenance                                                       |
| `queryIdentity`                                         |                   yes | Identifier or controlled attribute query that produced the offer |
| `gtin`, `brand`, `mpn`, `model`, `title`                |           conditional | Product identity evidence; raw invalid GTIN is retained          |
| `amountCents`, `currency`                               |                   yes | Raw monetary amount and ISO currency                             |
| `shippingCents`, `gstStatus`                            | yes, nullable/unknown | Unknown is never silently replaced with zero or inferred GST     |
| `packQuantity`, `condition`, `availability`, `saleType` |                   yes | Comparison basis                                                 |

A future CSV or XLSX importer would use the same column names, while JSON would use an array of
these objects. It must enforce file and row limits, preview mapping and validate the stable
idempotency key `sourceId + externalOfferId`, or a SHA-256 content fingerprint when the external ID
is absent. Any future spreadsheet export must neutralise formula-like cells. None of those bulk
offer-import behaviours are claimed for this release.

## Pricing policy

`aud-undercut-v1` stores money in integer cents. The floor applies 3,000 basis points with integer
half-up rounding to the nearest cent, preserving the existing 30% markup rule without binary
floating point. At AUD 100.00 cost, the floor is AUD 130.00. This is a 30% markup on cost and a
23.08% gross margin on sell price, not a 30% gross margin.

The aggressive benchmark is the lowest non-outlier eligible delivered comparable. The default undercut is the greater of AUD 0.01 and the lesser of AUD 1.00 or 1% of that benchmark. Three distinct sellers permit a recommendation; two permit manual review only; one is evidence only. After cent rounding the candidate must remain strictly below the benchmark and at or above the floor. Otherwise the result is `NO_SAFE_UNDERCUT` with no recommendation.

## Provider setup matrix

| Provider              | Default                                      | Authentication                      | Use and boundary                                     |
| --------------------- | -------------------------------------------- | ----------------------------------- | ---------------------------------------------------- |
| Deterministic fixture | test-only; explicit fixture process          | none                                | Offline CI and adversarial UI states; never live UI  |
| Local CSV/XLSX/JSON   | not implemented in this release              | future local file authority         | Future reviewed high-volume import path              |
| SerpAPI Shopping AU   | disabled until key and explicit local budget | key plus three paid-call controls   | Licensed intermediary, finite plan quota             |
| Serper Shopping AU    | disabled adapter                             | API key                             | Finite starting credits, never unlimited             |
| eBay Browse AU        | disabled adapter                             | OAuth application credentials       | Official API, `EBAY_AU` marketplace                  |
| Merchant benchmark    | disabled adapter                             | eligible Merchant account and OAuth | Aggregate benchmark, separate from offers            |
| Generic JSON feed     | disabled adapter                             | optional bearer token               | HTTPS host allowlist required; redirects revalidated |
| SearXNG               | disabled adapter                             | deployment-specific                 | Discovery only, not a verified structured offer      |

The desktop adapter requires four deliberate actions before any paid request: store a credential
in Windows-protected storage, validate it successfully, enter a positive total ceiling and
positive per-call reservation in integer cents, then explicitly enable paid calls. Its native
budget pessimistically reserves the per-call amount before dispatch. When the remaining ceiling
cannot cover that reservation, it returns the quota-exhausted state without contacting the
provider.

The loopback Node service retains its environment policy. It requires all three controls:
`SWL_PAID_CALLS_ENABLED=true`, a positive integer `SWL_PROVIDER_COST_CEILING_CENTS` and a positive
integer `SWL_PROVIDER_COST_PER_CALL_CENTS`; partial, malformed or non-positive configuration fails
closed. Its process-local budget likewise reserves the declared cost before a paid request. The
offline fixture is test-only and exempt. The GitHub Pages API uses per-user opaque access tokens
and Redis-backed global rate, cache, single-flight and pessimistic budget controls; the SerpAPI key
never enters the static bundle. No adapter may spend, recharge, bypass access controls, CAPTCHA,
paywalls, robots controls, authentication, site terms or rate limits.

## Operations and recovery

The current application supports explicit single-query live search and operator-reviewed reference
attachment. Production search first returns product candidates; only an exact operator-selected
candidate can trigger direct merchant-offer retrieval. Test fixtures are not reachable through the
production UI. The following are requirements for a future unattended catalogue-wide queue, not
claims about the current release:

1. Preview eligible item count, query stages, cache hits, expected calls, quota use and worst-case paid cost.
2. Start with fixture or authorised feeds. Pause preserves completed evidence. Resume from the persisted checkpoint. Cancel leaves successful item evidence intact.
3. On quota exhaustion, mark remaining items `quota deferred`; do not tightly retry authentication, validation or quota failures.
4. On provider outage, retain partial results, use cache within visible freshness limits, and retry only retryable failures with bounded jitter.
5. Purge evidence only through an explicit retention confirmation. Export analysis without raw credentials or unsanitised provider payloads.
6. Recovery uses the append-only run, approval and price-history records. A prior price can be proposed as a new confirmed version; history is not rewritten.

## Security and deployment boundary

The local Node server binds to loopback. It accepts only the exact configured loopback `Host`, requires
same-origin Fetch Metadata on search and persisted evidence routes, requires the exact local
`Origin` plus `application/json` on mutations, and rejects cross-site/no-cors calls before reading
their body. This local boundary is not remote authentication: internet exposure would still require
authentication, authorisation, TLS and per-user audit identity. The internet-facing API-only Vercel
project supplies those controls with exact-origin CORS, per-user bearer authentication and Redis;
CORS is containment, not authentication. Generic feed implementations must
permit only configured HTTPS hosts, resolve DNS, block loopback, private and link-local addresses,
revalidate every redirect, require JSON content type, enforce response limits and timeouts, and
redact bearer credentials from logs.

The Pages build job and Vercel deployment exclusions remove `.env` files before public artefacts are
assembled. Any repository tracking or credential-rotation change is a separate approval-gated
operation and is not performed by this implementation. No credential template is
required: configure the documented environment names only in the authorised process environment.

## Source and licence register

| Source                                      | Purpose                               | Licence / responsibility                     |
| ------------------------------------------- | ------------------------------------- | -------------------------------------------- |
| GS1 GTIN check-digit method                 | Identity validation                   | Public standard description; GS1 terms apply |
| eBay Browse API documentation               | Optional official marketplace adapter | eBay developer terms apply                   |
| SerpAPI documentation                       | Existing Shopping adapter             | Provider plan and terms apply                |
| Project dependencies in `package-lock.json` | Runtime and tests                     | Package licences; review with release audit  |

Live terms, quotas and prerequisites must be checked against current official provider documentation before enabling a provider. Fixture tests do not establish provider approval.

## Limits

- Unknown GST, shipping, pack quantity, currency conversion or identity remains incomplete evidence.
- Benchmarks describe captured authorised evidence, not every internet price.
- Optional provider stubs expose capability and clean not-configured states; live credentials and approval are external configuration.
- Persistent catalogue-wide provider cache and resumable remote queue remain a release stop before production-scale unattended batches.
