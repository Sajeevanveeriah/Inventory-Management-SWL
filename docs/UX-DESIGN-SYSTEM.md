# UX design system

Rev01, the modernist system. The application is a flat, architectural operations console: a dark
ink navigation rail, a warm neutral canvas, ink-coloured interaction and brand red reserved for
four places only. It avoids remote fonts, icon services, decorative charts and repetitive helper
text.

Primary destinations are hash routes compatible with GitHub Pages: dashboard, new run, runs,
inventory, expansion catalogue, products and suppliers, saved import layouts, pricing rules,
competitors, price sources, exceptions, approvals, exports, integrations, audit, settings and help.
`src/ui/routes.ts`
is the single table behind the rail, the zero-padded route index and the page kicker, so a route's
group and its position can never drift apart.

The run workflow remains inside the New run workspace and never replaces global navigation.

Responsive behaviour keeps primary actions visible, switches navigation to a compact stacked
pattern on small screens, and allows deliberate horizontal table scrolling for dense operational
tables.

## The three rules

1. **Rules, not shadows or radii.** A container is defined by a `2px var(--border-strong)` edge;
   rows divide with `1px var(--border)`. Every `--radius*` token is `0` and must stay `0`. Where a
   ruled grid can wrap — the metric row, the validation pipeline, the competitor status row — the
   dividers are the container ground showing through a `gap`, so they stay exact at any cell count.
2. **Interaction is ink.** The primary action is an `--action` fill (`#201e1d`) with `--action-ink`
   text. Red appears in exactly four places: the SW mark, the active-nav bar, blocking or failed
   states, and the poster panels. It is never a hover and never an ordinary button.
3. **Numbers are the interface.** Money, counts and identifiers are mono, tabular and
   right-aligned, and the proposed sell price is the heaviest number on any row.

## Type

Archivo, bundled. `src/assets/fonts/archivo-latin-var.woff2` and its latin-ext companion are the
variable face, so weights 400-800 come from one download per subset. The production CSP is
`font-src 'self'`, so a font host was never an option and the family must never be imported from
one.

| Role              | Size / weight                  | Notes                            |
| ----------------- | ------------------------------ | -------------------------------- |
| Page title        | 40 / 800 / `-0.02em`           | one per screen                   |
| Metric figure     | 56 / 800                       | zero-padded                      |
| Poster figure     | 64 / 800                       | white on red, or white on ink    |
| Panel heading     | 17 / 800                       |                                  |
| Body              | 14 / 400                       |                                  |
| Small, lead       | 13 / 400                       | `--ink-faint`                    |
| Meta, cells       | 12-12.5 / 400                  | mono for numbers and identifiers |
| Micro label       | 11 / 400 mono, `0.08em`, upper | table headers, metric labels     |
| Kicker, nav group | 10 / 400 mono, `0.14em`, upper |                                  |

Sentence case everywhere except mono micro-labels and kickers.

## Tokens

`src/styles/app.css` defines the whole visual layer as custom properties, redeclared under
`[data-theme="dark"]`. No component rule hard-codes a colour, so both themes stay in step. The
Rev00 token names are kept as aliases onto their Rev01 roles (`--primary` onto `--action`, `--brand`
onto `--brand-red`, `--font` onto `--font-body`), so every value still has exactly one source.

- **Brand** - `--brand-red` for the mark and the poster panels, `--brand-red-ink` wherever red has
  to be read as text (6.4:1 on `--surface`; the mark colour itself never is).
- **Surfaces** - `--canvas`, `--surface`, `--surface-raised` and `--surface-subtle`, the quiet plane
  used for inset wells, formula strips and chart backdrops.
- **Text** - `--ink`, `--ink-secondary`, `--ink-faint` and the `--text-muted` alias.
- **Lines** - `--border-strong` for 2px section rules, `--border` for 1px row rules, `--border-subtle`
  for divisions that must read lighter still.
- **Navigation** - `--nav-bg`, `--nav-ink`, `--nav-ink-muted`, `--nav-hover`, `--nav-active` and
  `--nav-accent`, the 3px active bar, which is brand rather than control.
- **Interaction** - `--action`, `--action-ink`, `--action-hover`, `--action-active` and
  `--focus-ring`, a 2px brand-red outline at 2px offset on every interactive element, including
  inside the dark rail.
- **Status** - a background and ink pair per state, plus `--delta-up` and `--delta-down`. The
  down colour is deliberately not green: a fallen cost is not a success, only a direction.
- **Geometry** - `--rule` (2px), `--hairline` (1px), a zeroed radius ladder, and a 4px `--space-1`
  through `--space-8` scale that component rules step through instead of inventing values.
- **Rendering** - `color-scheme` is declared for both themes, so the engine paints scrollbars,
  native select popups, the caret and autofill to match the resolved theme rather than leaving
  light chrome around a dark window.

## Hierarchy and state

The page head carries a mono `GROUP / NN` kicker, a 40px heading and **one sentence** of lead
copy. Standing explanatory paragraphs and repeated privacy and boundary statements do not belong
on a route; they live in the privacy dialog and on the Help page.

Status is always carried by wording as well as colour. Badges are rectangular, mono and labelled;
the current navigation item takes a 3px bar as well as a fill; the current run stage is a filled
ink cell with its state spelled out. The review grid uses presentation-only short status forms so
a fixed 104px column never wraps, and keeps the full wording in the accessible name and in the
detail panel.

Metric cells state a mono label, a zero-padded figure and a note. An attention cell recolours its
whole cell to `--brand-red-ink`; it never takes a coloured fill. Numeric cells use
`tabular-nums lining-nums slashed-zero`, so columns align and a zero in a supplier code cannot be
misread as a letter O.

Every text colour is measured against WCAG 2.2 AA (4.5:1) in both themes, including small labels
on the navigation ground. Colour transitions are absent from the stage strip: its current stage
changes on navigation, and a mid-transition frame has no guaranteed contrast ratio. Motion
elsewhere is capped at 120ms on opacity and colour and is disabled under `prefers-reduced-motion`.

## Brand and visual language

The interface is the Stan Wootton Locksmiths operations console, so it carries the SWL identity
directly.

**Brand mark.** `src/ui/Brand.tsx` renders the exact proprietor-supplied Stan Wootton raster logo
from the data asset in `src/assets/swlLogo.ts`. Vite bundles it into both browser and desktop
builds, so the mark has no network or font dependency and remains permitted by the Content
Security Policy. The Windows application and installer icons remain the reviewed square adaptation
in `src-tauri/icons/` for legibility at native icon sizes.

**Layout.** A persistent 252px rail on wide screens and an off-canvas menu on compact screens
frame a 58px top bar: a search field on the left, the run chip in the centre — run identifier,
record count, approved count — and square icon controls on the right. The trading name lives in
the rail lockup and is not repeated in the bar.

**Contrast.** Every text token is checked against the surfaces it is used on. `--ink-faint` is
`#605d5d`: 6.5:1 on `--surface` and 6.0:1 on `--surface-subtle`. `--nav-ink-muted` is 9.7:1 on the
rail. `e2e/a11y.spec.ts` runs axe across every surface in both themes and fails the build on every
violation returned for the selected WCAG A and AA tags.

**Icons carry names, not just shapes.** The chrome controls are icon-only, so each has an
`aria-label` ("Open settings", "Privacy and data handling", "Dark appearance"). Two icons that
would read alike at 16px are not both used: the settings control is sliders rather than a cog,
because a cog beside the theme sun is indistinguishable at that size. The rail itself carries no
icons: a zero-padded index does the work a glyph was doing, and it also states position.
