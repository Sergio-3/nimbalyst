import { describe, it, expect, vi } from 'vitest';
import { authorizeCompoundBashCommand, COMPOUND_PART_WARNING } from '../toolAuthorization';
import { hasShellChainingOperators, splitOnShellOperators } from '../../../permissions/BashCommandAnalyzer';
import { generateToolPattern } from '../../../permissions/toolPermissionHelpers';

describe('splitOnShellOperators', () => {
  it('keeps a quoted argument containing ; and || as one argument', () => {
    const parts = splitOnShellOperators(
      "grep -l '^seoTitle:' src/*.md | sed 's|src/content/||;s|\\.md$||' > /tmp/out.txt; wc -l < /tmp/out.txt"
    );

    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('src/*.md');
    expect(parts[0]).not.toContain('glob');
    // Re-splitting a part must not find another chain
    expect(hasShellChainingOperators(parts[0])).toBe(false);
    expect(generateToolPattern('Bash', { command: parts[0] })).toBe('Bash(grep:*)');
    expect(generateToolPattern('Bash', { command: parts[1] })).toBe('Bash(wc:*)');
  });

  it('does not split a heredoc body into sub-commands', () => {
    const command = "cat /tmp/a.txt && python3 - <<'EOF'\na = load('x'); b = load('y')\nprint(a, b)\nEOF";

    const parts = splitOnShellOperators(command);

    expect(parts).toHaveLength(2);
    expect(parts[1]).toMatch(/^python3 -/);
    expect(parts.some(p => p.includes('load'))).toBe(false);
  });

  it('does not treat semicolons inside a lone heredoc as chaining', () => {
    expect(hasShellChainingOperators("python3 - <<'EOF'\na = 1; b = 2\nEOF")).toBe(false);
  });
});

describe('authorizeCompoundBashCommand', () => {
  function deps(approved: string[], answers: Record<string, 'allow' | 'deny'> = {}) {
    return {
      isPartPreApproved: vi.fn(async (pattern: string) => approved.includes(pattern)),
      authorizePart: vi.fn(async (partInput: any) =>
        (answers[partInput.command] ?? 'allow') === 'allow'
          ? { behavior: 'allow' as const, updatedInput: partInput }
          : { behavior: 'deny' as const, message: 'Tool call denied by user' }),
      logSecurity: vi.fn(),
    };
  }

  it('returns null for a simple command', async () => {
    const d = deps([]);
    await expect(authorizeCompoundBashCommand(d, { command: 'ls -la' })).resolves.toBeNull();
    expect(d.authorizePart).not.toHaveBeenCalled();
  });

  it('returns null for a multi-line compound command so the whole command is prompted', async () => {
    const d = deps(['Bash(ls:*)']);
    await expect(authorizeCompoundBashCommand(d, { command: 'ls && echo ok\nrm -rf build' })).resolves.toBeNull();
    expect(d.authorizePart).not.toHaveBeenCalled();
  });

  it('allows without prompting when every part is pre-approved', async () => {
    const d = deps(['Bash(git status:*)', 'Bash(ls:*)']);
    const input = { command: 'git status && ls', description: 'x' };

    await expect(authorizeCompoundBashCommand(d, input)).resolves.toEqual({ behavior: 'allow', updatedInput: input });
    expect(d.authorizePart).not.toHaveBeenCalled();
  });

  it('prompts only for parts that are not pre-approved, with the compound warning', async () => {
    const d = deps(['Bash(git status:*)']);
    const input = { command: 'git status && npm test', description: 'x' };

    await expect(authorizeCompoundBashCommand(d, input)).resolves.toEqual({ behavior: 'allow', updatedInput: input });
    expect(d.authorizePart).toHaveBeenCalledTimes(1);
    expect(d.authorizePart).toHaveBeenCalledWith({ command: 'npm test', description: 'x' }, [COMPOUND_PART_WARNING]);
  });

  it('denies and stops at the first denied part', async () => {
    const d = deps([], { 'rm -rf build': 'deny' });

    const result = await authorizeCompoundBashCommand(d, { command: 'rm -rf build && npm test' });

    expect(result).toEqual({ behavior: 'deny', message: 'Tool call denied by user' });
    expect(d.authorizePart).toHaveBeenCalledTimes(1);
  });
});
