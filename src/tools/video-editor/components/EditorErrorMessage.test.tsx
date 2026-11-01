import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EditorErrorMessage, parseEditorError } from './EditorErrorMessage';

const clipboard = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('@/shared/lib/browser/clipboard.ts', () => ({ writeClipboardTextSafe: clipboard.write }));

describe('EditorErrorMessage', () => {
  it('shows labeled headline, collapses long detail, and copies a fix command', async () => {
    clipboard.write.mockResolvedValue(true);
    render(<EditorErrorMessage message={"Headline: Remotion isn't installed on this machine\nDetail: " + 'ffmpeg refused the hold clip. '.repeat(15) + '\nFix: Run `cd /tmp/project && npm ci`'} />);
    expect(screen.getByText("Remotion isn't installed on this machine")).toBeTruthy();
    expect(screen.getByText('Technical details')).toBeTruthy();
    expect(screen.getByText(/ffmpeg refused/).closest('details')?.open).toBe(false);
    expect(screen.getByText('Fix: Run')).toBeTruthy();
    const copy = screen.getByRole('button', { name: 'Copy command' });
    await act(async () => { fireEvent.click(copy); });
    expect(clipboard.write).toHaveBeenCalledWith('cd /tmp/project && npm ci');
  });

  it('uses the first sentence as the legacy headline and carries Next into the fix', () => {
    const message = 'Render failed. The encoder exited with code 2.\nNext: Restart the encoder.';
    expect(parseEditorError(message)).toEqual({
      headline: 'Render failed.', detail: 'The encoder exited with code 2.', fix: 'Restart the encoder.',
    });
    render(<EditorErrorMessage message={message} />);
    expect(screen.getByText('Render failed.').className).toContain('font-medium');
    expect(screen.getByText('The encoder exited with code 2.')).toBeTruthy();
    expect(screen.getByText('Fix: Restart the encoder.')).toBeTruthy();
  });
});
