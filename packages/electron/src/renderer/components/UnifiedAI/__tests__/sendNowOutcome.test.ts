// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { sendNowOutcome, type QueuedPrompt } from '../PromptQueueList';

const prompt = (attachments?: QueuedPrompt['attachments']): QueuedPrompt => ({
  id: 'q1',
  prompt: 'do the thing',
  timestamp: 0,
  attachments,
});

const withAttachment = prompt([{ id: 'a1', filename: 'shot.png', type: 'image' }]);

describe('sendNowOutcome', () => {
  it('warns only while a delegated task would die with the interrupt', () => {
    expect(sendNowOutcome(false, prompt(), true)).toBe('interrupt');
    // Attachments do not matter here -- the turn is interrupted either way.
    expect(sendNowOutcome(false, withAttachment, true)).toBe('interrupt');
  });

  it('warns during the drain when the waiting prompt carries attachments', () => {
    // The main process refuses the handover for these (AIService: canAdoptQuery),
    // so a green light here would be a lie.
    expect(sendNowOutcome(true, withAttachment, true)).toBe('interrupt-attachments');
  });

  it('stays silent with no running task, whatever else is true', () => {
    expect(sendNowOutcome(false, prompt(), false)).toBe('safe');
    expect(sendNowOutcome(false, withAttachment, false)).toBe('safe');
    expect(sendNowOutcome(true, withAttachment, false)).toBe('safe');
  });

  it('stays silent when the handover keeps the running tasks alive', () => {
    expect(sendNowOutcome(true, prompt(), true)).toBe('safe');
    expect(sendNowOutcome(true, prompt([]), true)).toBe('safe');
  });

  it('treats an empty queue like any other prompt without attachments', () => {
    expect(sendNowOutcome(false, undefined, true)).toBe('interrupt');
    expect(sendNowOutcome(true, undefined, true)).toBe('safe');
    expect(sendNowOutcome(false, undefined, false)).toBe('safe');
  });
});
