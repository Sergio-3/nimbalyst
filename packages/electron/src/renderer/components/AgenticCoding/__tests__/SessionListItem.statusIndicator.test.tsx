// @vitest-environment jsdom
/**
 * The session row must keep showing work that is only a sub-agent's, and say so.
 *
 * The row had one spinner for two states the task panel already tells apart: the
 * lead generating, and the lead finished with sub-agents still running inside
 * its query. In the second one the row could also go blank altogether — after a
 * send-now the handed-over query is released from its turn, so nothing is
 * "processing" while the work goes on. #1269.
 */

import React from 'react';
import { Provider, createStore } from 'jotai';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionStatusIndicator } from '../SessionListItem';
import { sessionProcessingAtom, sessionStoreAtom } from '../../../store/atoms/sessions';

vi.mock('../SessionContextMenu', () => ({ SessionContextMenu: () => null }));
vi.mock('../FullTitleTooltip', () => ({ FullTitleTooltip: () => null }));

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { invoke: vi.fn().mockResolvedValue(null), on: vi.fn().mockReturnValue(() => {}), send: vi.fn() },
  });
});

afterEach(() => cleanup());

function renderIndicator(store: ReturnType<typeof createStore>) {
  return render(
    <Provider store={store}>
      <SessionStatusIndicator sessionId="s1" />
    </Provider>,
  );
}

describe('session row status while background sub-agents run', () => {
  it('still reports work when no turn is live but sub-agents are', () => {
    const store = createStore();
    store.set(sessionStoreAtom('s1'), {
      metadata: { backgroundDrain: true, currentTasks: [{ taskId: 't1', status: 'running' }] },
    } as never);

    const { container } = renderIndicator(store);

    const indicator = container.querySelector('.session-list-item-status.processing.background-work');
    expect(indicator).not.toBeNull();
    // How much work is left, in the one place the row can say it. Not "agent":
    // the count includes shell commands, which is what made the task list read
    // like a crashed sub-agent in the first place.
    expect(indicator?.getAttribute('title')).toContain('1 background task');
  });

  it('reads as the lead working while its own turn is live', () => {
    const store = createStore();
    store.set(sessionProcessingAtom('s1'), true);

    const { container } = renderIndicator(store);

    expect(container.querySelector('.session-list-item-status.processing')).not.toBeNull();
    expect(container.querySelector('.session-list-item-status.background-work')).toBeNull();
  });
});
