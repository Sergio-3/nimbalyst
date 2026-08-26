import { describe, it, expect } from 'vitest';
import {
  hasRunningTasks,
  shouldDeferTeardownForSubagents,
  shouldExitDrain,
  classifyDrainOutcome,
  shouldSettleTaskFromToolResult,
  mapTaskUpdatedPatchStatus,
  shouldApplyTaskUpdatedStatus,
  isNotificationFlushResult,
  shouldArmGraceTimerForResult,
  shouldContinueWithTaskResults,
  buildTaskResultContinuationMessage,
  shouldReapAdoptedTasks,
  resolveHandoverPark,
  createChunkReader,
  findForeignRunningTasks,
} from '../subagentDrain';

describe('shouldSettleTaskFromToolResult', () => {
  // Regression: NIM-1470. A backgrounded Bash returns its "Command running in
  // background with ID: ..." tool_result immediately, while the task is still
  // running. Settling the task on that acknowledgement made hasRunningTasks()
  // false at turn end, so the drain never engaged and the CLI subprocess (and
  // the build it was running) was killed at teardown.
  it('does not settle a local_bash task on its background-launch acknowledgement', () => {
    const task = { taskType: 'local_bash', status: 'running' };
    const ack =
      'Command running in background with ID: b0hywzbc1. Output is being written to: /tmp/tasks/b0hywzbc1.output.';
    expect(shouldSettleTaskFromToolResult(task, ack)).toBe(false);
  });

  it('never settles a local_bash task from a tool_result, whatever the content', () => {
    const task = { taskType: 'local_bash', status: 'running' };
    expect(shouldSettleTaskFromToolResult(task, 'exit code 0')).toBe(false);
  });

  it('does not settle a backgrounded sub-agent (task_updated is_backgrounded)', () => {
    const task = { taskType: 'local_agent', isBackgrounded: true, status: 'running' };
    expect(shouldSettleTaskFromToolResult(task, 'some agent output')).toBe(false);
  });

  it('does not settle any task on a "running in the background" acknowledgement', () => {
    const task = { taskType: 'local_agent', status: 'running' };
    expect(
      shouldSettleTaskFromToolResult(task, 'Task is now running in the background. Use TaskOutput to check.'),
    ).toBe(false);
  });

  // Regression: NIM-1556. The sub-agent background-launch acknowledgement no
  // longer says "running in the background" — it now reads "Async agent
  // launched successfully. ... The agent is working in the background." and
  // arrives as an array of content blocks. Both differences made the guard
  // settle the task at launch, so the drain never engaged and teardown killed
  // the sub-agent 5s after the lead turn ended.
  it('does not settle a backgrounded sub-agent on the "Async agent launched" acknowledgement', () => {
    const task = { taskType: 'local_agent', status: 'running' };
    const ack =
      'Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\n'
      + "agentId: a031abbe9a4b13f54 (internal ID - do not mention to user. Use SendMessage with to: 'a031abbe9a4b13f54', summary: '<5-10 word recap>' to continue this agent.)\n"
      + 'The agent is working in the background. You will be notified automatically when it completes.';
    expect(shouldSettleTaskFromToolResult(task, ack)).toBe(false);
  });

  it('does not settle on a launch acknowledgement delivered as content blocks', () => {
    const task = { taskType: 'local_agent', status: 'running' };
    expect(
      shouldSettleTaskFromToolResult(task, [
        { type: 'text', text: 'Async agent launched successfully.\nThe agent is working in the background.' },
      ]),
    ).toBe(false);
    expect(
      shouldSettleTaskFromToolResult(task, [
        { type: 'text', text: 'Task is now running in the background. Use TaskOutput to check.' },
      ]),
    ).toBe(false);
  });

  it('settles a foreground sub-agent whose tool call blocked until completion', () => {
    const task = { taskType: 'local_agent', status: 'running' };
    expect(shouldSettleTaskFromToolResult(task, 'Agent finished: findings attached.')).toBe(true);
  });

  it('does not settle a task that is not running', () => {
    const task = { taskType: 'local_agent', status: 'completed' };
    expect(shouldSettleTaskFromToolResult(task, 'done')).toBe(false);
  });

  it('settles on non-string content for a foreground sub-agent', () => {
    const task = { taskType: 'local_agent', status: 'running' };
    expect(shouldSettleTaskFromToolResult(task, [{ type: 'text', text: 'done' }])).toBe(true);
  });
});

describe('mapTaskUpdatedPatchStatus', () => {
  it('maps non-terminal states to running', () => {
    expect(mapTaskUpdatedPatchStatus('pending')).toBe('running');
    expect(mapTaskUpdatedPatchStatus('running')).toBe('running');
    expect(mapTaskUpdatedPatchStatus('paused')).toBe('running');
  });

  it('maps terminal states', () => {
    expect(mapTaskUpdatedPatchStatus('completed')).toBe('completed');
    expect(mapTaskUpdatedPatchStatus('failed')).toBe('failed');
    expect(mapTaskUpdatedPatchStatus('killed')).toBe('stopped');
  });

  it('returns undefined for absent/unknown status', () => {
    expect(mapTaskUpdatedPatchStatus(undefined)).toBeUndefined();
    expect(mapTaskUpdatedPatchStatus('something_new')).toBeUndefined();
  });
});

describe('shouldApplyTaskUpdatedStatus', () => {
  // Live-verification finding (NIM-1470): the CLI emits a terminal task_updated
  // patch BEFORE the task_notification. Settling the task from the patch made
  // shouldExitDrain break the loop before the notification chunk was read, so
  // drainTerminalNotifications stayed empty and the wake continuation never
  // fired. While draining, only task_notification may settle a task.
  it('does not apply a terminal status while draining', () => {
    expect(shouldApplyTaskUpdatedStatus('completed', true)).toBe(false);
    expect(shouldApplyTaskUpdatedStatus('failed', true)).toBe(false);
    expect(shouldApplyTaskUpdatedStatus('stopped', true)).toBe(false);
  });

  it('applies terminal status when not draining', () => {
    expect(shouldApplyTaskUpdatedStatus('completed', false)).toBe(true);
    expect(shouldApplyTaskUpdatedStatus('stopped', false)).toBe(true);
  });

  it('always applies non-terminal status; never applies undefined', () => {
    expect(shouldApplyTaskUpdatedStatus('running', true)).toBe(true);
    expect(shouldApplyTaskUpdatedStatus('running', false)).toBe(true);
    expect(shouldApplyTaskUpdatedStatus(undefined, false)).toBe(false);
  });
});

describe('isNotificationFlushResult', () => {
  // Regression: NIM-1470. Resuming a session with a stale background task, the
  // CLI emitted task_notification(stopped) chunks followed by an empty success
  // result (num_turns=0, 93ms) BEFORE processing the user's prompt. Ending the
  // turn there swallowed the prompt.
  const flushResult = { type: 'result', subtype: 'success', is_error: false, num_turns: 0, result: '' };

  it('detects the flush result after task notifications with no assistant output', () => {
    expect(isNotificationFlushResult(flushResult, true, false)).toBe(true);
  });

  it('is not a flush result without a preceding task notification', () => {
    expect(isNotificationFlushResult(flushResult, false, false)).toBe(false);
  });

  it('is not a flush result once assistant output was seen', () => {
    expect(isNotificationFlushResult(flushResult, true, true)).toBe(false);
  });

  it('is not a flush result when the turn did real work or errored', () => {
    expect(
      isNotificationFlushResult({ ...flushResult, num_turns: 3, result: 'answer' }, true, false),
    ).toBe(false);
    expect(
      isNotificationFlushResult({ ...flushResult, subtype: 'error_during_execution' }, true, false),
    ).toBe(false);
    expect(isNotificationFlushResult({ ...flushResult, is_error: true }, true, false)).toBe(false);
  });
});

describe('shouldArmGraceTimerForResult', () => {
  // Regression: NIM-1470 follow-up. The grace-period timer that ends the
  // control channel after N seconds of stream silence must NOT arm on the
  // notification-flush result — the CLI keeps working (minutes of silence
  // during a background sub-agent), so arming there ended the channel mid-turn
  // and every later Bash tool_result failed "Stream closed" while the
  // subprocess ran away (chunkCount climbing past 400, promptController=ended).
  const flushResult = { type: 'result', subtype: 'success', is_error: false, num_turns: 0, result: '' };
  const realResult = { type: 'result', subtype: 'success', is_error: false, num_turns: 3, result: 'answer' };

  it('does NOT arm on a notification-flush result (the runaway-subprocess bug)', () => {
    expect(shouldArmGraceTimerForResult(flushResult, true, false)).toBe(false);
  });

  it('arms on the real turn result', () => {
    expect(shouldArmGraceTimerForResult(realResult, true, false)).toBe(true);
  });

  it('arms on a plain result when no task notification preceded it', () => {
    // Without a preceding task notification it is not a flush, so it is the
    // real end-of-turn and must arm (unchanged behavior for normal turns).
    expect(shouldArmGraceTimerForResult(flushResult, false, false)).toBe(true);
  });

  it('never arms on a non-result chunk', () => {
    expect(shouldArmGraceTimerForResult({ type: 'assistant' }, true, false)).toBe(false);
    expect(shouldArmGraceTimerForResult({ type: 'user' }, false, false)).toBe(false);
  });
});

describe('shouldContinueWithTaskResults', () => {
  it('continues after a clean resolve with a completed or failed task', () => {
    expect(
      shouldContinueWithTaskResults('resolved', [
        { taskId: 'b1', description: 'build', status: 'completed' },
      ]),
    ).toBe(true);
    expect(
      shouldContinueWithTaskResults('resolved', [
        { taskId: 'b1', description: 'build', status: 'failed' },
      ]),
    ).toBe(true);
  });

  it('does not continue for stopped-only notifications (user stopped the task)', () => {
    expect(
      shouldContinueWithTaskResults('resolved', [
        { taskId: 'b1', description: 'build', status: 'stopped' },
      ]),
    ).toBe(false);
  });

  // Regression: GitHub #1355. A background shell (local_bash) streams no chunks
  // while it runs, so the drain grace timer never resets and closes stdin after
  // its window — the CLI then kills the shell and reports it 'stopped'. That is
  // OUR teardown, not a user stop, but it took the same silent path: the session
  // woke with no message at all and neither the agent nor the user could tell
  // "killed" from "stopped". A killed-by-teardown task must be reported.
  it('continues for a task our own teardown killed, unlike a user stop', () => {
    expect(
      shouldContinueWithTaskResults('resolved', [
        { taskId: 'b1', description: 'gh run watch', status: 'stopped', killedByTeardown: true },
      ]),
    ).toBe(true);
  });

  it('does not continue when the drain did not resolve cleanly', () => {
    expect(
      shouldContinueWithTaskResults('aborted', [
        { taskId: 'b1', description: 'build', status: 'completed' },
      ]),
    ).toBe(false);
    expect(shouldContinueWithTaskResults('resolved', [])).toBe(false);
  });
});

describe('buildTaskResultContinuationMessage', () => {
  it('includes description, status, summary and output file; skips stopped tasks', () => {
    const msg = buildTaskResultContinuationMessage([
      {
        taskId: 'b1',
        description: 'Run build:mac:local packaging',
        status: 'completed',
        summary: 'BUILD_EXIT=0',
        outputFile: '/tmp/tasks/b1.output',
      },
      { taskId: 'b2', description: 'stopped watcher', status: 'stopped' },
    ]);
    expect(msg).toContain('Run build:mac:local packaging');
    expect(msg).toContain('completed');
    expect(msg).toContain('BUILD_EXIT=0');
    expect(msg).toContain('/tmp/tasks/b1.output');
    expect(msg).not.toContain('stopped watcher');
  });

  // #1355: name the cause instead of leaving a bare "stopped". The agent reads
  // this to decide whether to re-run the work — an ambiguous status caused a
  // duplicate paid re-run in the reporter's workspace.
  it('reports a teardown kill as killed, names the grace window, and keeps a user stop out', () => {
    const msg = buildTaskResultContinuationMessage([
      {
        taskId: 'b1',
        description: 'gh run watch 32603089993',
        status: 'stopped',
        killedByTeardown: true,
        outputFile: '/tmp/tasks/b1.output',
      },
      { taskId: 'b2', description: 'user stopped watcher', status: 'stopped' },
    ]);
    expect(msg).toContain('gh run watch 32603089993');
    expect(msg).toContain('killed');
    expect(msg).toContain('/tmp/tasks/b1.output');
    expect(msg).not.toContain('user stopped watcher');
  });
});

describe('hasRunningTasks', () => {
  it('is false with no running tasks', () => {
    expect(hasRunningTasks([])).toBe(false);
    expect(hasRunningTasks([{ status: 'completed' }, { status: 'stopped' }])).toBe(false);
  });

  it('is true when at least one task is running', () => {
    expect(hasRunningTasks([{ status: 'completed' }, { status: 'running' }])).toBe(true);
  });
});

describe('shouldDeferTeardownForSubagents', () => {
  it('defers only while a sub-agent is still running', () => {
    expect(shouldDeferTeardownForSubagents(true)).toBe(true);
    expect(shouldDeferTeardownForSubagents(false)).toBe(false);
  });
});

describe('shouldExitDrain', () => {
  it('exits once draining and all sub-agents have resolved', () => {
    expect(shouldExitDrain(true, true, false)).toBe(true);
  });

  it('keeps draining while a sub-agent is still running', () => {
    expect(shouldExitDrain(true, true, true)).toBe(false);
  });

  it('does not exit-via-drain before complete was emitted or when not draining', () => {
    expect(shouldExitDrain(false, true, false)).toBe(false);
    expect(shouldExitDrain(true, false, false)).toBe(false);
  });
});

describe('resolveHandoverPark', () => {
  /** A handover that is about to park: every condition satisfied. */
  const parkable = {
    state: 'accepted',
    exitCause: 'handover',
    hasLiveQuery: true,
    hasPromptController: true,
    promptStreamEnded: false,
    hasAbortController: true,
    abortSignalFired: false,
  } satisfies Parameters<typeof resolveHandoverPark>[0];

  it('parks only when the loop accepted, exited for the handover, and still holds a query', () => {
    expect(resolveHandoverPark(parkable)).toBe('park');
  });

  // The v2 regression: the 5s park timeout fired after the loop had already
  // accepted, cleared the request flag, and the teardown then read "no handover"
  // and closed a query whose sub-agents were reported as still running. The
  // decision hangs off the accepted state, so a late timeout cannot revoke it.
  // #1269.
  it('still parks when the request timed out after the loop accepted', () => {
    expect(resolveHandoverPark(parkable)).toBe('park');
    expect(resolveHandoverPark({ ...parkable, state: 'abandoned' })).toBe('teardown');
  });

  // Parking on the REQUEST rather than the exit handed the follow-up turn a
  // corpse: the iterator died while the requester was still waiting, and close,
  // reap and auto-continue were all skipped. #1269.
  it('tears down when the iterator died while the handover was pending', () => {
    for (const exitCause of ['iterator-done', 'iterator-error', 'aborted', 'interrupted'] as const) {
      expect(resolveHandoverPark({ ...parkable, state: 'requested', exitCause })).toBe('teardown');
      expect(resolveHandoverPark({ ...parkable, exitCause })).toBe('teardown');
    }
  });

  it('tears down when there is no query left to hand on', () => {
    expect(resolveHandoverPark({ ...parkable, hasLiveQuery: false })).toBe('teardown');
  });

  it('tears down when no handover was ever requested', () => {
    expect(
      resolveHandoverPark({ ...parkable, state: null, exitCause: 'resolved' }),
    ).toBe('teardown');
  });

  // These three used to be checked beside the call instead of inside it, where a
  // missing part fell through to the normal teardown while the exit cause still
  // read 'handover' — the pairing that closes the query and leaves its tasks
  // 'running'. Answering inside means the caller has one decision to react to.
  // #1269.
  it('tears down when a part of the lease is missing', () => {
    expect(resolveHandoverPark({ ...parkable, hasPromptController: false })).toBe('teardown');
    expect(resolveHandoverPark({ ...parkable, hasAbortController: false })).toBe('teardown');
  });

  // An abort() landing between the loop's exit and the teardown leaves an
  // abortController that has already fired; the query it governs is on its way
  // out, so parking it hands the follow-up turn a dead transport. #1269.
  it('tears down when the abort signal fired after the loop accepted', () => {
    expect(resolveHandoverPark({ ...parkable, abortSignalFired: true })).toBe('teardown');
  });

  // Holding the controller is not the same as being able to push on it. The
  // drain grace timer ends the prompt stream on a timeout and the object stays
  // in hand reporting isEnded(), so every presence check still passed and the
  // query was parked with a stream nothing could be delivered on — the adoption
  // then failed at push() and the sub-agents the park existed for died anyway.
  // #1269.
  it('tears down when the prompt stream was already ended', () => {
    expect(resolveHandoverPark({ ...parkable, promptStreamEnded: true })).toBe('teardown');
  });
});

describe('findForeignRunningTasks', () => {
  // The runtime backstop for an exit path nobody enumerated: a task still
  // registered as running under a query generation that is gone pins every later
  // drain. #1269.
  it('reports running tasks from an older query generation only', () => {
    const tasks = [
      { taskId: 'stale', status: 'running', queryGeneration: 3 },
      { taskId: 'current', status: 'running', queryGeneration: 4 },
      { taskId: 'settled', status: 'completed', queryGeneration: 3 },
    ];

    expect(findForeignRunningTasks(tasks, 4).map(t => t.taskId)).toEqual(['stale']);
  });

  // Tasks registered before generations existed (or by a path that forgot to
  // stamp) must not be silently trusted — an unstamped running task is exactly
  // the unknown edge this detector is for.
  it('treats an unstamped running task as foreign', () => {
    expect(
      findForeignRunningTasks([{ taskId: 'nostamp', status: 'running' }], 1).map(t => t.taskId),
    ).toEqual(['nostamp']);
  });
});

describe('shouldReapAdoptedTasks', () => {
  /** An adopted turn unwinding outside a drain with tasks left to reap. */
  const reapable = {
    adoptedLease: true,
    parkedForHandover: false,
    wasDraining: false,
    ownsQuery: true,
    hasRunningTasks: true,
  } satisfies Parameters<typeof shouldReapAdoptedTasks>[0];

  // The regression this exists for: a turn adopts a handover lease, the user
  // interrupts it while it is still generating, and the inherited tasks are left
  // registered as running forever — pinning every later turn in a drain that
  // cannot settle. #1269.
  it('reaps when an adopted turn ends outside a drain and hands nothing on', () => {
    expect(shouldReapAdoptedTasks(reapable)).toBe(true);
  });

  it('leaves the drain path and a further handover to their own owners', () => {
    expect(shouldReapAdoptedTasks({ ...reapable, wasDraining: true })).toBe(false);
    expect(shouldReapAdoptedTasks({ ...reapable, parkedForHandover: true })).toBe(false);
  });

  // A turn that never adopted cannot hold tasks older than itself, so reaping
  // here would change behaviour on the ordinary interrupt path.
  it('never reaps for a turn that did not adopt a lease', () => {
    expect(shouldReapAdoptedTasks({ ...reapable, adoptedLease: false })).toBe(false);
  });

  // The crash-retry path (#1361) re-enters sendMessage; the nested run replaces
  // the query and tears down its own, so by the time the outer run unwinds it
  // owns nothing. Reaping there settled the NESTED run's live sub-agents. #1269.
  it('reaps nothing for a run whose query a nested run already replaced', () => {
    expect(shouldReapAdoptedTasks({ ...reapable, ownsQuery: false })).toBe(false);
  });

  // With nothing running there is nothing to reap, and the teardown this gates
  // aborts and closes the query — a healthy one, whose subprocess the next turn
  // would then have to start cold. #1269.
  it('leaves a healthy query alone when an adopted turn ends with no tasks running', () => {
    expect(shouldReapAdoptedTasks({ ...reapable, hasRunningTasks: false })).toBe(false);
  });
});

describe('classifyDrainOutcome', () => {
  // A handover did not close the query — the sub-agents run on inside it and
  // their notifications land in the adopting turn. Reaping would report live
  // work as dead. #1269.
  it('reaps nothing on a handover', () => {
    expect(
      classifyDrainOutcome({ wasDraining: true, hasRunningTasks: true, cause: 'handover' }),
    ).toEqual({ markStopped: false, autoContinue: false });
  });

  it('does nothing when we were not draining', () => {
    expect(
      classifyDrainOutcome({ wasDraining: false, hasRunningTasks: true, cause: 'iterator-error' }),
    ).toEqual({ markStopped: false, autoContinue: false });
  });

  it('does nothing when no tasks are left running (clean resolve)', () => {
    expect(
      classifyDrainOutcome({ wasDraining: true, hasRunningTasks: false, cause: 'resolved' }),
    ).toEqual({ markStopped: false, autoContinue: false });
  });

  it('auto-continues on unexpected iterator end with tasks still running', () => {
    expect(
      classifyDrainOutcome({ wasDraining: true, hasRunningTasks: true, cause: 'iterator-done' }),
    ).toEqual({ markStopped: true, autoContinue: true });
    expect(
      classifyDrainOutcome({ wasDraining: true, hasRunningTasks: true, cause: 'iterator-error' }),
    ).toEqual({ markStopped: true, autoContinue: true });
  });

  it('marks stopped but does NOT auto-continue on user stop / supersede', () => {
    expect(
      classifyDrainOutcome({ wasDraining: true, hasRunningTasks: true, cause: 'aborted' }),
    ).toEqual({ markStopped: true, autoContinue: false });
    expect(
      classifyDrainOutcome({ wasDraining: true, hasRunningTasks: true, cause: 'interrupted' }),
    ).toEqual({ markStopped: true, autoContinue: false });
  });
});

describe('createChunkReader', () => {
  // The SDK hands every caller the same generator, so a read abandoned by the
  // turn that gave the query away is not harmless: the next message resolves
  // THAT promise, and a fresh next() lines up behind it. The lost message is
  // typically the sub-agent's terminal task_notification, which is what pinned
  // the task 'running' and left the session spinning. #1269.
  it('delivers the in-flight read as the first chunk instead of starting a new one', async () => {
    let nextCalls = 0;
    let release: ((r: IteratorResult<string>) => void) | null = null;
    const iterator = {
      next: () => {
        nextCalls++;
        return Promise.resolve({ done: false as const, value: `fresh-${nextCalls}` });
      },
    };
    const inFlight = new Promise<IteratorResult<string>>((resolve) => { release = resolve; });

    const read = createChunkReader(iterator, inFlight);
    const first = read();
    expect(nextCalls).toBe(0);

    release!({ done: false, value: 'task_notification' });
    expect(await first).toEqual({ done: false, value: 'task_notification' });

    // Only the inherited read is special; everything after comes from the
    // iterator as usual.
    expect(await read()).toEqual({ done: false, value: 'fresh-1' });
    expect(nextCalls).toBe(1);
  });

  it('reads straight from the iterator when nothing was inherited', async () => {
    const iterator = { next: () => Promise.resolve({ done: false as const, value: 'chunk' }) };
    const read = createChunkReader(iterator, null);
    expect(await read()).toEqual({ done: false, value: 'chunk' });
  });
});
