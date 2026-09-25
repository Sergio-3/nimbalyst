// @vitest-environment jsdom
/**
 * Stored PromptForUserInput rows through the whole read path: raw rows ->
 * TranscriptTransformer (real parser, in-memory event store) -> projector ->
 * RequestUserInputWidget. The widget decides open / answered / cancelled only
 * from the projected tool call, so this pins what a reload shows.
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Provider as JotaiProvider } from 'jotai';
import { TranscriptTransformer, type RawMessage, type ISessionMetadataStore } from '../TranscriptTransformer';
import { InMemoryTranscriptEventStore } from '../InMemoryTranscriptEventStore';
import { TranscriptProjector } from '../TranscriptProjector';
import { store } from '../../../../store/store';
import { setInteractiveWidgetHost } from '../../../../store/atoms/interactiveWidgetHost';
import { RequestUserInputWidget } from '../../../../ui/AgentTranscript/components/CustomToolWidgets/RequestUserInputWidget';
import type { InteractiveWidgetHost } from '../../../../ui/AgentTranscript/components/CustomToolWidgets/InteractiveWidgetHost';
import { promptResponseRow, promptToolResultRow, promptToolUseRow } from './fixtures/requestUserInputRows';

const SESSION_ID = 'session-request-user-input-chain';
const TOOL_USE_ID = 'toolu_01ThYaSQa4GRnzDMAcvmzkKB';

function metadataStore(): ISessionMetadataStore {
  const statuses = new Map<string, any>();
  return {
    async getTransformStatus(sessionId) {
      return statuses.get(sessionId) ?? {
        transformVersion: null,
        lastRawMessageId: null,
        lastTransformedAt: null,
        transformStatus: null,
      };
    },
    async updateTransformStatus(sessionId, update) {
      statuses.set(sessionId, update);
    },
  };
}

/** Feeds `passes` one after another, each as a later batch of the same log. */
async function renderAfter(...passes: RawMessage[][]) {
  const events = new InMemoryTranscriptEventStore();
  const metadata = metadataStore();
  const log: RawMessage[] = [];
  for (const pass of passes) {
    log.push(...pass);
    const rows = [...log];
    await new TranscriptTransformer(
      { async getMessages(sessionId, afterId) { return rows.filter((r) => r.sessionId === sessionId && (afterId == null || r.id > afterId)); } },
      events,
      metadata,
    ).processNewMessages(SESSION_ID, 'claude-code');
  }
  const { messages } = TranscriptProjector.project(await events.getSessionEvents(SESSION_ID));
  const message = messages.find((m) => m.toolCall?.providerToolCallId === TOOL_USE_ID);
  render(
    <JotaiProvider store={store}>
      <RequestUserInputWidget message={message as any} sessionId={SESSION_ID} isExpanded onToggle={() => {}} />
    </JotaiProvider>,
  );
  return screen.getByTestId('request-user-input-widget').getAttribute('data-state');
}

describe('PromptForUserInput rows -> parser -> widget', () => {
  beforeEach(() => {
    cleanup();
    setInteractiveWidgetHost(SESSION_ID, {
      requestUserInputSubmit: vi.fn().mockResolvedValue(undefined),
      requestUserInputCancel: vi.fn().mockResolvedValue(undefined),
    } as unknown as InteractiveWidgetHost);
  });

  // The row form the late-answer writer produces (its test compares against
  // this fixture) closes the form as answered.
  it('closes a form as answered by its written tool_result', async () => {
    const state = await renderAfter([
      promptToolUseRow(SESSION_ID, TOOL_USE_ID),
      promptResponseRow(SESSION_ID, TOOL_USE_ID),
      promptToolResultRow(SESSION_ID, TOOL_USE_ID),
    ]);

    expect(state).toBe('completed');
  });

  it('closes a form as cancelled when the only stored answer is a cancel', async () => {
    const state = await renderAfter([
      promptToolUseRow(SESSION_ID, TOOL_USE_ID),
      promptResponseRow(SESSION_ID, TOOL_USE_ID, { cancelled: true }),
    ]);

    expect(state).toBe('cancelled');
    expect(screen.queryByTestId('request-user-input-submit')).toBeNull();
  });

  it('keeps a form open when its stored answers never reached the agent', async () => {
    const state = await renderAfter([
      promptToolUseRow(SESSION_ID, TOOL_USE_ID),
      promptResponseRow(SESSION_ID, TOOL_USE_ID),
      promptResponseRow(SESSION_ID, TOOL_USE_ID, { answers: { farbe: { type: 'singleSelect', selectedId: 'rot' } } }),
    ]);

    expect(state).toBe('pending');
  });

  it('keeps an answered form answered when a cancel from another device arrives later', async () => {
    const state = await renderAfter(
      [promptToolUseRow(SESSION_ID, TOOL_USE_ID), promptToolResultRow(SESSION_ID, TOOL_USE_ID)],
      [promptResponseRow(SESSION_ID, TOOL_USE_ID, { cancelled: true, respondedBy: 'mobile' })],
    );

    expect(state).toBe('completed');
  });
});
