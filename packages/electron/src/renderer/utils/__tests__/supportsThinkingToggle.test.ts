// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { supportsThinkingToggle, supportsEffortLevel } from '../modelUtils';

describe('supportsThinkingToggle', () => {
  it('keeps thinking mandatory for current Opus and optional for Sonnet', () => {
    expect(supportsThinkingToggle('claude-code:opus')).toBe(false);
    expect(supportsThinkingToggle('claude-code:sonnet')).toBe(true);
  });

  it.each(['claude-code', 'claude-code-cli'])('handles explicit Opus versions and 1M selections for %s', (provider) => {
    expect(supportsThinkingToggle(`${provider}:opus-5-5-1m`)).toBe(false);
    expect(supportsThinkingToggle(`${provider}:opus-5`)).toBe(true);
    expect(supportsThinkingToggle(`${provider}:opus-5-1m`)).toBe(true);
    expect(supportsEffortLevel(`${provider}:opus-5`)).toBe(true);
    expect(supportsEffortLevel(`${provider}:opus-5-5`)).toBe(true);
  });

  it('enables the toggle for pinned opus variants', () => {
    // Older Opus versions still support the existing Off preference.
    expect(supportsThinkingToggle('claude-code:opus-4-7')).toBe(true);
    expect(supportsThinkingToggle('claude-code:opus-4-6')).toBe(true);
  });

  it('disables the toggle for fable and haiku variants', () => {
    expect(supportsThinkingToggle('claude-code:fable')).toBe(false);
    expect(supportsThinkingToggle('claude-code:haiku')).toBe(false);
  });

  it('disables the toggle for non-claude-code and missing models', () => {
    expect(supportsThinkingToggle(undefined)).toBe(false);
    expect(supportsThinkingToggle('gpt-5.5')).toBe(false);
  });
});
