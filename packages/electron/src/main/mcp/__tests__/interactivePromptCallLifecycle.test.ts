// @vitest-environment node
//
// NIM-2607 / #1341: a blocking prompt whose MCP call the client abandons used
// to leave the waiter pending forever -- the "awaiting input" bit stuck on, the
// timers and listeners leaked, and the widget kept offering buttons whose
// answer had nowhere to go.

import { describe, it, expect, vi, afterEach } from 'vitest';

import { attachInteractivePromptCall } from '../tools/interactivePromptKeepalive';
import { settleReasonFromResponse, shouldTerminalizePrompt } from '../tools/interactivePromptAbandonment';

describe('shouldTerminalizePrompt', () => {
  // A question in an old, dead session stays answerable: answering it persists
  // the answer and resumes the session with it as a new turn (#1116). That
  // fallback only runs when no live waiter is found, so an abandoned call must
  // tear its waiter down WITHOUT closing the widget out.
  it('leaves an abandoned question answerable so the answer can resume the session', () => {
    expect(shouldTerminalizePrompt({ kind: 'ask_user_question', reason: 'client-abandoned' })).toBe(false);
    expect(shouldTerminalizePrompt({ kind: 'request_user_input', reason: 'client-abandoned' })).toBe(false);
    expect(shouldTerminalizePrompt({ kind: 'git_commit_proposal', reason: 'client-abandoned' })).toBe(false);
  });

  it('fails closed on an abandoned permission request', () => {
    // NIM-2607: no resume story for an approval, and a stale Allow answers nobody.
    expect(shouldTerminalizePrompt({ kind: 'tool_permission', reason: 'client-abandoned' })).toBe(true);
  });

  it('always closes out a prompt the user actually answered', () => {
    for (const kind of ['ask_user_question', 'request_user_input', 'git_commit_proposal', 'tool_permission'] as const) {
      expect(shouldTerminalizePrompt({ kind, reason: 'user-responded' })).toBe(true);
    }
  });

  // NIM-7240: a new user turn closes the question for good, unlike a stop.
  it('closes out a question a waiter settles as superseded', () => {
    const reason = settleReasonFromResponse({ reason: 'superseded' });
    expect(reason).toBe('superseded');
    expect(shouldTerminalizePrompt({ kind: 'ask_user_question', reason })).toBe(true);
    expect(shouldTerminalizePrompt({ kind: 'request_user_input', reason })).toBe(true);
    expect(settleReasonFromResponse({})).toBe('user-responded');
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('attachInteractivePromptCall', () => {
  it('settles the waiter when the client aborts the call', () => {
    const controller = new AbortController();
    const onAbort = vi.fn();

    attachInteractivePromptCall({
      request: { params: { _meta: { progressToken: 1 } } },
      extra: { sendNotification: vi.fn(), signal: controller.signal },
      toolName: 'AskUserQuestion',
      onAbort,
    });

    controller.abort();
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it('stops heartbeating once the call is aborted', () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const sendNotification = vi.fn();

    attachInteractivePromptCall({
      request: { params: { _meta: { progressToken: 1 } } },
      extra: { sendNotification, signal: controller.signal },
      toolName: 'AskUserQuestion',
      onAbort: () => {},
      intervalMs: 1000,
    });

    vi.advanceTimersByTime(2000);
    expect(sendNotification).toHaveBeenCalledTimes(2);

    controller.abort();
    vi.advanceTimersByTime(5000);
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it('does not fire onAbort after the prompt has settled normally', () => {
    const controller = new AbortController();
    const onAbort = vi.fn();

    const detach = attachInteractivePromptCall({
      request: { params: { _meta: { progressToken: 1 } } },
      extra: { sendNotification: vi.fn(), signal: controller.signal },
      toolName: 'AskUserQuestion',
      onAbort,
    });

    detach();
    controller.abort();
    expect(onAbort).not.toHaveBeenCalled();
  });

  it('settles immediately when handed an already-aborted call', () => {
    const controller = new AbortController();
    controller.abort();
    const onAbort = vi.fn();

    attachInteractivePromptCall({
      request: { params: { _meta: { progressToken: 1 } } },
      extra: { sendNotification: vi.fn(), signal: controller.signal },
      toolName: 'AskUserQuestion',
      onAbort,
    });

    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it('still heartbeats when the transport offers no abort signal', () => {
    vi.useFakeTimers();
    const sendNotification = vi.fn();

    const detach = attachInteractivePromptCall({
      request: { params: { _meta: { progressToken: 1 } } },
      extra: { sendNotification },
      toolName: 'AskUserQuestion',
      onAbort: () => { throw new Error('must not abort'); },
      intervalMs: 1000,
    });

    vi.advanceTimersByTime(3000);
    expect(sendNotification).toHaveBeenCalledTimes(3);
    detach();
  });
});
