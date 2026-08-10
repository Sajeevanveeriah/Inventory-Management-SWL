import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import App from '../src/App';
import { centsToAud } from '../src/core/liveSearch';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/settings';
import { defaultSources } from '../src/core/sources';
import { PlatformProvider } from '../src/platform/context';
import type { PlatformResult, PlatformService } from '../src/platform/contracts';
import { platformFail, platformOk } from '../src/platform/contracts';
import { createWebPlatformService } from '../src/platform/web';
import { AppStateProvider } from '../src/state/store';

function publicationService(
  succeeds: boolean,
  observe?: (changes: Parameters<PlatformService['catalogue']['publishApproved']>[0]) => void,
): PlatformService {
  const service = createWebPlatformService();
  return {
    ...service,
    settings: {
      ...service.settings,
      async load() {
        return platformOk(DEFAULT_SETTINGS);
      },
      async save(settings) {
        return platformOk(settings);
      },
    },
    profiles: {
      ...service.profiles,
      async list() {
        return platformOk([]);
      },
    },
    aliases: {
      ...service.aliases,
      async list() {
        return platformOk([]);
      },
    },
    sources: {
      ...service.sources,
      async list() {
        return platformOk(defaultSources());
      },
    },
    configuration: {
      ...service.configuration,
      async migrationStatus() {
        return platformOk({
          legacyConfigurationFound: false,
          alreadyImported: false,
          counts: { profiles: 0, aliases: 0, settings: 1 },
          valid: true,
          invalidCounts: { profiles: 0, aliases: 0, settings: 0 },
          validationMessages: [],
        });
      },
    },
    catalogue: {
      ...service.catalogue,
      async publishApproved(changes) {
        observe?.(changes);
        if (!succeeds) {
          return platformFail('unavailable', 'Synthetic publication failed.');
        }
        return platformOk(
          changes.map((change, index) => ({
            item: change.item,
            approval: {
              id: `approval-${index}`,
              itemId: change.item.id,
              approvedBy: change.approvedBy,
              proposedSellCents: change.item.sellPriceCents,
              reason: change.reason,
              approvedAt: '2026-08-09T00:00:00.000Z',
            },
            priceHistory: {
              id: `history-${index}`,
              itemId: change.item.id,
              cost: centsToAud(change.item.costCents),
              sellPrice: centsToAud(change.item.sellPriceCents),
              costCents: change.item.costCents,
              sellPriceCents: change.item.sellPriceCents,
              approvalId: `approval-${index}`,
              recordedAt: '2026-08-09T00:00:00.000Z',
            },
          })),
        );
      },
    },
  };
}

async function renderApp(service?: PlatformService) {
  const selectedService = service ?? publicationService(true);
  const rendered = render(
    <StrictMode>
      <PlatformProvider service={selectedService}>
        <AppStateProvider>
          <App />
        </AppStateProvider>
      </PlatformProvider>
    </StrictMode>,
  );
  await waitFor(() =>
    expect(
      screen.queryByRole('heading', { name: /loading stored configuration/i }),
    ).not.toBeInTheDocument(),
  );
  return rendered;
}

describe('application workflow (jsdom integration)', () => {
  it('blocks the workflow instead of substituting defaults when settings hydration fails', async () => {
    const base = publicationService(true);
    const service: PlatformService = {
      ...base,
      settings: {
        ...base.settings,
        async load() {
          return platformFail('integrity_failed', 'Synthetic stored settings failed validation.');
        },
      },
    };
    await renderApp(service);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/operational workflow is blocked/i);
    expect(alert).toHaveTextContent(/defaults have not been substituted/i);
    expect(
      screen.getByRole('button', {
        name: /retry verified configuration load/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: /load synthetic demonstration/i,
      }),
    ).not.toBeInTheDocument();
  });

  it('persists the header theme toggle through the platform settings service', async () => {
    const user = userEvent.setup();
    const base = publicationService(true);
    let savedTheme: 'light' | 'dark' | null = null;
    const service: PlatformService = {
      ...base,
      settings: {
        ...base.settings,
        async save(settings) {
          savedTheme = settings.theme;
          return platformOk(settings);
        },
      },
    };
    await renderApp(service);

    const toggle = screen.getByRole('button', { name: /dark theme/i });
    await user.click(toggle);

    await waitFor(() => expect(savedTheme).toBe('dark'));
    expect(screen.getByRole('button', { name: /light theme/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('does not expose browser-download controls on desktop routes', async () => {
    const user = userEvent.setup();
    const base = publicationService(true);
    const profile = {
      id: 'desktop-profile',
      name: 'Synthetic desktop profile',
      version: 1,
      supplierMapping: {},
      supplierHeaders: ['Code'],
      servicem8Mapping: {},
      servicem8Headers: ['Item Number'],
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z',
    };
    const service: PlatformService = {
      ...base,
      kind: 'desktop',
      profiles: {
        ...base.profiles,
        async list() {
          return platformOk([profile]);
        },
      },
      recovery: {
        ...base.recovery,
        async previewReset() {
          return platformOk({
            resetToken: 'synthetic-reset-preview',
            confirmationPhrase: 'ERASE SWL LOCAL DATA',
            scope: ['Native SQLite operational and configuration records'],
            recordCounts: {
              catalogueItems: 0,
              approvals: 0,
              priceHistory: 0,
              competitorReferences: 0,
              sources: 0,
              profiles: 1,
              aliases: 0,
              settings: 1,
            },
          });
        },
      },
    };
    window.location.hash = '#/suppliers';
    await renderApp(service);

    await screen.findByRole('cell', { name: /synthetic desktop profile/i });
    expect(screen.queryByRole('button', { name: /export json/i })).not.toBeInTheDocument();
    expect(screen.getByText(/configuration transfer/i)).toBeInTheDocument();

    window.location.hash = '#/runs';
    window.dispatchEvent(new Event('hashchange'));
    await screen.findByRole('heading', { name: 'Runs', level: 1 });
    expect(
      screen.queryByRole('button', { name: /download run metadata/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/desktop run evidence/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /privacy and data handling/i }));
    await user.click(
      screen.getByRole('button', {
        name: /preview application data erasure/i,
      }),
    );
    expect(await screen.findByText(/legacy configuration in the same WebView/i)).toHaveTextContent(
      /preserved outside this reset scope/i,
    );
  });

  it('describes Static Pages as session-only and provider-free', async () => {
    const user = userEvent.setup();
    const base = publicationService(true);
    const session = createWebPlatformService(undefined, { sessionOnly: true });
    const service: PlatformService = {
      ...base,
      capabilities: session.capabilities,
      health: session.health,
      search: session.search,
    };
    window.location.hash = '#/dashboard';
    await renderApp(service);

    expect(screen.getByText(/session-only demo is empty/i)).toBeInTheDocument();
    expect(screen.getByText(/refreshing the page clears/i)).toBeInTheDocument();

    window.location.hash = '#/competitors';
    window.dispatchEvent(new Event('hashchange'));
    await screen.findByRole('heading', {
      name: 'Competitor search',
      level: 1,
    });
    expect(screen.queryByRole('button', { name: /search live prices/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('searchbox', { name: /product name/i })).not.toBeInTheDocument();
    expect(screen.getByText(/does not expose a live-provider query/i)).toBeInTheDocument();
    expect(screen.getByText(/manual competitor evidence remains available/i)).toBeInTheDocument();

    window.location.hash = '#/sources';
    window.dispatchEvent(new Event('hashchange'));
    await screen.findByRole('heading', { name: 'Source registry', level: 1 });
    expect(screen.getByText(/performs no live provider retrieval/i)).toBeInTheDocument();
    expect(screen.getByText(/bulk evidence-file import is not available/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /privacy and data handling/i }));
    expect(screen.getByText(/Static Pages has no Node server/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot make a provider request/i)).toBeInTheDocument();
  });

  it('does not expose an unpersisted business rule while a delayed settings save fails', async () => {
    const user = userEvent.setup();
    let finishSave!: (result: PlatformResult<Settings>) => void;
    let published: Parameters<PlatformService['catalogue']['publishApproved']>[0] = [];
    const base = publicationService(true, (changes) => (published = changes));
    const service: PlatformService = {
      ...base,
      settings: {
        ...base.settings,
        async save() {
          return new Promise<PlatformResult<Settings>>((resolve) => {
            finishSave = resolve;
          });
        },
      },
    };
    await renderApp(service);
    await user.click(screen.getByRole('button', { name: /^open settings$/i }));
    await user.click(
      screen.getByRole('radio', {
        name: /supplier costs include gst/i,
      }),
    );
    await user.click(screen.getByRole('button', { name: /apply changes/i }));
    await user.click(screen.getByRole('button', { name: /confirm and apply/i }));
    expect(screen.getByRole('button', { name: /saving verified settings/i })).toBeDisabled();

    finishSave(platformFail('integrity_failed', 'Synthetic settings write failed safely.'));
    expect(await screen.findAllByText(/synthetic settings write failed safely/i)).not.toHaveLength(
      0,
    );
    expect(screen.getByRole('button', { name: /confirm and apply/i })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: /^Back$/i }));
    await user.click(screen.getByRole('button', { name: /^Close$/i }));

    await user.click(screen.getByRole('button', { name: /load synthetic demonstration/i }));
    await screen.findByText('DEMO-fictionville-supplier-price-list.csv');
    await user.click(screen.getByRole('button', { name: /continue to column mapping/i }));
    await user.click(
      screen.getByRole('button', {
        name: /confirm mapping and run comparison/i,
      }),
    );
    await user.click(screen.getByRole('button', { name: /review proposed changes/i }));
    await user.click(screen.getByRole('button', { name: /^Price changed \(\d+\)$/ }));
    await user.click(screen.getAllByRole('button', { name: /^Approve$/ })[0]!);
    expect(published[0]?.item.gstBasis).toBe('unknown');
  }, 30_000);

  it('walks the synthetic demo from start to the review workspace', async () => {
    const user = userEvent.setup();
    await renderApp(publicationService(true));

    // Start screen: the rail carries the Stan Wootton Locksmiths lock-up.
    expect(screen.getByText('Stan Wootton')).toBeInTheDocument();
    expect(screen.getByText('Pricing & Inventory')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Stan Wootton Locksmiths' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getAllByText(/local processing only/i).length).toBeGreaterThan(0);

    // Load the demo.
    await user.click(screen.getByRole('button', { name: /load synthetic demonstration/i }));
    await waitFor(() => {
      expect(screen.getByText('DEMO-fictionville-supplier-price-list.csv')).toBeInTheDocument();
      expect(screen.getByText('DEMO-fictionville-servicem8-export.csv')).toBeInTheDocument();
    });
    expect(screen.getByText(/fictional demo data/i)).toBeInTheDocument();

    // Continue to mapping — suggestions should be pre-selected from headers.
    await user.click(screen.getByRole('button', { name: /continue to column mapping/i }));
    const codeSelect = screen.getByLabelText(/supplier item code/i);
    expect((codeSelect as HTMLSelectElement).value).toBe('0');

    // Run the comparison.
    await user.click(
      screen.getByRole('button', {
        name: /confirm mapping and run comparison/i,
      }),
    );
    await screen.findByRole('heading', {
      name: /validation and comparison results/i,
    });
    // Demo dataset: 16 supplier records, 10 ServiceM8 records.
    const pipeline = screen.getByRole('list', { name: /record counts/i });
    expect(within(pipeline).getByText('Supplier records').previousSibling).toHaveTextContent('16');
    expect(within(pipeline).getByText('ServiceM8 records').previousSibling).toHaveTextContent('10');

    // Review workspace.
    await user.click(screen.getByRole('button', { name: /review proposed changes/i }));
    await screen.findByRole('heading', { name: /review proposed changes/i });

    // Blocked rows expose no approve control; approvable rows do.
    await user.click(screen.getByRole('button', { name: /^Invalid \(\d+\)$/ }));
    expect(screen.queryAllByRole('button', { name: /^Approve$/ })).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /^Ambiguous \(\d+\)$/ }));
    expect(screen.queryAllByRole('button', { name: /^Approve$/ })).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /^Price changed \(\d+\)$/ }));
    const approveButtons = screen.getAllByRole('button', { name: /^Approve$/ });
    expect(approveButtons.length).toBeGreaterThan(0);

    // A published approval is durable and never becomes a session-only undo.
    await user.click(approveButtons[0]!);
    expect(screen.getAllByText('Approved').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /^Undo$/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Redo$/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /clear exclusion/i })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /^Approvals$/ }));
    expect(await screen.findByText(/recorded, append-only/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /withdraw approval/i })).not.toBeInTheDocument();
  }, 30_000);

  it('does not apply a web approval when atomic publication fails', async () => {
    const user = userEvent.setup();
    await renderApp(publicationService(false));
    await user.click(screen.getByRole('button', { name: /load synthetic demonstration/i }));
    await screen.findByText('DEMO-fictionville-supplier-price-list.csv');
    await user.click(screen.getByRole('button', { name: /continue to column mapping/i }));
    await user.click(
      screen.getByRole('button', {
        name: /confirm mapping and run comparison/i,
      }),
    );
    await screen.findByRole('heading', {
      name: /validation and comparison results/i,
    });
    await user.click(screen.getByRole('button', { name: /review proposed changes/i }));
    await user.click(screen.getByRole('button', { name: /^Price changed \(\d+\)$/ }));
    await user.click(screen.getAllByRole('button', { name: /^Approve$/ })[0]!);

    expect(
      await screen.findAllByText(/approval was not recorded: synthetic publication failed/i),
    ).not.toHaveLength(0);
    expect(screen.queryAllByText('Approved')).toHaveLength(0);
  }, 30_000);

  it('records the operator-selected GST basis without transforming prices', async () => {
    const user = userEvent.setup();
    let published: Parameters<PlatformService['catalogue']['publishApproved']>[0] = [];
    await renderApp(publicationService(true, (changes) => (published = changes)));

    await user.click(screen.getByRole('button', { name: /^open settings$/i }));
    await user.click(
      screen.getByRole('radio', {
        name: /supplier costs include gst/i,
      }),
    );
    await user.click(screen.getByRole('button', { name: /apply changes/i }));
    await user.click(screen.getByRole('button', { name: /confirm and apply/i }));

    await user.click(screen.getByRole('button', { name: /load synthetic demonstration/i }));
    await screen.findByText('DEMO-fictionville-supplier-price-list.csv');
    await user.click(screen.getByRole('button', { name: /continue to column mapping/i }));
    await user.click(
      screen.getByRole('button', {
        name: /confirm mapping and run comparison/i,
      }),
    );
    await screen.findByRole('heading', {
      name: /validation and comparison results/i,
    });
    await user.click(screen.getByRole('button', { name: /review proposed changes/i }));
    await user.click(screen.getByRole('button', { name: /^Price changed \(\d+\)$/ }));
    await user.click(screen.getAllByRole('button', { name: /^Approve$/ })[0]!);

    expect(published).toHaveLength(1);
    expect(published[0]?.item.gstBasis).toBe('inc-gst');
  }, 30_000);

  it('shows a specific rejection for unsupported files', async () => {
    const user = userEvent.setup({ applyAccept: false });
    await renderApp();
    await user.click(screen.getByRole('button', { name: /start new comparison/i }));
    const input = screen.getByLabelText(/supplier export file/i);
    const bad = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    await user.upload(input, bad);
    // The rejection appears both in the alert and the aria-live announcer.
    expect(await screen.findAllByText(/not a supported file type/i)).not.toHaveLength(0);
    expect(screen.getByRole('alert')).toHaveTextContent(/not a supported file type/i);
    expect(screen.getByText(/Only .csv and .xlsx files are accepted/i)).toBeInTheDocument();
  });

  it('keeps export gated until the checklist passes', async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole('button', { name: /load synthetic demonstration/i }));
    await screen.findByText('DEMO-fictionville-supplier-price-list.csv');
    await user.click(screen.getByRole('button', { name: /continue to column mapping/i }));
    await user.click(
      screen.getByRole('button', {
        name: /confirm mapping and run comparison/i,
      }),
    );
    await screen.findByRole('heading', {
      name: /validation and comparison results/i,
    });

    // Jump to checks with zero approvals: the approvals gate must fail.
    await user.click(screen.getByRole('button', { name: /pre-export checks/i }));
    await screen.findByRole('heading', { name: /release checklist/i });
    expect(screen.getByText(/Nothing is approved yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue to export/i })).toBeDisabled();
  }, 30_000);

  it('persists manual evidence as a typed reference for an exact catalogue item', async () => {
    const user = userEvent.setup();
    const base = publicationService(true);
    let attached: Parameters<PlatformService['references']['attach']>[1] | null = null;
    const service: PlatformService = {
      ...base,
      catalogue: {
        ...base.catalogue,
        async list() {
          return platformOk([
            {
              id: 'LW4570',
              itemNumber: 'LW4570',
              description: 'Synthetic Lockwood deadlatch',
              costCents: 10_000,
              sellPriceCents: 13_000,
              gstBasis: 'inc-gst',
              updatedAt: '2026-08-09T00:00:00.000Z',
            },
          ]);
        },
      },
      references: {
        ...base.references,
        async attach(itemId, observation) {
          attached = observation;
          return platformOk({
            id: 'reference-1',
            itemId,
            observation,
            attachedAt: '2026-08-09T00:00:00.000Z',
          });
        },
      },
    };
    await renderApp(service);

    await user.click(screen.getByRole('button', { name: /^Competitor search$/ }));
    await user.type(screen.getByRole('textbox', { name: /sku or product/i }), 'LW4570');
    await user.type(screen.getByRole('textbox', { name: /observed price/i }), '95.00');
    await user.click(screen.getByRole('button', { name: /store observation/i }));

    await waitFor(() => expect(attached).not.toBeNull());
    expect(attached).toMatchObject({
      sku: 'LW4570',
      price: '95.00',
      currency: 'AUD',
      sourceName: 'Manual operator entry',
      reviewState: 'accepted',
    });
    expect(screen.getAllByText(/reference price stored for LW4570/i).length).toBeGreaterThan(0);
  });

  it('does not offer attachment for an unchanged row that is absent from the approved catalogue', async () => {
    const user = userEvent.setup();
    const base = publicationService(true);
    const service: PlatformService = {
      ...base,
      catalogue: {
        ...base.catalogue,
        async list() {
          return platformOk([]);
        },
      },
    };
    await renderApp(service);

    await user.click(screen.getByRole('button', { name: /load synthetic demonstration/i }));
    await screen.findByText('DEMO-fictionville-supplier-price-list.csv');
    await user.click(screen.getByRole('button', { name: /continue to column mapping/i }));
    await user.click(
      screen.getByRole('button', {
        name: /confirm mapping and run comparison/i,
      }),
    );
    await screen.findByRole('heading', {
      name: /validation and comparison results/i,
    });

    await user.click(screen.getByRole('button', { name: /^Competitor search$/ }));
    await user.type(
      screen.getByRole('textbox', {
        name: /catalogue item \(servicem8 item number, supplier code or sku\)/i,
      }),
      'FIC-001',
    );
    expect(
      await screen.findByText(/no approved catalogue item matches FIC-001/i),
    ).toBeInTheDocument();
  }, 30_000);

  it('forwards the operator-entered provider budget through the page adapter boundary', async () => {
    const user = userEvent.setup();
    const base = publicationService(true);
    const initialStatus = {
      provider: 'native-provider',
      state: 'configured' as const,
      paidCallsEnabled: false,
      costCeilingAud: '0.00',
      costCeilingCents: 0,
      costPerCallCents: 0,
      spentCents: 0,
      credentialConfigured: true,
      credentialHint: 'stored',
      lastValidatedAt: '2026-08-09T00:00:00.000Z',
    };
    let enabledArguments: [boolean, number | undefined, number | undefined] | null = null;
    const service: PlatformService = {
      ...base,
      capabilities: { ...base.capabilities, protectedCredentials: true },
      async health() {
        return platformOk({
          ok: true,
          provider: 'native-provider',
          liveSearchConfigured: true,
          fixtureMode: false,
        });
      },
      catalogue: {
        ...base.catalogue,
        async list() {
          return platformOk([]);
        },
      },
      search: {
        ...base.search,
        async status() {
          return platformOk(initialStatus);
        },
        async setPaidCallsEnabled(enabled, ceiling, perCall) {
          enabledArguments = [enabled, ceiling, perCall];
          return platformOk({
            ...initialStatus,
            paidCallsEnabled: enabled,
            costCeilingAud: enabled ? '10.00' : '0.00',
            costCeilingCents: enabled ? (ceiling ?? 0) : 0,
            costPerCallCents: enabled ? (perCall ?? 0) : 0,
          });
        },
      },
    };
    await renderApp(service);

    await user.click(screen.getByRole('button', { name: /^Competitor search$/ }));
    await user.type(screen.getByRole('textbox', { name: /total provider budget/i }), '10.00');
    await user.type(screen.getByRole('textbox', { name: /reserved cost per call/i }), '0.05');
    await user.click(
      screen.getByRole('button', {
        name: /enable paid provider calls within budget/i,
      }),
    );
    await waitFor(() => expect(enabledArguments).toEqual([true, 1_000, 5]));
  });

  it('opens and closes the compact navigation with focus return', async () => {
    const user = userEvent.setup();
    await renderApp();
    const menu = screen.getByRole('button', { name: 'Menu' });

    await user.click(menu);
    expect(menu).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Application navigation')).toHaveClass('nav-open');

    await user.keyboard('{Escape}');
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    expect(menu).toHaveFocus();
  });
});
