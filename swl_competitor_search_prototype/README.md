# SWL Competitor Search and Recommendation Prototype

Local prototype for the Stan Wootton Locksmiths Pricing Control Hub. It records manual competitor price observations as dated evidence, matches competitor candidates to internal products, normalises prices to AUD ex GST, and calculates a recommended competitive price that never breaches the approved 30 percent markup on cost floor.

**Production write is not authorised.** This prototype does not connect to ServiceM8, Xero, or any competitor website, and it cannot release prices. It produces proposals only. No live competitor source is approved (Q 011 remains open); the only allowed method is local manual observation.

## Purpose

1. Search local competitor product records for candidates matching an internal SKU.
2. Record dated, reviewed competitor price observations (manual evidence only).
3. Normalise observed prices to AUD ex GST (default GST rate 10 percent).
4. Calculate a recommended price with strategies MATCH, UNDERCUT_AMOUNT, UNDERCUT_PERCENT, and MAINTAIN_FLOOR.
5. Enforce the cost floor: floor_ex = cost_ex x 1.30. Competitor prices below the floor are flagged (COMPETITOR_BELOW_FLOOR) and release is blocked.
6. Record audit events for search, observation, review, and recommendation.

## Local setup

Requires Python 3.11 or later.

```
cd swl_competitor_search_prototype
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env   # optional, defaults are safe
```

## Seed command

Idempotent, never deletes data:

```
.venv/bin/python -m app.seed
```

## Local run

```
.venv/bin/uvicorn app.main:app --reload
```

Then open http://127.0.0.1:8000/ui/competitor-search in a browser. Health check: http://127.0.0.1:8000/health

## Local test

```
.venv/bin/python -m pytest tests/ -v
```

Tests use in-memory SQLite and no network.

## Pricing rules

- 30 percent means markup on cost, not gross margin. Cost AUD 100.00 ex GST gives sell AUD 130.00 ex GST.
- GST normalisation: ex = inclusive / 1.10. Display incl = ex x 1.10.
- Rounding: two decimal places, ROUND_HALF_UP, applied after calculation. Configurable via ROUNDING_PLACES.
- Recommendation: the higher of the floor and the strategy target. If the competitor target is below the floor, the floor is recommended, the exception state is COMPETITOR_BELOW_FLOOR, and release is blocked. Exception approval is not granted in this prototype.

## Validation and quarantine

Observations are excluded from recommendations when: source not approved, GST basis unknown, currency not AUD, match confidence low, review state not accepted, price missing or negative, observation stale (default 30 days, configurable via STALE_DAYS), pack size not 1, condition not new, or service basis not product only.

## Known limitations

- Local SQLite only. PostgreSQL compatible models exist but no PostgreSQL connection is made.
- No authentication; intended for a single local operator on a trusted machine.
- Exception approval workflow stores state but cannot grant release.
- Currency conversion is not implemented; AUD only.
- Shipping normalisation is recorded but not applied to the comparison price.

## Safety controls

- No ServiceM8 or Xero connection or write.
- No price release capability anywhere in the code.
- No live web fetching, scraping, or crawling. Search operates on local records only.
- Only example.com placeholder URLs in seed data. No real competitor names, customer data, or secrets.
- All money values use Decimal, never float.
- Audit events record search, observation creation, review decisions, and recommendations.
- Errors return generic messages; stack traces are not exposed to the UI.
