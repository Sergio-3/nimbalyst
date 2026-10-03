/**
 * Unanswered questions in a transcript, including those a sub-agent asked.
 *
 * A sub-agent's question sits in its card's child list, not at the top level,
 * so a scan of the top level alone neither offers "Jump to question" nor stops
 * the Thinking indicator for it. Child questions are scanned right after their
 * sub-agent, and every result carries the top-level index of the row that
 * holds it — the sub-agent for a child question — so callers compute rows
 * exactly as for a top-level question.
 */
import type { TranscriptViewMessage } from '../../../ai/server/transcript/TranscriptProjector';
import { isQuestionTool, partitionUnansweredQuestions, type UnansweredQuestion } from '../../../ai/server/interactivePromptTools';

function collectChildQuestions(message: TranscriptViewMessage, into: TranscriptViewMessage[]): void {
  if (message.type !== 'subagent') return;
  for (const child of message.subagent?.childEvents ?? []) {
    if (isQuestionTool(child.toolCall?.toolName)) into.push(child);
    collectChildQuestions(child, into);
  }
}

export function partitionTranscriptQuestions(messages: readonly TranscriptViewMessage[]): {
  open: UnansweredQuestion[];
  superseded: UnansweredQuestion[];
} {
  const scan: TranscriptViewMessage[] = [];
  const topLevelIndex: number[] = [];
  messages.forEach((message, index) => {
    const children: TranscriptViewMessage[] = [];
    collectChildQuestions(message, children);
    for (const entry of [message, ...children]) {
      scan.push(entry);
      topLevelIndex.push(index);
    }
  });
  const { open, superseded } = partitionUnansweredQuestions(scan);
  const lift = (question: UnansweredQuestion): UnansweredQuestion => ({ ...question, index: topLevelIndex[question.index] });
  return { open: open.map(lift), superseded: superseded.map(lift) };
}
