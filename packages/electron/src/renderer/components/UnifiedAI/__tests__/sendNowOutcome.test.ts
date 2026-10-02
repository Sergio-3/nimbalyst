// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { emptyEnterSendNow, sendNowOutcome, type QueuedPrompt } from '../PromptQueueList';

describe('sendNowOutcome', () => {
  it('warns only while a delegated task would die with the interrupt', () => {
    expect(sendNowOutcome(false, true)).toBe('interrupt');
  });

  it('stays silent with no running task, whatever else is true', () => {
    expect(sendNowOutcome(false, false)).toBe('safe');
    expect(sendNowOutcome(true, false)).toBe('safe');
  });

  it('stays silent when the handover keeps the running tasks alive', () => {
    expect(sendNowOutcome(true, true)).toBe('safe');
  });
});

describe('emptyEnterSendNow', () => {
  const queue: QueuedPrompt[] = [
    { id: 'first', prompt: 'oldest', timestamp: 1 },
    { id: 'second', prompt: 'newer', timestamp: 2 },
  ];

  it('sends the head of the queue now, like the button, while that is safe', () => {
    const sent: Array<[string, string]> = [];
    const enter = emptyEnterSendNow((id, prompt) => sent.push([id, prompt]), queue, 'safe');
    enter?.();
    expect(sent).toEqual([['first', 'oldest']]);
  });

  // The one case a keystroke must never reach: the click would stop delegated
  // work. No handler at all, so Enter in an empty input does nothing.
  it('does nothing in the interrupt state', () => {
    const sent: Array<[string, string]> = [];
    const enter = emptyEnterSendNow((id, prompt) => sent.push([id, prompt]), queue, 'interrupt');
    expect(enter).toBeUndefined();
    enter?.();
    expect(sent).toEqual([]);
  });

  it('does nothing without a waiting prompt or without send-now', () => {
    expect(emptyEnterSendNow(() => {}, [], 'safe')).toBeUndefined();
    expect(emptyEnterSendNow(undefined, queue, 'safe')).toBeUndefined();
  });
});
