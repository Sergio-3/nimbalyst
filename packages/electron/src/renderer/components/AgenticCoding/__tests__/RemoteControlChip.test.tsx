// @vitest-environment jsdom
/**
 * Session header control for Remote Control (GH #1480).
 *
 * The tests that matter are about not offering a control that cannot work:
 * hide on providers that can never bridge, hide before the session has a live
 * provider, and never claim "connected" from anything but a real bridge. The
 * rest covers the toggle round trip and the push path, which is what keeps the
 * chip honest when the bridge drops on its own.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteControlChip } from '../RemoteControlChip';

const SESSION_ID = 'session-1';

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION_ID,
    supported: true,
    active: true,
    connected: false,
    sessionUrl: null,
    ...overrides,
  };
}

let pushListener: ((data: unknown) => void) | null = null;

function installApi(api: Record<string, unknown>) {
  (window as any).electronAPI = {
    onRemoteControlChanged: (cb: (data: unknown) => void) => {
      pushListener = cb;
      return () => { pushListener = null; };
    },
    ...api,
  };
}

afterEach(() => {
  cleanup();
  pushListener = null;
  delete (window as any).electronAPI;
  vi.restoreAllMocks();
});

beforeEach(() => {
  pushListener = null;
});

describe('RemoteControlChip', () => {
  it('stays hidden for a provider that cannot bridge', async () => {
    installApi({ aiGetRemoteControl: vi.fn(async () => snapshot({ supported: false, active: false })) });
    render(<RemoteControlChip sessionId={SESSION_ID} provider="openai-codex" />);
    await waitFor(() => expect((window as any).electronAPI.aiGetRemoteControl).toHaveBeenCalled());
    expect(screen.queryByTestId('remote-control-chip-button')).toBeNull();
  });

  it('stays hidden until the session has a live provider', async () => {
    installApi({ aiGetRemoteControl: vi.fn(async () => snapshot({ active: false })) });
    render(<RemoteControlChip sessionId={SESSION_ID} provider="claude-code" />);
    await waitFor(() => expect((window as any).electronAPI.aiGetRemoteControl).toHaveBeenCalled());
    expect(screen.queryByTestId('remote-control-chip-button')).toBeNull();
  });

  it('offers the control on a live session and connects on click', async () => {
    const enable = vi.fn(async () =>
      snapshot({ connected: true, sessionUrl: 'https://claude.ai/code/session_x' }),
    );
    installApi({ aiGetRemoteControl: vi.fn(async () => snapshot()), aiEnableRemoteControl: enable });

    render(<RemoteControlChip sessionId={SESSION_ID} provider="claude-code" />);
    const chip = await screen.findByTestId('remote-control-chip-button');
    expect(chip.textContent).toContain('Remote');
    expect(screen.queryByTestId('remote-control-chip-open')).toBeNull();

    await act(async () => { fireEvent.click(chip); });

    expect(enable).toHaveBeenCalledWith(SESSION_ID, 'claude-code');
    await waitFor(() => expect(screen.getByTestId('remote-control-chip-button').textContent).toContain('Remote on'));
    expect(screen.getByTestId('remote-control-chip-open')).toBeTruthy();
  });

  it('opens the pairing URL rather than inventing one', async () => {
    const openExternal = vi.fn();
    installApi({
      aiGetRemoteControl: vi.fn(async () =>
        snapshot({ connected: true, sessionUrl: 'https://claude.ai/code/session_x' }),
      ),
      openExternal,
    });

    render(<RemoteControlChip sessionId={SESSION_ID} provider="claude-code" />);
    const open = await screen.findByTestId('remote-control-chip-open');
    fireEvent.click(open);

    expect(openExternal).toHaveBeenCalledWith('https://claude.ai/code/session_x');
  });

  it('disconnects on a second click', async () => {
    const disable = vi.fn(async () => snapshot({ connected: false, sessionUrl: null }));
    installApi({
      aiGetRemoteControl: vi.fn(async () =>
        snapshot({ connected: true, sessionUrl: 'https://claude.ai/code/session_x' }),
      ),
      aiDisableRemoteControl: disable,
    });

    render(<RemoteControlChip sessionId={SESSION_ID} provider="claude-code" />);
    const chip = await screen.findByTestId('remote-control-chip-button');
    await act(async () => { fireEvent.click(chip); });

    expect(disable).toHaveBeenCalledWith(SESSION_ID, 'claude-code');
    await waitFor(() => expect(screen.getByTestId('remote-control-chip-button').textContent).toContain('Remote'));
    expect(screen.queryByTestId('remote-control-chip-open')).toBeNull();
  });

  it('follows a bridge that drops on its own', async () => {
    installApi({
      aiGetRemoteControl: vi.fn(async () =>
        snapshot({ connected: true, sessionUrl: 'https://claude.ai/code/session_x' }),
      ),
    });

    render(<RemoteControlChip sessionId={SESSION_ID} provider="claude-code" />);
    await screen.findByTestId('remote-control-chip-open');

    await act(async () => {
      pushListener?.({ sessionId: SESSION_ID, connected: false, sessionUrl: null });
    });

    expect(screen.queryByTestId('remote-control-chip-open')).toBeNull();
  });

  it('ignores push events aimed at another session', async () => {
    installApi({
      aiGetRemoteControl: vi.fn(async () =>
        snapshot({ connected: true, sessionUrl: 'https://claude.ai/code/session_x' }),
      ),
    });

    render(<RemoteControlChip sessionId={SESSION_ID} provider="claude-code" />);
    await screen.findByTestId('remote-control-chip-open');

    await act(async () => {
      pushListener?.({ sessionId: 'someone-else', connected: false, sessionUrl: null });
    });

    expect(screen.getByTestId('remote-control-chip-open')).toBeTruthy();
  });

  it('surfaces a failure instead of silently staying off', async () => {
    installApi({
      aiGetRemoteControl: vi.fn(async () => snapshot()),
      aiEnableRemoteControl: vi.fn(async () => { throw new Error('no bridge for you'); }),
    });

    render(<RemoteControlChip sessionId={SESSION_ID} provider="claude-code" />);
    const chip = await screen.findByTestId('remote-control-chip-button');
    await act(async () => { fireEvent.click(chip); });

    await waitFor(() =>
      expect(screen.getByTestId('remote-control-chip-button').getAttribute('title')).toContain('no bridge for you'),
    );
  });
});
