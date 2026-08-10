import { useEffect, useRef, useState } from "react";
import { APP_NAME, APP_VERSION } from "./core/audit";
import { usePlatform } from "./platform/context";
import {
  STEP_ORDER,
  STEP_TITLES,
  useAppDispatch,
  useAppState,
  type StepId,
} from "./state/store";
import { useActions } from "./state/useActions";
import { PrivacyDialog } from "./ui/PrivacyDialog";
import { SettingsDialog } from "./ui/SettingsDialog";
import { RecoveryPanel, SettingsPage } from "./ui/pages/ConfigPages";
import { CompetitorsPage, SourcesPage } from "./ui/pages/CompetitorSearchPage";
import { IntegrationsPage } from "./ui/pages/IntegrationsPage";
import {
  ApprovalsPage,
  AuditPage,
  DashboardPage,
  ExceptionsPage,
  HelpPage,
  PricingRulesPage,
  RunsPage,
} from "./ui/pages/OperationsPages";
import { Page } from "./ui/pages/PageChrome";
import { SearchPage } from "./ui/pages/SearchPage";
import { SuppliersPage } from "./ui/pages/SuppliersPage";
import { ChecklistStep } from "./ui/steps/ChecklistStep";
import { ExportStep } from "./ui/steps/ExportStep";
import { FilesStep } from "./ui/steps/FilesStep";
import { MappingStep } from "./ui/steps/MappingStep";
import { ReviewStep } from "./ui/steps/ReviewStep";
import { StartStep } from "./ui/steps/StartStep";
import { ValidateStep } from "./ui/steps/ValidateStep";

const ROUTES = [
  ["#/dashboard", "Dashboard"],
  ["#/new-run", "New run"],
  ["#/runs", "Runs"],
  ["#/inventory", "Inventory search"],
  ["#/suppliers", "Suppliers"],
  ["#/mapping-profiles", "Mapping profiles"],
  ["#/pricing-rules", "Pricing rules"],
  ["#/competitors", "Competitor search"],
  ["#/sources", "Source registry"],
  ["#/exceptions", "Exceptions"],
  ["#/approvals", "Approvals"],
  ["#/exports", "Exports"],
  ["#/integrations", "Integrations"],
  ["#/audit", "Audit"],
  ["#/settings", "Configuration"],
  ["#/help", "Help"],
] as const;

type Route = (typeof ROUTES)[number][0];

/** Left rail grouping: section label + routes, commercial-platform style. */
const NAV_GROUPS: ReadonlyArray<readonly [string, ReadonlyArray<Route>]> = [
  ["Overview", ["#/dashboard", "#/new-run", "#/runs"]],
  ["Catalogue", ["#/inventory", "#/suppliers", "#/mapping-profiles"]],
  ["Pricing", ["#/pricing-rules", "#/competitors", "#/sources"]],
  ["Review", ["#/exceptions", "#/approvals", "#/exports"]],
  ["System", ["#/integrations", "#/audit", "#/settings", "#/help"]],
];

/** 16px stroke icons keyed by route. Decorative: labels carry the meaning. */
const NAV_ICONS: Record<Route, string> = {
  "#/dashboard": "M2 9h4v5H2zM7 5h4v9H7zM12 2h4v12h-4z",
  "#/new-run": "M8 3v10M3 8h10",
  "#/runs": "M3 4h10M3 8h10M3 12h6",
  "#/inventory": "M7 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM10 10l4 4",
  "#/suppliers": "M2 12V6l6-3 6 3v6l-6 3zM8 3v6M2 6l6 3 6-3",
  "#/mapping-profiles": "M3 3h4v4H3zM9 9h4v4H9zM7 5h4M11 5v4",
  "#/pricing-rules": "M8 2v12M5 5h4.5a2 2 0 1 1 0 4H6a2 2 0 1 0 0 4h5",
  "#/competitors": "M2 13l3-4 3 2 3-5 3 3M2 3v10h12",
  "#/sources":
    "M8 2c3 0 6 .8 6 2s-3 2-6 2-6-.8-6-2 3-2 6-2zM2 4v8c0 1.2 3 2 6 2s6-.8 6-2V4",
  "#/exceptions": "M8 2l6 11H2zM8 6.5v3M8 11.5v.5",
  "#/approvals": "M3 8.5l3.5 3.5L13 5",
  "#/exports": "M8 10V2M5 5l3-3 3 3M3 10v3h10v-3",
  "#/integrations": "M5 8H2M14 8h-3M8 5V2M8 14v-3M5.5 5.5h5v5h-5z",
  "#/audit": "M4 2h8v12H4zM6 5h4M6 8h4M6 11h2",
  "#/settings":
    "M8 5.5A2.5 2.5 0 1 1 8 10.5 2.5 2.5 0 0 1 8 5.5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4",
  "#/help": "M6 6a2 2 0 1 1 3 1.7c-.7.4-1 .8-1 1.8M8 12v.5",
};

function NavIcon({ route }: { route: Route }) {
  return (
    <svg
      className="nav-icon"
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={NAV_ICONS[route]} />
    </svg>
  );
}

function currentRoute(): Route {
  const hash = window.location.hash || "#/new-run";
  return ROUTES.some(([route]) => route === hash)
    ? (hash as Route)
    : "#/dashboard";
}

function stepEnabled(
  step: StepId,
  state: ReturnType<typeof useAppState>,
): boolean {
  if (state.configurationHydration.status !== "ready") return false;
  const filesReady =
    state.supplier.table !== null && state.servicem8.table !== null;
  if (step === "start" || step === "files") return true;
  if (step === "mapping") return filesReady;
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
                className={i < stepIndex ? "step-done" : ""}
                aria-current={state.step === step ? "step" : undefined}
                disabled={!stepEnabled(step, state)}
                onClick={() => dispatch({ type: "go-to-step", step })}
              >
                <span className="step-index" aria-hidden="true">
                  {i < stepIndex ? "✓" : i + 1}
                </span>
                {STEP_TITLES[step]}
              </button>
            </li>
          ))}
        </ol>
      </nav>
      {state.step === "start" && <StartStep />}
      {state.step === "files" && <FilesStep />}
      {state.step === "mapping" && <MappingStep />}
      {state.step === "validate" && <ValidateStep />}
      {state.step === "review" && <ReviewStep />}
      {state.step === "checklist" && <ChecklistStep />}
      {state.step === "export" && <ExportStep />}
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
  const platform = usePlatform();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const actions = useActions();
  const [route, setRoute] = useState<Route>(currentRoute);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const pageTitle = ROUTES.find(([id]) => id === route)?.[1] ?? "Dashboard";
  const totalRecords = state.comparison?.rows.length ?? 0;
  const approvedCount = Object.values(state.review.decisions).filter(
    (decision) => decision.state === "approved",
  ).length;

  const go = (next: Route) => {
    window.location.assign(next);
    setRoute(next);
    setMenuOpen(false);
  };
  const goRoute = (next: string) => go(next as Route);

  useEffect(() => {
    const onHash = () => setRoute(currentRoute());
    window.addEventListener("hashchange", onHash);
    if (!window.location.hash) window.location.hash = "#/new-run";
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const nav = navRef.current;
    nav?.querySelector<HTMLElement>('button[aria-current="page"]')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
        return;
      }
      if (event.key !== "Tab" || !nav) return;
      const focusable = [
        ...nav.querySelectorAll<HTMLElement>("button:not(:disabled)"),
      ];
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
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  useEffect(() => {
    document.title = `${pageTitle} - ${APP_NAME}`;
  }, [pageTitle]);

  // "/" focuses the global search from anywhere outside a text field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey)
        return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (state.configurationHydration.status !== "ready") {
    return (
      <>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <main id="main-content">
          <Page
            title={
              state.configurationHydration.status === "loading"
                ? "Loading stored configuration"
                : "Stored configuration unavailable"
            }
          >
            {state.configurationHydration.status === "loading" ? (
              <p role="status">
                Verifying settings, mapping profiles, aliases and source
                registry before enabling the workflow.
              </p>
            ) : (
              <>
                <div className="callout callout-danger" role="alert">
                  <strong>The operational workflow is blocked.</strong>
                  <p>{state.configurationHydration.error}</p>
                  <p>
                    Defaults have not been substituted. Retry after repairing or
                    restoring the local configuration.
                  </p>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() =>
                      dispatch({ type: "configuration-hydration-retry" })
                    }
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
        </main>
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
          className={`side-nav${menuOpen ? " nav-open" : ""}`}
          aria-label="Application navigation"
          role={menuOpen ? "dialog" : undefined}
          aria-modal={menuOpen ? "true" : undefined}
        >
          <div className="nav-brand">{APP_NAME}</div>
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
            {platform.kind === "desktop"
              ? "Desktop · native local services"
              : "Web demonstration · own-origin only"}
          </span>
          <nav aria-label="Primary">
            {NAV_GROUPS.map(([group, routes]) => (
              <div className="nav-group" key={group}>
                <span className="nav-group-label" aria-hidden="true">
                  {group}
                </span>
                {routes.map((id) => {
                  const label = ROUTES.find(([r]) => r === id)?.[1] ?? id;
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-current={route === id ? "page" : undefined}
                      onClick={() => go(id)}
                    >
                      <NavIcon route={id} />
                      {label}
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
        <div className="app-frame">
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
            <input
              ref={searchRef}
              className="global-search"
              type="search"
              value={searchQuery}
              placeholder="Search products ( / )"
              aria-label="Search products across supplier and ServiceM8 data"
              onChange={(event) => {
                setSearchQuery(event.target.value);
                if (route !== "#/inventory" && event.target.value.trim() !== "")
                  go("#/inventory");
              }}
            />
            <span className="notice">No live ServiceM8 or Xero writes</span>
            <span className="run-status">
              {totalRecords} records · {approvedCount} approved
            </span>
            {state.demoMode && (
              <span className="badge badge-missing-from-supplier">
                Fictional demo data
              </span>
            )}
            <button
              type="button"
              className="header-btn"
              aria-pressed={state.settings.theme === "dark"}
              onClick={(event) => {
                const button = event.currentTarget;
                button.disabled = true;
                void actions
                  .changeSettings(
                    {
                      ...state.settings,
                      theme: state.settings.theme === "dark" ? "light" : "dark",
                    },
                    "Theme toggled",
                    false,
                  )
                  .finally(() => {
                    button.disabled = false;
                  });
              }}
            >
              {state.settings.theme === "dark" ? "Light theme" : "Dark theme"}
            </button>
            <button
              type="button"
              className="header-btn"
              onClick={() => setPrivacyOpen(true)}
            >
              Privacy &amp; data
            </button>
            <button
              type="button"
              className="header-btn"
              onClick={() => setSettingsOpen(true)}
            >
              Settings
            </button>
          </header>
          <main id="main-content">
            {route === "#/dashboard" && <DashboardPage go={goRoute} />}
            {route === "#/new-run" && <RunWorkspace />}
            {route === "#/runs" && <RunsPage />}
            {route === "#/inventory" && (
              <SearchPage
                query={searchQuery}
                onQueryChange={setSearchQuery}
                goToNewRun={() => go("#/new-run")}
              />
            )}
            {route === "#/suppliers" && <SuppliersPage />}
            {route === "#/mapping-profiles" && <MappingProfilesPage />}
            {route === "#/pricing-rules" && <PricingRulesPage />}
            {route === "#/competitors" && <CompetitorsPage />}
            {route === "#/sources" && <SourcesPage />}
            {route === "#/exceptions" && <ExceptionsPage />}
            {route === "#/approvals" && <ApprovalsPage go={goRoute} />}
            {route === "#/exports" && <ExportsPage />}
            {route === "#/integrations" && <IntegrationsPage />}
            {route === "#/audit" && <AuditPage />}
            {route === "#/settings" && (
              <SettingsPage openSettingsDialog={() => setSettingsOpen(true)} />
            )}
            {route === "#/help" && <HelpPage />}
          </main>
          <footer className="app-footer">
            <span>
              {APP_NAME} v{APP_VERSION}
            </span>
            <span>
              {platform.kind === "desktop"
                ? "Windows desktop"
                : "Browser demonstration"}{" "}
              · candidate import files only · AUD
            </span>
          </footer>
        </div>
      </div>
      <div aria-live="polite" role="status" className="visually-hidden">
        {state.announcement}
      </div>
      {settingsOpen && (
        <SettingsDialog open onClose={() => setSettingsOpen(false)} />
      )}
      {privacyOpen && (
        <PrivacyDialog open onClose={() => setPrivacyOpen(false)} />
      )}
    </>
  );
}
