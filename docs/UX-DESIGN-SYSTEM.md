# UX design system

The application uses a calm internal operations shell with deep navy navigation, warm neutral canvas, steel-blue primary actions, restrained maroon notices and labelled green, amber and red status states. It avoids external fonts, icon services, decorative charts and repetitive helper text.

Primary destinations are hash routes compatible with GitHub Pages: dashboard, new run, runs, inventory, expansion catalogue, suppliers, mapping profiles, pricing rules, competitors, source registry, integrations, exceptions, approvals, exports, audit, settings and help.

The run workflow remains inside the New run workspace and no longer replaces global navigation.

Responsive behaviour keeps primary actions visible, switches navigation to a compact stacked pattern on small screens and allows deliberate horizontal table scrolling for dense operational tables.

## Tokens

`src/styles/app.css` defines the whole visual layer as custom properties, redeclared under `[data-theme="dark"]`. No component rule hard-codes a colour, so both themes stay in step:

- **Surfaces** - `--canvas`, `--surface`, `--surface-raised` and `--surface-subtle` (the quiet secondary plane used for table headers, inset wells and chart backdrops).
- **Text** - `--ink`, `--ink-secondary`, `--ink-faint` and the `--text-muted` alias.
- **Lines** - `--border`, `--border-strong` and `--border-subtle` for internal divisions that should read lighter than a container edge.
- **Navigation** - `--nav-bg`, `--nav-ink`, `--nav-ink-muted`, `--nav-hover`, `--nav-active` and `--nav-accent`.
- **Elevation** - `--shadow-sm` for flat chrome, `--shadow` for resting cards, `--shadow-md` for hover and `--shadow-lg` for overlays. A resting surface is defined by its hairline border rather than by a drop shadow, and in the dark theme `--shadow-sm` and `--shadow` are `none`: on a dark ground a shadow is invisible, so separation comes from the lighter surface and its border instead.
- **Geometry** - a `--radius-sm`/`--radius`/`--radius-lg`/`--radius-xl` ladder (6/8/12/16 px) and a 4 px `--space-1` through `--space-6` scale that component rules step through instead of inventing one-off values. The ladder is deliberately tight: large radii read as consumer-app decoration and loosen a dense operational grid.
- **Rendering** - `color-scheme` is declared for both themes, so the engine paints scrollbars, native select popups, the caret and autofill to match the resolved theme rather than leaving light chrome around a dark window.

## Hierarchy and state

The page heading is the largest text on any surface, and card headings step down from it. Status is always carried by wording as well as colour: badges and pills are labelled, the current navigation item takes an accent bar as well as a fill, and the current run step is a filled control rather than a tint.

Emphasis comes from size, weight and colour, not from capitals. Table column headers, metric labels and before/after labels are sentence case at medium weight; uppercase tracking is reserved for the navigation group labels, where it separates a section heading from the destinations under it. Uppercase everywhere costs horizontal room in dense tables and shouts over the data it labels.

Metric tiles carry a small icon inline with their label, a value, and a state as a coloured dot plus wording. Reserving two label lines keeps every value in the row on one baseline whether its label wraps or not. Numeric cells use `tabular-nums lining-nums slashed-zero`, so columns align and a zero in a supplier code cannot be misread as a letter O.

Every text and icon colour is measured against WCAG 2.2 AA (4.5:1) in both themes, including small bold labels on the navigation ground. Colour transitions are deliberately absent from the run stepper: its current step changes on navigation, and a mid-transition frame has no guaranteed contrast ratio. Motion elsewhere is capped at short opacity, translate and colour changes and is disabled under `prefers-reduced-motion`.

## Brand and visual language (v1.2.0)

The interface is the Stan Wootton Locksmiths operations console, so it carries the SWL identity
directly.

**Brand mark.** `src/ui/Brand.tsx` renders the exact proprietor-supplied Stan Wootton raster logo
from the data asset in `src/assets/swlLogo.ts`. Vite bundles it into both browser and desktop builds, so the mark
has no network or font dependency and remains permitted by the Content Security Policy. The
Windows application and installer icons remain the reviewed square adaptation in
`src-tauri/icons/` for legibility at native icon sizes.

**Colour roles.** The brand red `#d81e24` belongs to the mark and to nothing else. It is never an
interactive colour, so it can never be confused with the destructive red. Interaction uses the
brand's deep blue `#1e4f8f`.

**Layout.** A persistent navigation rail on wide screens and an off-canvas menu on compact
screens frame a search-first toolbar with restrained icon controls. The optional workspace chip
appears only where width permits. Content sits on a softly tinted canvas in quiet rounded cards,
and dashboard metrics collapse from a compact grid to one column only on the narrowest screens.

**Contrast.** Every text token is checked against the surfaces it is used on. `--ink-faint` is
`#616d80`: 5.24:1 on `--surface` and 4.84:1 on `--surface-subtle`, clearing WCAG AA for small
text on both. `e2e/a11y.spec.ts` runs axe across every surface in both themes and fails the build
on every violation returned for the selected WCAG A and AA tags.

**Icons carry names, not just shapes.** The chrome controls are icon-only, so each has an
`aria-label` ("Open settings", "Privacy and data handling", "Dark appearance"). Two icons
that would read alike at 18px are not both used: the settings control is sliders rather than a
cog, because a cog beside the theme sun is indistinguishable at that size.
