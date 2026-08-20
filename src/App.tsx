import { useEffect, useRef, useState } from 'react';
import { APP_NAME, APP_VERSION } from './core/audit';
import { buildApprovalProposals, deriveExceptions } from './core/operations';
import { datePrefix } from './core/run';
import type { Settings } from './core/settings';
import { usePlatform } from './platform/context';
import { STEP_ORDER, STEP_TITLES, useAppDispatch, useAppState, type StepId } from './state/store';
import { useActions } from './state/useActions';
import { AppearanceControl } from './ui/AppearanceControl';
import { BrandLockup } from './ui/Brand';
import { NAV_GROUPS, ROUTES, routeIndex, routeTitle, type Route } from './ui/routes';
import { PrivacyDialog } from './ui/PrivacyDialog';
import { SettingsDialog } from './ui/SettingsDialog';
import { RecoveryPanel, SettingsPage } from './ui/pages/ConfigPages';
import { CompetitorsPage, SourcesPage } from './ui/pages/CompetitorSearchPage';
import { ExpansionCataloguePage } from './ui/pages/ExpansionCataloguePage';
import { IntegrationsPage } from './ui/pages/IntegrationsPage';
import {
  ApprovalsPage,
  AuditPage,
  DashboardPage,
  ExceptionsPage,
  HelpPage,
  PricingRulesPage,
  RunsPage,
} from './ui/pages/OperationsPages';
import { Page, Panel } from './ui/pages/PageChrome';
import { SearchPage } from './ui/pages/SearchPage';
import { SuppliersPage } from './ui/pages/SuppliersPage';
import { ChecklistStep } from './ui/steps/ChecklistStep';
import { ExportStep } from './ui/steps/ExportStep';
import { FilesStep } from './ui/steps/FilesStep';
import { MappingStep } from './ui/steps/MappingStep';
import { ReviewStep } from './ui/steps/ReviewStep';
import { StartStep } from './ui/steps/StartStep';
import { ValidateStep } from './ui/steps/ValidateStep';

function ShieldIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 1.7 13 3.4v4.2c0 3-2.1 5.6-5 6.7-2.9-1.1-5-3.7-5-6.7V3.4z" />
      <path d="M5.9 8.1 7.4 9.6l2.9-3" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Sliders, not a cog: a cog at 18px is indistinguishable from the
          sun used by the theme toggle sitting beside it. */}
      <path d="M2.5 4.5h11M2.5 11.5h11" />
      <circle cx="6" cy="4.5" r="1.9" fill="var(--surface)" />
      <circle cx="10.5" cy="11.5" r="1.9" fill="var(--surface)" />
    </svg>
  );
}

function currentRoute(): Route {
  const hash = window.location.hash || '#/new-run';
  return ROUTES.some(([route]) => route === hash) ? (hash as Route) : '#/dashboard';
}

function stepEnabled(step: StepId, state: ReturnType<typeof useAppState>): boolean {
  if (state.configurationHydration.status !== 'ready') return false;
  const filesReady = state.supplier.table !== null && state.servicem8.table !== null;
  if (step === 'start' || step === 'files') return true;
  if (step === 'mapping') return filesReady;
  return state.comparison !== null;
}

function RunWorkspace() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const stepIndex = STEP_ORDER.indexOf(state.step);
  return (
    <Page
      title="New run"
      lead="Seven stages, in order: nothing reaches the import file until every one of them has been completed."
    >
      {/* Stage strip: one bordered container of seven equal cells. The index,
          the tick and the state word are aria-hidden, so each control keeps
          its stage title as its accessible name and aria-current="step"
          carries the position. */}
      <nav className="run-stepper" aria-label="Run workflow">
        <ol>
          {STEP_ORDER.map((step, i) => {
            const done = i < stepIndex;
            const enabled = stepEnabled(step, state);
            const current = state.step === step;
            return (
              <li key={step}>
                <button
                  type="button"
                  className={done ? 'step-done' : ''}
                  aria-current={current ? 'step' : undefined}
                  disabled={!enabled}
                  onClick={() => dispatch({ type: 'go-to-step', step })}
                >
                  <span className="step-index" aria-hidden="true">
                    {String(i + 1).padStart(2, '0')}
                    {done ? ' ✓' : ''}
                  </span>
                  <span className="step-title">{STEP_TITLES[step]}</span>
                  <span className="step-state" aria-hidden="true">
                    {current ? 'Current' : done ? 'Done' : enabled ? 'Ready' : 'Locked'}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
      {state.step === 'start' && <StartStep />}
      {state.step === 'files' && <FilesStep />}
      {state.step === 'mapping' && <MappingStep />}
      {state.step === 'validate' && <ValidateStep />}
      {state.step === 'review' && <ReviewStep />}
      {state.step === 'checklist' && <ChecklistStep />}
      {state.step === 'export' && <ExportStep />}
    </Page>
  );
}

/**
 * Saved column layouts, read-only. Editing a mapping happens in the run's
 * mapping stage, which owns the duplicate-column detection and the save
 * dialog; rendering that whole step here duplicated it on two routes.
 */
function MappingProfilesPage({ goToNewRun }: { goToNewRun: () => void }) {
  const state = useAppState();
  const mappedCount = (mapping: Record<string, number | null>) =>
    Object.values(mapping).filter((index) => index !== null).length;
  const columnFor = (profile: (typeof state.profiles)[number], key: string) => {
    const index = (profile.supplierMapping as Record<string, number | null>)[key];
    return index === null || index === undefined ? '—' : (profile.supplierHeaders[index] ?? '—');
  };
  return (
    <Page
      title="Saved import layouts"
      lead="Saved supplier column layouts; the ServiceM8 side is a fixed contract and cannot be remapped."
      primary={
        <button type="button" className="btn btn-primary" onClick={goToNewRun}>
          Edit in a run
        </button>
      }
    >
      <Panel title="Saved profiles" meta={`${state.profiles.length} saved`}>
        {state.profiles.length === 0 ? (
          <p className="hint">
            No profiles saved yet. Map a supplier&rsquo;s columns in a run, then save the layout.
          </p>
        ) : (
          <div
            className="table-scroll"
            role="region"
            aria-label="Saved import layouts"
            tabIndex={0}
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Profile</th>
                  <th scope="col" className="num">
                    Fields mapped
                  </th>
                  <th scope="col">Code column</th>
                  <th scope="col">Cost column</th>
                  <th scope="col">Category column</th>
                  <th scope="col">Saved</th>
                </tr>
              </thead>
              <tbody>
                {state.profiles.map((profile) => (
                  <tr key={profile.id}>
                    <td data-label="Profile">
                      {profile.name} <span className="mono muted">v{profile.version}</span>
                    </td>
                    <td className="num" data-label="Fields mapped">
                      {mappedCount(profile.supplierMapping as Record<string, number | null>)}
                    </td>
                    <td className="mono" data-label="Code column">
                      {columnFor(profile, 'supplierCode')}
                    </td>
                    <td className="mono" data-label="Cost column">
                      {columnFor(profile, 'supplierCost')}
                    </td>
                    <td className="mono" data-label="Category column">
                      {columnFor(profile, 'supplierCategory')}
                    </td>
                    <td className="mono" data-label="Saved">
                      {profile.updatedAt.slice(0, 10)}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td data-label="Profile">ServiceM8 Materials &amp; Services</td>
                  <td className="num" data-label="Fields mapped">
                    —
                  </td>
                  <td colSpan={3} data-label="Columns">
                    <span className="badge badge-invalid">Locked contract</span> Column names and
                    order are fixed by the import format.
                  </td>
                  <td className="mono" data-label="Saved">
                    built in
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </Page>
  );
}

function ExportsPage() {
  return (
    <Page
      title="Exports"
      lead="Every blocking check must pass before the five workflow outputs can be generated."
    >
      <ChecklistStep />
      <ExportStep />
    </Page>
  );
}

export default function App() {
  const platform = usePlatform();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const actions = useActions();
  const [route, setRoute] = useState<Route>(currentRoute);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [appearanceSaving, setAppearanceSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const pendingRouteFocusRef = useRef(false);
  const appearanceSavingRef = useRef(false);
  const settingsRef = useRef(state.settings);
  const pageTitle = routeTitle(route);
  const totalRecords = state.comparison?.rows.length ?? 0;
  const approvedCount = Object.values(state.review.decisions).filter(
    (decision) => decision.state === 'approved',
  ).length;

  /**
   * Rail counts, fed by the same selectors the destination screens use. A
   * count is rendered only when it is non-zero, and it is aria-hidden: the
   * label is the control's accessible name, and the number is repeated in the
   * heading of the screen it points at.
   */
  const navCounts: Partial<Record<Route, number>> = {
    '#/inventory': totalRecords,
    '#/expansion': (state.comparison?.rows ?? []).filter((row) => row.status === 'new-item').length,
    '#/suppliers': state.profiles.length,
    '#/exceptions': deriveExceptions(state.comparison).length,
    '#/approvals': buildApprovalProposals(state.comparison, state.review.decisions).filter(
      (proposal) => proposal.approvable && state.review.decisions[proposal.id] === undefined,
    ).length,
  };

  const go = (next: Route, focusHeading = true) => {
    pendingRouteFocusRef.current = focusHeading;
    window.location.assign(next);
    setRoute(next);
    setMenuOpen(false);
  };
  const goRoute = (next: string) => go(next as Route);

  useEffect(() => {
    settingsRef.current = state.settings;
  }, [state.settings]);

  const changeAppearance = async (
    change: Partial<Pick<Settings, 'theme' | 'glassTint'>>,
    description: string,
  ) => {
    if (appearanceSavingRef.current) return false;
    appearanceSavingRef.current = true;
    setAppearanceSaving(true);
    const next = { ...settingsRef.current, ...change };
    try {
      const saved = await actions.changeSettings(next, description, false);
      if (saved) settingsRef.current = next;
      return saved;
    } finally {
      appearanceSavingRef.current = false;
      setAppearanceSaving(false);
    }
  };

  useEffect(() => {
    const onHash = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onHash);
    if (!window.location.hash) window.location.hash = '#/new-run';
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const nav = navRef.current;
    nav?.querySelector<HTMLElement>('button[aria-current="page"]')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
        return;
      }
      if (event.key !== 'Tab' || !nav) return;
      const focusable = [...nav.querySelectorAll<HTMLElement>('button:not(:disabled)')];
      const first = focusable.at(0);
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  useEffect(() => {
    document.title = `${pageTitle} - ${APP_NAME}`;
  }, [pageTitle]);

  useEffect(() => {
    if (!pendingRouteFocusRef.current) return undefined;
    pendingRouteFocusRef.current = false;
    const focusHeading = () => {
      document.querySelector<HTMLElement>('.page-head h1')?.focus();
    };
    if (typeof window.requestAnimationFrame !== 'function') {
      focusHeading();
      return undefined;
    }
    const frame = window.requestAnimationFrame(focusHeading);
    return () => window.cancelAnimationFrame(frame);
  }, [route]);

  // "/" focuses the global search from anywhere outside a text field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (state.configurationHydration.status !== 'ready') {
    return (
      <>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <div className="recovery-shell">
          <main id="main-content" className="recovery-main">
            <div className="recovery-brand">
              <BrandLockup productName="Pricing &amp; Inventory Control" />
              <span>Configuration recovery</span>
            </div>
            <div className="recovery-surface">
              <Page
                title={
                  state.configurationHydration.status === 'loading'
                    ? 'Loading stored configuration'
                    : 'Stored configuration unavailable'
                }
              >
                {state.configurationHydration.status === 'loading' ? (
                  <p role="status">
                    Verifying settings, saved import layouts, aliases and price sources before
                    enabling the workflow.
                  </p>
                ) : (
                  <>
                    <div className="callout callout-danger" role="alert">
                      <strong>The operational workflow is blocked.</strong>
                      <p>{state.configurationHydration.error}</p>
                      <p>
                        Defaults have not been substituted. Retry after repairing or restoring the
                        local configuration.
                      </p>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => dispatch({ type: 'configuration-hydration-retry' })}
                      >
                        Retry verified configuration load
                      </button>
                    </div>
                    <RecoveryPanel
                      platform={platform}
                      announce={actions.announce}
                      afterRestore={actions.reloadAfterRestore}
                    />
                  </>
                )}
              </Page>
            </div>
          </main>
        </div>
        <div aria-live="polite" role="status" className="visually-hidden">
          {state.announcement}
        </div>
      </>
    );
  }

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <div className="app-shell">
        <aside
          ref={navRef}
          id="primary-navigation"
          className={`side-nav${menuOpen ? ' nav-open' : ''}`}
          aria-label="Application navigation"
          role={menuOpen ? 'dialog' : undefined}
          aria-modal={menuOpen ? 'true' : undefined}
        >
          <div className="nav-brand">
            <BrandLockup productName="Pricing &amp; Inventory Control" />
          </div>
          <button
            type="button"
            className="nav-close"
            aria-label="Close menu"
            onClick={() => {
              setMenuOpen(false);
              menuButtonRef.current?.focus();
            }}
          >
            Close
          </button>
          <span className="local-badge">
            {platform.kind === 'desktop' ? 'Desktop · local services' : 'Web demo · own origin'}
          </span>
          <nav aria-label="Primary">
            {NAV_GROUPS.map(([group, routes]) => (
              <div className="nav-group" key={group}>
                <span className="nav-group-label" aria-hidden="true">
                  {group}
                </span>
                {routes.map((id) => {
                  const count = navCounts[id] ?? 0;
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-current={route === id ? 'page' : undefined}
                      onClick={() => go(id)}
                    >
                      <span className="nav-index" aria-hidden="true">
                        {routeIndex(id)}
                      </span>
                      <span className="nav-label">{routeTitle(id)}</span>
                      {count > 0 && (
                        <span className="nav-count" aria-hidden="true">
                          {count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
        </aside>
        {menuOpen && (
          <button
            type="button"
            className="nav-scrim"
            aria-label="Close menu"
            onClick={() => {
              setMenuOpen(false);
              menuButtonRef.current?.focus();
            }}
          />
        )}
        <div
          className="app-frame"
          inert={menuOpen ? true : undefined}
          aria-hidden={menuOpen ? 'true' : undefined}
        >
          <header className="topbar">
            <button
              ref={menuButtonRef}
              type="button"
              className="header-btn menu-button"
              aria-expanded={menuOpen}
              aria-controls="primary-navigation"
              onClick={() => setMenuOpen(true)}
            >
              Menu
            </button>
            <div className={`topbar-search${state.demoMode ? ' demo-active' : ''}`}>
              <svg
                className="search-icon"
                viewBox="0 0 16 16"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              >
                <circle cx="7" cy="7" r="4.5" />
                <path d="M10.4 10.4 14 14" />
              </svg>
              <input
                ref={searchRef}
                className="global-search"
                type="search"
                value={searchQuery}
                placeholder="Search products ( / )"
                aria-label="Search products across supplier and ServiceM8 data"
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  if (route !== '#/inventory' && event.target.value.trim() !== '')
                    go('#/inventory', false);
                }}
              />
              {state.demoMode && <span className="demo-indicator">Fictional demo data</span>}
            </div>
            {/* Run chip: the identity of the work in progress, not of the
                operator. The trading name lives in the rail lockup. */}
            <p className="run-chip">
              {state.comparison !== null && <span className="run-chip-mark" aria-hidden="true" />}
              {state.comparison === null ? (
                'No run open'
              ) : (
                <>
                  <span>RUN {datePrefix()}</span>
                  <span className="run-chip-sep" aria-hidden="true">
                    |
                  </span>
                  <span>{totalRecords} records</span>
                  <span className="run-chip-sep" aria-hidden="true">
                    |
                  </span>
                  <span>{approvedCount} approved</span>
                </>
              )}
            </p>
            <div className="topbar-actions">
              <AppearanceControl
                value={state.settings.theme}
                disabled={appearanceSaving}
                onChange={(theme) => {
                  void changeAppearance({ theme }, `theme changed to ${theme}`);
                }}
              />
              <button
                type="button"
                className="icon-btn"
                aria-label="Privacy and data handling"
                title="Privacy and data"
                onClick={() => setPrivacyOpen(true)}
              >
                <ShieldIcon />
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label="Open settings"
                title="Settings"
                onClick={() => setSettingsOpen(true)}
              >
                <GearIcon />
              </button>
            </div>
          </header>
          <main id="main-content">
            <div className="route-view" key={route}>
              {route === '#/dashboard' && <DashboardPage go={goRoute} />}
              {route === '#/new-run' && <RunWorkspace />}
              {route === '#/runs' && <RunsPage />}
              {route === '#/inventory' && (
                <SearchPage
                  query={searchQuery}
                  onQueryChange={setSearchQuery}
                  goToNewRun={() => go('#/new-run')}
                />
              )}
              {route === '#/expansion' && (
                <ExpansionCataloguePage goToNewRun={() => go('#/new-run')} />
              )}
              {route === '#/suppliers' && <SuppliersPage />}
              {route === '#/mapping-profiles' && (
                <MappingProfilesPage goToNewRun={() => go('#/new-run')} />
              )}
              {route === '#/pricing-rules' && <PricingRulesPage />}
              {route === '#/competitors' && <CompetitorsPage />}
              {route === '#/sources' && <SourcesPage />}
              {route === '#/exceptions' && <ExceptionsPage />}
              {route === '#/approvals' && <ApprovalsPage go={goRoute} />}
              {route === '#/exports' && <ExportsPage />}
              {route === '#/integrations' && <IntegrationsPage />}
              {route === '#/audit' && <AuditPage />}
              {route === '#/settings' && (
                <SettingsPage openSettingsDialog={() => setSettingsOpen(true)} />
              )}
              {route === '#/help' && <HelpPage />}
            </div>
          </main>
          <footer className="app-footer">
            <span>
              {APP_NAME} v{APP_VERSION} · © Stan Wootton Locksmiths
            </span>
            <span>
              {platform.kind === 'desktop' ? 'Windows desktop' : 'Browser demonstration'} ·
              ServiceM8 Materials CSV · AUD
            </span>
          </footer>
        </div>
      </div>
      <div aria-live="polite" role="status" className="visually-hidden">
        {state.announcement}
      </div>
      {settingsOpen && (
        <SettingsDialog
          open
          appearanceSaving={appearanceSaving}
          onAppearanceChange={changeAppearance}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {privacyOpen && <PrivacyDialog open onClose={() => setPrivacyOpen(false)} />}
    </>
  );
}
