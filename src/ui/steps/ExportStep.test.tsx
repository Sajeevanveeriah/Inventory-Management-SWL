import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { GeneratedOutput } from '../../io/exportWorkbooks';
import { PlatformProvider } from '../../platform/context';
import { createDesktopPlatformService, type InvokeFunction } from '../../platform/desktop';
import { DesktopFolderPanel, GeneratedFilesPanel } from './ExportStep';

const output: GeneratedOutput = {
  filename: '20260809-Synthetic-Import.xlsx',
  kind: 'import',
  label: 'Synthetic candidate import',
  blob: new Blob([new Uint8Array([1, 2, 3])]),
  sanitizedCells: 0,
};

const allOutputs: GeneratedOutput[] = [
  output,
  ...(['Change-Report', 'Exceptions', 'Rollback', 'Audit-Summary'] as const).map(
    (name, index): GeneratedOutput => ({
      ...output,
      filename: `20260809-Synthetic-${name}.${index === 3 ? 'txt' : 'xlsx'}`,
      kind: index === 3 ? 'audit' : 'change-report',
    }),
  ),
];

describe('desktop export presentation', () => {
  it('does not expose browser download controls in the desktop application', () => {
    const { rerender } = render(<GeneratedFilesPanel outputs={[output]} platformKind="desktop" />);
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
    expect(screen.getByText(/native folder picker/i)).toBeInTheDocument();

    rerender(<GeneratedFilesPanel outputs={[output]} platformKind="web" />);
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
  });

  it('defaults a same-file conflict to cancel and offers another folder without overwrite', async () => {
    const user = userEvent.setup();
    const announce = vi.fn();
    const invoke: InvokeFunction = async function invokeCommand<T>(command: string) {
      if (command === 'choose_output_destination') {
        return {
          grantId: 'grant-1',
          displayName: 'Synthetic output folder',
        } as T;
      }
      if (command === 'reserve_export_batch') {
        throw Object.assign(new Error('An output with this name already exists.'), {
          code: 'conflict',
          retryable: false,
        });
      }
      return undefined as T;
    };

    render(
      <PlatformProvider service={createDesktopPlatformService(invoke)}>
        <DesktopFolderPanel outputs={allOutputs} announce={announce} />
      </PlatformProvider>,
    );
    await user.click(screen.getByRole('button', { name: /choose output folder/i }));
    await user.click(screen.getByRole('button', { name: /write all files/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /existing files were not overwritten/i,
    );
    expect(screen.queryByRole('button', { name: /overwrite/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /choose another folder/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /cancel export/i }));
    expect(announce).toHaveBeenCalledWith('Export cancelled. Existing files were not changed.');
  });
});
