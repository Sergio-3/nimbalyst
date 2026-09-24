// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react';
import { Provider as JotaiProvider } from 'jotai';
import { store } from '@nimbalyst/runtime/store/store';
import { setInteractiveWidgetHost } from '@nimbalyst/runtime/store/atoms/interactiveWidgetHost';
import { clearRequestUserInputDraft } from '@nimbalyst/runtime/store/atoms/requestUserInputDraft';
import { RequestUserInputWidget } from '@nimbalyst/runtime/ui/AgentTranscript/components/CustomToolWidgets/RequestUserInputWidget';
import type { InteractiveWidgetHost } from '@nimbalyst/runtime/ui/AgentTranscript/components/CustomToolWidgets/InteractiveWidgetHost';
import { createRequestUserInputHostActions } from '../promptResponseOutcome';

const SESSION_ID = 'session-rejected-answer';
const PROMPT_ID = 'toolu_rejected';
const REASON = 'This form was already answered.';

// The session transcript's host callbacks, fed the IPC result of a rejected
// answer, drive the real widget: the rejection must reach it as a throw.
describe('RequestUserInput host actions when the answer is rejected', () => {
  const invoke = vi.fn();
  const capture = vi.fn();
  const refreshPendingPrompts = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    invoke.mockResolvedValue({ success: false, error: REASON });
    clearRequestUserInputDraft(PROMPT_ID);
    setInteractiveWidgetHost(SESSION_ID, createRequestUserInputHostActions({
      sessionId: SESSION_ID,
      invoke,
      capture,
      refreshPendingPrompts,
    }) as unknown as InteractiveWidgetHost);
  });

  afterEach(() => {
    cleanup();
    setInteractiveWidgetHost(SESSION_ID, null);
  });

  it.each([
    ['submit', 'request-user-input-submit'],
    ['cancel', 'request-user-input-cancel'],
  ])('keeps the form open and shows the reason after a rejected %s', async (_action, button) => {
    render(
      <JotaiProvider store={store}>
        <RequestUserInputWidget
          message={{
            toolCall: {
              providerToolCallId: PROMPT_ID,
              arguments: {
                title: 'Pick a colour',
                fields: [{ type: 'editText', id: 'body', label: 'Body', format: 'plain', initialText: 'blue' }],
              },
              result: null,
            },
          } as any}
          sessionId={SESSION_ID}
          isExpanded
          onToggle={() => {}}
        />
      </JotaiProvider>,
    );
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByTestId(button));
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0]).toBe('messages:respond-to-prompt');
    expect(screen.getByTestId('request-user-input-widget').getAttribute('data-state')).toBe('pending');
    expect(screen.getByTestId('request-user-input-error').textContent).toBe(REASON);
    expect(screen.queryByText('Submitted')).toBeNull();
    expect(capture).not.toHaveBeenCalled();
    expect(refreshPendingPrompts).not.toHaveBeenCalled();
  });
});
