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
 *
 * The four cases differ in ONE variable: how the abandoned generation answers
 * the control request. The SDK's own type says that is not one shape but three
 * — `subtype: 'success'`, one of the `error_*` subtypes with `is_error`, or
 * nothing at all if the process never gets that far — and the follow-up turn
 * inherits whichever one arrives. A fix that only survives the success shape is
 * a fix for one third of the users who hit this.
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

/**
 * Turn A up to the moment the send-now has parked the query: a background
 * sub-agent is running, the lead is still generating, no drain is open. Every
 * step here is a PRECONDITION and therefore throws — a case that never reached
 * the park measures nothing, and saying so as a fixture error keeps it out of
 * the case's own assertions. The property being parked at all is measured by
 * the first test in this file, not here.
 */
async function parkMidGeneration(
  provider: ClaudeCodeProvider,
  cli: ReturnType<typeof fakeCliFleet>,
): Promise<void> {
  const state = internals(provider);

  const turnA = startTurn(provider, 'start the sweep');
  await waitFor(() => cli[0]?.promptsDelivered.length === 1, 'the first prompt to reach stdin');
  cli[0].emit({ type: 'system', subtype: 'task_started', task_id: 'sweep', description: 'Long background sweep' });
  cli[0].emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'delegating…' }] } });
  await waitFor(() => turnA.chunks.some(c => c.type === 'text'), 'the lead turn to start generating');

  if (state.activeTasks.get('sweep')?.status !== 'running') {
    throw new Error('fixture: no background sub-agent is running, so there is nothing for a park to preserve');
  }
  if (state.drainingBackgroundTasks) {
    throw new Error('fixture: the lead already finished and a drain is open — that is the other half of #1269');
  }

  const outcome = await provider.interruptCurrentTurn({ canAdoptQuery: true });
  await turnA.done;

  if ((outcome as { method?: string } | undefined)?.method !== 'handover') {
    throw new Error(`fixture: the send-now did not park the query (outcome=${JSON.stringify(outcome)})`);
  }
}

/** Turn B on the parked query. Adoption is a precondition, not a measurement. */
async function startAdoptedFollowUp(
  provider: ClaudeCodeProvider,
  cli: ReturnType<typeof fakeCliFleet>,
): Promise<Turn> {
  const turn = startTurn(provider, 'follow-up');
  await reached(() => cli[0].promptsDelivered.length === 2 || cli.length > 1);
  if (cli.length !== 1 || cli[0].promptsDelivered[1] !== 'follow-up') {
    throw new Error(`fixture: the follow-up turn did not adopt the parked query (subprocesses=${cli.length})`);
  }
  return turn;
}

/** Everything the follow-up turn put on screen as its own answer. */
function visibleText(turn: Turn): string {
  return turn.chunks
    .filter(chunk => chunk.type === 'text')
    .map(chunk => chunk.content ?? '')
    .join('');
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

  it('answers the follow-up prompt when the abandoned generation ends on an ERROR result', async () => {
    const cli = fakeCliFleet();
    const provider = new ClaudeCodeProvider();

    try {
      await parkMidGeneration(provider, cli);

      // The shape the SDK declares for a turn that stopped early: an
      // `error_*` subtype with `is_error`, and NO `result` field — the error
      // text lives in `errors`. It belongs to the turn that is already gone,
      // exactly like the success-shaped one the first test uses.
      cli[0].emit({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        num_turns: 1,
        duration_ms: 1234,
        duration_api_ms: 1200,
        total_cost_usd: 0,
        stop_reason: null,
        errors: [],
        usage: {},
        modelUsage: {},
      });

      const turnB = await startAdoptedFollowUp(provider, cli);

      // Read after a bounded wait, not immediately: an error bubble that
      // arrives one tick late is the same defect as one that arrives at once.
      const erroredOnInheritedResult = await reached(
        () => turnB.chunks.some(c => c.type === 'error'),
        400,
      );
      // Its own wait, not a read of the state the line above happened to leave
      // behind: the error bubble and the `complete` that follows it are two
      // yields, and the first `reached` returns on the first of them.
      const endedOnInheritedResult = await reached(
        () => turnB.chunks.some(c => c.type === 'complete'),
        400,
      );
      const errorText = turnB.chunks.filter(c => c.type === 'error').map(c => c.error ?? '').join('');
      const showedRawChunkJson = /error_during_execution|"is_error"/.test(errorText + visibleText(turnB));

      // Turn B's own work, on the query it adopted. Counted, not tested for
      // presence: a `complete` already yielded on the inherited chunk would
      // otherwise pass for turn B ending on its own result.
      const completesBeforeItsOwnWork = turnB.chunks.filter(c => c.type === 'complete').length;
      cli[0].emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'following up' }] } });
      cli[0].emit({ type: 'result', subtype: 'success', result: 'follow-up done', usage: {} });
      const answeredItsOwnPrompt = await reached(() => visibleText(turnB).includes('following up'), 2000);
      const completedOnItsOwnResult = await reached(
        () => turnB.chunks.filter(c => c.type === 'complete').length > completesBeforeItsOwnWork,
        2000,
      );

      expect.soft(erroredOnInheritedResult, "the abandoned generation's error result must not raise an error bubble in the follow-up turn")
        .toBe(false);
      expect.soft(endedOnInheritedResult, "the abandoned generation's error result must not end the follow-up turn before it answered")
        .toBe(false);
      expect.soft(showedRawChunkJson, 'the follow-up turn must not show the raw inherited chunk as text — an error result with no message stringifies the whole chunk')
        .toBe(false);
      expect.soft(answeredItsOwnPrompt, "the follow-up turn must still answer the user's message")
        .toBe(true);
      expect.soft(completedOnItsOwnResult, 'the follow-up turn must end on its OWN result')
        .toBe(true);
    } finally {
      provider.abort();
    }
  }, 30_000);

  it('keeps the abandoned generation\'s leftover text and usage out of the follow-up turn', async () => {
    const cli = fakeCliFleet();
    const provider = new ClaudeCodeProvider();

    try {
      await parkMidGeneration(provider, cli);

      // Success-shaped, but carrying what the model had produced before the
      // interrupt landed, plus that generation's token count. Both belong to
      // the turn the user cut off.
      cli[0].emit({
        type: 'result',
        subtype: 'success',
        result: 'abandoned text',
        num_turns: 1,
        usage: { input_tokens: 9999, output_tokens: 8888 },
      });

      const turnB = await startAdoptedFollowUp(provider, cli);
      // Give the inherited result time to be read before turn B produces
      // anything of its own — leaked text is only attributable while nothing
      // else is on screen.
      const leakedAbandonedText = await reached(() => visibleText(turnB).includes('abandoned text'), 400);

      cli[0].emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'following up' }] } });
      cli[0].emit({ type: 'result', subtype: 'success', result: 'follow-up done', usage: { input_tokens: 11, output_tokens: 22 } });
      await reached(() => turnB.chunks.some(c => c.type === 'complete'), 2000);
      const reportedUsage = turnB.chunks.find(c => c.type === 'complete')?.usage;

      expect.soft(leakedAbandonedText, "the abandoned generation's leftover text must not appear as the follow-up turn's answer")
        .toBe(false);
      expect.soft(reportedUsage?.input_tokens, "the follow-up turn's input tokens must come from its own result, not the abandoned generation's")
        .toBe(11);
      expect.soft(reportedUsage?.output_tokens, "the follow-up turn's output tokens must come from its own result, not the abandoned generation's")
        .toBe(22);
    } finally {
      provider.abort();
    }
  }, 30_000);

  it('ends the follow-up turn on its own result when the abandoned generation never answers at all', async () => {
    const cli = fakeCliFleet();
    const provider = new ClaudeCodeProvider();

    try {
      await parkMidGeneration(provider, cli);

      // Nothing is emitted here on purpose. The interrupt can land after the
      // generation already produced its result — or the CLI can simply not
      // send another one — and then the only result the follow-up turn ever
      // sees is its OWN.
      const turnB = await startAdoptedFollowUp(provider, cli);

      cli[0].emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'following up' }] } });
      cli[0].emit({ type: 'result', subtype: 'success', result: 'follow-up done', usage: {} });

      // Bounded: a turn that never ends must be REPORTED as never ending, not
      // left to hold the suite open until the runner's own timeout kills it.
      const answeredItsOwnPrompt = await reached(() => visibleText(turnB).includes('following up'), 2000);
      const completedOnItsOwnResult = await reached(() => turnB.chunks.some(c => c.type === 'complete'), 3000);

      expect.soft(answeredItsOwnPrompt, "the follow-up turn must answer the user's message")
        .toBe(true);
      expect.soft(completedOnItsOwnResult, 'the follow-up turn must end on its own result — with no inherited result to drop, dropping one leaves the session spinning forever')
        .toBe(true);
    } finally {
      provider.abort();
    }
  }, 20_000);
});
