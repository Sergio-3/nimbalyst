// Decision helpers for the "background sub-agent drain" behavior in
// ClaudeCodeProvider.sendMessage(). Extracted as pure functions so the teardown
// logic can be unit-tested without the full SDK streaming machinery.
//
// Background: the SDK runs plain/background Task/Agent sub-agents natively inside
// the lead's subprocess and streams their lifecycle as system `task_started` /
// `task_progress` / `task_notification` chunks (tracked in `activeTasks`). A
// background sub-agent can outlive the lead's own turn: the lead emits its
// `result` chunk (turn end) while the sub-agent is still running. The streaming
// loop used to break immediately on `result`, so the sub-agent's later
// `task_notification` was never read and its stdin was torn down — killing it and
// leaving the orchestrator idle forever. See NIM-1344 / GitHub #732.

export interface SubagentTaskLike {
  status: string;
}

/** A tracked task as `activeTasks` holds it — status is written in place. */
export interface MutableSubagentTask extends SubagentTaskLike {
  description?: string;
  taskId?: string;
}

// The immediate tool_result the SDK returns when a command/sub-agent is
// launched in (or moved to) the background. It is a launch acknowledgement,
// not a completion: the task is still running and will settle later via a
// system task_notification chunk. The CLI has used several wordings —
// "Command running in background with ID: …" (Bash), "Task is now running in
// the background" and "Async agent launched successfully… The agent is
// working in the background" (sub-agents) — so match all of them. NIM-1556.
const BACKGROUND_LAUNCH_ACK = /running in (the )?background|working in the background|async agent launched/i;

/**
 * Flatten tool_result content to searchable text. The SDK delivers it either
 * as a plain string or as an array of content blocks ({type:'text', text}) —
 * the sub-agent launch acknowledgement arrives as the latter. NIM-1556.
 */
export function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(block =>
        block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
          ? (block as { text: string }).text
          : '')
      .join('\n');
  }
  return '';
}

/**
 * Decide whether a tool_result whose toolUseId matches a tracked task means
 * that task has finished. True only for the foreground case (the tool call
 * blocked until the sub-agent completed). Backgrounded tasks return an
 * immediate "running in background" acknowledgement while still running —
 * settling on it made hasRunningTasks() false at turn end, so the drain never
 * engaged and teardown killed the task with the subprocess. See NIM-1470.
 */
export function shouldSettleTaskFromToolResult(
  task: { taskType?: string; isBackgrounded?: boolean; status: string },
  resultContent: unknown,
): boolean {
  if (task.status !== 'running') return false;
  // local_bash tasks only exist when a Bash command was backgrounded; their
  // matching tool_result is always the launch acknowledgement.
  if (task.taskType === 'local_bash') return false;
  // Authoritative signal from a task_updated patch, when the CLI sent one.
  if (task.isBackgrounded) return false;
  if (BACKGROUND_LAUNCH_ACK.test(extractToolResultText(resultContent))) return false;
  return true;
}

/**
 * Map a task_updated patch status (SDK TaskState vocabulary) onto the
 * provider's coarser task status vocabulary. Returns undefined when the patch
 * carries no status change we track (pending/paused stay "running" — the task
 * has not reached a terminal state).
 */
export function mapTaskUpdatedPatchStatus(
  patchStatus: string | undefined,
): 'running' | 'completed' | 'failed' | 'stopped' | undefined {
  switch (patchStatus) {
    case 'pending':
    case 'running':
    case 'paused':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'killed':
      return 'stopped';
    default:
      return undefined;
  }
}

/**
 * Decide whether a task_updated patch's mapped status may be applied to the
 * tracked task. While draining after the lead turn ended, terminal statuses
 * must come ONLY from task_notification: the CLI emits the terminal
 * task_updated patch first, and settling on it exits the drain loop before
 * the notification chunk (summary, output file) is read — leaving nothing to
 * build the wake-up continuation from. See NIM-1470.
 */
export function shouldApplyTaskUpdatedStatus(
  mapped: 'running' | 'completed' | 'failed' | 'stopped' | undefined,
  draining: boolean,
): boolean {
  if (!mapped) return false;
  if (mapped === 'running') return true;
  return !draining;
}

/**
 * Detect the empty "flush" result the CLI emits when a resumed session has
 * pending task notifications: it enqueues the <task-notification> user message,
 * emits a success result with num_turns=0 and no text, and only THEN processes
 * the queued notification plus the real user prompt. Treating that flush result
 * as end-of-turn swallows the user's prompt (the real answer streams after it,
 * into a torn-down channel). See NIM-1470.
 */
export function isNotificationFlushResult(
  chunk: { type?: string; subtype?: string; is_error?: boolean; num_turns?: number; result?: string },
  sawTaskNotificationThisTurn: boolean,
  sawAssistantOutputThisTurn: boolean,
): boolean {
  return (
    chunk.type === 'result'
    && chunk.subtype === 'success'
    && chunk.is_error !== true
    && chunk.num_turns === 0
    && !chunk.result
    && sawTaskNotificationThisTurn
    && !sawAssistantOutputThisTurn
  );
}

/**
 * Decide whether a `result` chunk should arm the grace-period timer that ends
 * the control channel after N seconds of stream silence. A notification-flush
 * result must NOT arm it: the CLI is still working (often minutes of
 * main-stream silence while a background sub-agent runs), so ending the channel
 * mid-turn makes every later canUseTool/hook request fail "Stream closed" and
 * leaks the runaway subprocess. Only the REAL result arms the timer. Non-result
 * chunks never arm it. See NIM-1470.
 */
export function shouldArmGraceTimerForResult(
  chunk: { type?: string; subtype?: string; is_error?: boolean; num_turns?: number; result?: string },
  sawTaskNotificationThisTurn: boolean,
  sawAssistantOutputThisTurn: boolean,
): boolean {
  if (chunk.type !== 'result') return false;
  return !isNotificationFlushResult(chunk, sawTaskNotificationThisTurn, sawAssistantOutputThisTurn);
}

/** Terminal task_notification captured while draining, for the continuation turn. */
export interface TaskTerminalNotification {
  taskId: string;
  description: string;
  status: 'completed' | 'failed' | 'stopped';
  summary?: string;
  outputFile?: string;
  /**
   * The task reported 'stopped' because OUR teardown killed it — the drain
   * grace timer expired, we closed the prompt stream, and the CLI killed the
   * task along with its own process. Distinct from a user stop, which reaches
   * this struct identically. A background shell (local_bash) streams no chunks
   * while it runs, so it never resets the grace timer and this is its normal
   * fate on any run longer than the window. See GitHub #1355.
   */
  killedByTeardown?: boolean;
  /** How long the task had been running when it was killed, for the report. */
  elapsedMs?: number;
}

/** True for a task that ended only because our own teardown killed it. */
function wasKilledByTeardown(n: TaskTerminalNotification): boolean {
  return n.status === 'stopped' && n.killedByTeardown === true;
}

/** A notification worth telling the session about. */
function isReportable(n: TaskTerminalNotification): boolean {
  return n.status !== 'stopped' || wasKilledByTeardown(n);
}

/**
 * After a clean drain resolve, decide whether to wake the session with a
 * visible continuation turn carrying the task results. Completed/failed tasks
 * warrant one, and so does a task our own teardown killed — silence there left
 * the agent unable to tell "killed" from "stopped" and cost the reporter a
 * duplicate paid re-run (#1355). A task the USER stopped stays stopped.
 */
export function shouldContinueWithTaskResults(
  cause: DrainExitCause,
  notifications: TaskTerminalNotification[],
): boolean {
  return cause === 'resolved' && notifications.some(isReportable);
}

/** "13m 42s" / "47s" — coarse duration for the report line. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * Build the continuation prompt delivered (via the idle-message path) when
 * background tasks settled after the lead turn ended. Visible to the user, so
 * it reads as a system notification rather than an internal nudge.
 *
 * A teardown kill is named as a kill, not left as a bare "stopped": the agent
 * reads this to decide whether the work still needs doing. See #1355.
 */
export function buildTaskResultContinuationMessage(
  notifications: TaskTerminalNotification[],
): string {
  const reportable = notifications.filter(isReportable);
  const killed = reportable.filter(wasKilledByTeardown);

  const lines = reportable.map(n => {
    const parts = wasKilledByTeardown(n)
      ? [
          `- "${n.description || n.taskId}" was KILLED at process exit`
          + (n.elapsedMs !== undefined ? ` after running ${formatElapsed(n.elapsedMs)}` : '')
          + ' — it did not finish on its own.',
        ]
      : [`- "${n.description || n.taskId}" ${n.status}`];
    if (n.summary) parts.push(`  Summary: ${n.summary}`);
    if (n.outputFile) parts.push(`  Output file: ${n.outputFile}`);
    return parts.join('\n');
  });

  const header =
    killed.length === reportable.length
      ? '[System: background task(s) you launched were killed before finishing:'
      : '[System: background task(s) you launched have settled:';

  const footer = killed.length > 0
    ? '\nAny output file above holds only partial output, up to the moment of the kill.'
      + ' Treat the killed work as NOT done: re-run it, or report that it could not complete.'
      + ' Continue the work that was waiting on the rest.]'
    : '\nContinue the work that was waiting on them.]';

  return header + '\n' + lines.join('\n') + footer;
}

/** True if any tracked sub-agent task is still running. */
export function hasRunningTasks(tasks: Iterable<SubagentTaskLike>): boolean {
  for (const t of tasks) {
    if (t.status === 'running') return true;
  }
  return false;
}

/**
 * Mark every still-running task stopped and return their labels. Called when
 * the transport those tasks were running on is gone — the drain loop exiting
 * with stragglers, or abort() killing the subprocess — so no further
 * task_notification can settle them. Leaving one 'running' makes the next
 * turn's `result` defer teardown for nothing (NIM-2458).
 */
export function reapRunningTasks(tasks: Iterable<MutableSubagentTask>): string[] {
  const stranded: string[] = [];
  for (const task of tasks) {
    if (task.status === 'running') {
      task.status = 'stopped';
      stranded.push(task.description || task.taskId || 'unknown task');
    }
  }
  return stranded;
}

/** Count of tasks still running — what the drain gate actually keys off. */
export function countRunningTasks(tasks: Iterable<SubagentTaskLike>): number {
  let count = 0;
  for (const t of tasks) {
    if (t.status === 'running') count++;
  }
  return count;
}

/**
 * After the lead's `result` chunk, decide whether to defer teardown (keep
 * draining the SDK iterator) rather than breaking out of the loop immediately.
 *
 * Two reasons to defer, and the second is not "still running":
 *
 * - A background sub-agent is still running. Breaking closes stdin and kills it.
 * - A task reported terminally DURING this turn. Nothing is left running, but
 *   the CLI enqueues its own task-notification continuation turn on ANY task
 *   notification, and that turn outlives the `result`. Tearing down here closes
 *   the control channel it needs: every canUseTool request in it fails
 *   "AbortError: Stream closed" without ever reaching the host, so the user is
 *   never asked, never sees the work, and the model records denials it
 *   attributes to them. Deferring routes the case into the same drain that
 *   already handles tasks finishing after the turn — `finalizeBackgroundDrain`
 *   closes the CLI's continuation and delivers a visible one instead.
 *
 * The drain that a mid-turn notification opens exits at the very next chunk
 * (nothing is running), so this costs one extra iteration, not a held-open turn.
 * See GitHub #1410.
 */
export function shouldDeferTeardownForSubagents(
  hasRunning: boolean,
  sawTaskNotificationThisTurn: boolean,
): boolean {
  return hasRunning || sawTaskNotificationThisTurn;
}

/**
 * While draining (after `complete` was already emitted), decide whether the loop
 * can now exit because every background sub-agent has reported a terminal status.
 */
export function shouldExitDrain(
  completeEmitted: boolean,
  draining: boolean,
  hasRunning: boolean,
): boolean {
  return completeEmitted && draining && !hasRunning;
}

// Why the streaming loop stopped iterating. Derived from WHERE the loop exits, so
// we never have to guess the abort source from shared instance state.
export type DrainExitCause =
  | 'resolved' // sub-agents finished (or turn ended with none running)
  | 'aborted' // abort() / supersede — the AbortController fired
  | 'interrupted' // interruptWithMessage() — teammate/user interrupt
  | 'handover' // the live query was parked as a lease for a follow-up turn
  | 'iterator-done' // the SDK iterator ended on its own
  | 'iterator-error'; // the SDK iterator threw

export type HandoverState =
  | 'requested' // someone asked, the streaming loop has not reacted yet
  | 'accepted' // the loop left its drain for it; only this state may park
  | 'abandoned'; // the request timed out, the caller fell back to a real interrupt

/**
 * Decide whether the teardown block parks the live query as a lease or tears it
 * down normally. Parking keys off the loop's EXIT, never off the request, which
 * only says someone asked — an iterator that died meanwhile leaves a corpse to
 * hand on. Every condition lives here rather than beside the call, because a
 * check made outside fails SILENTLY into the normal teardown while the exit
 * cause still says `handover`, and that pairing closes the query with
 * `markStopped: false` — the pinned "Thinking…" this fix exists to remove. #1269.
 */
export function resolveHandoverPark(params: {
  state: HandoverState | null;
  exitCause: DrainExitCause;
  hasLiveQuery: boolean;
  /** The prompt controller that keeps the query's stdin open is still held. */
  hasPromptController: boolean;
  /**
   * The drain grace timer ends that stream on a timeout while the controller
   * object survives, so presence alone would pass a park whose follow-up prompt
   * can no longer be pushed — killing the sub-agents the park preserves.
   */
  promptStreamEnded: boolean;
  hasAbortController: boolean;
  /** Already fired: the query is dying, parking hands on a dead transport. */
  abortSignalFired: boolean;
}): 'park' | 'teardown' {
  if (params.state !== 'accepted') return 'teardown';
  if (params.exitCause !== 'handover') return 'teardown';
  if (!params.hasLiveQuery) return 'teardown';
  if (!params.hasPromptController) return 'teardown';
  if (params.promptStreamEnded) return 'teardown';
  if (!params.hasAbortController) return 'teardown';
  if (params.abortSignalFired) return 'teardown';
  return 'park';
}

/**
 * `Query[Symbol.asyncIterator]()` gives every caller the SAME generator, so a
 * fresh `next()` lines up BEHIND the read the handing-over turn left in flight:
 * that first message — typically a sub-agent's terminal `task_notification` —
 * would resolve a promise nobody awaits and pin its task 'running' forever.
 * Hence the streaming loop consumes `inFlight` before the iterator. #1269.
 */
export function createChunkReader<T>(
  iterator: { next: () => Promise<IteratorResult<T>> },
  inFlight: Promise<IteratorResult<T>> | null,
): () => Promise<IteratorResult<T>> {
  let pending = inFlight;
  return () => {
    if (pending) {
      const chunk = pending;
      pending = null;
      return chunk;
    }
    return iterator.next();
  };
}

/**
 * Running tasks stamped with a query generation other than the live one. The
 * stamp travels with the query when a turn adopts it, so a foreign stamp means
 * some exit path closed a query without reaping its tasks — the shape of #1269,
 * and the only detector here that does not depend on our model of the exit paths
 * being complete. Callers log it and reap, turning an unknown edge into a
 * self-heal instead of a permanent "Thinking…".
 */
export function findForeignRunningTasks<T extends MutableSubagentTask & { queryGeneration?: number }>(
  tasks: Iterable<T>,
  currentGeneration: number,
): T[] {
  const foreign: T[] = [];
  for (const task of tasks) {
    if (task.status !== 'running') continue;
    if (task.queryGeneration === currentGeneration) continue;
    foreign.push(task);
  }
  return foreign;
}

/**
 * Does this turn's teardown have to reap background tasks itself? Only a turn
 * that ADOPTED a lease can hold tasks older than itself, and one interrupted
 * while still generating never enters the drain that would normally reap them —
 * an interrupt is not an abort, so nothing else does either. The leftovers then
 * make every later turn defer teardown into a drain that can never settle. #1269.
 */
export function shouldReapAdoptedTasks(params: {
  adoptedLease: boolean;
  /** This turn handed its query on again, so the tasks keep a live owner. */
  parkedForHandover: boolean;
  /** This turn ended inside a drain, which does its own reaping. */
  wasDraining: boolean;
  /**
   * False on the crash-retry path, where a nested run has already replaced and
   * torn down the query — reaping there would settle the NESTED run's live
   * sub-agents.
   */
  ownsQuery: boolean;
  /**
   * The interrupt reaps the running tasks itself, so `hasRunningTasks` is
   * already false when this runs — without this the query has no owner left and
   * is never closed, and its subprocess outlives the turn that was using it.
   */
  wasInterrupted: boolean;
  /** With none, teardown would close a healthy query for nothing. */
  hasRunningTasks: boolean;
}): boolean {
  return params.ownsQuery
    && params.adoptedLease
    && !params.parkedForHandover
    && !params.wasDraining
    && (params.wasInterrupted || params.hasRunningTasks);
}

export interface DrainOutcome {
  /** Mark still-running tasks as stopped (they will never report completion). */
  markStopped: boolean;
  /**
   * Nudge the orchestrator with a visible continuation turn. Only true for an
   * UNEXPECTED death — never for a user stop or a new-prompt supersede, where a
   * continuation would contradict the user's intent or race their real prompt.
   */
  autoContinue: boolean;
}

/**
 * Decide what to do when the streaming loop exits while draining background
 * sub-agents. Auto-continue ONLY when the death was unexpected (the SDK iterator
 * ended or threw while tasks were still running) — not on abort/interrupt.
 */
export function classifyDrainOutcome(params: {
  wasDraining: boolean;
  hasRunningTasks: boolean;
  cause: DrainExitCause;
}): DrainOutcome {
  if (!params.wasDraining || !params.hasRunningTasks) {
    return { markStopped: false, autoContinue: false };
  }
  // A handover is not a death: the query stays open under the follow-up turn and
  // the sub-agents keep reporting into it. Reaping here would declare live work
  // dead and suppress its results for good. See #1269.
  if (params.cause === 'handover') {
    return { markStopped: false, autoContinue: false };
  }
  const unexpected = params.cause === 'iterator-done' || params.cause === 'iterator-error';
  return { markStopped: true, autoContinue: unexpected };
}
