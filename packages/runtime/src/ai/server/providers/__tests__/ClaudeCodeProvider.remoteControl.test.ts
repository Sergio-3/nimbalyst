/**
 * Remote Control plumbing on ClaudeCodeProvider (GH #1480).
 *
 * The bridge has to outlive a turn, so these tests pin the two things that
 * make that true: the methods read `sessionQuery` (persistent) and never
 * `leadQuery` (nulled after each turn), and a response without a
 * `bridge_session_id` is not reported as a live bridge.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => ({
  app: { ...(await import('../../../../../../electron/test-stubs/privateUserData')).testApp, isPackaged: false },
}));

vi.mock('../claudeCode/cliPathResolver', () => ({
  resolveClaudeAgentCliPath: async () => '/fake/claude',
}));

vi.mock('../../../../electron/claudeCodeEnvironment', () => ({
  setupClaudeCodeEnvironment: () => ({}),
  resolveNativeBinaryPath: () => undefined,
}));

import { ClaudeCodeProvider, type RemoteControlInfo } from '../ClaudeCodeProvider';

type ProviderInternals = {
  sessionQuery: { enableRemoteControl: (...args: unknown[]) => Promise<RemoteControlInfo> } | null;
  leadQuery: unknown;
  currentSessionId: string | undefined;
};

function internals(provider: ClaudeCodeProvider): ProviderInternals {
  return provider as unknown as ProviderInternals;
}

const LIVE: RemoteControlInfo = {
  session_url: 'https://claude.ai/code/session_test',
  connect_url: 'https://claude.ai/code?environment=',
  bridge_epoch: 1,
  bridge_session_id: 'cse_test',
};

/** Install a fake persistent query returning a scripted bridge response. */
function stubQuery(provider: ClaudeCodeProvider, response: RemoteControlInfo = LIVE) {
  const enableRemoteControl = vi.fn(async () => response);
  internals(provider).sessionQuery = { enableRemoteControl };
  internals(provider).currentSessionId = 'session-1';
  return enableRemoteControl;
}

describe('ClaudeCodeProvider Remote Control', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses to start without an active session', async () => {
    const provider = new ClaudeCodeProvider();
    await expect(provider.enableRemoteControl()).rejects.toThrow(/No active session/);
    expect(provider.getRemoteControlInfo()).toBeNull();
  });

  it('refuses to start when the bundled SDK has no Remote Control', async () => {
    const provider = new ClaudeCodeProvider();
    internals(provider).sessionQuery = {} as ProviderInternals['sessionQuery'];
    await expect(provider.enableRemoteControl()).rejects.toThrow(/does not expose Remote Control/);
  });

  it('starts the bridge, keeps the info and emits it', async () => {
    const provider = new ClaudeCodeProvider();
    const spy = stubQuery(provider);
    const events: unknown[] = [];
    provider.on('remoteControl:changed', (payload) => events.push(payload));

    const info = await provider.enableRemoteControl('my-laptop');

    expect(spy).toHaveBeenCalledWith(true, 'my-laptop');
    expect(info).toEqual(LIVE);
    expect(provider.getRemoteControlInfo()).toEqual(LIVE);
    expect(events).toEqual([{ sessionId: 'session-1', remoteControl: LIVE }]);
  });

  it('does not report a bridge that never came up', async () => {
    const provider = new ClaudeCodeProvider();
    stubQuery(provider, { session_url: 'https://claude.ai/code/session_test' });

    await provider.enableRemoteControl();

    expect(provider.getRemoteControlInfo()).toBeNull();
  });

  it('reads sessionQuery, not the per-turn leadQuery', async () => {
    const provider = new ClaudeCodeProvider();
    const spy = stubQuery(provider);
    // leadQuery is nulled between turns; the bridge must survive that.
    internals(provider).leadQuery = null;

    await expect(provider.enableRemoteControl()).resolves.toEqual(LIVE);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('stops the bridge and clears the state', async () => {
    const provider = new ClaudeCodeProvider();
    const spy = stubQuery(provider);
    await provider.enableRemoteControl('my-laptop');

    const events: unknown[] = [];
    provider.on('remoteControl:changed', (payload) => events.push(payload));
    await provider.disableRemoteControl();

    expect(spy).toHaveBeenLastCalledWith(false);
    expect(provider.getRemoteControlInfo()).toBeNull();
    expect(events).toEqual([{ sessionId: 'session-1', remoteControl: null }]);
  });

  it('clears the state even when the SDK call fails', async () => {
    const provider = new ClaudeCodeProvider();
    const provider2 = internals(provider);
    provider2.sessionQuery = { enableRemoteControl: vi.fn(async () => { throw new Error('boom'); }) };
    provider2.currentSessionId = 'session-1';

    await expect(provider.disableRemoteControl()).rejects.toThrow('boom');
    expect(provider.getRemoteControlInfo()).toBeNull();
  });

  it('is a no-op when stopping an already-stopped bridge', async () => {
    const provider = new ClaudeCodeProvider();
    await expect(provider.disableRemoteControl()).resolves.toBeUndefined();
    expect(provider.getRemoteControlInfo()).toBeNull();
  });
});
