// @vitest-environment jsdom
import React from 'react';
import { Provider } from 'jotai';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';

vi.mock('@nimbalyst/runtime/ui/AgentTranscript/components/AgentTranscriptPanel', async () => {
  const ReactModule = await import('react');
  return {
    AgentTranscriptPanel: ReactModule.forwardRef(
      ({ initialSettings }: { initialSettings?: { collapseTools?: boolean } }, _ref) => (
        <div data-testid="transcript-panel" data-collapse-tools={String(initialSettings?.collapseTools)} />
      ),
    ),
  };
});
vi.mock('../SessionAIInput', async () => {
  const ReactModule = await import('react');
  return { SessionAIInput: ReactModule.forwardRef(() => <div />) };
});
vi.mock('posthog-js/react', () => ({ usePostHog: () => ({ capture: vi.fn() }) }));
vi.mock('../../../contexts/DialogContext', () => ({ useDialog: () => ({ open: vi.fn(), close: vi.fn() }) }));

import { SessionTranscript } from '../SessionTranscript';
import { sessionStoreAtom } from '../../../store/atoms/sessions';
import { settingAtom } from '../../../store/atoms/settingAtomFamily';

// Any IPC the transcript fires on mount resolves to nothing; listeners return
// an unsubscribe. Without `settingsSet` a setting write lands locally.
const ipc: unknown = new Proxy(() => undefined, {
  get: (_target, prop) => {
    if (prop === 'then' || prop === 'settingsSet') return undefined;
    if (typeof prop === 'string' && /^on[A-Z]|^on$|^addListener|^subscribe/.test(prop)) return () => () => undefined;
    return ipc;
  },
  apply: () => Promise.resolve(undefined),
});

describe('SessionTranscript tool-call grouping setting', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: ipc });
    store.set(sessionStoreAtom('group-setting'), {
      id: 'group-setting',
      provider: 'claude-code',
      model: 'claude-code:sonnet',
      messages: [],
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  it.each([true, false])('hands ai.chatGroupToolCalls = %s to the transcript as collapseTools', async (value) => {
    await act(async () => {
      await store.set(settingAtom('ai.chatGroupToolCalls'), value);
    });
    render(
      <Provider store={store}>
        <SessionTranscript sessionId="group-setting" workspacePath="/workspace" mode="agent" />
      </Provider>,
    );
    expect(screen.getByTestId('transcript-panel').getAttribute('data-collapse-tools')).toBe(String(value));
  });
});
