# Update Log

Dates checked against the local system clock.

## 2026-08-04 v2 site redesign (Rev01 draft)

- Added the v2 server rendered site with seventeen routes under /v2 using Jinja2 templates and a local CSS design system.
- Kept the original competitor search page available unchanged at /ui/competitor-search with a /legacy redirect.
- Added the exception queue, approvals proposal view, read only releases view, mock reconciliation view, audit log view, settings view, and help content.
- Extended the seed script with a pending low confidence observation, an accepted observation for the high body padlock, a below floor recommendation example, and a seed audit event. Seed remains idempotent and never deletes data.
- Added 37 new tests covering routes, navigation, banners, filters, validation, exception queue, proposal only approvals, secret scanning of rendered pages, external asset scanning, and basic accessibility checks. Full suite: 57 tests.
- No external fonts, scripts, CDNs, analytics, or tracking were added. Production write features remain off.

## 2026-08-04 initial competitor module (Rev01 draft)

- Initial local competitor search and recommendation module with FastAPI, SQLAlchemy, and the original single page UI. 20 tests.
