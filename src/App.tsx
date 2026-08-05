import { useEffect, useRef, useState } from 'react';
import { APP_NAME, APP_VERSION } from './core/audit';
import { isDesktop } from './platform/desktop';
import { STEP_ORDER, STEP_TITLES, useAppDispatch, useAppState, type StepId } from './state/store';
import { PrivacyDialog } from './ui/PrivacyDialog';
import { SettingsDialog } from './ui/SettingsDialog';
import { CompetitorsPage, SettingsPage } from './ui/pages/ConfigPages';
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
import { Page } from './ui/pages/PageChrome';
import { SearchPage } from './ui/pages/SearchPage';
import { SuppliersPage } from './ui/pages/SuppliersPage';
import { ChecklistStep } from './ui/steps/ChecklistStep';
import { ExportStep } from './ui/steps/ExportStep';
import { FilesStep } from './ui/steps/FilesStep';
import { MappingStep } from './ui/steps/MappingStep';
import { ReviewStep } from './ui/steps/ReviewStep';
import { StartStep } from './ui/steps/StartStep';
import { ValidateStep } from './ui/steps/ValidateStep';

const ROUTES = [
  ['#/dashboard', 'Dashboard'],
  ['#/new-run', 'New run'],
  ['#/runs', 'Runs'],
  ['#/inventory', 'Inventory search'],
  ['#/suppliers', 'Suppliers'],
  ['#/mapping-profiles', 'Mapping profiles'],
  ['#/pricing-rules', 'Pricing rules'],
  ['#/competitors', 'Competitors'],
  ['#/exceptions', 'Exceptions'],
  ['#/approvals', 'Approvals'],
  ['#/exports', 'Exports'],
  ['#/integrations', 'Integrations'],
  ['#/audit', 'Audit'],
  ['#/settings', 'Configuration'],
  ['#/help', 'Help'],
] as const;

type Route = (typeof ROUTES)[number][0];

function currentRoute(): Route {
  const hash = window.location.hash || '#/new-run';
  return ROUTES.some(([route]) => route === hash) ? (hash as Route) : '#/dashboard';
}

function stepEnabled(step: StepId, state: ReturnType<typeof useAppState>): boolean {
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
    <Page title="Run workspace">
      <nav className="run-stepper" aria-label="Run workflow">
        <ol>
          {STEP_ORDER.map((step, i) => (
            <li key={step}>
              <button
                type="button"
                className={i < stepIndex ? 'step-done' : ''}
                aria-current={state.step === step ? 'step' : undefined}
                disabled={!stepEnabled(step, state)}
                onClick={() => dispatch({ type: 'go-to-step', step })}
              >
                <span className="step-index" aria-hidden="true">
                  {i < stepIndex ? '✓' : i + 1}
                </span>
                {STEP_TITLES[step]}
              </button>
            </li>
          ))}
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

function MappingProfilesPage() {
  return (
    <Page title="Mapping profiles">
      <MappingStep />
    </Page>
  );
}

function ExportsPage() {
  return (
    <Page title="Exports">
      <ChecklistStep />
      <ExportStep />
    </Page>
  );
}

export default function App() {
  const state = useAppState();
  const [route, setRoute] = useState<Route>(currentRoute);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const pageTitle = ROUTES.find(([id]) => id === route)?.[1] ?? 'Dashboard';
  const totalRecords = state.comparison?.rows.length ?? 0;
  const approvedCount = Object.values(state.review.decisions).filter(
    (decision) => decision.state === 'approved',
  ).length;

  const go = (next: Route) => {
    window.location.assign(next);
    setRoute(next);
  };
  const goRoute = (next: string) => go(next as Route);

  useEffect(() => {
    const onHash = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onHash);
    if (!window.location.hash) window.location.hash = '#/new-run';
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    document.title = `${pageTitle} - ${APP_NAME}`;
  }, [pageTitle]);

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

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <div className="app-shell">
        <aside className="side-nav">
          <h1>{APP_NAME}</h1>
          <span className="local-badge">
            {isDesktop() ? 'Desktop · local processing only' : 'Local processing only'}
          </span>
          <nav aria-label="Primary">
            {ROUTES.map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-current={route === id ? 'page' : undefined}
                onClick={() => go(id)}
              >
                {label}
              </button>
            ))}
          </nav>
        </aside>
        <div className="app-frame">
          <header className="topbar">
            <input
              ref={searchRef}
              className="global-search"
              type="search"
              value={searchQuery}
              placeholder="Search products ( / )"
              aria-label="Search products across supplier and ServiceM8 data"
              onChange={(event) => {
                setSearchQuery(event.target.value);
                if (route !== '#/inventory' && event.target.value.trim() !== '') go('#/inventory');
              }}
            />
            <span className="notice">No live ServiceM8 or Xero writes</span>
            <span className="run-status">
              {totalRecords} records · {approvedCount} approved
            </span>
            {state.demoMode && (
              <span className="badge badge-missing-from-supplier">Fictional demo data</span>
            )}
            <button type="button" className="header-btn" onClick={() => setPrivacyOpen(true)}>
              Privacy &amp; data
            </button>
            <button type="button" className="header-btn" onClick={() => setSettingsOpen(true)}>
              Settings
            </button>
          </header>
          <main id="main-content">
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
            {route === '#/suppliers' && <SuppliersPage />}
            {route === '#/mapping-profiles' && <MappingProfilesPage />}
            {route === '#/pricing-rules' && <PricingRulesPage />}
            {route === '#/competitors' && <CompetitorsPage />}
            {route === '#/exceptions' && <ExceptionsPage />}
            {route === '#/approvals' && <ApprovalsPage go={goRoute} />}
            {route === '#/exports' && <ExportsPage />}
            {route === '#/integrations' && <IntegrationsPage />}
            {route === '#/audit' && <AuditPage />}
            {route === '#/settings' && (
              <SettingsPage openSettingsDialog={() => setSettingsOpen(true)} />
            )}
            {route === '#/help' && <HelpPage />}
          </main>
          <footer className="app-footer">
            <span>
              {APP_NAME} v{APP_VERSION}
            </span>
            <span>
              {isDesktop() ? 'Windows desktop' : 'Browser-only'} · candidate import files only · AUD
            </span>
          </footer>
        </div>
      </div>
      <div aria-live="polite" role="status" className="visually-hidden">
        {state.announcement}
      </div>
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <PrivacyDialog open={privacyOpen} onClose={() => setPrivacyOpen(false)} />
    </>
  );
}
