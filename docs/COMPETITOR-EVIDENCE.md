# Competitor evidence

Competitor evidence is local-only. Allowed inputs are manual entry, paste, operator-provided CSV/XLSX evidence and review of existing local records. Live fetching, scraping, crawling, competitor browser automation, authentication bypass, CAPTCHA bypass, paywall bypass and unapproved APIs are prohibited.

The TypeScript domain supports product-linked observations with source, URL/reference fields, GST basis, shipping, stock, condition, pack compatibility, confidence and review state. Recommendations normalise eligible observations to AUD ex GST, select the lowest valid accepted observation by default and enforce the cost floor.

Exception states: OK, COMPETITOR_BELOW_FLOOR, LOW_CONFIDENCE, UNKNOWN_GST, UNAPPROVED_SOURCE, STALE_OBSERVATION, NO_VALID_OBSERVATION, MISSING_COST and AMBIGUOUS_MATCH.
