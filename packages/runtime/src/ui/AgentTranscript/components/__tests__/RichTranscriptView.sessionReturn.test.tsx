import React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptViewMessage } from '../../../../ai/server/transcript/TranscriptProjector';
import { RichTranscriptView } from '../RichTranscriptView';
import { setSessionReturnState } from '../../../../store/atoms/transcriptScroll';

// Rows are 100px tall in this fake list; the viewport shows one row.
const vlist = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  scrollBy: vi.fn(),
  onScroll: undefined as ((offset: number) => void) | undefined,
  rowCount: 0,
  bufferSize: undefined as number | undefined,
  // scrollToIndex calls already made each time the list's passive effects ran;
  // a placement made before them was made before the browser could paint.
  callsAtPassiveEffects: [] as number[],
}));

vi.mock('virtua', async () => {
  const ReactModule = await import('react');
  return {
    VList: ReactModule.forwardRef(({ children, onScroll, bufferSize }: { children: React.ReactNode; onScroll?: (offset: number) => void; bufferSize?: number }, ref) => {
      const rows = ReactModule.Children.toArray(children);
      vlist.rowCount = rows.length;
      vlist.onScroll = onScroll;
      vlist.bufferSize = bufferSize;
      ReactModule.useEffect(() => {
        vlist.callsAtPassiveEffects.push(vlist.scrollToIndex.mock.calls.length);
      });
      ReactModule.useImperativeHandle(ref, () => ({
        cache: undefined,
        scrollOffset: 0,
        get scrollSize() { return vlist.rowCount * 100; },
        viewportSize: 100,
        findItemIndex: (offset: number) => Math.floor(offset / 100),
        getItemOffset: (index: number) => index * 100,
        scrollToIndex: vlist.scrollToIndex,
        scrollBy: vlist.scrollBy,
      }));
      return <div>{rows}</div>;
    }),
  };
});

const text = (sequence: number, value: string, type: TranscriptViewMessage['type'] = 'assistant_message'): TranscriptViewMessage => ({
  id: sequence, sequence, createdAt: new Date(1_784_648_445_000 + sequence), type, text: value, subagentId: null,
});
const tool = (sequence: number, toolName: string): TranscriptViewMessage => ({
  ...text(sequence, ''), type: 'tool_call', text: undefined,
  toolCall: {
    toolName, toolDisplayName: toolName, status: 'running', description: null,
    arguments: toolName === 'AskUserQuestion'
      ? { questions: [{ header: 'Next', question: 'Continue?', options: [{ label: 'Yes', description: 'Continue' }] }] }
      : { file_path: '/tmp/x' },
    targetFilePath: null, mcpServer: null, mcpTool: null, providerToolCallId: `tool-${sequence}`, progress: [],
  },
});

// Ten alternating user/assistant rows, so the anchor sits mid-transcript.
const history = Array.from({ length: 10 }, (_, i) => text(i + 1, `row ${i + 1}`, i % 2 ? 'assistant_message' : 'user_message'));

describe('RichTranscriptView returning to a session', () => {
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
  };
  const show = (sessionId: string, messages: TranscriptViewMessage[]) => {
    const view = render(<RichTranscriptView sessionId={sessionId} sessionStatus="idle" messages={messages} provider="claude-code" />);
    flushFrames();
    return view;
  };
  /** Visit, scroll to `offset` (row 3 + 40px for 340), then switch away. */
  const visitAndLeave = (sessionId: string, messages: TranscriptViewMessage[], offset: number) => {
    const view = show(sessionId, messages);
    act(() => vlist.onScroll?.(offset));
    view.unmount();
    vlist.scrollToIndex.mockClear();
    vlist.scrollBy.mockClear();
  };

  beforeEach(() => {
    frames = new Map();
    nextFrame = 0;
    vlist.scrollToIndex.mockReset();
    vlist.scrollBy.mockReset();
    vi.stubGlobal('CSS', { highlights: { delete: vi.fn(), set: vi.fn() } });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  });

  it('lands on the first new agent message, not on the tool calls before it', () => {
    visitAndLeave('return-news', history, 340);
    // index 10: Read (grouped into row 12), 11: Bash, 12: assistant text, 13: more text
    show('return-news', [...history, tool(11, 'Read'), tool(12, 'Bash'), text(13, 'Done'), text(14, 'user follow-up', 'user_message')]);
    expect(vlist.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(vlist.scrollToIndex).toHaveBeenCalledWith(12, { align: 'start' });
  });

  it('counts a new approval card as news even without agent text after it', () => {
    visitAndLeave('return-card', history, 340);
    // index 10: Read (own row, no assistant text follows), 11: permission card
    show('return-card', [...history, tool(11, 'Read'), tool(12, 'mcp__nimbalyst__ToolPermission')]);
    expect(vlist.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(vlist.scrollToIndex).toHaveBeenCalledWith(11, { align: 'start' });
  });

  it('restores the remembered row and offset when nothing new arrived', () => {
    visitAndLeave('return-anchor', history, 340);
    show('return-anchor', history);
    expect(vlist.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(vlist.scrollToIndex).toHaveBeenCalledWith(3, { align: 'start', offset: 40 });
  });

  it('treats only-new tool calls as nothing new and keeps the remembered position', () => {
    visitAndLeave('return-tools', history, 340);
    show('return-tools', [...history, tool(11, 'Read'), tool(12, 'Bash')]);
    expect(vlist.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(vlist.scrollToIndex).toHaveBeenCalledWith(3, { align: 'start', offset: 40 });
  });

  describe('with steps folded into bundles', () => {
    const grouped = { showToolCalls: true, showThinking: true, compactMode: false, collapseTools: true, showSessionInit: false };
    const thinking = (sequence: number): TranscriptViewMessage => ({ ...text(sequence, ''), thinking: 'considering' });
    const report = (sequence: number): TranscriptViewMessage => ({
      ...text(sequence, 'Child done', 'user_message'), promptActor: 'agent', promptMessageKind: 'report',
    });
    // Row 1 hosts the bundle [thinking, Read, report, thinking]; rows 2-4 are hidden.
    const folded = [text(1, 'go', 'user_message'), thinking(2), tool(3, 'Read'), report(4), thinking(5), text(6, 'Done'), text(7, 'next', 'user_message')];
    folded[2].toolCall!.status = 'completed';
    folded[2].toolCall!.result = 'ok';

    it('returns to the host row when the remembered row is a member behind it', () => {
      setSessionReturnState('return-folded', { lastSequence: 7, anchor: { sequence: 4, offset: 40 }, atBottom: false });
      render(<RichTranscriptView sessionId="return-folded" sessionStatus="idle" messages={folded} provider="claude-code" settings={grouped} />);
      flushFrames();
      expect(vlist.scrollToIndex).toHaveBeenCalledTimes(1);
      expect(vlist.scrollToIndex).toHaveBeenCalledWith(1, { align: 'start', offset: 0 });
    });

    it('jumps to a member by opening its bundle on the host row', () => {
      const ref = React.createRef<{ scrollToMessage: (index: number) => void; scrollToTop: () => void }>();
      const { container } = render(
        <RichTranscriptView ref={ref} sessionId="jump-folded" sessionStatus="idle" messages={folded} provider="claude-code"
          settings={grouped} persistScrollState={false} />,
      );
      flushFrames();
      vlist.scrollToIndex.mockClear();
      act(() => ref.current!.scrollToMessage(3));
      expect(vlist.scrollToIndex).toHaveBeenCalledWith(1, { align: 'center' });
      expect(container.querySelector('.rich-transcript-tool-bundle-button')!.getAttribute('aria-expanded')).toBe('true');
    });
  });

  it('does not jump back to an old open question far up the transcript', () => {
    const withQuestion = [text(1, 'ask', 'user_message'), tool(2, 'AskUserQuestion'), ...history.map(m => ({ ...m, id: m.id + 2, sequence: m.sequence + 2 }))];
    // Left at the bottom (12 rows, viewport at the last one).
    visitAndLeave('return-question', withQuestion, 1100);
    show('return-question', withQuestion);
    expect(vlist.scrollBy).not.toHaveBeenCalled();
    expect(vlist.scrollToIndex).not.toHaveBeenCalledWith(expect.anything(), { align: 'start' });
    expect(vlist.scrollToIndex).toHaveBeenLastCalledWith(11, { align: 'end' });
  });

  it('remembers each session under its own id when the same view switches sessions', () => {
    // B left on row 7 + 40px, A on row 3 + 40px, then the view moves on to B.
    visitAndLeave('switch-b', history, 740);
    const view = show('switch-a', history);
    act(() => vlist.onScroll?.(340));
    view.rerender(<RichTranscriptView sessionId="switch-b" sessionStatus="idle" messages={history} provider="claude-code" />);
    flushFrames();
    view.unmount();
    vlist.scrollToIndex.mockClear();

    show('switch-a', history);
    expect(vlist.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(vlist.scrollToIndex).toHaveBeenCalledWith(3, { align: 'start', offset: 40 });
  });
});

// Opening a long session used to mount a 10 000 px buffer of rows at index 0,
// then the same again at the bottom one frame later; none of the first batch
// was ever on screen.
describe('RichTranscriptView placing a session it opens', () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  const flushFrame = () => act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(callback => callback(0));
  });
  const isScrollReady = (container: HTMLElement) => container.querySelector('.rich-transcript-messages-wrapper.scroll-ready') !== null;

  beforeEach(() => {
    frames = new Map();
    nextFrame = 0;
    vlist.scrollToIndex.mockReset();
    vlist.callsAtPassiveEffects = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('CSS', { highlights: { delete: vi.fn(), set: vi.fn() } });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  });
  const originalIntersectionObserver = globalThis.IntersectionObserver;
  afterEach(() => {
    vi.useRealTimers();
    globalThis.IntersectionObserver = originalIntersectionObserver;
  });

  it('scrolls to the target at mount and widens the buffer only after the ready frame painted', () => {
    const view = render(<RichTranscriptView sessionId="place-a" sessionStatus="idle" messages={history} provider="claude-code" />);
    // Placed before the first frame, so the first measured render is the bottom.
    expect(vlist.scrollToIndex).toHaveBeenCalledWith(9, { align: 'end' });
    // ...and within the commit, before any passive effect (i.e. before paint).
    expect(vlist.callsAtPassiveEffects[0]).toBe(1);
    const settlingBuffer = vlist.bufferSize!;

    for (let i = 0; i < 3 && !isScrollReady(view.container); i++) flushFrame();
    expect(isScrollReady(view.container)).toBe(true);
    // The ready frame still renders the narrow range.
    flushFrame();
    expect(vlist.bufferSize).toBe(settlingBuffer);
    act(() => vi.runOnlyPendingTimers());
    const fullBuffer = vlist.bufferSize!;
    expect(fullBuffer).toBeGreaterThan(settlingBuffer);

    // Switching sessions in place starts narrow again from its first render.
    vlist.scrollToIndex.mockClear();
    vlist.callsAtPassiveEffects = [];
    view.rerender(<RichTranscriptView sessionId="place-b" sessionStatus="idle" messages={history} provider="claude-code" />);
    expect(vlist.bufferSize).toBe(settlingBuffer);
    expect(vlist.scrollToIndex).toHaveBeenCalledWith(9, { align: 'end' });
    expect(vlist.callsAtPassiveEffects[0]).toBe(1);
    for (let i = 0; i < 6; i++) flushFrame();
    act(() => vi.runOnlyPendingTimers());
    expect(vlist.bufferSize).toBe(fullBuffer);
  });

  it('starts narrow again when the same session is hidden and shown again', () => {
    let reportVisible: ((visible: boolean) => void) | undefined;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        reportVisible = visible => callback([{ isIntersecting: visible }]);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    });
    render(<RichTranscriptView sessionId="place-c" sessionStatus="idle" messages={history} provider="claude-code" />);
    const settlingBuffer = vlist.bufferSize!;
    for (let i = 0; i < 6; i++) flushFrame();
    act(() => vi.runOnlyPendingTimers());
    const fullBuffer = vlist.bufferSize!;
    expect(fullBuffer).toBeGreaterThan(settlingBuffer);

    // Mode switch away and back: the list remounts, and must not do so wide.
    act(() => reportVisible!(false));
    act(() => reportVisible!(true));
    expect(vlist.bufferSize).toBe(settlingBuffer);
    for (let i = 0; i < 6; i++) flushFrame();
    act(() => vi.runOnlyPendingTimers());
    expect(vlist.bufferSize).toBe(fullBuffer);
  });

  it('shows an empty session that is already running at once', () => {
    // No messages yet, but the thinking row renders the list.
    const view = render(<RichTranscriptView sessionId="place-empty" sessionStatus="running" messages={[]} provider="claude-code" />);
    expect(isScrollReady(view.container)).toBe(true);
  });
});
