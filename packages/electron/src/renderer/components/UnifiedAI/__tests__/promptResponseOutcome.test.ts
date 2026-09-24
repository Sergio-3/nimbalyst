// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { assertPromptResponseAccepted } from '../promptResponseOutcome';

describe('assertPromptResponseAccepted', () => {
  it('turns a rejected answer into an error carrying the reason', () => {
    expect(() => assertPromptResponseAccepted({ success: false, error: 'This form was already answered.' }))
      .toThrow(new Error('This form was already answered.'));
  });

  it('accepts a successful result and a handler that returns nothing', () => {
    expect(() => assertPromptResponseAccepted({ success: true })).not.toThrow();
    expect(() => assertPromptResponseAccepted(undefined)).not.toThrow();
  });
});
