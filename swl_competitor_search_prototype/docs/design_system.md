# Pricing Control Hub v2 Design System

Local prototype design system for the Stan Wootton Locksmiths Pricing Control Hub. All assets are local. No external fonts, scripts, CDNs, analytics, or tracking.

## Principles

1. Exception first: exceptions are always visible, never hidden, never colour only.
2. Evidence over automation: competitor data informs, it never overrides the cost floor.
3. Honest values: no silent rounding, suppression, or restatement.
4. One primary action per page.

## Typography

- Font: system stack (`system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif`).
- Base size 1rem, small text 0.875rem.
- Headings: h1 1.5rem, h2 1.2rem, h3 1.05rem, logical order enforced.

## Colour tokens

| Token | Value | Use |
|---|---|---|
| colour-bg | #f7f8fa | Page background |
| colour-surface | #ffffff | Cards, tables, forms |
| colour-text | #1c2430 | Body text (contrast on surface 14.9:1) |
| colour-text-muted | #4a5568 | Secondary text (contrast 7.5:1) |
| colour-border | #cbd2dc | Borders |
| colour-primary | #1a4f8b | Primary actions, links (contrast on white 7.0:1) |
| colour-danger | #a4262c | Danger, blocked (contrast on white 7.0:1) |
| colour-success | #0b6a0b | Safe, approved (contrast on white 6.6:1) |

All text and interactive colour pairs meet WCAG 2.1 AA. Status is always conveyed with a text label in addition to colour.

## Spacing tokens

0.25rem, 0.5rem, 0.75rem, 1rem, 1.5rem, 2rem (space-1 to space-8).

## Radius and shadow tokens

- radius-small 3px (buttons, badges, inputs), radius-medium 6px (cards, alerts).
- shadow-card: 0 1px 3px rgba(28, 36, 48, 0.12).

## Buttons

Hierarchy: primary (filled blue), secondary (outlined blue), danger (filled red), quiet (text only). Disabled buttons reduce opacity and set `aria-disabled`. Focus uses a visible 3px outline.

## Badges

safe, flag, blocked, pending, approved, rejected, quarantined, stale, missing, not-authorised. Each badge combines a background, border, and a text label. Colour is never the only signal.

## Alerts

info (blue), warning (amber), error (red), success (green). Each alert leads with a bold text statement.

## Forms

Every input has a `label` with `for`. Grouped inputs use `fieldset` and `legend`. Errors are text messages linked with `aria-describedby` and `role="status"`. Invalid fields set `aria-invalid`. Focus states are visible outlines.

## Tables

Used for review heavy screens. Header cells use `scope`. Numeric columns right align with tabular numerals. Wide tables scroll inside a `table-scroll` container. Maximum 200 rows per page.

## Motion and print

Reduced motion is respected via `prefers-reduced-motion`. Print styles hide navigation and forms so approval packs and exception reports print cleanly.
