// @vitest-environment node
import { createStore } from 'jotai';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionMeta } from '@nimbalyst/runtime';
import {
  agentBubbleStateAtom,
  agentSessionAttentionAtom,
  hasUnansweredInteractivePrompt,
  refreshPendingPromptsAtom,
  respondToPromptAtom,
  sessionHasPendingInteractivePromptAtom,
  sessionListWorkspaceAtom,
  sessionProcessingAtom,
  sessionRegistryAtom,
  sessionStoreAtom,
  sessionUnreadAtom,
} from '../sessions';
import { createRequestUserInputHostActions } from '../../../components/UnifiedAI/promptResponseOutcome';

const WORKSPACE = '/workspace/current';

function session(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: `Session ${id}`,
    provider: 'claude-code',
    model: 'claude-code:sonnet',
    sessionType: 'session',
    workspaceId: WORKSPACE,
    worktreeId: null,
    parentSessionId: null,
    childCount: 0,
    uncommittedCount: 0,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    isArchived: false,
    isPinned: false,
    ...overrides,
  };
}

function setup(...sessions: SessionMeta[]) {
  const store = createStore();
  store.set(sessionListWorkspaceAtom, WORKSPACE);
  store.set(sessionRegistryAtom, new Map(sessions.map((item) => [item.id, item])));
  return store;
}

describe('agentBubbleStateAtom', () => {
  it('is hidden when no session needs attention', () => {
    const store = setup(session('idle'));
    expect(store.get(agentBubbleStateAtom)).toEqual({ color: null, count: 0 });
  });

  it('uses awaiting-input priority and counts only awaiting sessions', () => {
    const store = setup(session('awaiting-1'), session('awaiting-2'), session('running'), session('unread'));
    store.set(sessionHasPendingInteractivePromptAtom('awaiting-1'), true);
    store.set(sessionHasPendingInteractivePromptAtom('awaiting-2'), true);
    store.set(sessionProcessingAtom('running'), true);
    store.set(sessionUnreadAtom('unread'), true);

    expect(store.get(agentBubbleStateAtom)).toEqual({ color: 'orange', count: 2 });
  });

  it('uses running priority when no session awaits input', () => {
    const store = setup(session('running-1'), session('running-2'), session('unread'));
    store.set(sessionProcessingAtom('running-1'), true);
    store.set(sessionProcessingAtom('running-2'), true);
    store.set(sessionUnreadAtom('unread'), true);

    expect(store.get(agentBubbleStateAtom)).toEqual({ color: 'green', count: 2 });
  });

  it('shows the unread count when no higher-priority state exists', () => {
    const store = setup(session('unread-1'), session('unread-2'));
    store.set(sessionUnreadAtom('unread-1'), true);
    store.set(sessionUnreadAtom('unread-2'), true);

    expect(store.get(agentBubbleStateAtom)).toEqual({ color: 'blue', count: 2 });
  });
});

describe('agentSessionAttentionAtom', () => {
  it('classifies each session once at its highest-priority state', () => {
    const store = setup(session('overlap'));
    store.set(sessionHasPendingInteractivePromptAtom('overlap'), true);
    store.set(sessionProcessingAtom('overlap'), true);
    store.set(sessionUnreadAtom('overlap'), true);

    const groups = store.get(agentSessionAttentionAtom);
    expect(groups.awaitingInput.map((item) => item.id)).toEqual(['overlap']);
    expect(groups.running).toEqual([]);
    expect(groups.unread).toEqual([]);
  });

  it('ignores archived and other-workspace sessions', () => {
    const store = setup(
      session('current'),
      session('archived', { isArchived: true }),
      session('other-workspace', { workspaceId: '/workspace/other' }),
    );
    store.set(sessionUnreadAtom('current'), true);
    store.set(sessionUnreadAtom('archived'), true);
    store.set(sessionUnreadAtom('other-workspace'), true);

    expect(store.get(agentSessionAttentionAtom).unread.map((item) => item.id)).toEqual(['current']);
  });

  // An agent sets phase 'complete' just before its closing output, which is
  // what flags the session unread -- so a blanket phase filter hid exactly the
  // sessions that had just finished.
  it('still surfaces a complete-phase session that is unread or awaiting input', () => {
    const store = setup(
      session('done-unread', { phase: 'complete' }),
      session('done-awaiting', { phase: 'complete' }),
      session('done-running', { phase: 'complete' }),
    );
    store.set(sessionUnreadAtom('done-unread'), true);
    store.set(sessionHasPendingInteractivePromptAtom('done-awaiting'), true);
    store.set(sessionProcessingAtom('done-running'), true);

    const groups = store.get(agentSessionAttentionAtom);
    expect(groups.unread.map((item) => item.id)).toEqual(['done-unread']);
    expect(groups.awaitingInput.map((item) => item.id)).toEqual(['done-awaiting']);
    expect(groups.running).toEqual([]);
  });
});

describe('hasUnansweredInteractivePrompt', () => {
  const prompt = (result?: string) => ({
    type: 'tool_call',
    toolCall: { toolName: 'mcp__nimbalyst__AskUserQuestion', ...(result ? { result } : {}) },
  });
  const userMessage = { type: 'user_message', text: 'what about X?' };

  it('is pending while an interactive tool call has no result', () => {
    expect(hasUnansweredInteractivePrompt([userMessage, prompt()])).toBe(true);
  });

  it('is not pending once the tool call has a result', () => {
    expect(hasUnansweredInteractivePrompt([userMessage, prompt('{"answers":{}}')])).toBe(false);
  });

  // Typing instead of answering aborts the turn, so the tool_use never gets a
  // tool_result. Without this, the session showed "waiting for your response"
  // forever -- including while a later turn was actively running.
  it('is not pending when the user typed a new prompt instead of answering', () => {
    const messages = [
      userMessage,
      prompt(),
      { type: 'user_message', text: 'never mind, do this instead' },
      { type: 'assistant_message', text: 'on it' },
    ];
    expect(hasUnansweredInteractivePrompt(messages)).toBe(false);
  });

  it('is pending for a prompt raised after the abandoned one', () => {
    const messages = [prompt(), userMessage, { type: 'assistant_message', text: 'on it' }, prompt()];
    expect(hasUnansweredInteractivePrompt(messages)).toBe(true);
  });

  it('is pending for a canonical interactive_prompt event with pending status', () => {
    expect(
      hasUnansweredInteractivePrompt([userMessage, { type: 'interactive_prompt', interactivePrompt: { status: 'pending' } }]),
    ).toBe(true);
  });

  it('ignores non-interactive tool calls that are still running', () => {
    expect(hasUnansweredInteractivePrompt([userMessage, { type: 'tool_call', toolCall: { toolName: 'Bash' } }])).toBe(false);
  });
});

describe('agentSessionAttentionAtom: complete-phase session still working', () => {
  // `phase` only keeps a session out of Running. A session the agent marked
  // complete but that is still streaming gets flagged unread by every message,
  // and must land there instead of vanishing from all three groups.
  it('surfaces a processing complete-phase session as unread when it is unread', () => {
    const store = setup(session('done-working', { phase: 'complete' }));
    store.set(sessionProcessingAtom('done-working'), true);
    store.set(sessionUnreadAtom('done-working'), true);

    const groups = store.get(agentSessionAttentionAtom);
    expect(groups.running).toEqual([]);
    expect(groups.unread.map((item) => item.id)).toEqual(['done-working']);
  });

  it('keeps a processing complete-phase session with nothing unread out of every group', () => {
    const store = setup(session('done-working', { phase: 'complete' }));
    store.set(sessionProcessingAtom('done-working'), true);

    expect(store.get(agentSessionAttentionAtom)).toEqual({ awaitingInput: [], running: [], unread: [] });
  });
});

describe('agentSessionAttentionAtom: sub-agent drain counts as running', () => {
  // The lead turn is done but background sub-agents still work; the session
  // list spins for it (#1269), so the popover counts it as running too.
  function drain(store: ReturnType<typeof setup>, id: string) {
    store.set(sessionStoreAtom(id), { metadata: { backgroundDrain: true } } as never);
  }

  it('counts a draining session as running while it is no longer processing', () => {
    const store = setup(session('draining', { phase: 'implementing' }));
    drain(store, 'draining');

    const groups = store.get(agentSessionAttentionAtom);
    expect(groups.running.map((item) => item.id)).toEqual(['draining']);
    expect(groups.unread).toEqual([]);
  });

  it('surfaces a draining complete-phase session as unread when it is unread', () => {
    const store = setup(session('done-draining', { phase: 'complete' }));
    drain(store, 'done-draining');
    store.set(sessionUnreadAtom('done-draining'), true);

    const groups = store.get(agentSessionAttentionAtom);
    expect(groups.running).toEqual([]);
    expect(groups.unread.map((item) => item.id)).toEqual(['done-draining']);
  });
});

// The answer's broadcast clears the flag before the answering invoke returns;
// the refresh after it reads messages in which the answered call has no result
// yet. Counting that call again pinned the "?" on the open session until the
// user switched sessions and back.
describe('pending-prompt refresh after an answer', () => {
  const SESSION = 'answered';
  const form = (id: string) => ({
    type: 'tool_call',
    toolCall: { toolName: 'mcp__nimbalyst__PromptForUserInput', providerToolCallId: id },
  });
  const permission = (requestId: string) => ({
    type: 'tool_call',
    toolCall: { toolName: 'ToolPermission', providerToolCallId: `tool-${requestId}`, arguments: { requestId } },
  });

  function clearedByBroadcast(messages: unknown[]) {
    const store = createStore();
    store.set(sessionStoreAtom(SESSION), { messages } as any);
    store.set(sessionHasPendingInteractivePromptAtom(SESSION), false);
    return store;
  }
  function submitForm(store: ReturnType<typeof createStore>, promptId: string) {
    return createRequestUserInputHostActions({
      sessionId: SESSION,
      invoke: async () => ({ success: true }),
      refreshPendingPrompts: (sessionId, settledPromptId) =>
        store.set(refreshPendingPromptsAtom, sessionId, settledPromptId),
    }).requestUserInputSubmit(promptId, {});
  }

  afterEach(() => {
    delete (globalThis as any).window?.electronAPI;
  });

  it('keeps the flag cleared when the submitted form was the only open prompt', async () => {
    const store = clearedByBroadcast([{ type: 'user_message' }, form('toolu_A')]);
    await submitForm(store, 'toolu_A');
    expect(store.get(sessionHasPendingInteractivePromptAtom(SESSION))).toBe(false);
  });

  it('sets the flag for another prompt that is still open in the session', async () => {
    const store = clearedByBroadcast([{ type: 'user_message' }, form('toolu_A'), form('toolu_B')]);
    await submitForm(store, 'toolu_B');
    expect(store.get(sessionHasPendingInteractivePromptAtom(SESSION))).toBe(true);
  });

  it('keeps the flag cleared after the only tool permission is answered', async () => {
    ((globalThis as any).window ??= {}).electronAPI = { invoke: async () => ({ success: true }) };
    const store = clearedByBroadcast([{ type: 'user_message' }, permission('perm-1')]);
    await store.set(respondToPromptAtom, {
      sessionId: SESSION,
      promptId: 'perm-1',
      promptType: 'permission_request',
      response: { decision: 'deny', scope: 'once', cancelled: true },
    });
    expect(store.get(sessionHasPendingInteractivePromptAtom(SESSION))).toBe(false);
  });
});
