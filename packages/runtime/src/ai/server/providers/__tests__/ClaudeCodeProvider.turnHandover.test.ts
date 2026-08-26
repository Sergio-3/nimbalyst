// @vitest-environment node
/**
 * Send-now during a background sub-agent drain, driven through the real
 * `sendMessage` generator (#1269).
 *
 * The sibling file `ClaudeCodeProvider.taskReap.test.ts` covers the ownership
 * rules by calling the handover methods directly. That leaves the two things
 * only a whole turn can show: that the teardown block actually reaches its
 * reap, and that a query carried from turn to turn keeps the one stdin its
 * sub-agents run on. Both broke in ordinary use while unit tests on the same
 * methods were green.
 *
 * Only the CLI subprocess is faked. buildSdkOptions, the persistent prompt
 * stream, the streaming loop, the drain and the teardown are the shipping ones.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false },
}));

/** Every 'ai-edit' restore point the run wrote, in order. */
const history = vi.hoisted(() => ({ snapshots: [] as string[] }));
vi.mock('../../../../../../electron/src/main/HistoryManager', () => ({
  historyManager: {
    createSnapshot: async (filePath: string) => { history.snapshots.push(filePath); },
    getPendingTags: async () => [],
    createTag: async () => {},
    updateTagStatus: async () => {},
  },
}));

vi.mock('../claudeCode/cliPathResolver', () => ({
  resolveClaudeAgentCliPath: async () => '/fake/claude',
}));

vi.mock('../../../../electron/claudeCodeEnvironment', () => ({
  setupClaudeCodeEnvironment: () => ({}),
  resolveNativeBinaryPath: () => undefined,
}));

const sdkQuery = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: unknown) => sdkQuery(args),
}));

import { ClaudeCodeProvider } from '../ClaudeCodeProvider';
import type { StreamChunk } from '../../types';

/**
 * One CLI subprocess: a stdin pipe that outlives a turn, one output stream, and
 * the background sub-agents living inside it. Each `query()` call spawns its
 * own — so "the follow-up turn kept the sub-agent" and "the follow-up turn got
 * a fresh process" are distinguishable rather than a matter of interpretation.
 */
function spawnFakeCli(prompt: AsyncIterable<any>, abortController?: AbortController) {
  const promptsDelivered: string[] = [];
  const seen = { stdinClosed: false, interrupts: 0, closes: 0, aborted: false };

  const outbox: any[] = [];
  let ended = false;
  let wake: () => void = () => {};
  let wakePromise = new Promise<void>(resolve => { wake = resolve; });
  const nudge = () => {
    const resolveCurrent = wake;
    wakePromise = new Promise<void>(resolve => { wake = resolve; });
    resolveCurrent();
  };

  // The controller handed to query() governs the subprocess: when it fires, the
  // process dies and every sub-agent inside it dies with it. Modelled, not just
  // recorded, because "who still has the right to abort this" is the question
  // the lease exists to answer.
  abortController?.signal.addEventListener('abort', () => {
    seen.aborted = true;
    ended = true;
    nudge();
  });

  // The SDK calls transport.endInput() the moment the prompt iterable ends,
  // which shuts the pipe every running sub-agent depends on. Recorded rather
  // than acted on: a fake that also stopped its output here would blur which of
  // the two effects a regression produced.
  void (async () => {
    for await (const message of prompt) {
      promptsDelivered.push(String(message?.message?.content ?? ''));
      nudge();
    }
    seen.stdinClosed = true;
    nudge();
  })();

  async function* stream(): AsyncGenerator<any, void> {
    while (true) {
      while (outbox.length > 0) yield outbox.shift();
      if (ended) return;
      await wakePromise;
    }
  }

  // An async generator returns itself from [Symbol.asyncIterator](), so every
  // reader shares one cursor — the SDK property that makes an abandoned
  // iterator.next() eat the next chunk.
  const query = Object.assign(stream(), {
    interrupt: async () => { seen.interrupts++; },
    close: () => { seen.closes++; ended = true; nudge(); },
    setPermissionMode: async () => {},
    setModel: async () => {},
    mcpServerStatus: async () => [],
    streamInput: async () => {},
    reconnectMcpServer: async () => {},
  });

  return {
    query,
    seen,
    promptsDelivered,
    emit: (chunk: any) => { outbox.push(chunk); nudge(); },
  };
}

function fakeCliFleet() {
  const spawned: ReturnType<typeof spawnFakeCli>[] = [];
  sdkQuery.mockImplementation((args: { prompt: AsyncIterable<any>; options?: { abortController?: AbortController } }) => {
    const cli = spawnFakeCli(args.prompt, args.options?.abortController);
    spawned.push(cli);
    return cli.query;
  });
  return spawned;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

type Turn = {
  chunks: StreamChunk[];
  done: Promise<void>;
  /**
   * willResumeAfterCompletion() as the consumer reads it while handling
   * `complete`: true defers the session end, so the session stays `running`.
   * Captured at that instant because it is only true for that instant.
   */
  resumeAtComplete?: boolean;
};

function startTurn(provider: ClaudeCodeProvider, message: string): Turn {
  const turn: Turn = { chunks: [], done: Promise.resolve() };
  turn.done = (async () => {
    for await (const chunk of provider.sendMessage(message, undefined, 'session-1', [], process.cwd())) {
      turn.chunks.push(chunk);
      if (chunk.type === 'complete') turn.resumeAtComplete = provider.willResumeAfterCompletion();
    }
  })();
  return turn;
}

function internals(provider: ClaudeCodeProvider) {
  return provider as unknown as {
    activeTasks: Map<string, { status: string; queryGeneration?: number }>;
    drainingBackgroundTasks: boolean;
    parkedLease: unknown;
  };
}

/** Turn 1: the lead finishes, one background sub-agent holds the query open. */
async function runToDrain(
  provider: ClaudeCodeProvider,
  cli: () => ReturnType<typeof spawnFakeCli> | undefined,
): Promise<Turn> {
  const turn = startTurn(provider, 'start the sweep');
  await waitFor(() => cli()?.promptsDelivered.length === 1, 'the first prompt to reach stdin');
  cli()!.emit({ type: 'system', subtype: 'task_started', task_id: 'sweep', description: 'Long background sweep' });
  cli()!.emit({ type: 'result', subtype: 'success', result: 'kicked off', usage: {} });
  await waitFor(() => internals(provider).drainingBackgroundTasks, 'the lead turn to enter the drain');
  return turn;
}

describe('ClaudeCodeProvider send-now during a sub-agent drain', () => {
  // The v1 regression, end to end. A turn that adopted the query and is then
  // interrupted while still generating is the one exit where neither a drain
  // nor an abort runs, so the teardown's own reap is all there is. Without it
  // the subprocess kept running unowned and its task stayed `running`, pinning
  // the session at "Thinking…" for nine minutes. #1269.
  it('reaps the inherited sub-agent when an adopted turn is interrupted mid-generation', async () => {
    const cli = fakeCliFleet();
    const provider = new ClaudeCodeProvider();
    const state = internals(provider);

    const turnA = await runToDrain(provider, () => cli[0]);
    // The deferral that makes everything after it matter: the consumer keeps
    // the session alive for the sub-agent.
    expect(turnA.resumeAtComplete).toBe(true);

    await expect(provider.interruptCurrentTurn({ canAdoptQuery: true }))
      .resolves.toEqual({ method: 'handover' });
    await turnA.done;
    expect(state.parkedLease).not.toBeNull();
    expect(state.activeTasks.get('sweep')?.status).toBe('running');

    const turnB = startTurn(provider, 'follow-up');
    await waitFor(() => cli[0].promptsDelivered.length === 2, 'the follow-up prompt to reach stdin');
    // Same subprocess, same pipe: the sub-agent is still in there.
    expect(cli).toHaveLength(1);
    expect(cli[0].seen.stdinClosed).toBe(false);

    cli[0].emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'working on it' }] } });
    await waitFor(() => turnB.chunks.some(c => c.type === 'text'), 'the adopted turn to start generating');

    await expect(provider.interruptCurrentTurn()).resolves.toEqual({ method: 'interrupt' });
    await turnB.done;

    // Nothing can settle this task any more — the subprocess it ran in is gone.
    expect(state.activeTasks.get('sweep')?.status).toBe('stopped');
    expect(cli[0].seen.closes).toBe(1);
    // And between turns the session is free again.
    expect(provider.willResumeAfterCompletion()).toBe(false);

    const turnC = startTurn(provider, 'third');
    await waitFor(() => cli.length === 2, 'the next turn to open a fresh query');
    cli[1].emit({ type: 'result', subtype: 'success', result: 'ok', usage: {} });
    await turnC.done;

    // The user-visible end state: the next completed turn ends the session
    // instead of opening a drain on a task nothing can ever finish.
    expect(turnC.resumeAtComplete).toBe(false);
    expect(state.drainingBackgroundTasks).toBe(false);
  }, 20_000);

  // Two send-nows in a row. Each delivery goes onto the persistent prompt
  // stream; the one-shot streamInput it replaced would have closed stdin here
  // and killed the sub-agent the second handover exists to preserve. #1269.
  it('carries one live query through two consecutive handovers without closing stdin', async () => {
    const cli = fakeCliFleet();
    const provider = new ClaudeCodeProvider();
    const state = internals(provider);

    const turnA = await runToDrain(provider, () => cli[0]);
    await expect(provider.interruptCurrentTurn({ canAdoptQuery: true }))
      .resolves.toEqual({ method: 'handover' });
    await turnA.done;

    const turnB = startTurn(provider, 'second');
    await waitFor(() => cli[0].promptsDelivered.length === 2, 'the second prompt to reach stdin');
    cli[0].emit({ type: 'result', subtype: 'success', result: 'still sweeping', usage: {} });
    await waitFor(() => state.drainingBackgroundTasks, 'the adopted turn to enter its own drain');

    await expect(provider.interruptCurrentTurn({ canAdoptQuery: true }))
      .resolves.toEqual({ method: 'handover' });
    await turnB.done;

    const turnC = startTurn(provider, 'third');
    await waitFor(() => cli[0].promptsDelivered.length === 3, 'the third prompt to reach stdin');

    expect(cli).toHaveLength(1);
    expect(cli[0].promptsDelivered).toEqual(['start the sweep', 'second', 'third']);
    expect(cli[0].seen.stdinClosed).toBe(false);
    expect(cli[0].seen.interrupts).toBe(0);
    expect(cli[0].seen.closes).toBe(0);
    // Restamped across both handovers, so this turn's drain waits for it
    // instead of reaping it as a stranger.
    expect(state.activeTasks.get('sweep')?.status).toBe('running');

    // Land the sub-agent's result on the third turn to close the run out.
    cli[0].emit({ type: 'result', subtype: 'success', result: 'done', usage: {} });
    await waitFor(() => state.drainingBackgroundTasks, 'the third turn to enter the drain');
    cli[0].emit({ type: 'system', subtype: 'task_notification', task_id: 'sweep', status: 'completed', summary: 'swept' });
    await turnC.done;

    expect(state.activeTasks.get('sweep')?.status).toBe('completed');
  }, 20_000);

  // Two turns of one session can be in flight at the same time, and the entry
  // of the second aborts whatever `this.abortController` holds ("Abort any
  // existing request before starting a new one", sendMessage). After an
  // adoption that field is the LEASE's controller — the live subprocess the
  // inherited sub-agents run in.
  //
  // The overlap is the handover's own window. `interruptCurrentTurn` reports
  // 'handover', `clearStuckRunningState` forces the session idle so the waiting
  // prompt can dispatch, and while it is idle a second door into sendMessage
  // stands open: `onTeammateMessageWhileIdle` (MessageStreamingHandler) calls
  // the send-message handler directly — past the queue driver's processingSet
  // and session-busy guards — and this change taught it to accept a message for
  // a session whose query is parked. A prompt typed into the composer that the
  // forced idle just re-enabled (`ai:sendMessage`) reaches sendMessage the same
  // way. Neither door knows the other dispatched a turn a moment earlier.
  it('keeps the adopted query alive when a second turn enters the same session', async () => {
    const cli = fakeCliFleet();
    const provider = new ClaudeCodeProvider();
    const state = internals(provider);

    const turnA = await runToDrain(provider, () => cli[0]);
    await expect(provider.interruptCurrentTurn({ canAdoptQuery: true }))
      .resolves.toEqual({ method: 'handover' });
    await turnA.done;

    // Door one: the prompt the handover was made for. It adopts the lease, so
    // from here the provider's abort handle is the parked query's.
    const turnB = startTurn(provider, 'the waiting prompt');
    await waitFor(() => cli[0].promptsDelivered.length === 2, 'the waiting prompt to reach stdin');
    expect(cli).toHaveLength(1);
    expect(cli[0].seen.aborted).toBe(false);
    expect(state.activeTasks.get('sweep')?.status).toBe('running');

    // Door two, entered while that turn is still generating.
    const turnC = startTurn(provider, 'a sub-agent reported in');
    await waitFor(() => cli.length === 2, 'the second turn to open its own query');

    const killedTheLiveQuery = cli[0].seen.aborted;
    const sweepAfterOverlap = state.activeTasks.get('sweep')?.status;

    // Settle both turns so nothing keeps running past the assertions.
    cli[1].emit({ type: 'result', subtype: 'success', result: 'ok', usage: {} });
    await Promise.allSettled([turnB.done, turnC.done]);

    // The sub-agent this whole change exists to preserve. Asserted as one
    // object so a failure reports both halves: whether the handle fired, and
    // what became of the sub-agent behind it.
    expect({ killedTheLiveQuery, sweepAfterOverlap }).toEqual({
      killedTheLiveQuery: false,
      sweepAfterOverlap: 'running',
    });
  }, 20_000);

  // The subprocess only ever calls the hooks bound into the options its query
  // was created with, so on an adopted query the PARKED turn's AgentToolHooks
  // is where the file edits land. Reading a turn-fresh instance instead found
  // an empty edited-files set and skipped createTurnEndSnapshots entirely: the
  // turn's restore points never reached the file history, and nothing showed it
  // during the turn because the diff view runs off the file watcher. #1269.
  it("writes the adopted turn's restore points, and only its own", async () => {
    const cli = fakeCliFleet();
    const provider = new ClaudeCodeProvider();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-1269-'));
    const beforeHandover = path.join(dir, 'before.ts');
    const afterHandover = path.join(dir, 'after.ts');
    fs.writeFileSync(beforeHandover, 'before');
    fs.writeFileSync(afterHandover, 'after');

    const turnA = startTurn(provider, 'start the sweep');
    await waitFor(() => cli[0]?.promptsDelivered.length === 1, 'the first prompt to reach stdin');
    // The subprocess's one PreToolUse hook, for the whole life of the query.
    const preToolUse = sdkQuery.mock.calls.at(-1)![0].options.hooks.PreToolUse[0].hooks[0];
    const write = (filePath: string, toolUseId: string) => preToolUse(
      { tool_name: 'Write', tool_input: { file_path: filePath } },
      toolUseId,
      { signal: new AbortController().signal },
    );

    await write(beforeHandover, 'tool-a');
    cli[0].emit({ type: 'system', subtype: 'task_started', task_id: 'sweep', description: 'Long background sweep' });
    cli[0].emit({ type: 'result', subtype: 'success', result: 'kicked off', usage: {} });
    await waitFor(() => internals(provider).drainingBackgroundTasks, 'the lead turn to enter the drain');
    expect(history.snapshots).toEqual([beforeHandover]);

    await expect(provider.interruptCurrentTurn({ canAdoptQuery: true }))
      .resolves.toEqual({ method: 'handover' });
    await turnA.done;

    const turnB = startTurn(provider, 'follow-up');
    await waitFor(() => cli[0].promptsDelivered.length === 2, 'the follow-up prompt to reach stdin');
    await write(afterHandover, 'tool-b');
    cli[0].emit({ type: 'result', subtype: 'success', result: 'done', usage: {} });
    await waitFor(() => turnB.chunks.some(c => c.type === 'complete'), 'the adopted turn to end');

    // The second entry is what the fix restores. A repeat of the first would
    // mean the adopting turn carried the parked turn's files into its snapshot.
    expect(history.snapshots).toEqual([beforeHandover, afterHandover]);

    cli[0].emit({ type: 'system', subtype: 'task_notification', task_id: 'sweep', status: 'completed', summary: 'swept' });
    await turnB.done;
    fs.rmSync(dir, { recursive: true, force: true });
  }, 20_000);
});
