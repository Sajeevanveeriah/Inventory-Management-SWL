# UX design system

The application uses a calm internal operations shell with deep navy navigation, warm neutral canvas, steel-blue primary actions, restrained maroon notices and labelled green, amber and red status states. It avoids external fonts, icon services, decorative charts and repetitive helper text.

Primary destinations are hash routes compatible with GitHub Pages: dashboard, new run, runs, inventory, suppliers, mapping profiles, pricing rules, competitors, exceptions, approvals, exports, audit, settings and help.

The run workflow remains inside the New run workspace and no longer replaces global navigation.

Responsive behaviour keeps primary actions visible, switches navigation to a compact stacked pattern on small screens and allows deliberate horizontal table scrolling for dense operational tables.

## Tokens

`src/styles/app.css` defines the whole visual layer as custom properties, redeclared under `[data-theme="dark"]`. No component rule hard-codes a colour, so both themes stay in step:

- **Surfaces** — `--canvas`, `--surface`, `--surface-raised` and `--surface-subtle` (the quiet secondary plane used for table headers, inset wells and chart backdrops).
- **Text** — `--ink`, `--ink-secondary`, `--ink-faint` and the `--text-muted` alias.
- **Lines** — `--border`, `--border-strong` and `--border-subtle` for internal divisions that should read lighter than a container edge.
- **Navigation** — `--nav-bg`, `--nav-ink`, `--nav-ink-muted`, `--nav-hover`, `--nav-active` and `--nav-accent`.
- **Elevation** — `--shadow-sm` for flat chrome, `--shadow` for resting cards, `--shadow-md` for hover and `--shadow-lg` for overlays.
- **Geometry** — a `--radius-sm`/`--radius`/`--radius-lg`/`--radius-xl` ladder and a 4 px `--space-1` … `--space-6` scale that component rules step through instead of inventing one-off values.

## Hierarchy and state

The page heading is the largest text on any surface, and card headings step down from it. Status is always carried by wording as well as colour: badges and pills are labelled, the current navigation item takes an accent bar as well as a fill, and the current run step is a filled control rather than a tint.

Every text and icon colour is measured against WCAG 2.2 AA (4.5:1) in both themes, including small bold labels on the navigation ground. Colour transitions are deliberately absent from the run stepper: its current step changes on navigation, and a mid-transition frame has no guaranteed contrast ratio. Motion elsewhere is capped at short opacity, translate and colour changes and is disabled under `prefers-reduced-motion`.

## Brand and visual language (v1.2.0)

The interface is the Stan Wootton Locksmiths operations console, so it carries the SWL identity
directly.

**Brand mark.** `src/ui/Brand.tsx` draws the SW monogram as geometry, not text. A logo built from
a `<text>` element would silently substitute a different typeface on any machine without the
original font — and the desktop Content Security Policy forbids remote fonts entirely — so the
letterforms are paths and render identically everywhere. `public/brand/swl-mark.svg` is the same
mark, and the Windows application and installer icons are rendered from it (`src-tauri/icons/`,
RGBA, 16–512px, with a seven-size `.ico`).

**Colour roles.** The brand red `#d81e24` belongs to the mark and to nothing else. It is never an
interactive colour, so it can never be confused with the destructive red. Interaction uses the
brand's deep blue `#1e4f8f`.

**Layout.** A light navigation rail, a greeting header with a pill search field, circular icon
controls and a workspace chip on the right; content sits on a softly tinted canvas in rounded
cards. Dashboard tiles pair a tinted icon chip with the figure and its label.

**Contrast.** Every text token is checked against the surfaces it is used on. `--ink-faint` is
`#616d80`: 5.24:1 on `--surface` and 4.84:1 on `--surface-subtle`, clearing WCAG AA for small
text on both. `e2e/a11y.spec.ts` runs axe across every surface in both themes and fails the build
on any serious violation, which is how the one regression introduced during this redesign was
caught.

**Icons carry names, not just shapes.** The chrome controls are icon-only, so each has an
`aria-label` (“Open settings”, “Privacy and data handling”, “Switch to the dark theme”). Two icons
that would read alike at 18px are not both used: the settings control is sliders rather than a
cog, because a cog beside the theme sun is indistinguishable at that size.
