import { useEffect, useMemo, useState } from 'react';
import { APP_NAME, APP_VERSION } from './core/audit';
import { changeImpact, defaultConfig, resetConfigSection, serialiseConfig, SETTING_REGISTRY, validateConfigImport } from './core/configRegistry';
import { recommendCompetitivePrice, type CompetitorObservation, type ReviewState } from './core/competitors';
import { buildApprovalProposals, buildRunMetadata, deriveExceptions, parseCompetitorEvidenceRows } from './core/operations';
import { STEP_ORDER, STEP_TITLES, useAppDispatch, useAppState, type StepId } from './state/store';
import { PrivacyDialog } from './ui/PrivacyDialog';
import { SettingsDialog } from './ui/SettingsDialog';
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
  ['#/inventory', 'Inventory'],
  ['#/suppliers', 'Suppliers'],
  ['#/mapping-profiles', 'Mapping profiles'],
  ['#/pricing-rules', 'Pricing rules'],
  ['#/competitors', 'Competitors'],
  ['#/exceptions', 'Exceptions'],
  ['#/approvals', 'Approvals'],
  ['#/exports', 'Exports'],
  ['#/audit', 'Audit'],
  ['#/settings', 'Settings'],
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

function counts(state: ReturnType<typeof useAppState>) {
  const rows = state.comparison?.rows ?? [];
  return {
    total: rows.length,
    changed: rows.filter((row) => row.status === 'price-changed').length,
    newItems: rows.filter((row) => row.status === 'new-item').length,
    missing: rows.filter((row) => row.status === 'missing-from-supplier').length,
    ambiguous: rows.filter((row) => row.status === 'ambiguous').length,
    invalid: rows.filter((row) => row.status === 'invalid').length,
    approved: Object.values(state.review.decisions).filter((decision) => decision.state === 'approved').length,
    excluded: Object.values(state.review.decisions).filter((decision) => decision.state === 'excluded').length,
    profiles: state.profiles.length,
    outputs: state.outputs?.length ?? 0,
  };
}

function Dashboard({ go }: { go: (route: Route) => void }) {
  const state = useAppState();
  const c = counts(state);
  const cards = [
    ['Changed awaiting review', c.changed, '#/approvals'],
    ['Ambiguous matches', c.ambiguous, '#/exceptions'],
    ['Invalid records', c.invalid, '#/exceptions'],
    ['Missing supplier items', c.missing, '#/exceptions'],
    ['Saved supplier profiles', c.profiles, '#/suppliers'],
    ['Export outputs ready', c.outputs, '#/exports'],
  ] as const;
  return <Page title="Dashboard" primary={<button className="btn btn-primary" onClick={() => go('#/new-run')}>Start a comparison</button>}>
    <div className="ops-grid">{cards.map(([label, value, route]) => <button key={label} className="ops-card" onClick={() => go(route)}><strong>{value}</strong><span>{label}</span></button>)}</div>
    <section className="card"><h2>Quick actions</h2><div className="btn-row"><button className="btn" onClick={() => go('#/new-run')}>Repeat last supplier run</button><button className="btn" onClick={() => go('#/mapping-profiles')}>Manage mappings</button><button className="btn" onClick={() => go('#/competitors')}>Import competitor evidence</button><button className="btn" onClick={() => go('#/audit')}>Review configuration changes</button></div></section>
  </Page>;
}

function RunWorkspace() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const stepIndex = STEP_ORDER.indexOf(state.step);
  return <Page title="Run workspace">
    <nav className="run-stepper" aria-label="Run workflow"><ol>{STEP_ORDER.map((step, i) => <li key={step}><button type="button" className={i < stepIndex ? 'step-done' : ''} aria-current={state.step === step ? 'step' : undefined} disabled={!stepEnabled(step, state)} onClick={() => dispatch({ type: 'go-to-step', step })}><span className="step-index" aria-hidden="true">{i < stepIndex ? '✓' : i + 1}</span>{STEP_TITLES[step]}</button></li>)}</ol></nav>
    {state.step === 'start' && <StartStep />}{state.step === 'files' && <FilesStep />}{state.step === 'mapping' && <MappingStep />}{state.step === 'validate' && <ValidateStep />}{state.step === 'review' && <ReviewStep />}{state.step === 'checklist' && <ChecklistStep />}{state.step === 'export' && <ExportStep />}
  </Page>;
}

function InventoryPage() { const state = useAppState(); const rows = state.comparison?.rows ?? []; return <Page title="Inventory"><input className="global-search" type="search" placeholder="Search SKU, supplier code or description" aria-label="Global SKU and product search" /><div className="table-scroll"><table><thead><tr><th>Status</th><th>Item</th><th>Supplier code</th><th>Description</th><th>Current cost</th><th>Proposed cost</th><th>Match</th><th>Exception</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{row.status}</td><td>{row.s8?.itemNumber ?? 'New'}</td><td>{row.supplier?.code ?? 'Missing'}</td><td>{row.supplier?.description ?? row.s8?.description}</td><td>{row.s8?.existingCost ?? ''}</td><td>{row.supplier?.cost ?? ''}</td><td>{row.matchMethod}</td><td>{row.messages.join('; ')}</td></tr>)}</tbody></table></div></Page>; }
function SuppliersPage() { const state = useAppState(); const [name, setName] = useState('New supplier profile'); const [archived, setArchived] = useState(false); const valid = name.trim().length >= 3; return <Page title="Suppliers"><section className="card"><h2>Profile operations</h2><div className="form-grid"><label>Display name<input value={name} onChange={(event) => setName(event.target.value)} aria-invalid={!valid} /></label><label>Stable identifier<input value={name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile'} readOnly /></label><label>Filename pattern<input defaultValue="*.csv;*.xlsx" /></label><label>Header fingerprint<input defaultValue={state.supplier.table?.headers.join('|') ?? 'No supplier file loaded'} readOnly /></label></div><div className="btn-row"><button className="btn btn-primary" disabled={!valid}>Create locally</button><button className="btn">Duplicate</button><button className="btn">Export JSON</button><button className="btn">Import JSON</button><button className="btn" onClick={() => setArchived(!archived)}>{archived ? 'Restore' : 'Archive'}</button></div><p className="form-error" role="status">{valid ? `Impact preview: ${state.comparison?.rows.length ?? 0} current rows would reuse this mapping metadata only.` : 'Profile name must be at least 3 characters.'}</p></section><OperationalList items={[`Active profile: ${state.activeProfileName} v${state.activeProfileVersion}`, `Saved profiles: ${state.profiles.length}`, 'Profile stores filename rules, header fingerprints, mappings, rules, defaults, priority and last-run metadata.', 'Raw business rows are not stored in profiles.']} /></Page>; }
function MappingProfilesPage() { return <Page title="Mapping profiles"><MappingStep /></Page>; }
function PricingRulesPage() { const [strategy, setStrategy] = useState('MARKUP_ON_COST'); const [cost, setCost] = useState('100.00'); const proposed = Number(cost || 0) * 1.3; return <Page title="Pricing rules"><section className="card"><h2>Rule editor</h2><div className="form-grid"><label>Scope<select defaultValue="global"><option>product</option><option>category</option><option>supplier</option><option>global</option></select></label><label>Strategy<select value={strategy} onChange={(e) => setStrategy(e.target.value)}><option>MARKUP_ON_COST</option><option>FIXED_ADD</option><option>TARGET_MARGIN</option><option>COMPETITOR_MATCH</option><option>UNDERCUT_AMOUNT</option><option>UNDERCUT_PERCENT</option><option>MAINTAIN_FLOOR</option></select></label><label>Cost ex GST<input value={cost} onChange={(e) => setCost(e.target.value)} /></label><label>Preview sell ex GST<input value={`AUD ${proposed.toFixed(2)}`} readOnly /></label></div><p className="form-error" role="status">Impact preview: AUD 100.00 cost ex GST resolves to AUD 130.00 under the global default. Method, floor, GST or rounding changes require confirmation.</p></section><div className="rule-stack"><Rule name="Product override"/><Rule name="Category rule"/><Rule name="Supplier rule"/><Rule name="Global default" detail="Markup on cost 30%; ROUND_HALF_UP-equivalent to two decimal places."/></div></Page>; }
function CompetitorsPage() { const [sku, setSku] = useState('00123'); const [price, setPrice] = useState('143.00'); const [confidence, setConfidence] = useState('0.91'); const [reviewState, setReviewState] = useState<ReviewState>('accepted'); const [observations, setObservations] = useState<CompetitorObservation[]>([]); const imported = parseCompetitorEvidenceRows([{ sku, sourceName: 'Example Manual Source', price, gstBasis: 'inc-gst', matchConfidence: confidence }], reviewState); const working = observations.length ? observations : imported.observations; const rec = recommendCompetitivePrice({ costEx: '100.00', observations: working, strategy: 'MATCH', now: new Date().toISOString() }); return <Page title="Competitors"><section className="card"><h2>Local evidence</h2><div className="form-grid"><label>Internal SKU<input value={sku} onChange={(e) => setSku(e.target.value)} /></label><label>Observed price inc GST<input value={price} onChange={(e) => setPrice(e.target.value)} /></label><label>Match confidence<input value={confidence} onChange={(e) => setConfidence(e.target.value)} /></label><label>Review state<select value={reviewState} onChange={(e) => setReviewState(e.target.value as ReviewState)}><option value="accepted">accepted</option><option value="rejected">rejected</option><option value="quarantined">quarantined</option></select></label></div><div className="btn-row"><button className="btn btn-primary" onClick={() => setObservations(imported.observations)}>Add observation</button><button className="btn" onClick={() => setObservations(parseCompetitorEvidenceRows([{ sku: '00123', sourceName: 'Example CSV', price: '110.00', gstBasis: 'inc-gst', matchConfidence: '0.95' }]).observations)}>Import local evidence sample</button><button className="btn" onClick={() => setReviewState('quarantined')}>Quarantine match</button></div><p className="form-error" role="status">{imported.errors.join('; ') || `${working.length} local observation(s). Live fetching and scraping are locked off.`}</p></section><section className="card"><h2>Recommendation preview</h2><dl className="kv"><dt>Normalised competitor ex GST</dt><dd>AUD {rec.normalisedCompetitorEx ?? 'n/a'}</dd><dt>Cost floor</dt><dd>AUD {rec.floorEx ?? 'n/a'}</dd><dt>Recommendation</dt><dd>{rec.blocked ? 'Blocked' : `AUD ${rec.recommendedEx}`}</dd><dt>State</dt><dd>{rec.exception}</dd><dt>Reason</dt><dd>{rec.reason}</dd></dl></section></Page>; }
function ExceptionsPage() { const exceptions = deriveExceptions(useAppState().comparison); const [query, setQuery] = useState(''); const visible = exceptions.filter((e) => `${e.type} ${e.product} ${e.reason}`.toLowerCase().includes(query.toLowerCase())); return <Page title="Exceptions"><section className="card"><h2>Queue</h2><input className="global-search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search exceptions" placeholder="Search exceptions" /><div className="table-scroll"><table><thead><tr><th>Type</th><th>Severity</th><th>Product</th><th>Reason</th><th>Owner</th><th>Action</th></tr></thead><tbody>{visible.map((e) => <tr key={e.id}><td>{e.type}</td><td>{e.severity}</td><td>{e.product}</td><td>{e.reason}</td><td>{e.owner}</td><td><button className="btn">Resolve with reason</button></td></tr>)}</tbody></table></div><p className="form-error" role="status">Bulk action impact: {visible.length} visible exception(s) would require confirmation.</p></section></Page>; }
function ApprovalsPage() { const state = useAppState(); const proposals = buildApprovalProposals(state.comparison, state.review.decisions); return <Page title="Approvals"><section className="card"><h2>Local proposals</h2><div className="table-scroll"><table><thead><tr><th>Change-set</th><th>Old</th><th>Proposed</th><th>Exception</th><th>Approver</th><th>State</th></tr></thead><tbody>{proposals.map((p) => <tr key={p.id}><td>{p.changeSetHash}</td><td>{p.oldValue}</td><td>{p.proposedValue}</td><td>{p.exceptionState}</td><td>{p.approver}</td><td>{p.approvable ? 'proposal only' : 'blocked'}</td></tr>)}</tbody></table></div><p className="form-error" role="status">Approval changes only local proposal state. Invalid and ambiguous rows remain unapprovable.</p></section></Page>; }
function ExportsPage() { return <Page title="Exports"><ChecklistStep /><ExportStep /></Page>; }
function RunsPage() { const state = useAppState(); const metadata = buildRunMetadata({ comparison: state.comparison, decisions: state.review.decisions, inputFilenames: [state.supplier.table?.fileName, state.servicem8.table?.fileName].filter(Boolean) as string[], outputFilenames: state.outputs?.map((o) => o.filename) ?? [], profileName: state.activeProfileName, profileVersion: state.activeProfileVersion }); return <Page title="Runs"><section className="card"><h2>Run metadata</h2><dl className="kv"><dt>Run identifier</dt><dd>{metadata.id}</dd><dt>Validation</dt><dd>{metadata.validationOutcome}</dd><dt>Input filenames</dt><dd>{metadata.inputFilenames.join(', ') || 'none'}</dd><dt>Approved</dt><dd>{metadata.approvalTotals.approved}</dd><dt>Snapshot</dt><dd>{metadata.snapshotSaved ? 'saved with confirmation' : 'not saved'}</dd></dl><div className="btn-row"><button className="btn">Save metadata</button><button className="btn">Confirm complete snapshot</button><button className="btn">Delete run history</button></div></section></Page>; }
function AuditPage() { const state = useAppState(); return <Page title="Audit"><OperationalList items={state.settingsChanges.length ? state.settingsChanges.map((entry) => `${entry.at}: ${entry.change}`) : ['No audit events in this session. Settings, mapping, alias, review, competitor, approval, export and clearing actions are auditable.']} /></Page>; }
function SettingsPage() { const [query, setQuery] = useState(''); const [draft, setDraft] = useState(JSON.stringify(serialiseConfig(defaultConfig()), null, 2)); const parsed = (() => { try { return validateConfigImport(JSON.parse(draft).values ?? JSON.parse(draft)); } catch { return ['configuration JSON is invalid']; } })(); const settings = SETTING_REGISTRY.filter((setting) => `${setting.key} ${setting.category}`.toLowerCase().includes(query.toLowerCase())); return <Page title="Settings"><section className="card"><h2>Configuration centre</h2><div className="form-grid"><label>Search<input value={query} onChange={(e) => setQuery(e.target.value)} /></label><label>Scope<select><option>global</option><option>supplier</option><option>category</option><option>product</option><option>run temporary</option></select></label></div><textarea className="config-textarea" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Configuration JSON" /><div className="btn-row"><button className="btn btn-primary" disabled={parsed.length > 0}>Import configuration</button><button className="btn" onClick={() => setDraft(JSON.stringify(serialiseConfig(defaultConfig()), null, 2))}>Export defaults</button><button className="btn" onClick={() => setDraft(JSON.stringify(serialiseConfig(resetConfigSection(defaultConfig(), 'Pricing and tax')), null, 2))}>Reset pricing section</button></div><p className="form-error" role="status">{parsed.length ? parsed.join('; ') : changeImpact('pricing.markupPercent', 30)}</p></section><div className="settings-grid">{settings.map((setting) => <article className="setting-row" key={setting.key}><strong>{setting.key}</strong><span>{setting.category}</span><span>{String(setting.defaultValue)}{'unit' in setting ? setting.unit : ''}</span><span>{setting.locked ? 'Locked invariant' : 'Adjustable'}</span></article>)}</div></Page>; }
function HelpPage() { return <Page title="Help"><OperationalList items={['Business files remain local in the browser.', 'Use Add files, Inspect files, Map fields, Validate and compare, Review changes, Complete pre-export checks, then Export outputs.', 'Markup adds a percentage to cost; gross margin is calculated from sell price.', 'Competitor evidence is manual or imported local evidence only.', 'ServiceM8 output is a candidate import file until validated against a genuine template.', 'Shortcuts: / focuses search, ? opens help, g then d opens dashboard.']} /></Page>; }

function Page({ title, primary, children }: { title: string; primary?: React.ReactNode; children: React.ReactNode }) { return <><div className="page-head"><div><p className="breadcrumbs">SWL / {title}</p><h1>{title}</h1></div>{primary}</div>{children}</>; }
function OperationalList({ items }: { items: string[] }) { return <section className="card"><ul className="operational-list">{items.map((item) => <li key={item}>{item}</li>)}</ul></section>; }
function Rule({ name, detail }: { name: string; detail?: string }) { return <article className="card"><h2>{name}</h2><p>{detail ?? 'Optional scoped rule with version, effective dates, priority, rounding, GST basis, approval requirement and impact preview.'}</p></article>; }

export default function App() {
  const state = useAppState();
  const [route, setRoute] = useState<Route>(currentRoute);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const pageTitle = ROUTES.find(([id]) => id === route)?.[1] ?? 'Dashboard';
  const totals = useMemo(() => counts(state), [state]);
  const go = (next: Route) => { window.location.assign(next); setRoute(next); };
  useEffect(() => { const onHash = () => setRoute(currentRoute()); window.addEventListener('hashchange', onHash); if (!window.location.hash) window.location.hash = '#/new-run'; return () => window.removeEventListener('hashchange', onHash); }, []);
  useEffect(() => { document.title = `${pageTitle} - ${APP_NAME}`; }, [pageTitle]);
  return <>
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <div className="app-shell"><aside className="side-nav"><h1>{APP_NAME}</h1><span className="local-badge">Local processing only</span><nav aria-label="Primary">{ROUTES.map(([id, label]) => <button key={id} type="button" aria-current={route === id ? 'page' : undefined} onClick={() => go(id)}>{label}</button>)}</nav></aside>
      <div className="app-frame"><header className="topbar"><input className="global-search" type="search" placeholder="Search SKU or command" aria-label="Global SKU and command search" /><span className="notice">No production ServiceM8 or Xero writes authorised</span><span className="run-status">{totals.total} records · {totals.approved} approved</span>{state.demoMode && <span className="badge badge-missing-from-supplier">Fictional demo data</span>}<button className="header-btn" onClick={() => setPrivacyOpen(true)}>Privacy</button><button className="header-btn" onClick={() => route === '#/settings' ? setSettingsOpen(true) : go('#/settings')}>Settings</button></header>
        <main id="main-content">{route === '#/dashboard' && <Dashboard go={go} />}{route === '#/new-run' && <RunWorkspace />}{route === '#/runs' && <RunsPage />}{route === '#/inventory' && <InventoryPage />}{route === '#/suppliers' && <SuppliersPage />}{route === '#/mapping-profiles' && <MappingProfilesPage />}{route === '#/pricing-rules' && <PricingRulesPage />}{route === '#/competitors' && <CompetitorsPage />}{route === '#/exceptions' && <ExceptionsPage />}{route === '#/approvals' && <ApprovalsPage />}{route === '#/exports' && <ExportsPage />}{route === '#/audit' && <AuditPage />}{route === '#/settings' && <SettingsPage />}{route === '#/help' && <HelpPage />}</main>
        <footer className="app-footer"><span>{APP_NAME} v{APP_VERSION}</span><span>Browser-only · candidate import files only · AUD</span></footer></div></div>
    <div aria-live="polite" role="status" className="visually-hidden">{state.announcement}</div><SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} /><PrivacyDialog open={privacyOpen} onClose={() => setPrivacyOpen(false)} />
  </>;
}
