import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptViewMessage } from '../../../../ai/server/transcript/TranscriptProjector';
import type { RawMessage } from '../../../../ai/server/transcript/TranscriptTransformer';
import { projectRawMessagesToViewMessages } from '../../../../ai/server/transcript/projectRawMessages';
import { RichTranscriptView } from '../RichTranscriptView';

const vlistState = vi.hoisted(() => ({
  childCount: 0,
  scrollToIndex: vi.fn(),
  scrollBy: vi.fn(),
}));

vi.mock('virtua', async () => {
  const ReactModule = await import('react');

  return {
    VList: ReactModule.forwardRef(({ children }: { children: React.ReactNode }, ref) => {
      const rows = ReactModule.Children.toArray(children);
      vlistState.childCount = rows.length;

      ReactModule.useImperativeHandle(ref, () => ({
        cache: undefined,
        scrollOffset: 0,
        scrollSize: 300,
        viewportSize: 100,
        findItemIndex: (offset: number) => offset >= 100 ? 1 : 0,
        scrollToIndex: vlistState.scrollToIndex,
        scrollBy: vlistState.scrollBy,
      }));

      return <div data-testid="mock-vlist">{rows}</div>;
    }),
  };
});

describe('pending question navigation', () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  const flushFrames = () => {
    for (let i = 0; i < 12 && frames.size; i++) {
      act(() => {
        const callbacks = [...frames.values()];
        frames.clear();
        callbacks.forEach(callback => callback(0));
      });
    }
    expect(frames.size).toBe(0);
  };
  const question = (index: number, toolName = 'AskUserQuestion', result?: string) => makeMessage(index, {
    type: 'tool_call',
    toolCall: {
      toolName, status: 'running', toolDisplayName: toolName, description: null,
      arguments: toolName.endsWith('AskUserQuestion')
        ? { questions: [{ header: 'Next', question: 'Continue?', options: [{ label: 'Yes', description: 'Continue' }] }] }
        : { fields: [{ type: 'confirm', id: 'continue', label: 'Continue?' }] },
      result, targetFilePath: null, mcpServer: null, mcpTool: null,
      providerToolCallId: `question-${index}`, progress: [],
    },
  });
  const view = (messages: TranscriptViewMessage[], sessionId = 'questions') => (
    <RichTranscriptView sessionId={sessionId} sessionStatus="idle" messages={messages}
      provider="claude-code" persistScrollState={false} />
  );

  beforeEach(() => {
    frames = new Map();
    nextFrame = 0;
    vlistState.scrollToIndex.mockReset();
    vlistState.scrollBy.mockReset();
    vi.stubGlobal('CSS', { highlights: { delete: vi.fn(), set: vi.fn() } });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  });

  it.each(['AskUserQuestion', 'mcp__nimbalyst__PromptForUserInput', 'RequestUserInput'])(
    'reveals %s inside its grouped row once and stays reachable after later output', toolName => {
      const messages = [makeMessage(0, { text: 'Before' }), question(1, toolName), makeMessage(2, { text: 'After' })];
      const { rerender, container } = render(view(messages.slice(0, 1)));
      flushFrames();
      rerender(view(messages));
      const card = container.querySelector<HTMLElement>('[data-transcript-tool-id="question-1"]')!;
      vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({ top: 180 } as DOMRect);
      flushFrames();
      expect(vlistState.scrollToIndex).toHaveBeenLastCalledWith(2, { align: 'start' });
      expect(vlistState.scrollBy).toHaveBeenLastCalledWith(172);
      vlistState.scrollToIndex.mockClear();

      rerender(view([...messages, makeMessage(3, { text: 'More output' })]));
      flushFrames();
      expect(vlistState.scrollToIndex).not.toHaveBeenCalled();
      fireEvent.click(screen.getByLabelText('Jump to question'));
      flushFrames();
      expect(vlistState.scrollToIndex).toHaveBeenCalledWith(2, { align: 'start' });

      rerender(view([messages[0], question(1, toolName, '{"cancelled":true}'), messages[2]]));
      flushFrames();
      expect(screen.queryByLabelText('Jump to question')).toBeNull();
    },
  );

  it('handles orphan regrouping, a second question, and session switches without replaying old arrivals', () => {
    const prompt = makeMessage(0, { type: 'user_message', text: 'Go' });
    const { rerender } = render(view([prompt]));
    flushFrames();
    rerender(view([prompt, question(1)]));
    flushFrames();
    expect(vlistState.scrollToIndex).toHaveBeenLastCalledWith(1, { align: 'start' });
    vlistState.scrollToIndex.mockClear();
    const messages = [prompt, question(1), makeMessage(2, { text: 'Continuation' })];
    rerender(view(messages));
    flushFrames();
    expect(vlistState.scrollToIndex).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Jump to question'));
    flushFrames();
    expect(vlistState.scrollToIndex).toHaveBeenLastCalledWith(2, { align: 'start' });

    rerender(view([...messages, question(3)]));
    flushFrames();
    expect(vlistState.scrollToIndex).toHaveBeenLastCalledWith(3, { align: 'start' });
    fireEvent.click(screen.getByLabelText('Jump to question'));
    flushFrames();
    expect(vlistState.scrollToIndex).toHaveBeenLastCalledWith(2, { align: 'start' });

    // Questions already open when a session is shown count as seen.
    vlistState.scrollToIndex.mockClear();
    rerender(view([prompt, question(1)], 'other-session'));
    flushFrames();
    expect(vlistState.scrollToIndex).not.toHaveBeenCalledWith(expect.any(Number), { align: 'start' });
  });

  it('ignores superseded answers and non-question prompts', () => {
    const answered = question(1, 'AskUserQuestion', '{"answers":{"Continue?":"Yes"}}');
    answered.toolCall!.providerToolCallId = 'question-0';
    render(view([question(0), answered, question(2, 'ToolPermission'), question(3, 'ExitPlanMode')]));
    flushFrames();
    expect(screen.queryByLabelText('Jump to question')).toBeNull();
    expect(vlistState.scrollToIndex).not.toHaveBeenCalledWith(expect.any(Number), { align: 'start' });
  });

  it.each([
    ['the answer auto-resume', { text: '[Resuming after answering a question]\n\nContinue?: Yes' }],
    ['an agent send', { text: 'Child finished', promptActor: 'agent' as const }],
    ['an unpersisted optimistic send', { text: 'Do something else', optimistic: true }],
  ])('keeps an unanswered question open after %s', (_label, row) => {
    const answered = question(1, 'AskUserQuestion', '{"answers":{"Continue?":"Yes"}}');
    render(view([answered, question(2), makeMessage(3, { type: 'user_message', ...row })]));
    flushFrames();
    expect(screen.queryByTestId('ask-user-question-skipped')).toBeNull();
    screen.getByTestId('ask-user-question-submit');
  });

  it('closes a question the user moved past with a new message, but not one still open', () => {
    const newTurn = makeMessage(2, { type: 'user_message', text: 'Do something else' });
    const first = render(view([question(1), newTurn]));
    flushFrames();
    expect(screen.queryByLabelText('Jump to question')).toBeNull();
    expect(vlistState.scrollToIndex).not.toHaveBeenCalledWith(expect.any(Number), { align: 'start' });
    screen.getByTestId('ask-user-question-skipped');
    expect(screen.queryByTestId('ask-user-question-submit')).toBeNull();
    expect(screen.queryByTestId('ask-user-question-option')).toBeNull();
    first.unmount();

    // Thinking animates, so frames never settle here; assert without flushing.
    const running = (messages: TranscriptViewMessage[]) => (
      <RichTranscriptView sessionId="questions-running" sessionStatus="running" messages={messages}
        provider="claude-code" persistScrollState={false} />
    );
    const { container, rerender } = render(running([question(1), newTurn]));
    // A skipped question must not hide Thinking for the turn that replaced it.
    expect(container.querySelector('.rich-transcript-waiting')).not.toBeNull();

    // Same question asked after the latest user message: open and answerable.
    rerender(running([makeMessage(0, { type: 'user_message', text: 'Start' }), question(1)]));
    expect(container.querySelector('.rich-transcript-waiting')).toBeNull();
    expect(screen.queryByTestId('ask-user-question-skipped')).toBeNull();
    screen.getByTestId('ask-user-question-submit');
  });

  it('cancels queued bottom-follow when a question arrives and targets only the latest duplicate card', () => {
    const { rerender, container } = render(view([makeMessage(0, { text: 'Running' })]));
    flushFrames();
    rerender(view([makeMessage(0, { text: 'More output' })]));
    // The bottom-follow animation frame has not run when the question arrives.
    const latest = question(2);
    latest.toolCall!.providerToolCallId = 'question-1';
    rerender(view([makeMessage(0, { text: 'More output' }), question(1), latest, makeMessage(3, { text: 'After' })]));
    vlistState.scrollToIndex.mockClear();
    flushFrames();
    expect(vlistState.scrollToIndex).not.toHaveBeenCalledWith(expect.any(Number), { align: 'end' });
    expect(container.querySelectorAll('[data-transcript-tool-id="question-1"]')).toHaveLength(1);
    expect(vlistState.scrollBy).toHaveBeenCalled();
  });
});

describe('a question a sub-agent asks', () => {
  // Raw rows as the Claude Agent SDK writes them: the sub-agent's tool call
  // carries `parent_tool_use_id`, so the projector files it under the card.
  let rawId = 0;
  const row = (direction: 'input' | 'output', content: unknown): RawMessage => ({
    id: ++rawId, sessionId: 'sub-questions', source: 'claude-code', direction,
    content: JSON.stringify(content), createdAt: new Date(1_784_648_445_000 + rawId * 1000),
  });
  const prompt = (text: string) => row('input', { prompt: text });
  const toolUse = (id: string, name: string, input: unknown, parent?: string) => row('output', {
    type: 'assistant', ...(parent ? { parent_tool_use_id: parent } : {}),
    message: { id: `msg-${id}`, content: [{ type: 'tool_use', id, name, input }] },
  });
  const toolResult = (id: string, content: string, parent?: string) => row('input', {
    type: 'user', ...(parent ? { parent_tool_use_id: parent } : {}),
    message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
  });
  const say = (id: string, text: string) => row('output', { type: 'assistant', message: { id, content: [{ type: 'text', text }] } });
  const ask = { questions: [{ header: 'Next', question: 'Continue?', options: [{ label: 'Yes', description: 'Continue' }] }] };
  const spawn = (id: string) => toolUse(id, 'Agent', { prompt: 'Ask the user', description: 'Ask', subagent_type: 'general-purpose' });

  const grouped = { showToolCalls: true, showThinking: true, compactMode: false, collapseTools: true, showSessionInit: false };
  const view = (messages: TranscriptViewMessage[]) => (
    <RichTranscriptView sessionId="sub-questions" sessionStatus="running" messages={messages} provider="claude-code"
      settings={grouped} persistScrollState={false} backgroundDrainActive={false} hasRunningTasks={false} />
  );

  beforeEach(() => {
    vlistState.scrollToIndex.mockReset();
    vi.stubGlobal('CSS', { highlights: { delete: vi.fn(), set: vi.fn() } });
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  });

  it('opens the sub-agent row, offers the jump, and stops Thinking', async () => {
    const messages = await projectRawMessagesToViewMessages([
      prompt('Go'),
      spawn('agent-1'),
      toolUse('q-child', 'mcp__nimbalyst__AskUserQuestion', ask, 'agent-1'),
    ], 'claude-code');
    expect(messages.map(m => m.type)).toEqual(['user_message', 'subagent']);

    const { container } = render(view(messages));
    screen.getByTestId('ask-user-question-submit');
    expect(container.querySelector('[data-transcript-tool-id="q-child"]')).not.toBeNull();
    expect(container.querySelector('.rich-transcript-waiting')).toBeNull();
    fireEvent.click(screen.getByLabelText('Jump to question'));
    expect(vlistState.scrollToIndex).toHaveBeenCalledWith(1, { align: 'start' });
  });

  it('keeps the row of a top-level question behind a sub-agent that asked one', async () => {
    const messages = await projectRawMessagesToViewMessages([
      prompt('Go'),
      spawn('agent-1'),
      toolUse('q-child', 'mcp__nimbalyst__AskUserQuestion', ask, 'agent-1'),
      toolResult('q-child', JSON.stringify({ answers: { 'Continue?': 'Yes' } }), 'agent-1'),
      toolResult('agent-1', 'Asked and done.'),
      toolUse('q-top', 'mcp__nimbalyst__AskUserQuestion', ask),
      say('m-after', 'Waiting for you.'),
    ], 'claude-code');
    expect(messages.map(m => m.type)).toEqual(['user_message', 'subagent', 'tool_call', 'assistant_message']);

    render(view(messages));
    fireEvent.click(screen.getByLabelText('Jump to question'));
    expect(vlistState.scrollToIndex).toHaveBeenCalledWith(3, { align: 'start' });
  });
});

function makeMessage(
  index: number,
  overrides: Partial<TranscriptViewMessage>,
): TranscriptViewMessage {
  return {
    id: index + 1,
    sequence: index + 1,
    createdAt: new Date(1_784_648_445_000 + index),
    type: 'assistant_message',
    subagentId: null,
    ...overrides,
  };
}

describe('RichTranscriptView permission review banner', () => {
  beforeEach(() => {
    vlistState.childCount = 0;
    vlistState.scrollToIndex.mockReset();
    vi.stubGlobal('CSS', {
      highlights: {
        delete: vi.fn(),
        set: vi.fn(),
      },
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  it('keeps the pending permission scroll target addressable after a hidden classifier denial', async () => {
    const messages: TranscriptViewMessage[] = [
      makeMessage(0, {
        type: 'system_message',
        systemMessage: {
          systemType: 'permission_denied',
          deniedToolName: 'Bash',
          deniedReason: 'Classifier requested review',
          deniedReasonType: 'classifier',
        },
      }),
      makeMessage(1, {
        type: 'tool_call',
        toolCall: {
          toolName: 'ToolPermission',
          toolDisplayName: 'ToolPermission',
          status: 'running',
          description: null,
          arguments: {
            requestId: 'permission-1',
            toolName: 'Bash',
            rawCommand: 'npm test',
            pattern: 'Bash(npm test:*)',
            patternDisplayName: 'npm test commands',
            isDestructive: true,
            warnings: ['Auto-mode classifier requested review'],
            workspacePath: '/workspace',
          },
          targetFilePath: null,
          mcpServer: null,
          mcpTool: null,
          providerToolCallId: 'permission-1',
          progress: [],
        },
      }),
      makeMessage(2, {
        type: 'assistant_message',
        text: '',
      }),
    ];

    render(
      <RichTranscriptView
        sessionId="session-1"
        sessionStatus="waiting"
        isProcessing
        hasPendingInteractivePrompt
        messages={messages}
        provider="claude-code"
        persistScrollState={false}
      />,
    );

    const reviewButton = await screen.findByRole('button', {
      name: /1 pending permission.*click to review/i,
    });

    vlistState.scrollToIndex.mockClear();
    fireEvent.click(reviewButton);

    await waitFor(() => {
      expect(vlistState.scrollToIndex).toHaveBeenCalledWith(2, { align: 'center' });
    });
    expect(vlistState.childCount).toBe(messages.length);
    expect(vlistState.scrollToIndex.mock.calls[0][0]).toBeLessThan(vlistState.childCount);
  });
});
