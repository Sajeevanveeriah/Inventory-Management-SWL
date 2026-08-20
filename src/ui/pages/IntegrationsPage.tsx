import { useMemo, useState } from 'react';
import { usePlatform } from '../../platform/context';
import { useAppState } from '../../state/store';
import { EmptyState, Page } from './PageChrome';

export function IntegrationsPage() {
  const platform = usePlatform();
  const state = useAppState();
  const [system, setSystem] = useState<'all' | 'xero' | 'servicem8'>('all');
  const syncRuns = state.syncRuns;
  const syncCheckpoints = state.syncCheckpoints;
  const runs = useMemo(
    () => syncRuns.filter((run) => system === 'all' || run.system === system),
    [syncRuns, system],
  );
  const latestCheckpointByRun = useMemo(() => {
    const map = new Map<string, (typeof syncCheckpoints)[number]>();
    for (const checkpoint of syncCheckpoints) {
      const current = map.get(checkpoint.runId);
      if (!current || checkpoint.recordedAt > current.recordedAt)
        map.set(checkpoint.runId, checkpoint);
    }
    return map;
  }, [syncCheckpoints]);

  return (
    <Page
      title="Connect systems"
      lead="Review the safe one-way boundaries and locally recorded progress. This page cannot start a live call."
    >
      <div className="integration-grid">
        <section className="card">
          <div className="integration-head">
            <h2>Xero</h2>
            <span className="badge badge-unchanged">Read only</span>
          </div>
          <dl className="kv">
            <dt>Direction</dt>
            <dd>Upstream into this application</dd>
            <dt>Allowed operation</dt>
            <dd>Read Xero Items only</dd>
            <dt>Blocked operations</dt>
            <dd>
              The application cannot change Xero Items or choose an operation beyond this fixed
              read.
            </dd>
            <dt>Current action</dt>
            <dd>None. Account connection and each provider run remain separately approved.</dd>
          </dl>
        </section>
        <section className="card">
          <div className="integration-head">
            <h2>ServiceM8</h2>
            <span className="badge badge-unchanged">Approved writes only</span>
          </div>
          <dl className="kv">
            <dt>Direction</dt>
            <dd>Reviewed product details downstream to ServiceM8 Materials</dd>
            <dt>Allowed operations</dt>
            <dd>Read materials, then create or update approved fields after operator approval.</dd>
            <dt>Never changed</dt>
            <dd>Quantity-on-hand, deletion and deactivation are outside the integration.</dd>
            <dt>Recovery</dt>
            <dd>
              Each approved product update keeps a stable retry reference, pauses if the result is
              unclear, checks what ServiceM8 saved and records where a safe resume should begin.
            </dd>
          </dl>
        </section>
      </div>

      <section className="card">
        <h2>Local sync history</h2>
        <label>
          System
          <select
            value={system}
            onChange={(event) => setSystem(event.target.value as typeof system)}
          >
            <option value="all">All systems</option>
            <option value="xero">Xero</option>
            <option value="servicem8">ServiceM8</option>
          </select>
        </label>
        {runs.length === 0 ? (
          <EmptyState
            title="No recorded sync runs"
            detail="History appears only after a separately approved preview or sync. Opening this page never contacts Xero or ServiceM8."
          />
        ) : (
          <div
            className="table-scroll"
            role="region"
            aria-label="Local integration history"
            tabIndex={0}
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">System</th>
                  <th scope="col">Direction</th>
                  <th scope="col">Status</th>
                  <th scope="col">Mode</th>
                  <th scope="col">Started</th>
                  <th scope="col">Resume point</th>
                  <th scope="col">Item outcomes</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const checkpoint = latestCheckpointByRun.get(run.id);
                  const outcomes = state.syncItemOutcomes.filter(
                    (outcome) => outcome.runId === run.id,
                  );
                  const failed = outcomes.filter((outcome) => outcome.status === 'failed').length;
                  const succeeded = outcomes.filter(
                    (outcome) => outcome.status === 'succeeded',
                  ).length;
                  return (
                    <tr key={run.id}>
                      <td data-label="System">{run.system === 'xero' ? 'Xero' : 'ServiceM8'}</td>
                      <td data-label="Direction">
                        {run.direction === 'upstream-read' ? 'Read upstream' : 'Write downstream'}
                      </td>
                      <td data-label="Status">{run.status}</td>
                      <td data-label="Mode">{run.mode}</td>
                      <td data-label="Started">{run.startedAt}</td>
                      <td data-label="Resume point">
                        {checkpoint
                          ? checkpoint.cursorValue + ' at ' + checkpoint.recordedAt
                          : 'Not recorded'}
                      </td>
                      <td data-label="Item outcomes">
                        {succeeded} succeeded, {failed} failed,{' '}
                        {outcomes.length - succeeded - failed} other
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Local records</h2>
        <p>
          {platform.kind === 'desktop'
            ? 'The Windows app keeps sync history on this computer. Sign-in details are stored separately from this history.'
            : 'This browser demonstration keeps evidence for this session only. Sign-in details are stored separately.'}
        </p>
        <p role="status">External connections started from this page: none.</p>
      </section>
    </Page>
  );
}
