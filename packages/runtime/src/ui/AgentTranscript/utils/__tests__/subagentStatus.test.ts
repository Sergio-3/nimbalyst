// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { TranscriptViewMessage } from '../../../../ai/server/transcript/TranscriptProjector';
import { subagentStatus } from '../subagentStatus';

function agent(opts: { result?: string; isError?: boolean; background?: boolean; progress?: number; children?: number } = {}): TranscriptViewMessage {
  return {
    id: 1, sequence: 1, createdAt: new Date(0), type: 'subagent', subagentId: 'agent-1', isError: opts.isError,
    subagent: {
      isBackground: opts.background,
      childEvents: Array.from({ length: opts.children ?? 0 }, (_, i) => ({ id: 10 + i, type: 'tool_call' })),
    } as unknown as TranscriptViewMessage['subagent'],
    toolCall: {
      toolName: 'Task', toolDisplayName: 'Task', status: opts.result ? 'completed' : 'running', description: null,
      arguments: {}, targetFilePath: null, mcpServer: null, mcpTool: null, providerToolCallId: 'agent-1',
      progress: Array.from({ length: opts.progress ?? 0 }, (_, i) => ({ elapsedSeconds: i, progressContent: 'Read' })),
      ...(opts.result ? { result: opts.result } : {}),
    },
  };
}

const LAUNCH_ACK = 'Async agent launched successfully. agentId: agent-1';
const INTERCEPTED = 'Teammate "scout" has been spawned by Nimbalyst and is now running. agent_id: scout@team.';
const USER_REJECTED = "The user doesn't want to proceed with this tool use. The tool use was rejected.";

describe('subagentStatus', () => {
  it('trusts the live agent status over the spawn acknowledgement over the result', () => {
    const teammates = [{ agentId: 'agent-1', status: 'errored' as const }];
    expect(subagentStatus(agent({ result: 'done', isError: true }), { currentTeammates: teammates, sessionActive: false })).toBe('errored');
    // The host's teammate spawn reports an error result naming the agent it started.
    expect(subagentStatus(agent({ result: INTERCEPTED, isError: true }), { sessionActive: false })).toBe('running');
    expect(subagentStatus(agent({ result: 'All set.' }), { sessionActive: true })).toBe('done');
  });

  it('calls a spawn that was refused before it started Denied, not Running', () => {
    // User rejection or a permission classifier: an error result and no agent behind it.
    expect(subagentStatus(agent({ result: USER_REJECTED, isError: true }), { sessionActive: false })).toBe('denied');
    expect(subagentStatus(agent({ result: USER_REJECTED, isError: true }), { sessionActive: true })).toBe('denied');
    expect(subagentStatus(agent({ result: USER_REJECTED, isError: true }), {})).toBe('denied');
    // It started and then failed: that is an error, not a refusal.
    expect(subagentStatus(agent({ result: 'API Error: overloaded', isError: true, children: 2 }), { sessionActive: false })).toBe('errored');
  });

  it('calls an agent without a result Stopped only when nothing works on the session any more', () => {
    expect(subagentStatus(agent(), { sessionActive: false })).toBe('stopped');
    // Handed over to the background drain: the session reads idle, the agent runs.
    expect(subagentStatus(agent(), { sessionActive: true })).toBe('running');
    // The host does not report activity: never claim Stopped.
    expect(subagentStatus(agent(), {})).toBeNull();
    expect(subagentStatus(agent({ progress: 1 }), {})).toBe('running');
  });

  it('reads a background launch acknowledgement as Running while the session works, Done after', () => {
    expect(subagentStatus(agent({ result: LAUNCH_ACK, background: true }), { sessionActive: true })).toBe('running');
    expect(subagentStatus(agent({ result: LAUNCH_ACK, background: true }), { sessionActive: false })).toBe('done');
    expect(subagentStatus(agent({ result: 'Task is now running in the background' }), { sessionActive: true })).toBe('running');
    expect(subagentStatus(agent({ result: LAUNCH_ACK, background: true }), {})).toBe('done');
  });
});
