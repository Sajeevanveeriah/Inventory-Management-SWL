import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import App from '../src/App';
import { AppStateProvider } from '../src/state/store';

function renderApp() {
  return render(
    <StrictMode>
      <AppStateProvider>
        <App />
      </AppStateProvider>
    </StrictMode>,
  );
}

describe('application workflow (jsdom integration)', () => {
  it('walks the synthetic demo from start to the review workspace', async () => {
    const user = userEvent.setup();
    renderApp();

    // Start screen.
    expect(screen.getByText('SWL Pricing and Inventory Control')).toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: /confirm mapping and run comparison/i }));
    await screen.findByRole('heading', { name: /validation and comparison results/i });
    // Demo dataset: 13 supplier records, 8 ServiceM8 records.
    const pipeline = screen.getByRole('list', { name: /record counts/i });
    expect(within(pipeline).getByText('Supplier records').previousSibling).toHaveTextContent('13');
    expect(within(pipeline).getByText('ServiceM8 records').previousSibling).toHaveTextContent('8');

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

    // Approve one row and see the decision badge and undo enable.
    await user.click(approveButtons[0]!);
    expect(screen.getAllByText('Approved').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /^Undo$/ })).toBeEnabled();

    // Undo removes it again.
    await user.click(screen.getByRole('button', { name: /^Undo$/ }));
    expect(screen.getByRole('button', { name: /^Redo$/ })).toBeEnabled();
  }, 30_000);

  it('shows a specific rejection for unsupported files', async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderApp();
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
    renderApp();
    await user.click(screen.getByRole('button', { name: /load synthetic demonstration/i }));
    await screen.findByText('DEMO-fictionville-supplier-price-list.csv');
    await user.click(screen.getByRole('button', { name: /continue to column mapping/i }));
    await user.click(screen.getByRole('button', { name: /confirm mapping and run comparison/i }));
    await screen.findByRole('heading', { name: /validation and comparison results/i });

    // Jump to checks with zero approvals: the approvals gate must fail.
    await user.click(screen.getByRole('button', { name: /pre-export checks/i }));
    await screen.findByRole('heading', { name: /release checklist/i });
    expect(screen.getByText(/Nothing is approved yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue to export/i })).toBeDisabled();
  }, 30_000);

  it('opens and closes the compact navigation with focus return', async () => {
    const user = userEvent.setup();
    renderApp();
    const menu = screen.getByRole('button', { name: 'Menu' });

    await user.click(menu);
    expect(menu).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Application navigation')).toHaveClass('nav-open');

    await user.keyboard('{Escape}');
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    expect(menu).toHaveFocus();
  });
});
