// @vitest-environment node
/**
 * Every path that kills a query must reap its background sub-agent tasks
 * (NIM-2458, #1269).
 *
 * A background Task/Bash sub-agent runs inside the SDK subprocess. abort()
 * kills that subprocess, so the task's terminal `task_notification` can never
 * arrive. If it is left `status: 'running'` in `activeTasks`, the *next* turn's
 * `result` sees hasRunningTasks() === true and defers teardown to the drain
 * loop — the session stays 'running' and its queued prompts stall until the
 * drain grace expires. Observed as a ~5 minute stall on 2026-08-04.
 *
 * interruptCurrentTurn() leaves the same wreckage: the streaming loop breaks on
 * the interrupt, so no terminal notification can land afterwards, and the drain
 * that would otherwise reap never runs because an interrupt is not an abort.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false },
}));

vi.mock('../claudeCode/cliPathResolver', () => ({
  resolveClaudeAgentCliPath: async () => '/fake/claude',
}));

vi.mock('../../../../electron/claudeCodeEnvironment', () => ({
  setupClaudeCodeEnvironment: () => ({}),
  resolveNativeBinaryPath: () => undefined,
}));

import { ClaudeCodeProvider } from '../ClaudeCodeProvider';
import { createPersistentPromptStream } from '../claudeCode/sdkOptionsBuilder';

type FakeLease = {
  query: { close: () => void; interrupt?: () => Promise<void> };
  promptController: { end: (reason: string) => void; isEnded: () => boolean; push?: (message: unknown) => boolean };
  abortController: AbortController;
  generation?: number;
  sessionId?: string | undefined;
  optionsSignature?: string;
  pendingChunk?: Promise<IteratorResult<unknown>> | null;
  terminalNotifications?: Array<{ taskId: string; description: string; status: string }>;
};

/** The fingerprint an unchanged follow-up turn resolves. See V1 tests below. */
const SAME_OPTIONS = 'model=opus|effort=high|thinking=|allowed=|disallowed=|permission=default|mcp=';

type ProviderInternals = {
  activeTasks: Map<string, {
    taskId: string;
    description: string;
    status: string;
    queryGeneration?: number;
  }>;
  hasRunningTasks: () => boolean;
  parkedLease: FakeLease | null;
  handover: { state: 'requested' | 'accepted' | 'abandoned' } | null;
  leadQuery: { interrupt: () => Promise<void>; close?: () => void } | null;
  leadQueryAbortController: AbortController | null;
  promptController: { end: (reason: string) => void; isEnded: () => boolean; push?: (message: any) => boolean } | null;
  abortController: AbortController | null;
  drainingBackgroundTasks: boolean;
  drainExitCause: string;
  drainTerminalNotifications: Array<{ taskId: string; description: string; status: string }>;
  currentSessionId: string | undefined;
  wasInterrupted: boolean;
  settleHandover: (parts: {
    query: unknown;
    promptController: unknown;
    abortController: AbortController | null;
    exitCause: string;
    pendingChunk?: Promise<IteratorResult<unknown>> | null;
    sessionId?: string | undefined;
    optionsSignature?: string;
  }) => boolean;
  takeOwnedQueryParts: () => {
    query: ProviderInternals['leadQuery'];
    abortController: AbortController | null;
  };
  finalizeBackgroundDrain: (sessionId: string | undefined, query?: { close?: () => void } | null) => void;
  reapTasksOfEndedAdoptedTurn: (
    parts: {
      query: unknown;
      abortController: AbortController | null;
      sessionId: string | undefined;
    },
    turn: {
      adoptedLease: boolean;
      parkedForHandover: boolean;
      wasDraining: boolean;
      wasInterrupted: boolean;
    },
  ) => void;
  adoptParkedLeaseFor: (message: string, optionsSignature: string) => FakeLease | null;
  releaseAdoptedLease: () => void;
  reapForeignRunningTasks: (sessionId: string | undefined) => void;
  teammateManager: {
    requeueTeammateMessage: (msg: unknown) => void;
  };
  queryGeneration: number;
};

const teammateMessage = (content: string) => ({
  teammateName: 'scout',
  teammateAgentId: 'agent-1',
  content,
  summary: content,
});

function seedTasks(state: ProviderInternals): void {
  state.activeTasks.set('bkxaizroy', {
    taskId: 'bkxaizroy',
    description: 'Block until suite finishes',
    status: 'running',
  });
  state.activeTasks.set('done', {
    taskId: 'done',
    description: 'Already finished',
    status: 'completed',
  });
}

function internals(provider: ClaudeCodeProvider): ProviderInternals {
  return provider as unknown as ProviderInternals;
}

const PARK_TIMEOUT_MS = (ClaudeCodeProvider as unknown as { HANDOVER_PARK_TIMEOUT_MS: number })
  .HANDOVER_PARK_TIMEOUT_MS;
const LEASE_MAX_AGE_MS = (ClaudeCodeProvider as unknown as { PARKED_LEASE_MAX_AGE_MS: number })
  .PARKED_LEASE_MAX_AGE_MS;

/**
 * A provider sitting in a background-sub-agent drain: the lead turn is over,
 * one task is still running, and the query is only being held open for it.
 * This is the exact state in which a Stop or a queued prompt used to destroy
 * the sub-agent's work. #1269.
 */
function providerInDrain() {
  const provider = new ClaudeCodeProvider();
  const state = internals(provider);
  const interrupt = vi.fn(async () => {});
  const close = vi.fn();
  const end = vi.fn();
  const ended = vi.fn(() => false);
  const push = vi.fn(() => true);
  const abortController = new AbortController();

  state.leadQuery = { interrupt, close };
  // The controller the SDK was given for THIS query, recorded next to it when
  // the query was created.
  state.leadQueryAbortController = abortController;
  state.promptController = { end, isEnded: ended, push };
  state.abortController = abortController;
  state.drainingBackgroundTasks = true;
  state.currentSessionId = 'session-in-drain';
  state.queryGeneration = 1;
  state.activeTasks.set('subagent', {
    taskId: 'subagent',
    description: 'Long background sweep',
    status: 'running',
    queryGeneration: 1,
  });

  return { provider, state, interrupt, close, end, ended, push, abortController };
}

/**
 * What the teardown block does once the streaming loop has come out: capture
 * the parts, settle the handover, on anything that did NOT park run the
 * ordinary drain teardown, and finally reap what an adopted query left behind.
 * All three matter together: the park decision and the exit cause that the
 * teardown is then classified by are what a silent fall-through gets wrong, and
 * the reap is the only step that runs when the turn never entered a drain.
 */
function runTeardown(
  state: ProviderInternals,
  exitCause: string,
  pendingChunk?: Promise<IteratorResult<unknown>> | null,
  turn?: { sessionId?: string | undefined; optionsSignature?: string; adoptedLease?: boolean },
): boolean {
  // Same source the `finally` uses: the query and its controller come out as
  // the pair they were recorded as, not from whatever the provider holds now.
  const { query, abortController } = state.takeOwnedQueryParts();
  const promptController = state.promptController;
  const sessionId = turn && 'sessionId' in turn ? turn.sessionId : state.currentSessionId;
  state.abortController = null;
  state.drainExitCause = exitCause;
  const parked = state.settleHandover({
    query,
    promptController,
    abortController,
    exitCause,
    pendingChunk,
    sessionId,
    optionsSignature: turn?.optionsSignature ?? SAME_OPTIONS,
  });
  if (!parked) {
    state.finalizeBackgroundDrain(sessionId, query);
  }
  // The reap goes through the provider's own method rather than a restatement
  // of its decision, so the condition and the teardown it triggers are the
  // shipping ones. The `finally`'s call TO that method is still not covered:
  // reaching it means driving the whole sendMessage generator.
  state.reapTasksOfEndedAdoptedTurn(
    { query, abortController, sessionId },
    {
      adoptedLease: turn?.adoptedLease === true,
      parkedForHandover: parked,
      wasDraining: state.drainingBackgroundTasks,
      // Read here for the same reason the `finally` reads it before its own
      // reset: an interrupted query has no owner left to close it later.
      wasInterrupted: state.wasInterrupted,
    },
  );
  return parked;
}

/**
 * What the adoption site does: take the lease only if the turn's prompt lands
 * on its stream, then wire the new owner up before releasing the lease slot.
 */
function adoptLease(
  state: ProviderInternals,
  message = 'follow-up',
  optionsSignature = SAME_OPTIONS,
): FakeLease {
  const lease = state.adoptParkedLeaseFor(message, optionsSignature);
  if (!lease) throw new Error('expected a parked lease to adopt');
  state.leadQuery = lease.query as ProviderInternals['leadQuery'];
  // An adopted query keeps the controller the SDK was given for it — the
  // lease's, not one this turn made. Recorded as the pair, same as a fresh
  // query's.
  state.leadQueryAbortController = lease.abortController;
  state.promptController = lease.promptController;
  state.abortController = lease.abortController;
  state.releaseAdoptedLease();
  return lease;
}

describe('ClaudeCodeProvider background task reaping', () => {
  it('marks tasks orphaned by abort() stopped so the next turn does not defer teardown', () => {
    const provider = new ClaudeCodeProvider();
    const state = internals(provider);
    seedTasks(state);

    provider.abort();

    expect(state.hasRunningTasks()).toBe(false);
    expect(state.activeTasks.get('bkxaizroy')?.status).toBe('stopped');
    // A task that already settled keeps its own terminal status.
    expect(state.activeTasks.get('done')?.status).toBe('completed');
  });

  it('marks tasks orphaned by interruptCurrentTurn() stopped', async () => {
    const provider = new ClaudeCodeProvider();
    const state = internals(provider);
    const interrupt = vi.fn(async () => {});
    state.leadQuery = { interrupt };
    seedTasks(state);

    const outcome = await provider.interruptCurrentTurn();

    expect(outcome.method).toBe('interrupt');
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(state.hasRunningTasks()).toBe(false);
    expect(state.activeTasks.get('bkxaizroy')?.status).toBe('stopped');
    expect(state.activeTasks.get('done')?.status).toBe('completed');
  });

  // A handover parks the live query for the next turn instead of killing it, so
  // its sub-agents survive. Stop must still reach it: the parked query holds its
  // own abort controller — the one the SDK was given — which super.abort() does
  // not touch, because this.abortController was cleared when that turn ended.
  // Without the explicit disposal the subprocess kept running unowned. #1269.
  it('disposes a parked handover lease on abort so its query cannot outlive Stop', () => {
    const provider = new ClaudeCodeProvider();
    const state = internals(provider);
    const close = vi.fn();
    const end = vi.fn();
    const abortController = new AbortController();
    state.parkedLease = { query: { close }, promptController: { end, isEnded: () => false }, abortController };
    state.activeTasks.set('bnwiroqhc', {
      taskId: 'bnwiroqhc',
      description: 'Timestamp logging loop',
      status: 'running',
    });

    provider.abort();

    expect(close).toHaveBeenCalled();
    expect(abortController.signal.aborted).toBe(true);
    expect(end).toHaveBeenCalled();
    expect(state.parkedLease).toBeNull();
    expect(state.activeTasks.get('bnwiroqhc')?.status).toBe('stopped');
  });
});

/**
 * The handover itself: who owns the live query at each moment.
 *
 * These drive the provider's real handover methods and stand in only for the
 * two places the streaming loop touches the state machine — the drain exit that
 * commits to the handover, and the teardown block that runs afterwards
 * (`runTeardown` calls the same `settleHandover` the `finally` calls). Driving
 * the full `sendMessage` generator would need the SDK, the session store, git
 * and the transcript pipeline mocked out, which buys no additional coverage of
 * the ownership rules under test. #1269.
 */
describe('ClaudeCodeProvider handover lease lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Non-regression: with no queued prompt behind the Stop there is no turn to
  // hand the query to, so the interrupt must behave exactly as it did before
  // handovers existed.
  it('interrupts normally when no follow-up prompt is waiting', async () => {
    const { provider, state, interrupt } = providerInDrain();

    await expect(provider.interruptCurrentTurn()).resolves.toEqual({ method: 'interrupt' });
    expect(interrupt).toHaveBeenCalled();
    expect(state.parkedLease).toBeNull();
    expect(state.handover).toBeNull();
  });

  it('parks the live query when an adoptable prompt is waiting, leaving its sub-agents running', async () => {
    const { provider, state, interrupt, close } = providerInDrain();

    const pending = provider.interruptCurrentTurn({ canAdoptQuery: true });
    await Promise.resolve();
    expect(state.handover?.state).toBe('requested');

    state.handover!.state = 'accepted';
    expect(runTeardown(state, 'handover')).toBe(true);

    await expect(pending).resolves.toEqual({ method: 'handover' });
    expect(interrupt).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(state.parkedLease).not.toBeNull();
    expect(state.activeTasks.get('subagent')?.status).toBe('running');
  });

  // The v2 regression, and the reason the handover became a state machine: the
  // park budget expired while the loop had already committed and the teardown
  // was still unwinding (post-loop teardown has been measured at 152s here).
  // Falling back to a real interrupt at that point kills the very sub-agents the
  // handover was made to preserve. #1269.
  it('does not fall back to an interrupt when the park budget expires after the loop accepted', async () => {
    vi.useFakeTimers();
    const { provider, state, interrupt, close } = providerInDrain();

    const pending = provider.interruptCurrentTurn({ canAdoptQuery: true });
    await vi.advanceTimersByTimeAsync(0);
    state.handover!.state = 'accepted';

    await vi.advanceTimersByTimeAsync(PARK_TIMEOUT_MS * 2);
    expect(interrupt).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();

    expect(runTeardown(state, 'handover')).toBe(true);
    await expect(pending).resolves.toEqual({ method: 'handover' });
    expect(state.activeTasks.get('subagent')?.status).toBe('running');
  });

  // Parking on the request rather than on the loop's exit handed the follow-up
  // turn a dead query and skipped close, reap and auto-continue with it. #1269.
  //
  // The fall-back also has to notice that the turn is already gone: the wait
  // only ends when the teardown settles it, and by then the `finally` has run.
  // Interrupting anyway sets wasInterrupted on nothing — where it survives into
  // the NEXT turn and suppresses its teammate delivery — and reports a live
  // turn, so the caller leaves the session 'running' and the waiting prompt
  // strands behind session-busy. #1269.
  it('parks nothing and reports no live turn when the iterator dies while the handover is pending', async () => {
    const { provider, state, interrupt } = providerInDrain();

    const pending = provider.interruptCurrentTurn({ canAdoptQuery: true });
    await Promise.resolve();
    expect(runTeardown(state, 'iterator-done')).toBe(false);

    await expect(pending).resolves.toEqual({ method: 'interrupt', hadActiveTurn: false });
    expect(interrupt).not.toHaveBeenCalled();
    expect(state.wasInterrupted).toBe(false);
    expect(state.parkedLease).toBeNull();
    expect(state.handover).toBeNull();
    // Nothing parked, so the ordinary teardown kept its close and reap.
    expect(state.activeTasks.get('subagent')?.status).toBe('stopped');
  });

  // The state check above sees a controller that fired; this one sees a query
  // killed with no controller involved at all. A handover is accepted and the
  // teardown is still unwinding (measured at 152s) when a second send-now or a
  // second teammate message arrives: the single-slot guard turns it away, so it
  // interrupts for real — and the park that follows hands the next turn a lease
  // whose transport is dead. push() reports success on it, so the adoption looks
  // done and the user's message is silently gone. Nothing else catches it:
  // wasInterrupted is reset before the park is decided and the abort signal
  // never fired. #1269.
  it('parks nothing when a second interrupt kills the query the handover accepted', async () => {
    const { provider, state, interrupt, close } = providerInDrain();

    const first = provider.interruptCurrentTurn({ canAdoptQuery: true });
    await Promise.resolve();
    state.handover!.state = 'accepted';

    await expect(provider.interruptCurrentTurn({ canAdoptQuery: true }))
      .resolves.toEqual({ method: 'interrupt' });
    expect(interrupt).toHaveBeenCalled();

    expect(runTeardown(state, 'handover')).toBe(false);
    // The first requester is still owed an answer, and gets the honest one.
    await expect(first).resolves.toEqual({ method: 'interrupt', hadActiveTurn: false });

    expect(state.parkedLease).toBeNull();
    expect(close).toHaveBeenCalled();
    expect(state.activeTasks.get('subagent')?.status).toBe('stopped');
  });

  // The park decision used to be split: the pure function said 'park' and the
  // teardown then re-checked the lease parts beside the call. Any part that
  // fails that second check — here a controller that is still in hand but has
  // already fired (a second Stop, an overlapping turn's entry abort,
  // destroy()), so the query it governs is on its way out — fell through to the
  // normal teardown while the exit cause still read 'handover', and that pair
  // closes the query while classifying its sub-agents as still running, which
  // is the pinned "Thinking…" this fix exists to remove, reached through a
  // different door. Settling the handover now corrects the cause to
  // 'interrupted', so the teardown that follows reaps. #1269.
  it('does not park a query whose abort signal fired before the teardown ran', async () => {
    const { provider, state, close, abortController } = providerInDrain();

    const pending = provider.interruptCurrentTurn({ canAdoptQuery: true });
    await Promise.resolve();
    state.handover!.state = 'accepted';
    abortController.abort();

    expect(runTeardown(state, 'handover')).toBe(false);
    await pending;

    expect(state.parkedLease).toBeNull();
    expect(close).toHaveBeenCalled();
    expect(state.activeTasks.get('subagent')?.status).toBe('stopped');
  });

  // The signal check above is a check on a controller's STATE, and the failure
  // it cannot see is one of identity. sendMessage installs a fresh abort
  // controller on the provider at its entry, so a turn unwinding between its
  // handover break and its teardown finds one in `this.abortController` that no
  // query was ever given — unfired, so every state check passes it. Parked, it
  // leaves the lease holding an abort grip attached to nothing: the parked
  // query keeps running and a later Stop reaches none of it. Which controller
  // belongs to the parked query is therefore recorded with the query, not
  // worked out at teardown time. #1269.
  it('parks the controller its own query was created with, not one a later turn installed', async () => {
    const { provider, state, abortController } = providerInDrain();

    const stop = provider.interruptCurrentTurn({ canAdoptQuery: true });
    await Promise.resolve();
    state.handover!.state = 'accepted';
    // A second sendMessage entry lands while this turn is still unwinding and
    // puts its own controller on the provider.
    const laterTurnController = new AbortController();
    state.abortController = laterTurnController;

    expect(runTeardown(state, 'handover')).toBe(true);
    await stop;

    expect(state.parkedLease!.abortController).toBe(abortController);
    expect(state.parkedLease!.abortController).not.toBe(laterTurnController);
  });

  // Sub-agents that settled just before the handover reported into a drain that
  // the park then skipped, so nothing has told the session about them yet.
  // Clearing the field with the rest of the per-turn state dropped their
  // results silently; the batch rides along in the lease instead and the
  // adopting turn resumes its own drain from it. #1269.
  it('carries terminal notifications collected before the park into the lease', async () => {
    const { provider, state } = providerInDrain();
    const settledEarly = { taskId: 'subagent', description: 'Long background sweep', status: 'completed' };
    state.drainTerminalNotifications.push(settledEarly);

    const pending = provider.interruptCurrentTurn({ canAdoptQuery: true });
    await Promise.resolve();
    state.handover!.state = 'accepted';
    expect(runTeardown(state, 'handover')).toBe(true);
    await pending;

    // The `finally` resets the field right after settling the handover.
    state.drainTerminalNotifications = [];

    const lease = adoptLease(state);
    expect(lease.terminalNotifications).toEqual([settledEarly]);
  });

  // The adoption is only real once the prompt is ON the parked stream. An end()
  // that slips in between the park and the follow-up turn makes push() fail,
  // and an adoption that proceeds regardless runs a turn on a query that never
  // received the user's message. Delivery beats preservation: the lease goes,
  // the caller opens a fresh query, and the message arrives. #1269.
  it('gives up the adoption when the parked prompt stream closed before delivery', async () => {
    const { provider, state, close } = providerInDrain();
    const initial = {
      type: 'user' as const,
      message: { role: 'user' as const, content: 'initial' },
      parent_tool_use_id: null,
      session_id: '',
    };
    const { controller } = createPersistentPromptStream(initial);
    state.promptController = controller;

    const pending = provider.interruptCurrentTurn({ canAdoptQuery: true });
    await Promise.resolve();
    state.handover!.state = 'accepted';
    expect(runTeardown(state, 'handover')).toBe(true);
    await pending;

    controller.end('grace timer expired before the follow-up turn arrived');

    expect(state.adoptParkedLeaseFor('the user prompt', SAME_OPTIONS)).toBeNull();
    // Nothing is left holding the old query, and its sub-agents are settled —
    // so the fresh query the caller opens is the only owner in play.
    expect(state.parkedLease).toBeNull();
    expect(close).toHaveBeenCalled();
    expect(state.activeTasks.get('subagent')?.status).toBe('stopped');
  });

  // A running subprocess cannot change the model, effort, thinking mode, tool
  // restrictions or permission mode it was spawned with.
  // A turn that stops the previous one, switches model and sends the next
  // prompt used to adopt the old query and answer from the old model, while the
  // options logged right before it described the new one. #1269.
  it('declines the adoption when the follow-up turn resolved different query options', async () => {
    const { provider, state, close, push } = providerInDrain();

    const pending = provider.interruptCurrentTurn({ canAdoptQuery: true });
    await Promise.resolve();
    state.handover!.state = 'accepted';
    expect(runTeardown(state, 'handover')).toBe(true);
    await pending;

    expect(
      state.adoptParkedLeaseFor('the user prompt', 'model=sonnet|effort=high|thinking=|allowed=|disallowed=|permission=default|mcp='),
    ).toBeNull();
    // Nothing was delivered onto the old stream: the turn opens its own query
    // and sends the prompt there.
    expect(push).not.toHaveBeenCalled();
    expect(state.parkedLease).toBeNull();
    expect(close).toHaveBeenCalled();
    expect(state.activeTasks.get('subagent')?.status).toBe('stopped');
  });

  it('adopts when the follow-up turn resolved the same query options', async () => {
    const { provider, state, close } = providerInDrain();
    // The read the drain was blocked on belongs to the query, not to the turn
    // that abandoned it: the SDK hands every caller the same generator, so a
    // fresh next() in the adopting turn queues BEHIND it and the first message
    // after the handover -- usually the sub-agent's terminal task_notification
    // -- resolves a promise nobody awaits. It rides along in the lease. #1269.
    const inFlight = Promise.resolve({ done: false, value: 'task_notification' }) as Promise<
      IteratorResult<unknown>
    >;

    const pending = provider.interruptCurrentTurn({ canAdoptQuery: true });
    await Promise.resolve();
    state.handover!.state = 'accepted';
    expect(runTeardown(state, 'handover', inFlight)).toBe(true);
    await pending;

    expect(adoptLease(state).pendingChunk).toBe(inFlight);
    expect(close).not.toHaveBeenCalled();
    expect(state.activeTasks.get('subagent')?.status).toBe('running');
  });

  // The one exit an adopted query has that no drain covers: this turn inherited
  // running sub-agents with the lease and is stopped while still GENERATING, so
  // it never reaches the drain that would reap them and no second handover
  // passes them on. Nothing in the teardown reads as wrong — it is the absent
  // step that leaves them 'running', and every later turn then defers into a
  // drain that can never settle: the endless "Thinking…". #1269.
  it('reaps the tasks it inherited when an adopted turn is interrupted while generating', async () => {
    const { provider, state, close } = providerInDrain();

    const pending = provider.interruptCurrentTurn({ canAdoptQuery: true });
    await Promise.resolve();
    state.handover!.state = 'accepted';
    expect(runTeardown(state, 'handover')).toBe(true);
    await pending;

    adoptLease(state);
    // The adopting turn resets the per-turn drain state at the adoption site,
    // and this Stop lands before any sub-agent drain could begin.
    state.drainingBackgroundTasks = false;

    expect(runTeardown(state, 'interrupted', null, { adoptedLease: true })).toBe(false);

    expect(state.activeTasks.get('subagent')?.status).toBe('stopped');
    expect(close).toHaveBeenCalled();
  });

  // A lease is parked in the expectation that a follow-up turn adopts it, but
  // nothing guarantees that turn ever runs — the queued prompt can be swept or
  // deleted. Without an expiry the subprocess runs unowned and its tasks stay
  // 'running', pinning every later turn in a drain that cannot settle. #1269.
  //
  // The drain also really ends here, and the park had skipped the finalize step
  // that normally announces it. Without the announcement a consumer holding the
  // session end open for the drain waits for an event that no exit emits. #1269.
  it('disposes a lease that no turn ever adopts, reaps its tasks and announces the settled drain', async () => {
    vi.useFakeTimers();
    const { provider, state, close } = providerInDrain();
    const drainSettled = vi.fn();
    provider.on('subagents:drainSettled', drainSettled);

    const pending = provider.interruptCurrentTurn({ canAdoptQuery: true });
    await vi.advanceTimersByTimeAsync(0);
    state.handover!.state = 'accepted';
    runTeardown(state, 'handover');
    await pending;
    expect(state.parkedLease).not.toBeNull();
    expect(drainSettled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(LEASE_MAX_AGE_MS + 1);

    expect(state.parkedLease).toBeNull();
    expect(close).toHaveBeenCalled();
    expect(state.activeTasks.get('subagent')?.status).toBe('stopped');
    expect(drainSettled).toHaveBeenCalledWith({ sessionId: 'session-in-drain' });
  });

  // Which session a disposal reports for used to come from `currentSessionId`,
  // which is written only on `system/init` and only when the session has MCP
  // servers, and is cleared by abort(). An ADOPTED query never sends
  // `system/init` again, so once a Stop during a drain had cleared it, nothing
  // restored it: every later disposal emitted for `undefined`, both the task
  // update and drainSettled bailed on their guard, and the user kept seeing
  // killed sub-agents as running while the deferred session end never came.
  // The parking turn knows its session, so the lease carries it. #1269.
  it('reports the parking turn session on disposal, not a field a Stop can clear', async () => {
    vi.useFakeTimers();
    const { provider, state } = providerInDrain();
    const drainSettled = vi.fn();
    provider.on('subagents:drainSettled', drainSettled);

    const pending = provider.interruptCurrentTurn({ canAdoptQuery: true });
    await vi.advanceTimersByTimeAsync(0);
    state.handover!.state = 'accepted';
    expect(runTeardown(state, 'handover', null, { sessionId: 'session-of-parking-turn' })).toBe(true);
    await pending;

    // What a Stop during the drain leaves behind.
    state.currentSessionId = undefined;

    await vi.advanceTimersByTimeAsync(LEASE_MAX_AGE_MS + 1);

    expect(drainSettled).toHaveBeenCalledWith({ sessionId: 'session-of-parking-turn' });
  });

  // The chained case: the turn that adopted a lease is itself interrupted by
  // another queued prompt and hands the same query on again. It only works
  // because the prompt is delivered by pushing onto the live prompt stream --
  // delivering it with streamInput() would close the binary's stdin behind the
  // first delivery, so the second push would have nowhere to go and the user's
  // message would vanish without a trace. #1269.
  it('carries the query through a second handover, delivering both follow-up prompts', async () => {
    const { provider, state } = providerInDrain();
    const initial = {
      type: 'user' as const,
      message: { role: 'user' as const, content: 'initial' },
      parent_tool_use_id: null,
      session_id: '',
    };
    const { iterable, controller } = createPersistentPromptStream(initial);
    const sdkReadsPrompts = iterable[Symbol.asyncIterator]();
    state.promptController = controller;
    // The SDK has consumed the opening prompt and is waiting for more input.
    expect((await sdkReadsPrompts.next()).value).toBe(initial);

    // First handover, then the follow-up turn adopts and delivers its prompt.
    const firstStop = provider.interruptCurrentTurn({ canAdoptQuery: true });
    await Promise.resolve();
    state.handover!.state = 'accepted';
    expect(runTeardown(state, 'handover')).toBe(true);
    await expect(firstStop).resolves.toEqual({ method: 'handover' });

    const firstLease = adoptLease(state, 'second');
    expect((await sdkReadsPrompts.next()).value).toMatchObject({ message: { content: 'second' } });

    // Second handover on the very same query, from the turn that adopted it.
    const secondStop = provider.interruptCurrentTurn({ canAdoptQuery: true });
    await Promise.resolve();
    state.handover!.state = 'accepted';
    expect(runTeardown(state, 'handover')).toBe(true);
    await expect(secondStop).resolves.toEqual({ method: 'handover' });

    const secondLease = adoptLease(state, 'third');
    expect(secondLease.promptController).toBe(firstLease.promptController);
    expect((await sdkReadsPrompts.next()).value).toMatchObject({ message: { content: 'third' } });

    // Through both handovers the stream never ended, which is what kept the
    // sub-agents' stdin open.
    expect(controller.isEnded()).toBe(false);
    expect(state.activeTasks.get('subagent')?.status).toBe('running');
  });

  // The backstop for an exit path nobody enumerated. It does not depend on our
  // own model of the exit paths being complete, which is what makes it the only
  // detector here that survives someone else rearranging them. #1269.
  it('reaps a running task left behind by a query it no longer owns', () => {
    const provider = new ClaudeCodeProvider();
    const state = internals(provider);
    state.queryGeneration = 4;
    state.activeTasks.set('ghost', {
      taskId: 'ghost',
      description: 'Orphaned by a closed query',
      status: 'running',
      queryGeneration: 2,
    });
    state.activeTasks.set('mine', {
      taskId: 'mine',
      description: 'Started in this query',
      status: 'running',
      queryGeneration: 4,
    });

    state.reapForeignRunningTasks('s1');

    expect(state.activeTasks.get('ghost')?.status).toBe('stopped');
    expect(state.activeTasks.get('mine')?.status).toBe('running');
  });
});

/**
 * The teammate route into the same handover. It differs from the Stop route in
 * one way that decides everything: the follow-up turn it parks for is triggered
 * by this provider itself, out of the teammate queue — so if the queue turns out
 * to be empty, the park it just made has nobody to hand the query to. #1269.
 */
describe('ClaudeCodeProvider teammate handover', () => {
  it('hands the query over and delivers the batch through the idle path', async () => {
    const { provider, state, interrupt } = providerInDrain();
    const idle = vi.fn();
    provider.on('teammate:messageWhileIdle', idle);
    state.teammateManager.requeueTeammateMessage(teammateMessage('sweep finished'));

    const pending = provider.interruptWithMessage('unused');
    await Promise.resolve();
    state.handover!.state = 'accepted';
    expect(runTeardown(state, 'handover')).toBe(true);
    await pending;

    expect(interrupt).not.toHaveBeenCalled();
    expect(state.parkedLease).not.toBeNull();
    expect(idle).toHaveBeenCalledTimes(1);
    expect(idle.mock.calls[0][0].message).toContain('sweep finished');
    expect(state.activeTasks.get('subagent')?.status).toBe('running');
  });

  // The park used to come first and the messages second: an empty queue then
  // left a parked lease that no follow-up turn ever claimed, so it sat out the
  // watchdog and died — taking the sub-agents the handover existed to preserve.
  // Asking what there is to deliver first makes the empty case a no-op. #1269.
  it('requests no handover when there is nothing to deliver', async () => {
    const { provider, state, interrupt, close } = providerInDrain();

    await provider.interruptWithMessage('unused');

    expect(state.handover).toBeNull();
    expect(state.parkedLease).toBeNull();
    expect(interrupt).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});
