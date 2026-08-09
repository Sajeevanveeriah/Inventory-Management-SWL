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

In prose: only minimum product identifiers and variant terms enter a provider query. Supplier cost, current sell price, private notes, customer data and complete imported rows do not leave the machine. Raw evidence remains linked to its query and retrieval run. Matching, normalisation and exclusions run before the pricing policy. The policy can produce a review state with no recommendation. An operator must review, then separately confirm, any application.

## Canonical offer schema v1

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

CSV and XLSX use the same column names. JSON uses an array of these objects. Existing browser import validation enforces file and row limits before commit and previews mapping; imports should be dry-run first. The stable idempotency key is `sourceId + externalOfferId`, or the SHA-256 content fingerprint when the external ID is absent. Spreadsheet exports must prefix cells beginning with `=`, `+`, `-` or `@` with an apostrophe.

## Pricing policy

`aud-undercut-v1` stores money in integer cents. The floor is `ceil(cost cents x 1.30)`, preserving the existing 30% markup. At AUD 100.00 cost, the floor is AUD 130.00. This is a 30% markup on cost and a 23.08% gross margin on sell price, not a 30% gross margin.

The aggressive benchmark is the lowest non-outlier eligible delivered comparable. The default undercut is the greater of AUD 0.01 and the lesser of AUD 1.00 or 1% of that benchmark. Three distinct sellers permit a recommendation; two permit manual review only; one is evidence only. After cent rounding the candidate must remain strictly below the benchmark and at or above the floor. Otherwise the result is `NO_SAFE_UNDERCUT` with no recommendation.

## Provider setup matrix

| Provider              | Default                                    | Authentication                      | Use and boundary                                     |
| --------------------- | ------------------------------------------ | ----------------------------------- | ---------------------------------------------------- |
| Deterministic fixture | enabled with `SWL_SEARCH_PROVIDER=fixture` | none                                | Offline CI and adversarial UI states                 |
| Local CSV/XLSX/JSON   | operator import                            | local file authority                | Effectively unmetered high-volume path               |
| SerpAPI Shopping AU   | optional                                   | `SERPAPI_KEY`                       | Licensed intermediary, finite plan quota             |
| Serper Shopping AU    | disabled adapter                           | API key                             | Finite starting credits, never unlimited             |
| eBay Browse AU        | disabled adapter                           | OAuth application credentials       | Official API, `EBAY_AU` marketplace                  |
| Merchant benchmark    | disabled adapter                           | eligible Merchant account and OAuth | Aggregate benchmark, separate from offers            |
| Generic JSON feed     | disabled adapter                           | optional bearer token               | HTTPS host allowlist required; redirects revalidated |
| SearXNG               | disabled adapter                           | deployment-specific                 | Discovery only, not a verified structured offer      |

The paid-call ceiling defaults to AUD 0.00. No adapter may spend, recharge, bypass access controls, CAPTCHA, paywalls, robots controls, authentication, site terms or rate limits.

## Operations and recovery

1. Preview eligible item count, query stages, cache hits, expected calls, quota use and worst-case paid cost.
2. Start with fixture or authorised feeds. Pause preserves completed evidence. Resume from the persisted checkpoint. Cancel leaves successful item evidence intact.
3. On quota exhaustion, mark remaining items `quota deferred`; do not tightly retry authentication, validation or quota failures.
4. On provider outage, retain partial results, use cache within visible freshness limits, and retry only retryable failures with bounded jitter.
5. Purge evidence only through an explicit retention confirmation. Export analysis without raw credentials or unsanitised provider payloads.
6. Recovery uses the append-only run, approval and price-history records. A prior price can be proposed as a new confirmed version; history is not rewritten.

## Security and deployment boundary

The Node server binds to loopback. Its mutation endpoints are intentionally unsuitable for internet exposure. Remote mode requires authentication, authorisation, CSRF protection, TLS and per-user audit identity first. Generic feed implementations must permit only configured HTTPS hosts, resolve DNS, block loopback, private and link-local addresses, revalidate every redirect, require JSON content type, enforce response limits and timeouts, and redact bearer credentials from logs.

The formerly tracked root `.env` was removed from tracking without rewriting history. Rotate any credential that may ever have appeared there. `.env` remains ignored; `.env.example` contains names and placeholders only.

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
