/**
 * FleetSnapshot -- the one derived value every ambient surface renders.
 *
 * The menu bar strip and (later) the iOS Live Activity both consume this and
 * nothing else, so the phone and the menu bar can never disagree about what the
 * fleet is doing. Derivation is a pure function over the same `TraySessionInfo`
 * values `groupTraySessions` already consumes, so it is testable without the
 * singleton, without Electron, and without a device.
 *
 * Bucketing deliberately matches `groupTraySessions` (archived excluded,
 * `phase === 'complete'` suppresses only the running bucket). It differs in one
 * way the panel does not need: a session lands in exactly one *counted* bucket,
 * so the strip's numbers add up.
 */

/**
 * What a blocked session is asking for.
 *
 * The distinction is the strip's whole reason for colouring the dot: a session
 * title does not tell you whether responding costs three seconds or ten minutes,
 * and this does. Known at every prompt callsite -- see `setSessionPendingPrompt`.
 */
export type PromptKind = 'approval' | 'decision';

/**
 * A session state that wants something from the user.
 *
 * These are the states that get *counted* in the resting strip and that feed the
 * blocked-age. Completion is deliberately not one of them -- see `PriorityState`.
 */
export type WantingState = PromptKind | 'failed';

/**
 * A state the strip will expand and name a session for.
 *
 * Wider than `WantingState`. Starting, stalling and finishing are all worth
 * announcing but none is something the user has to act on, so they must not add
 * to the waiting count or drag the blocked-age down every time a turn begins or
 * ends. They own the priority slot without being wanting states.
 *
 * Naming a session as it *starts* is deliberate teaching: it is the moment the
 * user is most likely to be looking, so it is what tells them this patch of the
 * menu bar is where session state changes show up.
 */
export type PriorityState = WantingState | 'completed' | 'running' | 'stalled';

export interface TraySessionInfo {
  sessionId: string;
  title: string;
  workspacePath: string;
  status: 'running' | 'idle' | 'error' | 'completed';
  isStreaming: boolean;
  hasPendingPrompt: boolean;
  hasUnread: boolean;
  /** Timestamp when session completed, used for lingering display */
  completedAt?: number;
  /**
   * When this session most recently entered the running state.
   *
   * Stamped on the transition into running, not on every streaming tick, so the
   * strip names a session once as it starts rather than continuously while it
   * works.
   */
  startedAt?: number;
  /** Provider id (`claude-code`, `openai-codex`, …) for the panel's avatar tile. */
  provider?: string;
  /** Provider-qualified model id; the panel strips the prefix for display. */
  model?: string;
  /** Last activity, so the panel can show a relative time like the in-app popover. */
  updatedAt?: number;
  /**
   * When this session last produced evidence that its turn is still progressing.
   *
   * Distinct from `updatedAt`, which only moves on a lifecycle *transition*
   * (started, blocked, completed). A turn that spends forty minutes inside one
   * tool call makes no transitions at all, so measuring silence against
   * `updatedAt` called every long turn stalled -- the bug this field exists to
   * fix. Stamped from the per-turn liveness tick emitted by the streaming
   * handler; absent for a provider that does not emit one, which is why
   * `isStalled` takes the newest of the two rather than preferring this.
   */
  liveAt?: number;
  /**
   * Whether a turn is currently in flight for this session.
   *
   * Not consulted by `isStalled` today -- the threshold deliberately did not
   * move when liveness landed. It is carried so the panel can tell "running and
   * ticking" from "status says running and nothing is happening" without
   * re-deriving it, and so a later retune is a change to one predicate.
   */
  turnInFlight?: boolean;
  /** Kanban phase. `complete` only keeps a running session out of the running count, matching the in-app popover. */
  phase?: string;
  /** Archived sessions are hidden, matching the in-app popover. */
  isArchived?: boolean;
  /** What the open prompt is asking for. Only meaningful with `hasPendingPrompt`. */
  promptKind?: PromptKind;
  /**
   * When this session most recently *entered* a wanting state.
   *
   * Not `updatedAt`: a blocked session still emits activity, and the strip's age
   * has to mean "how long has this been waiting", not "how long since it last
   * said anything". It is also what makes "a name is only news once" expressible
   * -- a session that stays blocked keeps the same value, so it is never renamed.
   */
  wantingSince?: number;
}

export interface FleetPriority {
  sessionId: string;
  title: string;
  workspacePath: string;
  state: PriorityState;
  /** When this session entered `state`. */
  since: number;
}

export interface FleetSnapshot {
  running: number;
  /** Tool permission / commit proposal pending -- a tap. */
  needsApproval: number;
  /** AskUserQuestion / ExitPlanMode / PromptForUserInput pending -- thinking required. */
  needsDecision: number;
  failed: number;
  /** Running, but silent past `STALL_AFTER_MS`. Counted out of `running`, not on top of it. */
  stalled: number;
  unread: number;
  /** The session that most recently entered a wanting state, if any. */
  priority?: FleetPriority;
  /** Oldest `since` across *blocked* sessions; the age the strip shows while anything waits. */
  oldestWantingSince?: number;
  /**
   * Newest activity anywhere in the fleet.
   *
   * Consumed only by the panel's idle header, which labels it ("Last session
   * finished 3h ago"). It is deliberately *not* on the strip: an unlabeled
   * duration in the menu bar's actionable slot was the whole bug this state
   * audit came out of. See the State inventory in the plan.
   */
  lastActivityAt?: number;
  /** Monotonic. Lets a renderer drop a snapshot that arrives out of order. */
  revision: number;
}

/** Past this, a blocked session is a stall you did not notice, and the age escalates. */
export const AGE_HOT_MS = 60 * 60_000;

/**
 * How long a running session may go silent before it is called stalled.
 *
 * A guess, and flagged as one: the honest floor is the tail of the real gap
 * distribution in `ai_agent_messages`, which nobody has measured yet. Fifteen
 * minutes is chosen to sit clear of a long build or a slow tool call, on the
 * principle that a false stall is worse than a late one -- the whole point of
 * the state is that it is trustworthy enough to act on.
 */
export const STALL_AFTER_MS = 15 * 60_000;

export function emptyFleetSnapshot(revision = 0): FleetSnapshot {
  return {
    running: 0,
    needsApproval: 0,
    needsDecision: 0,
    failed: 0,
    stalled: 0,
    unread: 0,
    revision,
  };
}

/**
 * How urgent each state is.
 *
 * Two consumers: tie-breaking the priority slot here, and deciding in
 * `StripStateMachine` whether a new transition is important enough to interrupt
 * an announcement the user may still be reading.
 */
export const STATE_URGENCY: Record<PriorityState, number> = {
  failed: 5,
  decision: 4,
  approval: 3,
  // Above a plain completion because a stall is the one informational state the
  // user probably wants to do something about; below every wanting state because
  // nothing is actually blocked on them.
  stalled: 2,
  completed: 1,
  running: 0,
};

/**
 * Whether a session wants something, and what.
 *
 * `error` outranks a pending prompt: a session that failed while a prompt was
 * open is not waiting on an answer any more, it is broken. `groupTraySessions`
 * puts both in the same bucket so the order is invisible there; here it decides
 * which number the session is counted in, so it has to be stated.
 */
/**
 * Whether a state means "this session is waiting on you".
 *
 * The dividing line between the two kinds of announcement: a wanting name goes
 * stale the moment the thing it named is dealt with, while `completed` and
 * `running` describe something that already happened and stay true.
 */
export function isWantingState(state: PriorityState): state is WantingState {
  return state === 'approval' || state === 'decision' || state === 'failed';
}

/**
 * A running session that has gone quiet.
 *
 * This is the state the retired quiet-age was standing in for. "Is it idle or is
 * it broken" cannot be answered by the wall clock -- three hours is lunch or a
 * catastrophe depending on what you were expecting -- but it can be answered by
 * measuring the thing that would be broken: a session that claims to be running
 * and has not said anything.
 *
 * *Anything*, which is the correction: this used to read `updatedAt` alone, and
 * `updatedAt` only moves on a lifecycle transition. A turn sitting in a
 * thirty-minute test run makes none, so every long turn fell out of Running
 * after fifteen minutes and stayed out until it finished. The threshold was
 * never the problem -- it was being applied to "time since the last transition"
 * while claiming to mean "time since anything happened".
 *
 * The newest of the two stamps wins rather than liveness alone: a provider that
 * emits no liveness tick still transitions, and reading only `liveAt` there
 * would stall a session on the absence of a signal it never sends. Liveness is
 * additional evidence and can only ever make a session look more alive.
 *
 * A session with neither stamp is never stalled. That is the just-restored case,
 * where the absence of a timestamp means "not observed", not "silent".
 */
export function isStalled(session: TraySessionInfo, now: number): boolean {
  const lastSign = lastSignOfLife(session);
  if (lastSign === undefined) return false;
  return now - lastSign >= STALL_AFTER_MS;
}

/**
 * The newest evidence that this session is doing something, of any kind.
 *
 * Shared with `fleetActivity`, whose stalled rows report "silent for" from it:
 * a row that counted from `updatedAt` while the desktop stalled on `liveAt`
 * would put two different durations on the same fact.
 */
export function lastSignOfLife(session: TraySessionInfo): number | undefined {
  if (session.liveAt === undefined) return session.updatedAt;
  if (session.updatedAt === undefined) return session.liveAt;
  return Math.max(session.liveAt, session.updatedAt);
}

function wantingStateOf(session: TraySessionInfo): WantingState | null {
  if (session.status === 'error') return 'failed';
  if (session.hasPendingPrompt) return session.promptKind === 'decision' ? 'decision' : 'approval';
  return null;
}

/**
 * Derive the snapshot both ambient surfaces render.
 *
 * `revision` is an input rather than an internal counter so this stays pure --
 * the caller owns the monotonic sequence. `now` is an input for the same reason:
 * the stall bucket is the one classification that depends on the clock rather
 * than on an event, which also means the caller has to re-derive on a timer or
 * a stall is never noticed. See `TrayManager.stripAgeTimer`.
 *
 * `now` is deliberately *required* rather than defaulted to `Date.now()`. A
 * defaulted clock inside a function documented as pure is how a fixture stops
 * meaning what it reads: every test here pins its sessions to a fixed `NOW`, and
 * a default would have silently measured them against the real wall clock --
 * making every running fixture in the suite read as stalled by several years.
 *
 * `lastActivityAt` is a floor supplied by the caller because the session cache
 * is not a history: completed sessions are evicted after a minute, so on a quiet
 * machine there is nothing left to read a "how long has it been" age off. It
 * feeds the panel's idle header and nothing else.
 */
export function deriveFleetSnapshot(
  sessions: Iterable<TraySessionInfo>,
  revision: number,
  options: { now: number; lastActivityAt?: number },
): FleetSnapshot {
  const snapshot = emptyFleetSnapshot(revision);
  const { now } = options;
  let priority: FleetPriority | undefined;
  let oldestWantingSince: number | undefined;
  let lastActivityAt: number | undefined = options.lastActivityAt;

  const considerPriority = (session: TraySessionInfo, state: PriorityState, since: number) => {
    if (!priority || beatsPriority(session, state, since, priority)) {
      priority = {
        sessionId: session.sessionId,
        title: session.title || 'Untitled Session',
        workspacePath: session.workspacePath,
        state,
        since,
      };
    }
  };

  for (const session of sessions) {
    if (session.isArchived) continue;

    const activity = session.updatedAt ?? session.completedAt;
    if (activity !== undefined && (lastActivityAt === undefined || activity > lastActivityAt)) {
      lastActivityAt = activity;
    }

    const state = wantingStateOf(session);
    if (state) {
      if (state === 'failed') snapshot.failed += 1;
      else if (state === 'decision') snapshot.needsDecision += 1;
      else snapshot.needsApproval += 1;

      const since = session.wantingSince ?? session.updatedAt ?? 0;
      // A failure does not feed the blocked-age. The age means "how long has
      // something been waiting on you", and a session that crashed is not
      // waiting on anything -- `wantingStateOf` says as much when it ranks
      // `error` above a pending prompt. Letting it in made one old failure pin
      // `oldestWantingSince` forever: nothing clears `wantingSince` while the
      // status stays `error`, so the age went hot at an hour and stayed there
      // until the process restarted. Eviction was the other candidate fix and
      // is worse -- it would drop the failure out of the panel too, which is
      // the one place it still has something to say.
      if (state !== 'failed' && (oldestWantingSince === undefined || since < oldestWantingSince)) {
        oldestWantingSince = since;
      }
      considerPriority(session, state, since);
      continue;
    }

    if (session.status === 'running') {
      // An agent sets phase `complete` just before its closing output, so this
      // may only suppress the running bucket -- never an unread or prompting
      // session. Mirrors groupTraySessions and agentSessionAttentionAtom.
      if (session.phase !== 'complete') {
        // Stalled is counted *out of* running rather than on top of it, so the
        // two numbers still add up to the fleet and a stalled session does not
        // read as one more thing making progress.
        if (isStalled(session, now)) {
          snapshot.stalled += 1;
          // The moment it *became* stalled, counted from the same stamp
          // `isStalled` judged it on -- which is defined by construction here,
          // since `isStalled` is false without one.
          considerPriority(session, 'stalled', lastSignOfLife(session)! + STALL_AFTER_MS);
        } else {
          snapshot.running += 1;
          // Same guard as `completedAt` below: only a start this process
          // actually observed is nameable, so restoring the cache never
          // announces a batch of sessions as though they had all just begun.
          if (session.startedAt !== undefined) {
            considerPriority(session, 'running', session.startedAt);
          }
        }
        continue;
      }
    }

    // A finished session is worth naming, but is not waiting on anything -- it
    // takes no count and does not touch `oldestWantingSince`. `completedAt` is
    // stamped only by a live `session:completed`, which is what keeps the rows
    // seeded from the database at startup from each claiming a name on launch.
    if (session.status === 'completed' && session.completedAt !== undefined) {
      considerPriority(session, 'completed', session.completedAt);
    }

    if (session.hasUnread) snapshot.unread += 1;
  }

  if (priority) snapshot.priority = priority;
  if (oldestWantingSince !== undefined) snapshot.oldestWantingSince = oldestWantingSince;
  if (lastActivityAt !== undefined) snapshot.lastActivityAt = lastActivityAt;
  return snapshot;
}

/**
 * The priority slot goes to the session that just transitioned, so every
 * expansion of the strip coincides with something that actually happened.
 * Ties (two sessions blocking in the same millisecond) fall back to the more
 * urgent state, then to the session id purely so the result is deterministic.
 */
function beatsPriority(
  session: TraySessionInfo,
  state: PriorityState,
  since: number,
  incumbent: FleetPriority,
): boolean {
  if (since !== incumbent.since) return since > incumbent.since;
  if (STATE_URGENCY[state] !== STATE_URGENCY[incumbent.state]) {
    return STATE_URGENCY[state] > STATE_URGENCY[incumbent.state];
  }
  return session.sessionId > incumbent.sessionId;
}

/**
 * Minute-granularity age.
 *
 * Deliberately not seconds: the age is the one element allowed to change without
 * a real transition, and a ticking second counter is 60x the redraws to say the
 * same thing -- plus motion in peripheral vision pulls the eye off whatever you
 * were doing.
 */
export function formatFleetAge(elapsedMs: number): string {
  const minutes = Math.max(0, Math.floor(elapsedMs / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d`;
}
