// @vitest-environment node
/**
 * #1183: a permission request dropped without an answer is closed as expired
 * in the transcript, and a late click on it is refused instead of persisting
 * an "allow" that nothing acts on.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as Array<{ sessionId: string; toolUseId: string; result: any; isError?: boolean }>,
  reservations: new Map<string, unknown>(),
  handlers: new Map<string, (...args: any[]) => any>(),
  provider: { resolveToolPermission: vi.fn() },
  created: vi.fn(async () => undefined),
}));

vi.mock('electron', () => ({ ipcMain: { listenerCount: () => 0, emit: vi.fn() } }));
vi.mock('../../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } }));
vi.mock('../../../utils/privateSettingsStore', () => ({
  default: class {
    get(key: string) { return h.reservations.get(key); }
    set(key: string, value: unknown) { h.reservations.set(key, value); }
  },
}));
vi.mock('../../../mcp/tools/interactivePromptTranscript', () => ({
  persistInteractivePromptToolResult: vi.fn(async (row: any) => { h.rows.push(row); }),
}));
vi.mock('../../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, fn: (...args: any[]) => any) => h.handlers.set(channel, fn),
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { get: vi.fn(async () => ({ provider: 'claude-code' })) },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({
  AgentMessagesRepository: { create: h.created },
}));
vi.mock('@nimbalyst/runtime/ai/server', () => ({ ProviderFactory: { getProvider: () => h.provider } }));
vi.mock('@nimbalyst/runtime/sync/pushOutcome', () => ({ warnIfUnpublished: vi.fn() }));
vi.mock('../ipc/registerAskUserQuestionAnswerHandler', () => ({ registerAskUserQuestionAnswerHandler: vi.fn() }));
vi.mock('../codexQuestionDelivery', () => ({ configureCodexQuestionDelivery: vi.fn(), deliverCodexQuestionAnswer: vi.fn() }));
vi.mock('../requestUserInputResumption', () => ({ configureRequestUserInputResumption: vi.fn() }));
vi.mock('../../../tray/TrayManager', () => ({ TrayManager: { getInstance: () => ({}) } }));
vi.mock('../../SyncManager', () => ({ getSyncProvider: () => null }));
vi.mock('../askUserQuestionFallbackResolution', () => ({ persistInteractivePromptTerminalResult: vi.fn() }));
vi.mock('../pendingPromptPersistence', () => ({ setSessionPendingPrompt: vi.fn() }));

import { closeExpiredToolPermission } from '../expiredToolPermission';
import { registerInteractivePromptHandlers } from '../ipc/registerInteractivePromptHandlers';

registerInteractivePromptHandlers({ driveQueuedPrompts: vi.fn(), publishQueueStateToSync: vi.fn() } as any);
const answer = (sessionId: string, requestId: string, response: { decision: 'allow' | 'deny'; scope: string }) =>
  h.handlers.get('claude-code:answer-tool-permission')!({}, { requestId, sessionId, response });

let n = 0;
let sid = '';
beforeEach(() => {
  sid = `session-${++n}`;
  h.rows.length = 0;
  vi.clearAllMocks();
});

describe('closeExpiredToolPermission', () => {
  it('writes an expired terminal row for a dropped request', async () => {
    expect(await closeExpiredToolPermission(sid, 'auto-denied-1')).toBe(true);
    expect(h.rows).toEqual([expect.objectContaining({
      sessionId: sid,
      toolUseId: 'auto-denied-1',
      isError: true,
      result: expect.objectContaining({ decision: 'deny', cancelled: true, reason: 'expired' }),
    })]);
  });

  it('refuses a late click on an expired request and writes no allow', async () => {
    await closeExpiredToolPermission(sid, 'auto-denied-2');
    const result = await answer(sid, 'auto-denied-2', { decision: 'allow', scope: 'session' });
    expect(result).toMatchObject({ success: false });
    expect(h.provider.resolveToolPermission).not.toHaveBeenCalled();
    expect(h.created).not.toHaveBeenCalled();
    expect(h.rows).toHaveLength(1);
  });

  it('leaves a request alone that a click answered first', async () => {
    expect(await answer(sid, 'auto-denied-3', { decision: 'allow', scope: 'once' })).toMatchObject({ success: true });
    expect(await closeExpiredToolPermission(sid, 'auto-denied-3')).toBe(false);
    expect(h.rows).toHaveLength(0);
  });
});
