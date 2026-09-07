import { describe, it, expect } from 'vitest';
import { taskKindLabel, taskOutcomeLabel } from '../taskPresentation';

describe('taskKindLabel', () => {
  it('does not call a shell command a sub-agent', () => {
    expect(taskKindLabel('local_bash')).toBe('Command');
    expect(taskKindLabel('local_agent')).toBe('Sub-agent');
  });

  // A task_type the CLI adds later must not inherit the sub-agent wording —
  // that is how a plain Bash call came to read as a crashed agent.
  it('falls back to a neutral word for unknown and missing types', () => {
    expect(taskKindLabel('some_future_type')).toBe('Task');
    expect(taskKindLabel(undefined)).toBe('Task');
  });
});

describe('taskOutcomeLabel', () => {
  it('separates a non-zero exit from a kill', () => {
    expect(taskOutcomeLabel('failed')).toBe('failed');
    expect(taskOutcomeLabel('stopped')).toBe('stopped');
  });

  it('stays silent where the icon already says it', () => {
    expect(taskOutcomeLabel('running')).toBeNull();
    expect(taskOutcomeLabel('completed')).toBeNull();
  });
});
