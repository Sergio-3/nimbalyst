import type { TranscriptViewMessage } from '../../../ai/server/types';
import { isInteractiveWidgetTool } from '../../../ai/server/interactivePromptTools';
import { isToolLikeMessage } from './messageTypeHelpers';

/**
 * What a transcript remembers when the user leaves it. Messages are keyed by
 * `sequence`, not `id`: ids come from a process-wide counter and are reissued
 * when the runtime rebuilds a session's events, sequences are per session.
 */
export interface TranscriptReturnState {
  lastSequence: number;
  anchor: { sequence: number; offset: number } | null;
  atBottom: boolean;
}

export type TranscriptReturnTarget =
  | { kind: 'bottom' }
  | { kind: 'news'; index: number }
  | { kind: 'anchor'; index: number; offset: number };

/** Agent text or a card the user must act on; plain tool calls are not news. */
function isNews(message: TranscriptViewMessage): boolean {
  if (message.type === 'assistant_message') return !!message.text?.trim();
  return isToolLikeMessage(message) && isInteractiveWidgetTool(message.toolCall?.toolName);
}

/** Tool rows render inside the next assistant row when one follows. */
function rowIndexOf(messages: TranscriptViewMessage[], index: number): number {
  if (!isToolLikeMessage(messages[index])) return index;
  let next = index + 1;
  while (next < messages.length && isToolLikeMessage(messages[next])) next++;
  return messages[next]?.type === 'assistant_message' ? next : index;
}

/** Highest persisted sequence; optimistic rows carry -1. */
export function lastTranscriptSequence(messages: TranscriptViewMessage[]): number | null {
  let last: number | null = null;
  for (const message of messages) {
    if (message.sequence >= 0 && (last === null || message.sequence > last)) last = message.sequence;
  }
  return last;
}

/**
 * `resolveRow` maps a message index to the row that shows it; pass the row
 * plan's target when rows fold into bundles. Without it, tool rows resolve to
 * the assistant row that draws them and the anchor stays on its own row.
 */
export function decideTranscriptReturnTarget(
  messages: TranscriptViewMessage[],
  saved: TranscriptReturnState | undefined,
  resolveRow?: (index: number) => number,
): TranscriptReturnTarget {
  if (!saved) return { kind: 'bottom' };
  const news = messages.findIndex(m => m.sequence > saved.lastSequence && isNews(m));
  if (news >= 0) return { kind: 'news', index: resolveRow ? resolveRow(news) : rowIndexOf(messages, news) };
  if (saved.atBottom || !saved.anchor) return { kind: 'bottom' };
  const anchor = saved.anchor;
  const index = messages.findIndex(m => m.sequence === anchor.sequence);
  if (index < 0) return { kind: 'bottom' };
  const row = resolveRow ? resolveRow(index) : index;
  // An offset inside a row that no longer shows the anchor means nothing.
  return { kind: 'anchor', index: row, offset: row === index ? anchor.offset : 0 };
}
