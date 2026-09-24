/**
 * Raw `ai_agent_messages` rows around one PromptForUserInput call, in the forms
 * measured in a working database. Shared by the tests that write these rows
 * and the chain test that reads them back through parser and widget.
 */
import type { RawMessage } from '../../TranscriptTransformer';

export const PROMPT_TITLE = 'Farbe waehlen';

let nextId = 1;
function row(sessionId: string, fields: Omit<Partial<RawMessage>, 'content'> & { content: unknown }): RawMessage {
  return {
    id: nextId++,
    sessionId,
    source: 'claude-code',
    direction: 'output',
    createdAt: new Date(Date.UTC(2026, 8, 23, 7, 0, nextId)),
    ...fields,
    content: typeof fields.content === 'string' ? fields.content : JSON.stringify(fields.content),
  };
}

/** The CLI's assistant turn with the PromptForUserInput tool_use block. */
export function promptToolUseRow(sessionId: string, toolUseId: string): RawMessage {
  return row(sessionId, {
    content: {
      type: 'assistant',
      message: {
        id: `msg_${toolUseId}`,
        role: 'assistant',
        model: 'claude-opus-4-5',
        content: [{
          type: 'tool_use',
          id: toolUseId,
          name: 'mcp__nimbalyst__PromptForUserInput',
          input: {
            title: PROMPT_TITLE,
            fields: [{
              type: 'singleSelect',
              id: 'farbe',
              label: 'Farbe',
              options: [{ id: 'rot', label: 'Rot' }, { id: 'blau', label: 'Blau' }],
            }],
          },
        }],
      },
    },
  });
}

/**
 * A stored answer as `messages:respond-to-prompt` writes it. Without `attempt`
 * this is the legacy form (e.g. an answer that reached no waiter); with
 * `cancelled: true` it is the stored cancel of a form whose call had died.
 */
export function promptResponseRow(
  sessionId: string,
  toolUseId: string,
  fields: { cancelled?: boolean; answers?: Record<string, unknown>; respondedBy?: 'desktop' | 'mobile' } = {},
): RawMessage {
  const cancelled = fields.cancelled === true;
  return row(sessionId, {
    source: 'nimbalyst',
    content: {
      type: 'request_user_input_response',
      promptId: toolUseId,
      answers: cancelled ? {} : fields.answers ?? { farbe: { type: 'singleSelect', selectedId: 'blau' } },
      cancelled,
      respondedAt: Date.UTC(2026, 8, 23, 7, 33, 5),
      respondedBy: fields.respondedBy ?? 'desktop',
    },
  });
}

/** The synthetic tool_result the waiter writes when the user answers. */
export function promptToolResultRow(sessionId: string, toolUseId: string): RawMessage {
  const respondedAt = Date.UTC(2026, 8, 23, 7, 34, 0);
  return row(sessionId, {
    content: {
      type: 'nimbalyst_tool_result',
      tool_use_id: toolUseId,
      result: JSON.stringify({
        cancelled: false,
        answers: { farbe: { type: 'singleSelect', selectedId: 'blau' } },
        respondedBy: 'desktop',
        respondedAt,
      }),
      is_error: false,
    },
  });
}
