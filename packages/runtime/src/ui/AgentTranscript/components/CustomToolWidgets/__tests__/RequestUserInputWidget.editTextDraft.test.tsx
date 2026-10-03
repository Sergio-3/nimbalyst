/**
 * Regression test for GitHub issue #1418.
 *
 * The transcript is virtualized, so a widget scrolled out of view unmounts.
 * `EditTextRenderer` seeded its Lexical editor from `field.initialText` rather
 * than from the live draft, so a remount re-seeded the editor with the agent's
 * original text -- and OnChangePlugin then wrote that seed back over the draft
 * atom, destroying minutes of typing with no way to recover it.
 *
 * The editor must be seeded from the draft, which survives unmount.
 */

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { Provider as JotaiProvider } from 'jotai';
import {
  $createTextNode,
  $getRoot,
  $isElementNode,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  KEY_ENTER_COMMAND,
} from 'lexical';
import { store } from '../../../../../store/store';
import { setInteractiveWidgetHost } from '../../../../../store/atoms/interactiveWidgetHost';
import {
  clearRequestUserInputDraft,
  requestUserInputDraftAtom,
} from '../../../../../store/atoms/requestUserInputDraft';
import { RequestUserInputWidget } from '../RequestUserInputWidget';
import type { InteractiveWidgetHost } from '../InteractiveWidgetHost';

const SESSION_ID = 'session-1418';
const PROMPT_ID = 'tool-call-edittext-1418';
const SEED = 'Agent-supplied draft.';
const TYPED = 'Ten minutes of carefully written user input.';

function makeMessage(result: string | null = null) {
  return {
    toolCall: {
      providerToolCallId: PROMPT_ID,
      arguments: {
        title: 'Review the draft',
        fields: [
          { type: 'editText', id: 'body', label: 'Body', format: 'plain', initialText: SEED },
        ],
      },
      result,
    },
  } as any;
}

function renderWidget() {
  return render(
    <JotaiProvider store={store}>
      <RequestUserInputWidget
        message={makeMessage()}
        sessionId={SESSION_ID}
        isExpanded
        onToggle={() => {}}
      />
    </JotaiProvider>,
  );
}

function draftText(): string | undefined {
  const field = store.get(requestUserInputDraftAtom(PROMPT_ID)).fields.body;
  return field?.type === 'editText' ? field.state.text : undefined;
}

describe('RequestUserInputWidget editText draft survival', () => {
  beforeEach(() => {
    clearRequestUserInputDraft(PROMPT_ID);
    setInteractiveWidgetHost(SESSION_ID, {
      requestUserInputSubmit: vi.fn().mockResolvedValue(undefined),
      requestUserInputCancel: vi.fn().mockResolvedValue(undefined),
    } as unknown as InteractiveWidgetHost);
  });

  it('keeps the typed text across an unmount/remount cycle', async () => {
    const first = renderWidget();
    await act(async () => {});
    expect(draftText()).toBe(SEED);

    // Stand in for the user typing: OnChangePlugin writes exactly this.
    await act(async () => {
      store.set(requestUserInputDraftAtom(PROMPT_ID), (prev) => ({
        ...prev,
        fields: { ...prev.fields, body: { type: 'editText', state: { text: TYPED } } },
      }));
    });
    expect(draftText()).toBe(TYPED);

    // Scrolled out of view, then back.
    first.unmount();
    renderWidget();
    await act(async () => {});

    expect(draftText()).toBe(TYPED);
    expect(screen.getByTestId('request-user-input-edittext-content').textContent).toContain(TYPED);
  });
});

describe('RequestUserInputWidget closed states', () => {
  const renderClosed = (result: string | null, superseded?: boolean) => render(
    <JotaiProvider store={store}>
      <RequestUserInputWidget message={makeMessage(result)} sessionId={SESSION_ID} isExpanded onToggle={() => {}} superseded={superseded} />
    </JotaiProvider>,
  );

  it.each([
    ['a durable superseded result', '{"answers":{},"cancelled":true,"reason":"superseded"}', undefined],
    ['the transcript flag on an older transcript', null, true],
  ])('renders skipped and unanswerable for %s', (_label, result, superseded) => {
    renderClosed(result, superseded);
    screen.getByTestId('request-user-input-skipped');
    expect(screen.queryByTestId('request-user-input-cancelled')).toBeNull();
    expect(screen.queryByTestId('request-user-input-submit')).toBeNull();
    expect(screen.queryByTestId('request-user-input-cancel')).toBeNull();
  });

  it('keeps a plain cancel distinct from a skip', () => {
    renderClosed('{"answers":{},"cancelled":true}');
    screen.getByTestId('request-user-input-cancelled');
    expect(screen.queryByTestId('request-user-input-skipped')).toBeNull();
  });
});

// The editor is re-seeded from the draft on every mount, so the text the editor
// writes back must read in again as the same blocks. Plain text used to write
// blocks back joined by "\n\n" but split the seed on every "\n", so each
// remount plus keystroke turned one paragraph break into a growing run of
// blank lines.
describe('RequestUserInputWidget editText multi-paragraph remount', () => {
  const MULTI = 'First paragraph.\n\nSecond paragraph.\nA second line.';

  function renderWithSeed(format: 'plain' | 'markdown', seed = MULTI) {
    const message = {
      toolCall: {
        providerToolCallId: PROMPT_ID,
        arguments: {
          title: 'Review the draft',
          fields: [{ type: 'editText', id: 'body', label: 'Body', format, initialText: seed }],
        },
        result: null,
      },
    } as any;
    return render(
      <JotaiProvider store={store}>
        <RequestUserInputWidget message={message} sessionId={SESSION_ID} isExpanded onToggle={() => {}} />
      </JotaiProvider>,
    );
  }

  // Stand in for a keystroke at the end of the text: any real edit makes
  // OnChangePlugin write the editor's text back into the draft.
  async function typeAtEnd(char: string) {
    const editor = (screen.getByTestId('request-user-input-edittext-content') as any).__lexicalEditor;
    await act(async () => {
      editor.update(() => {
        const last = $getRoot().getLastChild();
        if ($isElementNode(last)) last.append($createTextNode(char));
      });
    });
  }

  beforeEach(() => {
    clearRequestUserInputDraft(PROMPT_ID);
    setInteractiveWidgetHost(SESSION_ID, {
      requestUserInputSubmit: vi.fn().mockResolvedValue(undefined),
      requestUserInputCancel: vi.fn().mockResolvedValue(undefined),
    } as unknown as InteractiveWidgetHost);
  });

  it.each(['plain', 'markdown'] as const)('keeps %s paragraphs unchanged across remounts', async (format) => {
    let view = renderWithSeed(format);
    await act(async () => {});
    let expected = MULTI;
    for (const char of ['!', '?', '.']) {
      await typeAtEnd(char);
      expected += char;
      expect(draftText()).toBe(expected);
      view.unmount();
      view = renderWithSeed(format);
      await act(async () => {});
    }
    expect(draftText()).toBe(expected);
  });

  // Breaks the user types, through the editor's own key handling: Enter makes a
  // new paragraph, Shift+Enter a line break inside one. Each must reach the
  // draft as one "\n" and stay one across a remount.
  async function pressAtEnd(step: { shift: boolean } | string) {
    const editor = (screen.getByTestId('request-user-input-edittext-content') as any).__lexicalEditor;
    await act(async () => {
      editor.update(() => { $getRoot().selectEnd(); }, { discrete: true });
      if (typeof step === 'string') {
        editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, step);
      } else {
        editor.dispatchCommand(KEY_ENTER_COMMAND, new KeyboardEvent('keydown', { key: 'Enter', shiftKey: step.shift }));
      }
    });
  }

  it.each([
    ['Enter', false],
    ['Shift+Enter', true],
  ] as const)('keeps a typed %s as one line break across remounts', async (_name, shift) => {
    let view = renderWithSeed('plain', 'A');
    await act(async () => {});
    await pressAtEnd({ shift });
    await pressAtEnd('B');
    expect(draftText()).toBe('A\nB');
    for (const char of ['!', '?']) {
      view.unmount();
      view = renderWithSeed('plain', 'A');
      await act(async () => {});
      await pressAtEnd(char);
    }
    expect(draftText()).toBe('A\nB!?');
  });
});

// The host rejects an answer the session cannot take (already answered, already
// on its way, could not be queued). The form must stay usable, keep the draft
// and say why, instead of claiming "Submitted" or "Cancelled".
describe('RequestUserInputWidget when the host rejects the answer', () => {
  const REASON = 'This answer is already on its way to the session.';

  beforeEach(() => {
    clearRequestUserInputDraft(PROMPT_ID);
    setInteractiveWidgetHost(SESSION_ID, {
      requestUserInputSubmit: vi.fn().mockRejectedValue(new Error(REASON)),
      requestUserInputCancel: vi.fn().mockRejectedValue(new Error(REASON)),
    } as unknown as InteractiveWidgetHost);
  });

  it.each([
    ['submit', 'request-user-input-submit'],
    ['cancel', 'request-user-input-cancel'],
  ])('stays open with the draft and the reason after a rejected %s', async (_action, button) => {
    renderWidget();
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByTestId(button));
    });

    expect(screen.getByTestId('request-user-input-widget').getAttribute('data-state')).toBe('pending');
    expect(draftText()).toBe(SEED);
    expect(screen.getByTestId('request-user-input-error').textContent).toBe(REASON);
  });
});
