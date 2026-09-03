// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { sendNowOutcome } from '../PromptQueueList';

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
