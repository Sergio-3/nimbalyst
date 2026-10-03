// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { TranscriptViewMessage } from '../../../../ai/server/transcript/TranscriptProjector';
import { bundleRole, groupToolCalls, formatToolCallBundleSummary, summarizeBundleMembers, type ToolCallGroup } from '../toolCallBundles';

let nextId = 1;

function tool(
  toolName: string,
  opts: {
    status?: 'running' | 'completed' | 'error';
    isError?: boolean;
    type?: 'tool_call' | 'subagent' | 'interactive_prompt';
    args?: Record<string, unknown>;
    result?: string;
  } = {},
): TranscriptViewMessage {
  const id = nextId++;
  const status = opts.status ?? 'completed';
  return {
    id,
    sequence: id,
    createdAt: new Date(id * 1000),
    type: opts.type ?? 'tool_call',
    subagentId: null,
    isError: opts.isError,
    toolCall: {
      toolName,
      toolDisplayName: toolName,
      status,
      description: null,
      arguments: opts.args ?? {},
      targetFilePath: null,
      mcpServer: null,
      mcpTool: null,
      providerToolCallId: `call-${id}`,
      progress: [],
      ...(status === 'running' ? {} : { result: opts.result ?? 'ok' }),
      ...(opts.isError ? { isError: true } : {}),
    },
  };
}

function message(overrides: Partial<TranscriptViewMessage>): TranscriptViewMessage {
  const id = nextId++;
  return { id, sequence: id, createdAt: new Date(id * 1000), type: 'assistant_message', subagentId: null, ...overrides };
}

const text = (value: string) => message({ text: value });
const thinking = (value = 'considering') => message({ text: '', thinking: value });
const userMsg = (overrides: Partial<TranscriptViewMessage> = {}) => message({ type: 'user_message', text: 'hello', ...overrides });
const system = (systemMessage: TranscriptViewMessage['systemMessage'], value = '[System: note]') =>
  message({ type: 'system_message', text: value, systemMessage });

function shape(groups: ToolCallGroup[]): string[] {
  return groups.map((g) => (g.kind === 'bundle' ? `bundle(${g.indices.join(',')})` : `item(${g.index})`));
}

function role(m: TranscriptViewMessage, showThinking = true): string {
  const r = bundleRole(m, { showThinking });
  return r.kind === 'member' ? r.member : r.kind;
}

describe('bundleRole', () => {
  // Only the lead agent's text and what is meant for the user stays visible;
  // every other step joins a bundle, and nothing invisible splits one.
  it.each<[string, () => TranscriptViewMessage, string, boolean?]>([
    ['plain tool call', () => tool('Read'), 'tool'],
    ['MCP tool call', () => tool('mcp__nimbalyst-trackers__tracker_list'), 'tool'],
    ['editor screenshot (the agent checking its own work)', () => tool('mcp__nimbalyst__capture_editor_screenshot'), 'tool'],
    ['super-loop progress that needs no answer', () => tool('mcp__nimbalyst-super-loop__super_loop_progress_update', { args: { status: 'running' } }), 'tool'],
    ['open question', () => tool('mcp__nimbalyst__AskUserQuestion', { status: 'running' }), 'separator'],
    ['answered question', () => tool('mcp__nimbalyst__PromptForUserInput', { result: '{"answers":{}}' }), 'separator'],
    ['permission prompt', () => tool('ToolPermission', { type: 'interactive_prompt', status: 'running' }), 'separator'],
    ['feedback draft', () => tool('mcp__nimbalyst-situational__RequestFeedback'), 'separator'],
    ['content shown to the user', () => tool('mcp__nimbalyst__display_to_user'), 'separator'],
    ['blocked super-loop', () => tool('mcp__nimbalyst-super-loop__super_loop_progress_update', { args: { status: 'blocked' } }), 'separator'],
    ['sub-agent row', () => tool('Task', { type: 'subagent' }), 'separator'],
    ['Task as a plain tool call', () => tool('Task'), 'separator'],
    ['Agent as a plain tool call', () => tool('Agent'), 'separator'],
    ['sibling-cancelled Task', () => tool('Task', { isError: true, result: '<tool_use_error>Sibling tool call errored</tool_use_error>' }), 'invisible'],
    ['agent text', () => text('Found it.'), 'separator'],
    ['error without text', () => message({ text: '', isError: true }), 'separator'],
    ['auth error', () => message({ text: '', isAuthError: true }), 'separator'],
    ['thinking block', () => thinking(), 'thinking'],
    ['thinking block while thinking is hidden', () => thinking(), 'invisible', false],
    ['empty assistant row', () => message({ text: '' }), 'invisible'],
    ['human message', () => userMsg({ promptActor: 'human' }), 'separator'],
    ['message without provenance', () => userMsg(), 'separator'],
    ['optimistic send', () => userMsg({ optimistic: true }), 'separator'],
    ['optimistic send that reads like the answer resume', () => userMsg({ optimistic: true, text: '[Resuming after answering a question]\n\nq: a' }), 'separator'],
    ['agent instruction to this session', () => userMsg({ promptActor: 'agent', promptMessageKind: 'instruction' }), 'separator'],
    ['agent send without a kind', () => userMsg({ promptActor: 'agent' }), 'separator'],
    ['child question to the parent', () => userMsg({ promptActor: 'agent', promptMessageKind: 'question' }), 'separator'],
    ['child report', () => userMsg({ promptActor: 'agent', promptMessageKind: 'report' }), 'message'],
    ['child status update', () => userMsg({ promptActor: 'agent', promptMessageKind: 'status' }), 'message'],
    ['system send (super-loop round, wakeup)', () => userMsg({ promptActor: 'system' }), 'message'],
    ['answer auto-resume by origin', () => userMsg({ promptOrigin: 'interactive-question' }), 'message'],
    ['answer auto-resume by prefix', () => userMsg({ text: '[Resuming after answering a question]\n\nq: a' }), 'message'],
    ['teammate notification', () => userMsg({ metadata: { isTeammateMessage: true } }), 'message'],
    ['denied by rule', () => system({ systemType: 'permission_denied', deniedToolName: 'Bash', deniedReasonType: 'rule' }), 'denied'],
    ['denied attachment staging', () => system({ systemType: 'permission_denied', isAttachmentStagingDenied: true } as TranscriptViewMessage['systemMessage']), 'separator'],
    ['classifier denial', () => system({ systemType: 'permission_denied', deniedReasonType: 'classifier' }), 'invisible'],
    ['status notice', () => system({ systemType: 'status' }), 'notice'],
    ['slash command notice', () => system({ systemType: 'slash_command' }), 'notice'],
    ['system reminder prompt', () => userMsg({ metadata: { promptType: 'system_reminder' } }), 'notice'],
    ['empty notice', () => system({ systemType: 'status' }, ''), 'invisible'],
    ['system error', () => system({ systemType: 'error' }, 'boom'), 'separator'],
  ])('%s', (_label, make, expected, showThinking = true) => {
    expect(role(make(), showThinking)).toBe(expected);
  });
});

describe('groupToolCalls', () => {
  it('bundles from a single member and lets visible text split runs', () => {
    const messages = [tool('Bash'), text('Found it.'), tool('Edit'), thinking(), tool('Bash'), text('Done.')];
    expect(shape(groupToolCalls(messages))).toEqual(['bundle(0)', 'item(1)', 'bundle(2,3,4)', 'item(5)']);
  });

  it('lets invisible rows neither split nor count, and separators end a run', () => {
    const messages = [
      tool('Bash'),
      message({ text: '' }),
      tool('Read'),
      tool('mcp__nimbalyst-mcp__AskUserQuestion', { status: 'running' }),
      tool('Glob'),
      tool('Task', { type: 'subagent' }),
      tool('Grep'),
    ];
    expect(shape(groupToolCalls(messages))).toEqual(['bundle(0,2)', 'item(3)', 'bundle(4)', 'item(5)', 'bundle(6)']);
  });

  it('skips excluded indices without letting them split or count', () => {
    const messages = [tool('Bash'), tool('Bash'), tool('Read')];
    expect(shape(groupToolCalls(messages, { exclude: new Set([1]) }))).toEqual(['bundle(0,2)']);
  });

  it('can drop non-tool separators where they are not rendered', () => {
    const messages = [tool('Bash'), text('child chatter'), tool('Read')];
    expect(shape(groupToolCalls(messages, { textSeparates: false }))).toEqual(['bundle(0,2)']);
  });
});

describe('bundle summary', () => {
  it('counts calls by kind, denials as calls, and the other steps by kind', () => {
    const messages = [
      tool('Bash'),
      tool('command_execution'),
      tool('Edit'),
      tool('Write'),
      tool('apply_patch'),
      tool('Read'),
      tool('Grep'),
      tool('Glob'),
      tool('mcp__nimbalyst-trackers__tracker_list'),
      system({ systemType: 'permission_denied', deniedToolName: 'Bash', deniedReasonType: 'mode' }),
      thinking(),
      thinking(),
      userMsg({ promptActor: 'agent', promptMessageKind: 'report' }),
      system({ systemType: 'status' }),
    ];
    const [group] = groupToolCalls(messages);
    if (group.kind !== 'bundle') throw new Error('expected a bundle');
    expect(group.summary).toMatchObject({
      total: 10,
      counts: { commands: 2, fileEdits: 3, reads: 1, searches: 2, other: 1, denied: 1 },
      thinking: 2,
      messages: 1,
      notices: 1,
      failed: 0,
    });
    expect(formatToolCallBundleSummary(group.summary)).toBe(
      '10 tool calls · 2 commands, 3 file edits, 1 read, 2 searches, 1 other, 1 denied · 2 thinking blocks, 1 message, 1 notice',
    );
  });

  it('uses the singular and shows only the parts that exist', () => {
    const one = groupToolCalls([tool('Bash')])[0];
    const onlyThinking = groupToolCalls([thinking()])[0];
    if (one.kind !== 'bundle' || onlyThinking.kind !== 'bundle') throw new Error('expected bundles');
    expect(formatToolCallBundleSummary(one.summary)).toBe('1 tool call · 1 command');
    expect(formatToolCallBundleSummary(onlyThinking.summary)).toBe('1 thinking block');
  });

  it('reports running and failed calls; a denial is counted, not failed', () => {
    const [group] = groupToolCalls([
      tool('Bash', { isError: true }),
      tool('Read', { status: 'error' }),
      tool('Bash', { status: 'running' }),
      system({ systemType: 'permission_denied', deniedToolName: 'Bash', deniedReasonType: 'rule' }),
    ]);
    if (group.kind !== 'bundle') throw new Error('expected a bundle');
    expect(group.summary.running).toBe(1);
    expect(group.summary.failed).toBe(2);
  });

  it('summarizes every member of a list, across separators', () => {
    const summary = summarizeBundleMembers([tool('Read'), text('Now the edit.'), tool('Edit'), thinking()]);
    expect(formatToolCallBundleSummary(summary)).toBe('2 tool calls · 1 file edit, 1 read · 1 thinking block');
  });
});
