/**
 * Per-session Remote Control IPC (GH #1480).
 *
 * The pull-and-command half of the surface. `ClaudeCodeProvider` owns the
 * bridge; this exposes it to the renderer so a session can be connected to
 * claude.ai/code and the mobile app, and so the UI can render its state.
 *
 * The push half (live transitions) lives in MessageStreamingHandler, which is
 * where provider event listeners are installed. Both are needed: the push
 * covers transitions, the pull covers first render, since no listener exists
 * until a message has been sent.
 *
 * Enabling requires a live session: the bridge is bound to the SDK subprocess,
 * so a provider that has not run a turn yet has nothing to bridge. That reads
 * as `active: false`, not as an error.
 */

import { ProviderFactory } from '@nimbalyst/runtime/ai/server';
import type { AIProviderType } from '@nimbalyst/runtime/ai/server/types';
import { safeHandle } from '../utils/ipcRegistry';

/**
 * Providers that can bridge a session to Remote Control.
 *
 * Only the Agent SDK path qualifies. Codex has no equivalent, and the
 * subscription CLI provider drives a real terminal session that connects
 * itself.
 */
const REMOTE_CONTROL_PROVIDERS: ReadonlySet<string> = new Set(['claude-code']);

/** Structural view of the provider methods this module needs. */
interface RemoteControlCapableProvider {
  enableRemoteControl(name?: string): Promise<{ session_url?: string; bridge_session_id?: string } | null>;
  disableRemoteControl(): Promise<void>;
  getRemoteControlInfo(): { session_url?: string; bridge_session_id?: string } | null;
}

/** What the renderer gets. Deliberately flat: no SDK shapes cross the wire. */
export interface RemoteControlSnapshot {
  sessionId: string;
  /** The provider can bridge at all. */
  supported: boolean;
  /** A live provider exists for this session, so enabling is possible. */
  active: boolean;
  /** The bridge is up. */
  connected: boolean;
  /** claude.ai URL of the bridged session, for pairing. Null when off. */
  sessionUrl: string | null;
}

function isCapable(provider: unknown): provider is RemoteControlCapableProvider {
  return typeof (provider as RemoteControlCapableProvider)?.enableRemoteControl === 'function';
}

function offline(sessionId: string, supported: boolean, active = false): RemoteControlSnapshot {
  return { sessionId, supported, active, connected: false, sessionUrl: null };
}

/**
 * Resolve the provider for a session, or null when there is nothing to bridge.
 * Cache lookup only: never creates a provider.
 */
function capableProvider(sessionId: string, provider: string): RemoteControlCapableProvider | null {
  if (!REMOTE_CONTROL_PROVIDERS.has(provider)) return null;
  const instance = ProviderFactory.getProvider(provider as AIProviderType, sessionId);
  return isCapable(instance) ? instance : null;
}

/**
 * Build the renderer payload for a session. Exported for the push path and for
 * tests; both must produce identical snapshots.
 */
export function getRemoteControlSnapshot(sessionId: string, provider: string): RemoteControlSnapshot {
  const supported = REMOTE_CONTROL_PROVIDERS.has(provider);
  if (!supported) return offline(sessionId, false);

  const instance = capableProvider(sessionId, provider);
  if (!instance) return offline(sessionId, true);

  const info = instance.getRemoteControlInfo();
  return {
    sessionId,
    supported: true,
    active: true,
    connected: Boolean(info?.bridge_session_id),
    sessionUrl: info?.session_url ?? null,
  };
}

function requireArgs(channel: string, payload: { sessionId?: string; provider?: string }) {
  if (!payload?.sessionId) throw new Error(`${channel} requires sessionId`);
  if (!payload?.provider) throw new Error(`${channel} requires provider`);
  return { sessionId: payload.sessionId, provider: payload.provider };
}

export function registerRemoteControlHandlers(): void {
  safeHandle(
    'ai:remote-control:get',
    async (_event, payload: { sessionId?: string; provider?: string }) => {
      const { sessionId, provider } = requireArgs('ai:remote-control:get', payload);
      return getRemoteControlSnapshot(sessionId, provider);
    },
  );

  safeHandle(
    'ai:remote-control:enable',
    async (_event, payload: { sessionId?: string; provider?: string; name?: string }) => {
      const { sessionId, provider } = requireArgs('ai:remote-control:enable', payload);
      const instance = capableProvider(sessionId, provider);
      if (!instance) {
        throw new Error('Remote Control is not available for this session');
      }
      await instance.enableRemoteControl(payload?.name);
      return getRemoteControlSnapshot(sessionId, provider);
    },
  );

  safeHandle(
    'ai:remote-control:disable',
    async (_event, payload: { sessionId?: string; provider?: string }) => {
      const { sessionId, provider } = requireArgs('ai:remote-control:disable', payload);
      const instance = capableProvider(sessionId, provider);
      // Nothing to stop is a success: the caller wanted it off, and it is.
      if (instance) await instance.disableRemoteControl();
      return getRemoteControlSnapshot(sessionId, provider);
    },
  );
}
