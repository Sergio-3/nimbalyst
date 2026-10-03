/**
 * Raw rows of one lead turn with a background sub-agent, in the form the
 * Claude Agent SDK writes them: the sub-agent's own text arrives as assistant
 * rows with `parent_tool_use_id` and `message.model`, interleaved with the
 * lead's rows. Taken from a real session and anonymized: every text, prompt,
 * argument, result and id is replaced; order, row shapes and timing are kept.
 */
import type { RawMessage } from '../../TranscriptTransformer';

// One row per line: id, direction, ms after the first row, parsed content.
const ROWS = [
  {"id": 1, "direction": "input", "createdAtMs": 0, "content": {"prompt": "User prompt 150."}},
  {"id": 2, "direction": "output", "createdAtMs": 61988, "content": {"type": "assistant", "message": {"model": "claude-opus-5-5", "id": "msg_anon_01", "role": "assistant", "content": [{"type": "thinking", "thinking": ""}]}, "parent_tool_use_id": null, "session_id": "sdk-session-anon"}},
  {"id": 3, "direction": "output", "createdAtMs": 84776, "content": {"type": "assistant", "message": {"model": "claude-opus-5-5", "id": "msg_anon_01", "role": "assistant", "content": [{"type": "tool_use", "id": "toolu_anon_02", "name": "Agent", "input": {"description": "Duplicate search", "prompt": "Search for duplicates.", "run_in_background": true}}]}, "parent_tool_use_id": null, "session_id": "sdk-session-anon"}},
  {"id": 4, "direction": "output", "createdAtMs": 87218, "content": {"type": "system", "subtype": "background_tasks_changed", "tasks": []}},
  {"id": 5, "direction": "output", "createdAtMs": 87502, "content": {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_anon_02", "content": [{"type": "text", "text": "Async agent launched successfully."}]}]}, "parent_tool_use_id": null, "session_id": "sdk-session-anon"}},
  {"id": 6, "direction": "output", "createdAtMs": 90957, "content": {"type": "assistant", "message": {"model": "claude-opus-5-5", "id": "msg_anon_03", "role": "assistant", "content": [{"type": "tool_use", "id": "toolu_anon_04", "name": "mcp__nimbalyst__update_session_meta", "input": {"phase": "implementing"}}]}, "parent_tool_use_id": null, "session_id": "sdk-session-anon"}},
  {"id": 7, "direction": "output", "createdAtMs": 94216, "content": {"type": "assistant", "message": {"model": "claude-opus-5-5", "id": "msg_anon_05", "role": "assistant", "content": [{"type": "thinking", "thinking": ""}]}, "parent_tool_use_id": "toolu_anon_02", "session_id": "sdk-session-anon"}},
  {"id": 8, "direction": "output", "createdAtMs": 94321, "content": {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_anon_04", "content": "ok"}]}, "parent_tool_use_id": null, "session_id": "sdk-session-anon"}},
  {"id": 9, "direction": "output", "createdAtMs": 94843, "content": {"type": "assistant", "message": {"model": "claude-opus-5-5", "id": "msg_anon_05", "role": "assistant", "content": [{"type": "tool_use", "id": "toolu_anon_06", "name": "Read", "input": {"file_path": "/workspace/notes.md"}}]}, "parent_tool_use_id": "toolu_anon_02", "session_id": "sdk-session-anon"}},
  {"id": 10, "direction": "output", "createdAtMs": 95074, "content": {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_anon_06", "content": "ok"}]}, "parent_tool_use_id": "toolu_anon_02", "session_id": "sdk-session-anon"}},
  {"id": 11, "direction": "output", "createdAtMs": 104845, "content": {"type": "assistant", "message": {"model": "claude-opus-5-5", "id": "msg_anon_07", "role": "assistant", "content": [{"type": "thinking", "thinking": ""}]}, "parent_tool_use_id": "toolu_anon_02", "session_id": "sdk-session-anon"}},
  {"id": 12, "direction": "output", "createdAtMs": 104891, "content": {"type": "assistant", "message": {"model": "claude-opus-5-5", "id": "msg_anon_08", "role": "assistant", "content": [{"type": "text", "text": "Lead: the duplicate search runs in the background; the summary follows when it reports."}]}, "parent_tool_use_id": null, "session_id": "sdk-session-anon"}},
  {"id": 13, "direction": "output", "createdAtMs": 104914, "content": {"type": "result", "subtype": "success", "num_turns": 9, "result": ""}},
  {"id": 14, "direction": "output", "createdAtMs": 105854, "content": {"type": "assistant", "message": {"model": "claude-opus-5-5", "id": "msg_anon_07", "role": "assistant", "content": [{"type": "tool_use", "id": "toolu_anon_09", "name": "Bash", "input": {"command": "echo check"}}]}, "parent_tool_use_id": "toolu_anon_02", "session_id": "sdk-session-anon"}},
  {"id": 15, "direction": "output", "createdAtMs": 109778, "content": {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_anon_09", "content": "ok"}]}, "parent_tool_use_id": "toolu_anon_02", "session_id": "sdk-session-anon"}},
  {"id": 16, "direction": "output", "createdAtMs": 175249, "content": {"type": "assistant", "message": {"model": "claude-opus-5-5", "id": "msg_anon_10", "role": "assistant", "content": [{"type": "text", "text": "Now the code."}]}, "parent_tool_use_id": "toolu_anon_02", "session_id": "sdk-session-anon"}},
  {"id": 17, "direction": "output", "createdAtMs": 176531, "content": {"type": "assistant", "message": {"model": "claude-opus-5-5", "id": "msg_anon_10", "role": "assistant", "content": [{"type": "tool_use", "id": "toolu_anon_11", "name": "Bash", "input": {"command": "echo check"}}]}, "parent_tool_use_id": "toolu_anon_02", "session_id": "sdk-session-anon"}},
  {"id": 18, "direction": "output", "createdAtMs": 176687, "content": {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_anon_11", "content": "ok"}]}, "parent_tool_use_id": "toolu_anon_02", "session_id": "sdk-session-anon"}},
  {"id": 19, "direction": "output", "createdAtMs": 308088, "content": {"type": "assistant", "message": {"model": "claude-opus-5-5", "id": "msg_anon_12", "role": "assistant", "content": [{"type": "text", "text": "Now part B tests (red first)."}]}, "parent_tool_use_id": "toolu_anon_02", "session_id": "sdk-session-anon"}},
  {"id": 20, "direction": "output", "createdAtMs": 314343, "content": {"type": "assistant", "message": {"model": "claude-opus-5-5", "id": "msg_anon_12", "role": "assistant", "content": [{"type": "tool_use", "id": "toolu_anon_13", "name": "Bash", "input": {"command": "echo check"}}]}, "parent_tool_use_id": "toolu_anon_02", "session_id": "sdk-session-anon"}},
  {"id": 21, "direction": "output", "createdAtMs": 319671, "content": {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_anon_13", "content": "ok"}]}, "parent_tool_use_id": "toolu_anon_02", "session_id": "sdk-session-anon"}},
  {"id": 22, "direction": "output", "createdAtMs": 374815, "content": {"type": "assistant", "message": {"model": "claude-opus-5-5", "id": "msg_anon_14", "role": "assistant", "content": [{"type": "text", "text": "Implement B."}]}, "parent_tool_use_id": "toolu_anon_02", "session_id": "sdk-session-anon"}},
  {"id": 23, "direction": "output", "createdAtMs": 622033, "content": {"type": "assistant", "message": {"model": "claude-opus-5-5", "id": "msg_anon_15", "role": "assistant", "content": [{"type": "tool_use", "id": "toolu_anon_16", "name": "SubagentHandback", "input": {"message": "Report."}}]}, "parent_tool_use_id": "toolu_anon_02", "session_id": "sdk-session-anon"}},
  {"id": 24, "direction": "output", "createdAtMs": 624677, "content": {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_anon_16", "content": "ok"}]}, "parent_tool_use_id": "toolu_anon_02", "session_id": "sdk-session-anon"}},
  {"id": 25, "direction": "output", "createdAtMs": 624707, "content": {"type": "system", "subtype": "init"}},
  {"id": 26, "direction": "output", "createdAtMs": 626816, "content": {"type": "assistant", "message": {"model": "claude-opus-5-5", "id": "msg_anon_17", "role": "assistant", "content": [{"type": "text", "text": "I handed the report to the lead."}]}, "parent_tool_use_id": "toolu_anon_02", "session_id": "sdk-session-anon"}},
  {"id": 27, "direction": "output", "createdAtMs": 626828, "content": {"type": "system", "subtype": "background_tasks_changed", "tasks": []}},
  {"id": 28, "direction": "input", "createdAtMs": 626861, "content": {"prompt": "User prompt 287."}},
] as const;

export const SUBAGENT_TEXTS = ["Now the code.", "Now part B tests (red first).", "Implement B.", "I handed the report to the lead."];
export const LEAD_TEXT = "Lead: the duplicate search runs in the background; the summary follows when it reports.";

export function subagentTextRows(sessionId: string): RawMessage[] {
  return ROWS.map(({ id, direction, createdAtMs, content }) => ({
    id, sessionId, source: 'claude-code', direction,
    createdAt: new Date(Date.UTC(2026, 0, 1) + createdAtMs),
    content: JSON.stringify(content),
  }));
}
