/**
 * RemoteControlChip — connect a session to claude.ai/code and the mobile app
 * (GH #1480).
 *
 * The bridge itself lives in the provider and outlives a turn, so this chip is
 * a control, not a status readout: toggling it starts or stops the bridge, and
 * once it is up the pairing URL is one click away.
 *
 * Pull on mount, push for transitions, same shape as the MCP status chip. The
 * pull matters because no push listener exists until a message has been sent.
 */

import { useCallback, useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { sessionStoreAtom } from '../../store/atoms/sessions';

/** Mirrors RemoteControlSnapshot in the main process. */
interface RemoteControlSnapshot {
  sessionId: string;
  supported: boolean;
  active: boolean;
  connected: boolean;
  sessionUrl: string | null;
}

interface RemoteControlChipProps {
  sessionId: string;
  provider: string;
}

export function RemoteControlChip({ sessionId, provider }: RemoteControlChipProps) {
  const [status, setStatus] = useState<RemoteControlSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const api = (window as any).electronAPI;
    if (!api?.aiGetRemoteControl) return;
    try {
      const next: RemoteControlSnapshot = await api.aiGetRemoteControl(sessionId, provider);
      if (next?.sessionId) setStatus(next);
    } catch {
      // A pull failure leaves the last known state in place rather than
      // blanking a control the user may be mid-way through using.
    }
  }, [sessionId, provider]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live transitions: the bridge dropping on its own, and the session becoming
  // bridgeable in the first place.
  //
  // A push only ever originates from a live provider, so it is authoritative
  // about `supported` and `active` too and replaces the state rather than
  // merging into it. Merging stranded the case this chip is usually in: mounted
  // before the session's first turn, so the pull reported `active: false` and
  // left `status` null -- nothing to merge into, and no second pull coming.
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.onRemoteControlChanged) return;
    return api.onRemoteControlChanged((data: Partial<RemoteControlSnapshot>) => {
      if (data?.sessionId !== sessionId) return;
      setStatus((prev) => ({
        sessionId,
        supported: data.supported ?? prev?.supported ?? true,
        active: data.active ?? prev?.active ?? true,
        connected: Boolean(data.connected),
        sessionUrl: data.sessionUrl ?? null,
      }));
    });
  }, [sessionId]);

  const toggle = useCallback(async () => {
    const api = (window as any).electronAPI;
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next: RemoteControlSnapshot = status?.connected
        ? await api.aiDisableRemoteControl(sessionId, provider)
        : await api.aiEnableRemoteControl(sessionId, provider);
      if (next?.sessionId) setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [busy, status?.connected, sessionId, provider]);

  const openSession = useCallback(() => {
    const api = (window as any).electronAPI;
    if (status?.sessionUrl && api?.openExternal) void api.openExternal(status.sessionUrl);
  }, [status?.sessionUrl]);

  // Hidden, not disabled, for providers that can never bridge: a dead toggle on
  // a Codex session would suggest the feature is merely broken there.
  if (!status?.supported) return null;
  // A session that has not run a turn has no subprocess to bridge yet.
  if (!status.active) return null;

  const connected = status.connected;
  const chipClass = error
    ? 'border-red-500/45 bg-red-500/10 text-red-500'
    : connected
      ? 'border-green-500/45 bg-green-500/10 text-green-600'
      : 'border-[var(--nim-border)] text-[var(--nim-text-muted)]';

  return (
    <span
      className="remote-control-chip shrink-0 inline-flex items-center gap-1"
      data-component="RemoteControlChip"
    >
      <button
        onClick={() => void toggle()}
        disabled={busy}
        className={`remote-control-chip-button shrink-0 inline-flex items-center gap-1.5 h-6 px-2 rounded-full border text-[0.6875rem] font-medium bg-transparent cursor-pointer transition-colors duration-150 hover:bg-[var(--nim-bg-hover)] disabled:opacity-60 disabled:cursor-default ${chipClass}`}
        title={
          error
            ? `Remote Control failed: ${error}`
            : connected
              ? 'Connected. Click to stop driving this session from your phone or browser.'
              : 'Drive this session from claude.ai/code or the Claude mobile app'
        }
        data-testid="remote-control-chip-button"
      >
        <span
          className={`remote-control-chip-dot w-1.5 h-1.5 rounded-full ${
            error ? 'bg-red-500' : connected ? 'bg-green-500' : 'bg-[var(--nim-text-muted)]'
          }`}
        />
        {busy ? 'Remote…' : connected ? 'Remote on' : 'Remote'}
      </button>

      {connected && status.sessionUrl && (
        <button
          onClick={openSession}
          className="remote-control-chip-open shrink-0 inline-flex items-center h-6 px-1.5 rounded-full border border-[var(--nim-border)] text-[0.6875rem] text-[var(--nim-text-muted)] bg-transparent cursor-pointer transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
          title="Open this session on claude.ai"
          data-testid="remote-control-chip-open"
        >
          ↗
        </button>
      )}
    </span>
  );
}

export function ActiveSessionRemoteControlChip({ sessionId }: { sessionId: string }) {
  const session = useAtomValue(sessionStoreAtom(sessionId));
  const provider = session?.provider;
  if (!provider) return null;
  return <RemoteControlChip sessionId={sessionId} provider={provider} />;
}
