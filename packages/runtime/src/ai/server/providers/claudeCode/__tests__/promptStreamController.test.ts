// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildQueryOptionsSignature, createPersistentPromptStream } from '../sdkOptionsBuilder';

/**
 * Tests for the PromptStreamController used to keep the Claude Code SDK's
 * binary stdin pipe open until we explicitly close it via end(). Background:
 * passing a string prompt makes the SDK set isSingleUserTurn=true and force-
 * close stdin on the first `result` chunk -- causing late can_use_tool
 * requests to hit "Tool permission request failed: Error: Stream closed".
 *
 * The controller wraps a generator that yields the initial user message and
 * then awaits an end() signal. Tests verify:
 * - generator yields the initial message exactly once before blocking
 * - end() is idempotent
 * - isEnded() flips after end()
 * - calling end() lets the generator return
 *
 * See nimbalyst-local/plans/stream-closed-native-binary-investigation.md.
 */

const makeMessage = (content = 'hello') => ({
  type: 'user' as const,
  message: { role: 'user' as const, content },
  parent_tool_use_id: null,
});

/** Resolves true if the iterator is still waiting for something to yield. */
async function stillPending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol('pending');
  const race = await Promise.race([
    promise,
    new Promise((r) => setTimeout(() => r(marker), 20)),
  ]);
  return race === marker;
}

describe('createPersistentPromptStream', () => {
  it('yields the initial message and blocks until end() is called', async () => {
    const initial = makeMessage();
    const { iterable, controller } = createPersistentPromptStream(initial);
    const iterator = iterable[Symbol.asyncIterator]();

    // First call yields the initial message.
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toBe(initial);

    // Second call blocks indefinitely until end() is called -- race with a
    // timeout to assert we are in fact pending.
    let nextResolved = false;
    const nextPromise = iterator.next().then((v) => {
      nextResolved = true;
      return v;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(nextResolved).toBe(false);
    expect(controller.isEnded()).toBe(false);

    controller.end('test');
    const second = await nextPromise;
    expect(second.done).toBe(true);
    expect(controller.isEnded()).toBe(true);
  });

  it('end() is idempotent and only logs/resolves once', async () => {
    const { iterable, controller } = createPersistentPromptStream(makeMessage());
    const iterator = iterable[Symbol.asyncIterator]();

    await iterator.next();

    controller.end('first');
    expect(controller.isEnded()).toBe(true);

    // Second call must not throw; isEnded stays true.
    controller.end('second');
    expect(controller.isEnded()).toBe(true);

    // The iterator finishes cleanly.
    const final = await iterator.next();
    expect(final.done).toBe(true);
  });

  it('isEnded() is false until end() is called', () => {
    const { controller } = createPersistentPromptStream(makeMessage());
    expect(controller.isEnded()).toBe(false);
    controller.end('test');
    expect(controller.isEnded()).toBe(true);
  });

  it('calling end() before the iterator starts still lets the iterator finish', async () => {
    const initial = makeMessage();
    const { iterable, controller } = createPersistentPromptStream(initial);

    controller.end('before-iteration');

    const iterator = iterable[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toBe(initial);

    const second = await iterator.next();
    expect(second.done).toBe(true);
  });
});

/**
 * push() delivers a follow-up user turn on the stream the SDK is already
 * reading. It exists because `Query.streamInput()` calls transport.endInput()
 * unconditionally once its input iterable ends: injecting a message through a
 * one-shot stream delivers it and then closes the binary's stdin, so the
 * background sub-agents still running in that subprocess lose their control
 * channel and the next follow-up prompt is dropped silently. #1269.
 */
describe('createPersistentPromptStream push()', () => {
  it('yields a pushed follow-up turn after the initial message', async () => {
    const initial = makeMessage('initial');
    const followUp = makeMessage('follow-up');
    const { iterable, controller } = createPersistentPromptStream(initial);
    const iterator = iterable[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toBe(initial);

    const pending = iterator.next();
    expect(await stillPending(pending)).toBe(true);

    expect(controller.push(followUp)).toBe(true);
    const delivered = await pending;
    expect(delivered.done).toBe(false);
    expect(delivered.value).toBe(followUp);
  });

  // The property that keeps stdin open: after delivering a follow-up turn the
  // generator must go back to waiting, never return. A returning generator is
  // exactly what streamInput() reads as "input finished" before closing stdin.
  it('does not return after delivering a pushed turn, so stdin stays open', async () => {
    const { iterable, controller } = createPersistentPromptStream(makeMessage('initial'));
    const iterator = iterable[Symbol.asyncIterator]();

    await iterator.next();
    controller.push(makeMessage('follow-up'));
    await iterator.next();

    const afterFollowUp = iterator.next();
    expect(await stillPending(afterFollowUp)).toBe(true);
    expect(controller.isEnded()).toBe(false);

    // Only end() releases it.
    controller.end('test');
    expect((await afterFollowUp).done).toBe(true);
  });

  // push() returning true is the caller's proof of delivery -- the handover
  // adoption commits the turn to the parked query on that answer alone. An
  // end() landing between the accepted push and the generator's next
  // resumption used to drop the queued message on the floor, so the proof was
  // a lie and the user's prompt vanished. end() still wins for anything after
  // it: push() refuses once ended. #1269.
  it('still yields a message push() accepted before end(), rather than discarding it', async () => {
    const accepted = makeMessage('accepted before end');
    const { iterable, controller } = createPersistentPromptStream(makeMessage('initial'));
    const iterator = iterable[Symbol.asyncIterator]();

    await iterator.next();
    // Nothing is reading: the generator is parked on its race, exactly as when
    // the SDK is busy with the previous turn.
    expect(controller.push(accepted)).toBe(true);
    controller.end('grace timer expired right after the push');

    const delivered = await iterator.next();
    expect(delivered.done).toBe(false);
    expect(delivered.value).toBe(accepted);
    expect((await iterator.next()).done).toBe(true);
  });
});

/**
 * A parked query keeps running under the options of the turn that started it.
 * The fingerprint is what lets a follow-up turn notice that the user changed
 * something the live subprocess cannot change, and open a fresh query instead of
 * answering from the previous configuration. #1269.
 */
describe('buildQueryOptionsSignature', () => {
  const base = {
    model: 'claude-code:opus',
    thinking: undefined,
    allowedTools: undefined,
    disallowedTools: undefined,
    mcpServers: { alpha: {}, beta: {} },
    env: { CLAUDE_CODE_EFFORT_LEVEL: 'high' },
  };

  it('changes for every setting the running subprocess cannot change', () => {
    const signature = buildQueryOptionsSignature(base);
    const variants = [
      { ...base, model: 'claude-code:sonnet' },
      { ...base, env: { CLAUDE_CODE_EFFORT_LEVEL: 'low' } },
      { ...base, thinking: { type: 'disabled' } },
      { ...base, allowedTools: ['Read'] },
      { ...base, disallowedTools: ['Bash'] },
      { ...base, mcpServers: { alpha: {} } },
    ];
    for (const variant of variants) {
      expect(buildQueryOptionsSignature(variant)).not.toBe(signature);
    }
  });

  // The session mode reaches the subprocess as `permissionMode` and nothing
  // else: plan mode carries no tool restrictions of its own. So while the field
  // was excluded from the fingerprint, agent, plan and auto were one and the
  // same to it — a user who switched to plan and sent the prompt through a
  // handover adopted the agent-mode query and kept writing files. #1269.
  it('separates the permission modes, which no other field in it distinguishes', () => {
    const signatures = ['default', 'plan', 'auto'].map(permissionMode =>
      buildQueryOptionsSignature({ ...base, permissionMode }),
    );
    expect(new Set(signatures).size).toBe(3);
  });

  // The working directory moves under a session with no user action at all: an
  // agent that runs Bash inside a worktree makes adoptWorktreeForSession persist
  // worktreePath, and the next turn resolves cwd, the permissions path and the
  // prompt's worktree block from it. Adopting across that change left the
  // subprocess writing to the main checkout while the UI, the file watchers and
  // the edit attribution all described the worktree. The prompt travels as a
  // hash, so the third variant (a meta-agent's plain string replacing the preset
  // with the same text) separates too, and anything new that enters the prompt
  // is covered without extending this function. #1269.
  it('changes when the workspace moves under the session', () => {
    const mainCheckout = {
      ...base,
      cwd: '/repo',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Working in /repo' },
    };
    const signature = buildQueryOptionsSignature(mainCheckout);
    const variants = [
      { ...mainCheckout, cwd: '/repo/.worktrees/feature' },
      {
        ...mainCheckout,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Working in /repo/.worktrees/feature' },
      },
      { ...mainCheckout, systemPrompt: 'Working in /repo' },
    ];
    for (const variant of variants) {
      expect(buildQueryOptionsSignature(variant)).not.toBe(signature);
    }
  });
});
