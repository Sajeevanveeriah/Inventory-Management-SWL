/**
 * Route table for the console shell.
 *
 * The rail, the page kicker and the route index all read from this one table,
 * so a route's group and its zero-padded position can never drift apart. The
 * index is derived from the group order, not stored per route.
 */

export const ROUTES = [
  ['#/dashboard', 'Dashboard'],
  ['#/new-run', 'New run'],
  ['#/runs', 'Runs'],
  ['#/inventory', 'Find a product'],
  ['#/expansion', 'Expansion catalogue'],
  ['#/suppliers', 'Products and suppliers'],
  ['#/mapping-profiles', 'Saved import layouts'],
  ['#/pricing-rules', 'Pricing rules'],
  ['#/competitors', 'Competitor search'],
  ['#/sources', 'Price sources'],
  ['#/exceptions', 'Exceptions'],
  ['#/approvals', 'Approvals'],
  ['#/exports', 'Exports'],
  ['#/integrations', 'Connect systems'],
  ['#/audit', 'Audit'],
  ['#/settings', 'Settings'],
  ['#/help', 'Help'],
] as const;

export type Route = (typeof ROUTES)[number][0];

/** Left rail grouping: section label plus its routes, in reading order. */
export const NAV_GROUPS: ReadonlyArray<readonly [string, ReadonlyArray<Route>]> = [
  ['Overview', ['#/dashboard', '#/new-run', '#/runs']],
  ['Catalogue', ['#/inventory', '#/expansion', '#/suppliers', '#/mapping-profiles']],
  ['Pricing', ['#/pricing-rules', '#/competitors', '#/sources']],
  ['Review', ['#/exceptions', '#/approvals', '#/exports']],
  ['System', ['#/integrations', '#/audit', '#/settings', '#/help']],
];

export function routeTitle(route: Route): string {
  return ROUTES.find(([id]) => id === route)?.[1] ?? route;
}

const INDEX_BY_ROUTE = new Map<Route, string>();
const GROUP_BY_ROUTE = new Map<Route, string>();
{
  let position = 0;
  for (const [group, routes] of NAV_GROUPS) {
    for (const route of routes) {
      position += 1;
      INDEX_BY_ROUTE.set(route, String(position).padStart(2, '0'));
      GROUP_BY_ROUTE.set(route, group);
    }
  }
}

/** Zero-padded rail position, `01`-`17`. */
export function routeIndex(route: Route): string {
  return INDEX_BY_ROUTE.get(route) ?? '';
}

export function routeGroup(route: Route): string {
  return GROUP_BY_ROUTE.get(route) ?? '';
}

/**
 * `GROUP / NN` for the page head, looked up by the heading a page renders.
 * Pages state their own title, so the shell does not have to thread the route
 * down through every page component.
 */
const KICKER_BY_TITLE = new Map<string, string>(
  ROUTES.map(([route, title]) => [
    title,
    `${routeGroup(route).toUpperCase()} / ${routeIndex(route)}`,
  ]),
);

export function kickerForTitle(title: string): string | undefined {
  return KICKER_BY_TITLE.get(title);
}
