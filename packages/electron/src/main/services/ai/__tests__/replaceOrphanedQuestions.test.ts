// @vitest-environment node
/**
 * A newer question closes only the forms nobody can answer any more: the call
 * dropped (or belongs to an earlier process), no waiter, no stored answer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('node:events') as typeof import('node:events');
  return {
    ipcMain: new EventEmitter(),
    rows: [] as Array<{ sessionId: string; toolUseId: string; result: any }>,
    messages: [] as unknown[],
    stored: [] as unknown[],
    provider: 'claude-code',
    sends: [] as Array<{ channel: string; payload: any }>,
  };
});

vi.mock('electron', () => ({
  ipcMain: h.ipcMain,
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (channel: string, payload: any) => h.sends.push({ channel, payload }) } }],
  },
}));
vi.mock('../../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('../../../utils/transcriptHelpers', () => ({
  loadViewMessages: vi.fn(async () => ({ success: true, messages: h.messages })),
}));
vi.mock('../../RepositoryManager', () => ({
  getQueuedPromptsStore: () => ({ get: async () => null, create: vi.fn() }),
}));
vi.mock('../../../mcp/tools/interactivePromptTranscript', () => ({
  buildInteractivePromptToolResultContent: vi.fn(),
  persistInteractivePromptToolResult: vi.fn(async (a: { sessionId: string; toolUseId: string; result: any }) => {
    h.rows.push(a);
  }),
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({
  AgentMessagesRepository: { list: vi.fn(async () => h.stored) },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { get: vi.fn(async () => ({ provider: h.provider, workspacePath: '/ws' })) },
}));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({ getSessionState: () => null }),
}));

import { replaceOrphanedQuestions } from '../replaceOrphanedQuestions';
import { notePromptAbandoned } from '../requestUserInputResumption';
import { loadViewMessages } from '../../../utils/transcriptHelpers';

const form = (id: string, toolName = 'mcp__nimbalyst__PromptForUserInput') => ({
  type: 'tool_call',
  toolCall: { toolName, providerToolCallId: id },
});
const toolUseRow = (id: string, createdAt: Date) => ({
  direction: 'output',
  createdAt,
  content: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'mcp__nimbalyst__PromptForUserInput', input: {} }] } }),
});

let n = 0;
let sid = '';

beforeEach(() => {
  sid = `session-replace-${++n}`;
  h.rows.length = 0;
  h.sends.length = 0;
  h.stored = [];
  h.provider = 'claude-code';
  h.messages = [form('toolu_old'), form('toolu_new')];
  h.ipcMain.removeAllListeners();
  vi.clearAllMocks();
});

describe('replaceOrphanedQuestions', () => {
  it('closes a dropped form as replaced and leaves the new one alone', async () => {
    notePromptAbandoned(sid, 'toolu_old');

    expect(await replaceOrphanedQuestions(sid, 'toolu_new')).toEqual(['toolu_old']);
    expect(h.rows).toEqual([
      expect.objectContaining({ sessionId: sid, toolUseId: 'toolu_old', result: expect.objectContaining({ cancelled: true, reason: 'replaced' }) }),
    ]);
    expect(h.sends).toEqual([{ channel: 'ai:message-logged', payload: { sessionId: sid, direction: 'output', workspacePath: '/ws' } }]);
  });

  it('closes a form an earlier process showed', async () => {
    h.stored = [toolUseRow('toolu_old', new Date(performance.timeOrigin - 60_000))];

    expect(await replaceOrphanedQuestions(sid, 'toolu_new')).toEqual(['toolu_old']);
  });

  it('leaves a form with a live waiter alone', async () => {
    notePromptAbandoned(sid, 'toolu_old');
    h.ipcMain.on(`request-user-input-response:${sid}:toolu_old`, () => {});

    expect(await replaceOrphanedQuestions(sid, 'toolu_new')).toEqual([]);
    expect(h.rows).toEqual([]);
  });

  it('leaves a form alone whose call may still be starting', async () => {
    // A sibling form of the same turn: shown by this process, call not dropped.
    h.stored = [toolUseRow('toolu_old', new Date())];

    expect(await replaceOrphanedQuestions(sid, 'toolu_new')).toEqual([]);
    expect(h.rows).toEqual([]);
  });

  it('leaves a form with a stored answer to its answer path', async () => {
    notePromptAbandoned(sid, 'toolu_old');
    h.stored = [{
      direction: 'output',
      createdAt: new Date(),
      content: JSON.stringify({ type: 'request_user_input_response', promptId: 'toolu_old', answers: { a: 1 }, cancelled: false }),
    }];

    expect(await replaceOrphanedQuestions(sid, 'toolu_new')).toEqual([]);
    expect(h.rows).toEqual([]);
  });

  it('leaves AskUserQuestion alone', async () => {
    notePromptAbandoned(sid, 'toolu_old');
    h.messages = [form('toolu_old', 'mcp__nimbalyst__AskUserQuestion'), form('toolu_new')];

    expect(await replaceOrphanedQuestions(sid, 'toolu_new')).toEqual([]);
  });

  it('does nothing for Codex, which owns its question lifecycle', async () => {
    h.provider = 'openai-codex';
    notePromptAbandoned(sid, 'toolu_old');

    expect(await replaceOrphanedQuestions(sid, 'toolu_new')).toEqual([]);
    expect(loadViewMessages).not.toHaveBeenCalled();
  });
});
