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
  it('only reports a handover while the lead turn is done and the waiting prompt has no attachments', () => {
    expect(sendNowOutcome(true, prompt())).toBe('handover');
    expect(sendNowOutcome(true, prompt([]))).toBe('handover');
  });

  it('reports an interrupt while the lead turn is still running', () => {
    expect(sendNowOutcome(false, prompt())).toBe('interrupt');
    // Attachments do not matter here -- the turn is interrupted either way.
    expect(sendNowOutcome(false, withAttachment)).toBe('interrupt');
  });

  it('reports an interrupt when the waiting prompt carries attachments, drain or not', () => {
    // The main process refuses the handover for these (AIService: canAdoptQuery),
    // so a green light here would be a lie.
    expect(sendNowOutcome(true, withAttachment)).toBe('interrupt-attachments');
  });

  it('treats an empty queue as an interrupt', () => {
    expect(sendNowOutcome(false, undefined)).toBe('interrupt');
  });
});
