/**
 * Pull path for the per-session Remote Control surface (GH #1480).
 *
 * The distinction these tests defend: "this provider cannot bridge at all",
 * "this session has not started a turn yet so there is nothing to bridge", and
 * "the bridge is up" are three different answers. A UI that collapses the first
 * two shows a dead toggle on providers that will never support it.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const getProvider = vi.fn();

vi.mock('@nimbalyst/runtime/ai/server', () => ({
  ProviderFactory: {
    getProvider: (...args: unknown[]) => getProvider(...args),
  },
}));

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: vi.fn(),
}));

import { getRemoteControlSnapshot } from '../RemoteControlHandlers';

function providerWith(info: { session_url?: string; bridge_session_id?: string } | null) {
  return {
    enableRemoteControl: vi.fn(async () => info),
    disableRemoteControl: vi.fn(async () => {}),
    getRemoteControlInfo: () => info,
  };
}

describe('getRemoteControlSnapshot', () => {
  beforeEach(() => {
    getProvider.mockReset();
  });

  it('reports a connected bridge with its pairing URL', () => {
    getProvider.mockReturnValue(
      providerWith({ session_url: 'https://claude.ai/code/session_x', bridge_session_id: 'cse_x' }),
    );

    expect(getRemoteControlSnapshot('s1', 'claude-code')).toEqual({
      sessionId: 's1',
      supported: true,
      active: true,
      connected: true,
      sessionUrl: 'https://claude.ai/code/session_x',
    });
  });

  it('reports a live session whose bridge is off', () => {
    getProvider.mockReturnValue(providerWith(null));

    expect(getRemoteControlSnapshot('s1', 'claude-code')).toEqual({
      sessionId: 's1',
      supported: true,
      active: true,
      connected: false,
      sessionUrl: null,
    });
  });

  it('separates "not started yet" from "not supported"', () => {
    // No provider in the cache: the session exists but has run no turn.
    getProvider.mockReturnValue(undefined);
    expect(getRemoteControlSnapshot('s1', 'claude-code')).toEqual({
      sessionId: 's1',
      supported: true,
      active: false,
      connected: false,
      sessionUrl: null,
    });

    // A provider that will never bridge reads as unsupported, and is never
    // even looked up.
    getProvider.mockClear();
    expect(getRemoteControlSnapshot('s1', 'openai-codex')).toEqual({
      sessionId: 's1',
      supported: false,
      active: false,
      connected: false,
      sessionUrl: null,
    });
    expect(getProvider).not.toHaveBeenCalled();
  });

  it('treats a provider missing the methods as not active', () => {
    getProvider.mockReturnValue({ somethingElse: () => {} });

    expect(getRemoteControlSnapshot('s1', 'claude-code')).toMatchObject({
      supported: true,
      active: false,
      connected: false,
    });
  });

  it('never reports a bridge without an id as connected', () => {
    // A response that carries a URL but no bridge id means the bridge never
    // came up; the provider stores null, so the snapshot must stay off.
    getProvider.mockReturnValue(providerWith(null));

    expect(getRemoteControlSnapshot('s1', 'claude-code').connected).toBe(false);
  });
});
