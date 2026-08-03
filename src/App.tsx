import { useEffect, useState } from 'react';
import { APP_NAME, APP_VERSION } from './core/audit';
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

function stepEnabled(step: StepId, state: ReturnType<typeof useAppState>): boolean {
  const filesReady = state.supplier.table !== null && state.servicem8.table !== null;
  switch (step) {
    case 'start':
    case 'files':
      return true;
    case 'mapping':
      return filesReady;
    case 'validate':
    case 'review':
    case 'checklist':
    case 'export':
      return state.comparison !== null;
    default:
      return false;
  }
}

export default function App() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);

  useEffect(() => {
    document.title = `${STEP_TITLES[state.step]} — ${APP_NAME}`;
  }, [state.step]);

  const stepIndex = STEP_ORDER.indexOf(state.step);

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="app-header">
        <h1>{APP_NAME}</h1>
        <span
          className="local-badge"
          title="All processing happens in this browser. Nothing is uploaded."
        >
          Local processing only
        </span>
        <span className="spacer" />
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

      <nav className="stepper" aria-label="Workflow steps">
        <ol>
          {STEP_ORDER.map((step, i) => {
            const enabled = stepEnabled(step, state);
            const done = i < stepIndex && enabled;
            return (
              <li key={step}>
                <button
                  type="button"
                  className={done ? 'step-done' : ''}
                  aria-current={state.step === step ? 'step' : undefined}
                  disabled={!enabled}
                  onClick={() => dispatch({ type: 'go-to-step', step })}
                >
                  <span className="step-index" aria-hidden="true">
                    {done ? '✓' : i + 1}
                  </span>
                  {STEP_TITLES[step]}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <main id="main-content">
        {state.step === 'start' && <StartStep />}
        {state.step === 'files' && <FilesStep />}
        {state.step === 'mapping' && <MappingStep />}
        {state.step === 'validate' && <ValidateStep />}
        {state.step === 'review' && <ReviewStep />}
        {state.step === 'checklist' && <ChecklistStep />}
        {state.step === 'export' && <ExportStep />}
      </main>

      <footer className="app-footer">
        <span>
          {APP_NAME} v{APP_VERSION} — for Stan Wootton Locksmiths. Local-first: business data never
          leaves this computer.
        </span>
        <span>
          Markup {state.settings.markupPercent}% on cost · AUD · {state.profiles.length} saved
          profile(s)
        </span>
      </footer>

      <div aria-live="polite" role="status" className="visually-hidden">
        {state.announcement}
      </div>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <PrivacyDialog open={privacyOpen} onClose={() => setPrivacyOpen(false)} />
    </>
  );
}
