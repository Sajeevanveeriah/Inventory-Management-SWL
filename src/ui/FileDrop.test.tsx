import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FileDrop } from './FileDrop';

describe('native file selection boundary', () => {
  it('uses the native picker and does not expose browser file input or drop ingestion', async () => {
    const user = userEvent.setup();
    const onChooseFile = vi.fn();
    const onFile = vi.fn();
    const { container } = render(
      <FileDrop
        role="supplier"
        label="Supplier export"
        hint="Synthetic input"
        slot={{ table: null, error: null, loading: false }}
        nativePicker
        onChooseFile={onChooseFile}
        onFile={onFile}
        onSheetChange={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    expect(container.querySelector('input[type="file"]')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Choose file' }));
    expect(onChooseFile).toHaveBeenCalledOnce();

    const dropzone = screen.getByText(/native windows picker/i).closest('.dropzone');
    expect(dropzone).not.toBeNull();
    if (dropzone === null) return;
    fireEvent.drop(dropzone, {
      dataTransfer: {
        files: [new File(['synthetic'], 'ignored.csv', { type: 'text/csv' })],
      },
    });
    expect(onFile).not.toHaveBeenCalled();
  });
});
