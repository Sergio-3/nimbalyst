import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptViewMessage } from '../../../../ai/server/transcript/TranscriptProjector';
import type { TranscriptSettings } from '../../types';
import { RichTranscriptView } from '../RichTranscriptView';

vi.mock('virtua', async () => {
  const ReactModule = await import('react');
  return {
    VList: ReactModule.forwardRef(({ children }: { children: React.ReactNode }, ref) => {
      ReactModule.useImperativeHandle(ref, () => ({
        cache: undefined,
        scrollOffset: 0,
        scrollSize: 300,
        viewportSize: 100,
        findItemIndex: () => 0,
        scrollToIndex: vi.fn(),
      }));
      return <div data-testid="mock-vlist">{ReactModule.Children.toArray(children)}</div>;
    }),
  };
});

let nextId = 1;

function base(type: TranscriptViewMessage['type']): Pick<TranscriptViewMessage, 'id' | 'sequence' | 'createdAt' | 'type' | 'subagentId'> {
  const id = nextId++;
  return { id, sequence: id, createdAt: new Date(1_784_648_445_000 + id * 1000), type, subagentId: null };
}

function tool(toolName: string, args: Record<string, unknown> = {}): TranscriptViewMessage {
  const msg = base('tool_call');
  return {
    ...msg,
    toolCall: {
      toolName,
      toolDisplayName: toolName,
      status: 'completed',
      description: null,
      arguments: args,
      targetFilePath: typeof args.file_path === 'string' ? args.file_path : null,
      mcpServer: null,
      mcpTool: null,
      providerToolCallId: `call-${msg.id}`,
      progress: [],
      result: 'ok',
    },
  };
}

const user = (text: string): TranscriptViewMessage => ({ ...base('user_message'), text });
const assistant = (text: string): TranscriptViewMessage => ({ ...base('assistant_message'), text });
const thinking = (value: string): TranscriptViewMessage => ({ ...base('assistant_message'), text: '', thinking: value });

const editCall = () => tool('Edit', {
  file_path: '/workspace/src/app.ts',
  old_string: 'export const x = 1;',
  new_string: 'export const x = 2;',
});

function subagentRow(childEvents: TranscriptViewMessage[] = [
  tool('Read', { file_path: '/workspace/a.ts' }), tool('Grep', { pattern: 'y' }),
]): TranscriptViewMessage {
  return {
    ...base('subagent'),
    subagentId: 'agent-1',
    toolCall: {
      toolName: 'Task',
      toolDisplayName: 'Task',
      status: 'completed',
      description: null,
      arguments: { prompt: 'look around', description: 'Explore' },
      targetFilePath: null,
      mcpServer: null,
      mcpTool: null,
      providerToolCallId: 'agent-1',
      progress: [],
      result: 'done',
    },
    subagent: { childEvents } as unknown as TranscriptViewMessage['subagent'],
  };
}

function settings(collapseTools: boolean, showThinking = true): TranscriptSettings {
  return { showToolCalls: true, showThinking, compactMode: false, collapseTools, showSessionInit: false };
}

function renderTranscript(messages: TranscriptViewMessage[], collapseTools: boolean, showThinking = true) {
  return render(
    <RichTranscriptView
      sessionId={`bundles-${nextId}`}
      sessionStatus="idle"
      messages={messages}
      provider="claude-code"
      workspacePath="/workspace"
      settings={settings(collapseTools, showThinking)}
      persistScrollState={false}
    />,
  );
}

describe('RichTranscriptView tool-call bundles', () => {
  beforeEach(() => {
    vi.stubGlobal('CSS', { highlights: { delete: vi.fn(), set: vi.fn() } });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  it('collapses back-to-back calls before the reply into one row, with diffs closed until asked for', () => {
    const { container } = renderTranscript(
      [user('Fix it'), tool('Read', { file_path: '/workspace/src/app.ts' }), tool('Grep', { pattern: 'x' }), editCall(), assistant('Done.')],
      true,
    );

    expect(container.querySelectorAll('.rich-transcript-tool-bundle')).toHaveLength(1);
    expect(screen.getByText('3 tool calls · 1 file edit, 1 read, 1 search')).toBeDefined();
    expect(container.querySelector('.rich-transcript-edit-card')).toBeNull();
    expect(screen.getByText('Done.')).toBeDefined();

    fireEvent.click(container.querySelector('.rich-transcript-tool-bundle-button')!);
    expect(container.querySelectorAll('.rich-transcript-tool-bundle-items .rich-transcript-tool-card')).toHaveLength(2);
    expect(container.querySelector('.rich-transcript-edit-card')).not.toBeNull();
    expect(container.querySelector('.rich-transcript-edit-card__diffs')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show changes' }));
    expect(screen.getByText('export const x = 2;')).toBeDefined();
  });

  it('bundles a trailing run of calls that has no reply yet into one row', () => {
    const { container } = renderTranscript(
      [user('Go'), tool('Read', { file_path: '/workspace/a.ts' }), tool('Read', { file_path: '/workspace/b.ts' })],
      true,
    );

    expect(container.querySelectorAll('.rich-transcript-tool-bundle')).toHaveLength(1);
    expect(container.querySelectorAll('.rich-transcript-tool-container.orphan')).toHaveLength(1);
    expect(screen.getByText('2 tool calls · 2 reads')).toBeDefined();
  });

  it('folds thinking into the bundle and keeps one header for the turn', () => {
    const { container } = renderTranscript(
      [user('Look'), thinking('first idea'), tool('Read', { file_path: '/workspace/a.ts' }), thinking('second idea'), assistant('Here it is.')],
      true,
    );

    expect(container.querySelectorAll('.rich-transcript-tool-bundle')).toHaveLength(1);
    screen.getByText('1 tool call · 1 read · 2 thinking blocks');
    // You, then the agent once: the reply continues the bundle's group.
    expect(container.querySelectorAll('.rich-transcript-message-header')).toHaveLength(2);
    expect(container.querySelector('.rich-transcript-bundle-host .rich-transcript-message-header')).not.toBeNull();

    fireEvent.click(container.querySelector('.rich-transcript-tool-bundle-button')!);
    expect(container.querySelectorAll('.rich-transcript-tool-bundle-items .rich-transcript-thinking')).toHaveLength(2);
  });

  it('marks a bundle whose call failed, as the projector reports it', () => {
    const failed = tool('Bash', { command: 'false' });
    // The projector sets the error on the tool call, never on the message.
    failed.toolCall = { ...failed.toolCall!, status: 'error', isError: true, result: 'exit 1' };
    const { container } = renderTranscript([user('Run'), tool('Read', { file_path: '/workspace/a.ts' }), failed, assistant('It failed.')], true);

    expect(container.querySelector('.rich-transcript-tool-bundle-failed')).not.toBeNull();
    expect(container.querySelector('.rich-transcript-tool-bundle .rich-transcript-tool-success')).toBeNull();
  });

  it('shows a sub-agent as one line with what it did, and bundles its children when opened', () => {
    const { container } = renderTranscript([user('Delegate'), subagentRow(), assistant('Agent finished.')], true);

    expect(container.querySelector('.rich-transcript-subagent-children')).toBeNull();
    expect(container.querySelector('.rich-transcript-subagent-work')!.textContent).toBe('2 tool calls · 1 read, 1 search');

    fireEvent.click(container.querySelector('.rich-transcript-tool-card.sub-agent .rich-transcript-tool-button')!);
    const children = container.querySelector('.rich-transcript-subagent-children');
    expect(children!.querySelectorAll('.rich-transcript-tool-bundle')).toHaveLength(1);
  });

  it.each([
    [true, true], [false, true], [true, false], [false, false],
  ])('shows a sub-agent\'s own text and thinking in its opened card (grouping %s, thinking %s)', (grouping, showThinking) => {
    const row = subagentRow([tool('Read', { file_path: '/workspace/a.ts' }), assistant('Now the code.'), thinking('next step'), tool('Grep', { pattern: 'y' })]);
    const { container } = renderTranscript([user('Delegate'), row, assistant('Agent finished.')], grouping, showThinking);
    if (grouping) fireEvent.click(container.querySelector('.rich-transcript-tool-card.sub-agent .rich-transcript-tool-button')!);

    const children = container.querySelector('.rich-transcript-subagent-children')!;
    expect(children.querySelector('.rich-transcript-subagent-text')!.textContent).toContain('Now the code.');
    // The text separates the child's steps; with grouping off every card stands alone.
    expect(children.querySelectorAll('.rich-transcript-tool-bundle')).toHaveLength(grouping ? 2 : 0);
    // The child's thinking left the lead's reply; it shows here or, when hidden, nowhere.
    children.querySelectorAll('.rich-transcript-tool-bundle-button').forEach(button => fireEvent.click(button));
    const thoughts = [...children.querySelectorAll('.rich-transcript-thinking')].map(el => el.textContent ?? '');
    expect(thoughts.some(t => t.includes('next step'))).toBe(showThinking);
    if (!showThinking) expect(container.textContent).not.toContain('next step');
  });

  it('opens sub-agents by default when grouping is off', () => {
    const { container } = renderTranscript([user('Delegate'), subagentRow(), assistant('Agent finished.')], false);
    expect(container.querySelector('.rich-transcript-subagent-children')).not.toBeNull();
    expect(container.querySelector('.rich-transcript-subagent-work')).toBeNull();
  });

  describe('a turn with an automated message folded into it', () => {
    afterEach(() => vi.restoreAllMocks());
    const T0 = 1_784_648_445_000;
    const at = (sec: number, message: TranscriptViewMessage): TranscriptViewMessage => ({ ...message, createdAt: new Date(T0 + sec * 1000) });
    const turn = (automated: Partial<TranscriptViewMessage>): TranscriptViewMessage[] => [
      at(0, user('Go')),
      at(60, tool('Edit', { file_path: '/workspace/a.ts', old_string: 'a', new_string: 'b' })),
      at(90, tool('Edit', { file_path: '/workspace/b.ts', old_string: 'a', new_string: 'b' })),
      at(120, assistant('Edited two files, waiting for the child.')),
      at(300, { ...user('automated'), ...automated }),
      at(310, assistant('Child reported, done.')),
    ];
    const AUTOMATED: Array<[string, Partial<TranscriptViewMessage>]> = [
      ['a child session report', { text: '[Child Session Update] done', promptActor: 'agent', promptMessageKind: 'report' }],
      ['a system send', { text: 'wake up', promptActor: 'system' }],
      ['the resume after an answer', { text: '[Resuming after answering a question]', promptOrigin: 'interactive-question' }],
    ];

    // The folded message is not a turn start: the visible turn runs from "Go".
    it.each(AUTOMATED)('times "Finished in" and counts files from the visible start (%s)', (_name, automated) => {
      const { container } = renderTranscript(turn(automated), true);
      const finished = [...container.querySelectorAll('.rich-transcript-turn-elapsed')].map(el => el.textContent ?? '');
      expect(finished).toHaveLength(1);
      expect(finished[0]).toMatch(/^Finished in 5m 10s/);
      expect(finished[0]).toContain('2 files');
    });

    it('counts the waiting time from the visible start', () => {
      vi.spyOn(Date, 'now').mockReturnValue(T0 + 320_000);
      // The counter ticks on animation frames; one synchronous frame would never end.
      vi.stubGlobal('requestAnimationFrame', () => 1);
      const messages = turn(AUTOMATED[0][1]).slice(0, 5);
      render(
        <RichTranscriptView
          sessionId={`bundles-${nextId}`}
          sessionStatus="running"
          messages={messages}
          provider="claude-code"
          workspacePath="/workspace"
          settings={settings(true)}
          persistScrollState={false}
        />,
      );
      expect(screen.getByTestId('turn-elapsed').textContent).toBe('5m 20s');
    });
  });

  it('renders every call on its own, diffs open, when grouping is off', () => {
    const { container } = renderTranscript(
      [user('Fix it'), tool('Read', { file_path: '/workspace/src/app.ts' }), editCall(), assistant('Done.')],
      false,
    );

    expect(container.querySelector('.rich-transcript-tool-bundle')).toBeNull();
    expect(container.querySelector('.rich-transcript-edit-card__diffs')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Show changes' })).toBeNull();
  });
});
