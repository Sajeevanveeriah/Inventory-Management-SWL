import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { APP_VERSION } from '../../core/audit';
import { createDesktopPlatformService, type InvokeFunction } from '../../platform/desktop';
import type { BackupSummary } from '../../platform/contracts';
import { RecoveryPanel } from './ConfigPages';

const backup: BackupSummary = {
  id: 'backup-1',
  filename: '20260809-SWL-Backup.db',
  createdAt: '2026-08-09T01:02:03.000Z',
  applicationVersion: APP_VERSION,
  schemaVersion: 1,
  sha256: 'a'.repeat(64),
  recordCounts: {
    catalogueItems: 2,
    approvals: 1,
    priceHistory: 1,
    competitorReferences: 0,
    sources: 5,
    profiles: 1,
    aliases: 1,
    settings: 1,
  },
};

describe('backup and recovery UI', () => {
  it('lists and creates a manual verified backup', async () => {
    const user = userEvent.setup();
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke: InvokeFunction = async <T,>(command: string, args?: Record<string, unknown>) => {
      calls.push(args ? { command, args } : { command });
      if (command === 'list_backups') return [] as T;
      if (command === 'create_backup') return backup as T;
      return undefined as T;
    };

    render(
      <RecoveryPanel
        platform={createDesktopPlatformService(invoke)}
        announce={vi.fn()}
        afterRestore={vi.fn(async () => true)}
      />,
    );
    expect(await screen.findByText(/no verified backup is available/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /create verified backup/i }));

    expect(
      await screen.findByRole('option', { name: /20260809-SWL-Backup\.db/i }),
    ).toBeInTheDocument();
    expect(calls).toContainEqual({
      command: 'create_backup',
      args: { reason: 'manual' },
    });
  });

  it('requires a verified preview and separate acknowledgement before restoring', async () => {
    const user = userEvent.setup();
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const afterRestore = vi.fn(async () => true);
    const announce = vi.fn();
    const invoke: InvokeFunction = async <T,>(command: string, args?: Record<string, unknown>) => {
      calls.push(args ? { command, args } : { command });
      if (command === 'list_backups') return [backup] as T;
      if (command === 'preview_restore') {
        return { ...backup, previewToken: 'preview-1', integrityOk: true } as T;
      }
      if (command === 'restore_backup') return backup as T;
      return undefined as T;
    };

    render(
      <RecoveryPanel
        platform={createDesktopPlatformService(invoke)}
        announce={announce}
        afterRestore={afterRestore}
      />,
    );
    await screen.findByRole('option', { name: /20260809-SWL-Backup\.db/i });
    expect(calls.some((call) => call.command === 'restore_backup')).toBe(false);

    await user.click(screen.getByRole('button', { name: /preview selected backup/i }));
    expect(await screen.findByText(/verified restore preview/i)).toBeInTheDocument();
    expect(calls).toContainEqual({
      command: 'preview_restore',
      args: { backupId: 'backup-1' },
    });
    const restore = screen.getByRole('button', {
      name: /restore selected backup/i,
    });
    expect(restore).toBeDisabled();
    expect(calls.some((call) => call.command === 'restore_backup')).toBe(false);

    await user.click(screen.getByRole('checkbox', { name: /restore replaces/i }));
    await user.click(restore);
    await waitFor(() => expect(afterRestore).toHaveBeenCalledOnce());
    expect(calls).toContainEqual({
      command: 'restore_backup',
      args: { previewToken: 'preview-1' },
    });
    expect(announce).toHaveBeenCalledWith('Backup restored and active workflow cleared.');
  });

  it('keeps the workflow blocked when post-restore configuration reload fails', async () => {
    const user = userEvent.setup();
    const announce = vi.fn();
    const invoke: InvokeFunction = async <T,>(command: string) => {
      if (command === 'list_backups') return [backup] as T;
      if (command === 'preview_restore') {
        return { ...backup, previewToken: 'preview-1', integrityOk: true } as T;
      }
      if (command === 'restore_backup') return backup as T;
      return undefined as T;
    };

    render(
      <RecoveryPanel
        platform={createDesktopPlatformService(invoke)}
        announce={announce}
        afterRestore={vi.fn(async () => false)}
      />,
    );
    await screen.findByRole('option', { name: /20260809-SWL-Backup\.db/i });
    await user.click(screen.getByRole('button', { name: /preview selected backup/i }));
    await user.click(screen.getByRole('checkbox', { name: /restore replaces/i }));
    await user.click(screen.getByRole('button', { name: /restore selected backup/i }));

    expect(await screen.findByText(/workflow remains blocked/i)).toBeInTheDocument();
    expect(announce).toHaveBeenCalledWith(
      expect.stringMatching(/reload failed.*workflow remains blocked/i),
    );
    expect(announce).not.toHaveBeenCalledWith('Backup restored and active workflow cleared.');
  });
});
