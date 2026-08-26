// @vitest-environment node
/**
 * Send-now while the lead is STILL GENERATING and a background sub-agent is
 * running (#1269).
 *
 * `ClaudeCodeProvider.turnHandover.test.ts` covers the case where the lead has
 * already produced its `result` and only the drain holds the query open. The
 * case here is the other half of the same user action: the user types into a
 * turn that is mid-answer. Today that routes to a real interrupt, which ends the
 * prompt stream and drops every reference to the query — the sub-agent inside it
 * has no owner left. Parking is the only state in which sub-agents survive a
 * turn change, so this turn has to park too.
 *
 * Only the CLI subprocess is faked; buildSdkOptions, the persistent prompt
 * stream, the streaming loop and the teardown are the shipping ones. The fake is
 * deliberately GENEROUS — it does not die when its stdin ends and keeps emitting
 * afterwards — so a chunk that fails to arrive failed on the provider's side
 * rather than because the fixture modelled the process as dead.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false },
}));

vi.mock('../../../../../../electron/src/main/HistoryManager', () => ({
  historyManager: {
    createSnapshot: async () => {},
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
 * One CLI subprocess. `seen.stdinClosed` is the observable for
 * `transport.endInput()`: the SDK ends the binary's stdin exactly when the
 * prompt AsyncIterable it was handed returns. Each `query()` call spawns its
 * own, so "the follow-up turn kept the sub-agent" and "the follow-up turn got a
 * fresh process" are distinguishable rather than a matter of interpretation.
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

  abortController?.signal.addEventListener('abort', () => {
    seen.aborted = true;
    ended = true;
    nudge();
  });

  // Recorded, not acted on: a fake that also stopped its output here would blur
  // which of the two effects a regression produced.
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

  const query = Object.assign(stream(), {
    // The control request only stops the model's generation; it does not end
    // the process and does not settle the stream. The abandoned generation's
    // `result` is emitted by the test, at the point the subprocess would.
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

/** Throwing wait — for fixture preconditions, where a timeout means the setup broke. */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Non-throwing wait — for the measurements. A property that is missing today
 * must be REPORTED as missing by its own assertion, not hidden behind a timeout
 * thrown three lines earlier.
 */
async function reached(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return predicate();
}

type Turn = { chunks: StreamChunk[]; done: Promise<void> };

function startTurn(provider: ClaudeCodeProvider, message: string): Turn {
  const turn: Turn = { chunks: [], done: Promise.resolve() };
  turn.done = (async () => {
    for await (const chunk of provider.sendMessage(message, undefined, 'session-1', [], process.cwd())) {
      turn.chunks.push(chunk);
    }
  })();
  void turn.done.catch(() => {});
  return turn;
}

function internals(provider: ClaudeCodeProvider) {
  return provider as unknown as {
    activeTasks: Map<string, { status: string }>;
    drainingBackgroundTasks: boolean;
    promptEndTimer: ReturnType<typeof setTimeout> | null;
  };
}

describe('ClaudeCodeProvider send-now while the lead is still generating', () => {
  it('parks the query instead of interrupting, so the running sub-agent survives into the follow-up turn', async () => {
    const cli = fakeCliFleet();
    const provider = new ClaudeCodeProvider();
    const state = internals(provider);

    try {
      // Turn A: a background sub-agent starts, the lead keeps writing. No
      // `result` chunk, so no drain — this is the state the drain-only handover
      // gate turns away today.
      const turnA = startTurn(provider, 'start the sweep');
      await waitFor(() => cli[0]?.promptsDelivered.length === 1, 'the first prompt to reach stdin');
      cli[0].emit({ type: 'system', subtype: 'task_started', task_id: 'sweep', description: 'Long background sweep' });
      cli[0].emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'delegating…' }] } });
      await waitFor(() => turnA.chunks.some(c => c.type === 'text'), 'the lead turn to start generating');

      // The whole measurement rests on these: something worth saving is running,
      // and the lead has not finished, so no drain is open.
      expect(state.activeTasks.get('sweep')?.status).toBe('running');
      expect(state.drainingBackgroundTasks).toBe(false);
      expect(cli[0].seen.stdinClosed).toBe(false);

      const outcome = await provider.interruptCurrentTurn({ canAdoptQuery: true });
      await turnA.done;

      // Positive polarity, and settled: `endInput()` reaches the fake's
      // for-await a tick after the teardown ends the stream, so reading the flag
      // straight after `turnA.done` would report "still open" for a stream that
      // is closing — an assertion that could never go red.
      const stdinClosedAfterSendNow = await reached(() => cli[0].seen.stdinClosed, 300);
      const sweepAfterSendNow = state.activeTasks.get('sweep')?.status;

      // The subprocess answers the control request with the abandoned
      // generation's `result`. It belongs to the turn that is already gone.
      cli[0].emit({ type: 'result', subtype: 'success', result: 'abandoned generation', usage: {} });

      // Turn B: the prompt the send-now was made for.
      const turnB = startTurn(provider, 'follow-up');
      await reached(() => cli[0].promptsDelivered.length === 2 || cli.length > 1);
      const carriedTheQuery = cli.length === 1 && cli[0].promptsDelivered[1] === 'follow-up';

      // Give the inherited `result` time to be read and discarded.
      const endedOnInheritedResult = await reached(
        () => turnB.chunks.some(c => c.type === 'complete'),
        400,
      );

      // The discard has to reach the grace timer too. It arms on any `result`
      // chunk and its expiry ends the prompt stream — the very kill the park
      // exists to prevent, only deferred by the grace window. Read BEFORE turn B
      // produces anything: its first chunk re-arms the timer as
      // reset-on-activity and would make an armed and a disarmed provider look
      // identical from here.
      const countdownArmedByDiscardedResult = state.promptEndTimer !== null;

      // Turn B's own work, on the query it is supposed to have adopted.
      cli[0].emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'following up' }] } });
      cli[0].emit({ type: 'result', subtype: 'success', result: 'follow-up done', usage: {} });
      const completedOnItsOwnResult = await reached(() => turnB.chunks.some(c => c.type === 'complete'));

      // Each property on its own SOFT assertion: the run has to name every
      // property that is missing, not just the first one. A hard assertion here
      // would report the handover and hide the five behind it.
      expect.soft(outcome, 'send-now during generation must report a handover, not an interrupt')
        .toEqual({ method: 'handover' });
      expect.soft(stdinClosedAfterSendNow, 'the prompt stream must stay open — ending it kills the sub-agent inside the subprocess')
        .toBe(false);
      expect.soft(sweepAfterSendNow, 'the running sub-agent must not be reaped by the send-now')
        .toBe('running');
      expect.soft(carriedTheQuery, 'the follow-up turn must adopt the parked query instead of spawning a second subprocess')
        .toBe(true);
      expect.soft(endedOnInheritedResult, "the abandoned generation's result must not end the follow-up turn")
        .toBe(false);
      expect.soft(countdownArmedByDiscardedResult, "the discarded result must not arm the prompt-end countdown — its expiry closes stdin and kills the parked sub-agent")
        .toBe(false);
      expect.soft(completedOnItsOwnResult, 'the follow-up turn must still end on its OWN result — the discard applies once')
        .toBe(true);
    } finally {
      provider.abort();
    }
  }, 30_000);
});
