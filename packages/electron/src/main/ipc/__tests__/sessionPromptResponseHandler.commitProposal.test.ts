// @vitest-environment node

// A commit proposal whose MCP waiter is gone is answered through the durable
// response path. The handler used to end the session unconditionally there.
// Once a dropped connection settles the waiter within the same app run, that
// branch is reachable while a later turn is still running -- and `endSession`
// then drops the session from the active set, so every busy check reports it
// idle mid-turn.

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  sessionState: null as null | { status: string; isStreaming: boolean },
  endSession: vi.fn(async (_sessionId: string) => {}),
}));

vi.mock('electron', async () => ({
  app: (await import('../../../../test-stubs/privateUserData')).testApp,
  ipcMain: new EventEmitter(),
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (name: string, fn: any) => mocks.handlers.set(name, fn),
}));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { query: async () => ({ rows: [] }) },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { get: async () => ({ provider: 'claude-code' }) },
}));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({
    getSessionState: () => mocks.sessionState,
    endSession: mocks.endSession,
  }),
}));
vi.mock('../../services/SessionCommitService', () => ({
  SessionCommitService: { getInstance: () => ({ recordCommit: async () => {} }) },
}));
vi.mock('../../services/ai/pendingPromptPersistence', () => ({
  setSessionPendingPrompt: async () => {},
}));
vi.mock('../../services/RepositoryManager', () => ({
  getQueuedPromptsStore: () => ({}),
}));
vi.mock('../../tray/TrayManager', () => ({
  TrayManager: { getInstance: () => ({ onPromptResolved() {} }) },
}));

import { registerSessionPromptResponseHandler } from '../sessionPromptResponseHandler';

async function commitOrphanedProposal() {
  registerSessionPromptResponseHandler();
  return mocks.handlers.get('messages:respond-to-prompt')!(
    { sender: { send: vi.fn() } },
    {
      sessionId: 'session-with-orphaned-proposal',
      promptId: 'toolu_commit',
      promptType: 'git_commit_proposal_request',
      response: { action: 'committed', commitHash: 'abc1234', commitDate: '2026-09-24T12:00:00Z' },
      respondedBy: 'desktop',
    },
  );
}

describe('commit proposal answered without a waiter', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.endSession.mockClear();
  });

  it.each([
    ['running', { status: 'running', isStreaming: true }],
    ['streaming behind a waiting prompt', { status: 'waiting_for_input', isStreaming: true }],
  ])('does not end a session that is %s', async (_label, state) => {
    mocks.sessionState = state;
    expect(await commitOrphanedProposal()).toMatchObject({ success: true });
    expect(mocks.endSession).not.toHaveBeenCalled();
  });

  it('still marks an idle session as ended', async () => {
    mocks.sessionState = { status: 'idle', isStreaming: false };
    expect(await commitOrphanedProposal()).toMatchObject({ success: true });
    expect(mocks.endSession).toHaveBeenCalledWith('session-with-orphaned-proposal');
  });
});
