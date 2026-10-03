// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { TranscriptViewMessage } from '../../../../ai/server/transcript/TranscriptProjector';
import { planTranscriptRows, type RowPlanOptions, type TranscriptRowPlan } from '../transcriptRowPlan';
import { isToolLikeMessage } from '../messageTypeHelpers';

// Compact fixtures: one letter code per message.
//   U user · T text · K thinking · E empty assistant · R Read · B Bash
//   Q open AskUserQuestion · P ToolPermission prompt · S sub-agent · M child report (agent)
function build(codes: string): TranscriptViewMessage[] {
  return codes.split(' ').map((code, i) => {
    const seq = i + 1;
    const base = { id: seq, sequence: seq, createdAt: new Date(seq * 1000), subagentId: null };
    const tool = (toolName: string, type: TranscriptViewMessage['type'] = 'tool_call', running = false): TranscriptViewMessage => ({
      ...base,
      type,
      toolCall: {
        toolName, toolDisplayName: toolName, status: running ? 'running' : 'completed', description: null, arguments: {},
        targetFilePath: null, mcpServer: null, mcpTool: null, providerToolCallId: `call-${seq}`, progress: [],
        ...(running ? {} : { result: 'ok' }),
      },
    });
    switch (code) {
      case 'U': return { ...base, type: 'user_message', text: `prompt ${seq}` };
      case 'M': return { ...base, type: 'user_message', text: `report ${seq}`, promptActor: 'agent', promptMessageKind: 'report' };
      case 'T': return { ...base, type: 'assistant_message', text: `text ${seq}` };
      case 'K': return { ...base, type: 'assistant_message', text: '', thinking: `thought ${seq}` };
      case 'E': return { ...base, type: 'assistant_message', text: '' };
      case 'R': return tool('Read');
      case 'B': return tool('Bash');
      case 'Q': return tool('mcp__nimbalyst__AskUserQuestion', 'tool_call', true);
      case 'P': return tool('ToolPermission', 'interactive_prompt', true);
      case 'S': return tool('Task', 'subagent');
      default: throw new Error(`unknown code ${code}`);
    }
  });
}

const GROUPED: RowPlanOptions = { grouping: true, showToolCalls: true, showThinking: true, superseded: new Set() };
const plan = (codes: string, options: Partial<RowPlanOptions> = {}) => planTranscriptRows(build(codes), { ...GROUPED, ...options });

/** Every visible card and every bundle has a visible row that draws it. */
function assertEveryCardDrawn(messages: TranscriptViewMessage[], p: TranscriptRowPlan) {
  for (let i = 0; i < messages.length; i++) {
    const bundle = p.bundleOf[i];
    if (bundle !== undefined) {
      const { hostRow, members } = p.bundles[bundle];
      expect(p.role[hostRow], `host of bundle with ${i}`).not.toBe('hidden');
      expect(p.carried[hostRow]).toContain(members[0]);
      continue;
    }
    if (!isToolLikeMessage(messages[i])) continue;
    const row = p.renderRow[i];
    expect(p.role[row], `row drawing card ${i}`).not.toBe('hidden');
    expect(p.carried[row]).toContain(i);
  }
}

describe('planTranscriptRows', () => {
  it('folds thinking and tool calls between two sentences into one bundle hosted by the first row', () => {
    const p = plan('U K R B K R T');
    expect(p.bundles).toHaveLength(1);
    expect(p.bundles[0].members).toEqual([1, 2, 3, 4, 5]);
    expect(p.bundles[0].hostRow).toBe(1);
    expect(p.role).toEqual(['self', 'host', 'hidden', 'hidden', 'hidden', 'hidden', 'self']);
    expect(p.carried[6]).toEqual([]);
    // One header per turn: on the host, not again on the reply.
    expect(p.isNewGroup[1]).toBe(true);
    expect(p.isNewGroup[6]).toBe(false);
    expect(p.turnEnd[1]).toBeNull();
    expect(p.turnEnd[6]).toEqual({ endIndex: 6, open: true });
  });

  it('keeps a child report between two sentences inside the agent group', () => {
    const p = plan('U T M T');
    expect(p.role).toEqual(['self', 'self', 'host', 'self']);
    expect(p.isNewGroup).toEqual([true, true, false, false]);
    expect(p.turnEnd[1]).toBeNull();
    expect(p.turnEnd[3]).toEqual({ endIndex: 3, open: true });
  });

  it('ends a turn on a trailing hidden thinking row', () => {
    const p = plan('U T K U T');
    expect(p.role[2]).toBe('host');
    expect(p.turnEnd[1]).toBeNull();
    expect(p.turnEnd[2]).toEqual({ endIndex: 2, open: false });
    const stopped = plan('U K B K U');
    expect(stopped.role.slice(1, 4)).toEqual(['host', 'hidden', 'hidden']);
    expect(stopped.turnEnd[1]).toEqual({ endIndex: 3, open: false });
  });

  it.each([
    'Q R K T',
    'K R Q K T',
    'R E Q E',
    'U S K T',
    'U P R T',
    'U R B',
    'U K R S B K T U Q',
    'U M R T M',
    'U E E R E T',
  ])('draws every visible card and bundle in a visible row: %s', codes => {
    const messages = build(codes);
    const p = planTranscriptRows(messages, GROUPED);
    assertEveryCardDrawn(messages, p);
    // Prompts the user must act on stay outside bundles, in the row that
    // pending-question and permission navigation compute for them.
    messages.forEach((m, i) => {
      if (m.toolCall?.status === 'running') expect(p.bundleOf[i]).toBeUndefined();
    });
  });

  it('keeps an open question visible when it precedes the bundle in the same row', () => {
    const p = plan('Q R K T');
    expect(p.renderRow[0]).toBe(2);
    expect(p.role[2]).toBe('host');
    expect(p.carried[2]).toEqual([0, 1]);
  });

  it('targets the bundle host for a member behind it, and the drawing row otherwise', () => {
    const p = plan('U K R M K T U');
    expect(p.targetRow(3)).toBe(1);
    expect(p.targetRow(4)).toBe(1);
    expect(p.targetRow(2)).toBe(1);
    expect(p.targetRow(5)).toBe(5);
    expect(p.visibleRowAtOrAfter(2)).toBe(5);
  });

  it('keeps bundle ids and moves hosts only forward while streaming, from the first member on', () => {
    const codes = 'U K R B K R T U R B T U E R K Q'.split(' ');
    let previous: { ids: Map<number, string>; hosts: Map<number, number> } | null = null;
    for (let length = 1; length <= codes.length; length++) {
      // Rebuilt events get fresh ids; sequences stay.
      const messages = build(codes.slice(0, length).join(' ')).map(m => ({ ...m, id: m.id + length * 1000 }));
      const p = planTranscriptRows(messages, GROUPED);
      const ids = new Map<number, string>();
      const hosts = new Map<number, number>();
      for (const bundle of p.bundles) {
        ids.set(bundle.members[0], bundle.id);
        hosts.set(bundle.members[0], bundle.hostRow);
      }
      messages.forEach((m, i) => {
        if (m.toolCall && m.toolCall.status !== 'running') expect(p.bundleOf[i], `prefix ${length}, call ${i}`).toBeDefined();
      });
      if (previous) {
        for (const [first, id] of previous.ids) {
          if (!ids.has(first)) continue;
          expect(ids.get(first), `prefix ${length}`).toBe(id);
          expect(hosts.get(first)!).toBeGreaterThanOrEqual(previous.hosts.get(first)!);
        }
      }
      previous = { ids, hosts };
    }
  });

  it('reproduces the ungrouped transcript when grouping is off', () => {
    const messages = build('U K R B K R T U R Q');
    messages[3] = { ...messages[3], toolCall: { ...messages[3].toolCall!, providerToolCallId: 'call-6' } };
    const p = planTranscriptRows(messages, { ...GROUPED, grouping: false, superseded: new Set([3]) });
    expect(p.bundles).toEqual([]);
    expect(p.role).toEqual(['self', 'self', 'hidden', 'hidden', 'self', 'hidden', 'self', 'self', 'self', 'self']);
    // Calls draw before the next assistant row; a superseded call still does.
    expect(p.carried[4]).toEqual([2, 3]);
    expect(p.carried[6]).toEqual([5]);
    expect(p.carried[8]).toEqual([8]);
    // Assistant rows after an assistant row continue the group, thinking or not.
    expect([1, 4, 6].map(i => p.isNewGroup[i])).toEqual([true, false, false]);
    expect(p.turnEnd[6]).toEqual({ endIndex: 6, open: false });
    expect(p.targetRow(2)).toBe(4);

    const hiddenTools = planTranscriptRows(messages, { ...GROUPED, grouping: false, showToolCalls: false, superseded: new Set() });
    expect(hiddenTools.carried[4]).toEqual([]);
    expect(hiddenTools.role[8]).toBe('hidden');
    expect(hiddenTools.role[9]).toBe('self');
  });
});
