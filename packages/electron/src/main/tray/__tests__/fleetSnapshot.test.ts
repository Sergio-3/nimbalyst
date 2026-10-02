// @vitest-environment node
import { describe, it, expect } from 'vitest';

import {
  deriveFleetSnapshot,
  formatFleetAge,
  STALL_AFTER_MS,
  type TraySessionInfo,
} from '../fleetSnapshot';
import { isIdleView, STRIP_NAME_HOLD_MS, StripStateMachine } from '../stripStateMachine';

const NOW = 1_700_000_000_000;

function session(overrides: Partial<TraySessionInfo> & { sessionId: string }): TraySessionInfo {
  return {
    title: overrides.sessionId,
    workspacePath: '/Users/dev/projects/nimbalyst',
    status: 'running',
    isStreaming: false,
    hasPendingPrompt: false,
    hasUnread: false,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('deriveFleetSnapshot', () => {
  it('counts each session once, splitting approval from decision', () => {
    const snapshot = deriveFleetSnapshot([
      session({ sessionId: 'perm', hasPendingPrompt: true, promptKind: 'approval', wantingSince: NOW - 1000 }),
      session({ sessionId: 'commit', hasPendingPrompt: true, promptKind: 'approval', wantingSince: NOW - 2000 }),
      session({ sessionId: 'question', hasPendingPrompt: true, promptKind: 'decision', wantingSince: NOW - 3000 }),
      session({ sessionId: 'busy' }),
      session({ sessionId: 'broken', status: 'error', wantingSince: NOW - 4000 }),
      session({ sessionId: 'read-me', status: 'completed', hasUnread: true }),
      session({ sessionId: 'quiet', status: 'completed' }),
    ], 1, { now: NOW });

    expect(snapshot).toMatchObject({
      needsApproval: 2,
      needsDecision: 1,
      failed: 1,
      running: 1,
      unread: 1,
      revision: 1,
    });
    // The oldest thing *blocked on the user* -- what the strip's age reports.
    // `broken` is older at NOW - 4000 and is deliberately not it: a crashed
    // session is not waiting on an answer, and nothing ever clears its
    // `wantingSince`, so counting it pinned the age hot forever.
    expect(snapshot.oldestWantingSince).toBe(NOW - 3000);
  });

  // The state the retired quiet-age was standing in for: "idle or broken",
  // asked of the thing that would actually be broken rather than of the clock.
  it('draws stalled out of running, not on top of it', () => {
    const snapshot = deriveFleetSnapshot([
      session({ sessionId: 'busy', updatedAt: NOW - 60_000 }),
      session({ sessionId: 'silent', updatedAt: NOW - STALL_AFTER_MS }),
    ], 1, { now: NOW });

    expect(snapshot).toMatchObject({ running: 1, stalled: 1 });
  });

  // The bug this file's stall rule shipped with: `updatedAt` only moves on a
  // lifecycle transition, so a turn that runs for 40 minutes without one -- a
  // long test run, a slow build -- left Running and never came back. Liveness
  // is the evidence of progress the threshold was always supposed to measure.
  it('keeps a long turn running while liveness ticks keep arriving', () => {
    const snapshot = deriveFleetSnapshot(
      [session({
        sessionId: 'long-tool-call',
        updatedAt: NOW - 40 * 60_000,
        liveAt: NOW - 30_000,
        turnInFlight: true,
      })],
      1,
      { now: NOW },
    );

    expect(snapshot).toMatchObject({ running: 1, stalled: 0 });
  });

  // The other half: liveness is *additional* evidence, never a way to defeat
  // the check. A ticker that stopped is exactly the wedged provider the stalled
  // bucket exists to catch.
  it('still stalls a session whose liveness ticks stopped', () => {
    const snapshot = deriveFleetSnapshot(
      [session({
        sessionId: 'wedged',
        updatedAt: NOW - 40 * 60_000,
        liveAt: NOW - STALL_AFTER_MS,
        turnInFlight: true,
      })],
      1,
      { now: NOW },
    );

    expect(snapshot).toMatchObject({ running: 0, stalled: 1 });
  });

  it('does not call a just-restored session stalled', () => {
    // No `updatedAt` means "not observed", not "silent" -- the cache is seeded
    // from the database on launch and must not announce a stall it never saw.
    const snapshot = deriveFleetSnapshot(
      [session({ sessionId: 'restored', updatedAt: undefined })],
      1,
      { now: NOW },
    );

    expect(snapshot).toMatchObject({ running: 1, stalled: 0 });
  });

  // `since` is the moment it *became* stalled, not `now`. If it moved with the
  // clock the "a name is only news once" memory would miss every time and the
  // strip would re-announce the same stall on every minute tick, forever.
  it('names a stalled session exactly once however long it stays stalled', () => {
    const machine = new StripStateMachine();
    const stalledAt = NOW - STALL_AFTER_MS;
    const stalled = (revision: number) => deriveFleetSnapshot(
      [session({ sessionId: 'silent', title: 'Silent', updatedAt: stalledAt })],
      revision,
      { now: NOW + revision * 60_000 },
    );

    expect(machine.update(stalled(1), NOW)).toMatchObject({ mode: 'named', state: 'stalled' });
    machine.tick(NOW + STRIP_NAME_HOLD_MS);
    expect(machine.update(stalled(2), NOW + STRIP_NAME_HOLD_MS + 1))
      .toMatchObject({ mode: 'counts', stalled: 1 });
  });

  it('never lets a failure drive the blocked-age, however old it is', () => {
    const snapshot = deriveFleetSnapshot(
      [session({ sessionId: 'broken', status: 'error', wantingSince: NOW - 8 * 60 * 60_000 })],
      1,
      { now: NOW },
    );

    expect(snapshot.failed).toBe(1);
    expect(snapshot.oldestWantingSince).toBeUndefined();
  });

  // Mirrors groupTraySessions / agentSessionAttentionAtom: an agent sets phase
  // 'complete' just before its closing output, so it may only suppress running.
  it('excludes archived sessions and lets complete-phase suppress only running', () => {
    const snapshot = deriveFleetSnapshot([
      session({ sessionId: 'archived', status: 'completed', hasUnread: true, isArchived: true }),
      session({ sessionId: 'done-streaming', phase: 'complete' }),
      session({ sessionId: 'done-prompting', hasPendingPrompt: true, phase: 'complete' }),
      session({ sessionId: 'done-unread', status: 'completed', hasUnread: true, phase: 'complete' }),
    ], 2, { now: NOW });

    expect(snapshot).toMatchObject({ running: 0, needsApproval: 1, unread: 1 });
  });

  it('gives the priority slot to the session that most recently started wanting something', () => {
    const snapshot = deriveFleetSnapshot([
      session({ sessionId: 'older', title: 'Older', hasPendingPrompt: true, promptKind: 'approval', wantingSince: NOW - 9000 }),
      session({ sessionId: 'newer', title: 'Newer', hasPendingPrompt: true, promptKind: 'decision', wantingSince: NOW - 100 }),
    ], 3, { now: NOW });

    expect(snapshot.priority).toMatchObject({ sessionId: 'newer', title: 'Newer', state: 'decision' });
  });

  it('breaks a same-millisecond tie toward the more urgent state', () => {
    const snapshot = deriveFleetSnapshot([
      session({ sessionId: 'a-waiting', hasPendingPrompt: true, promptKind: 'approval', wantingSince: NOW }),
      session({ sessionId: 'z-failed', status: 'error', wantingSince: NOW }),
    ], 4, { now: NOW });

    expect(snapshot.priority).toMatchObject({ sessionId: 'z-failed', state: 'failed' });
  });

  // A failed session is not waiting on an answer any more, it is broken -- so it
  // must not also be counted as needing approval.
  // Finishing is worth announcing, but it is not something to act on: it must
  // not join the waiting count, and it must not drag the blocked-age to zero
  // every time a turn ends.
  it('lets a finished session own the priority slot without counting as waiting', () => {
    const snapshot = deriveFleetSnapshot([
      session({ sessionId: 'blocked', hasPendingPrompt: true, promptKind: 'approval', wantingSince: NOW - 30 * 60_000 }),
      session({ sessionId: 'done', title: 'Done', status: 'completed', completedAt: NOW }),
    ], 6, { now: NOW });

    expect(snapshot.priority).toMatchObject({ sessionId: 'done', state: 'completed' });
    expect(snapshot).toMatchObject({ needsApproval: 1, needsDecision: 0, failed: 0, running: 0 });
    expect(snapshot.oldestWantingSince).toBe(NOW - 30 * 60_000);
  });

  // Unread rows seeded from the database at startup carry no `completedAt`, and
  // running sessions restored into the cache carry no `startedAt`. Neither may
  // claim a name the first time the strip renders.
  it('does not name a session whose start or completion this process never saw', () => {
    const snapshot = deriveFleetSnapshot([
      session({ sessionId: 'seeded', status: 'completed', hasUnread: true }),
      session({ sessionId: 'restored', status: 'running' }),
    ], 7, { now: NOW });

    expect(snapshot.priority).toBeUndefined();
    expect(snapshot).toMatchObject({ unread: 1, running: 1 });
  });

  it('lets a session that just started own the priority slot', () => {
    const snapshot = deriveFleetSnapshot([
      session({ sessionId: 'old', status: 'running', startedAt: NOW - 60_000 }),
      session({ sessionId: 'fresh', title: 'Fresh', status: 'running', startedAt: NOW }),
    ], 8, { now: NOW });

    expect(snapshot.priority).toMatchObject({ sessionId: 'fresh', state: 'running' });
    expect(snapshot.running).toBe(2);
    // Starting is not waiting, so it must not invent a blocked-age.
    expect(snapshot.oldestWantingSince).toBeUndefined();
  });

  it('counts a session that failed with a prompt open as failed, not waiting', () => {
    const snapshot = deriveFleetSnapshot([
      session({ sessionId: 's', status: 'error', hasPendingPrompt: true, promptKind: 'decision', wantingSince: NOW }),
    ], 5, { now: NOW });

    expect(snapshot).toMatchObject({ failed: 1, needsApproval: 0, needsDecision: 0 });
  });
});

describe('formatFleetAge', () => {
  it('rounds down to whole minutes, then to hours and minutes', () => {
    expect(formatFleetAge(8_000)).toBe('0m');
    expect(formatFleetAge(14 * 60_000)).toBe('14m');
    expect(formatFleetAge(59 * 60_000 + 59_000)).toBe('59m');
    expect(formatFleetAge(72 * 60_000)).toBe('1h12m');
    expect(formatFleetAge(25 * 60 * 60_000)).toBe('1d');
  });
});

describe('StripStateMachine', () => {
  function waiting(sessionId: string, since: number, kind: 'approval' | 'decision' = 'approval') {
    return session({ sessionId, title: sessionId, hasPendingPrompt: true, promptKind: kind, wantingSince: since });
  }

  it('expands to name a session on the transition, then settles back to counts', () => {
    const machine = new StripStateMachine();

    expect(machine.update(deriveFleetSnapshot([session({ sessionId: 'busy' })], 1, { now: NOW }), NOW))
      .toMatchObject({ mode: 'counts', running: 1, age: null });

    const asked = deriveFleetSnapshot([session({ sessionId: 'busy' }), waiting('ask', NOW, 'decision')], 2, { now: NOW });
    expect(machine.update(asked, NOW)).toMatchObject({ mode: 'named', title: 'ask', state: 'decision' });

    // Still inside the hold.
    expect(machine.tick(NOW + STRIP_NAME_HOLD_MS - 1)).toMatchObject({ mode: 'named' });
    // ...and out of it.
    expect(machine.tick(NOW + STRIP_NAME_HOLD_MS)).toMatchObject({
      mode: 'counts',
      needsApproval: 0,
      needsDecision: 1,
      running: 1,
    });
  });

  it('does not name a session again while it stays in the same wanting state', () => {
    const machine = new StripStateMachine();
    const snapshot = () => deriveFleetSnapshot([waiting('ask', NOW)], 2, { now: NOW });

    machine.update(snapshot(), NOW);
    // Settle out of the hold, then feed the same still-waiting session again --
    // a name is only news once.
    machine.tick(NOW + STRIP_NAME_HOLD_MS);
    expect(machine.update(snapshot(), NOW + STRIP_NAME_HOLD_MS + 1)).toMatchObject({ mode: 'counts' });
  });

  it('names a session again when it leaves and re-enters a wanting state', () => {
    const machine = new StripStateMachine();
    machine.update(deriveFleetSnapshot([waiting('ask', NOW)], 1, { now: NOW }), NOW);
    machine.update(deriveFleetSnapshot([session({ sessionId: 'ask' })], 2, { now: NOW }), NOW + 10_000);

    const again = deriveFleetSnapshot([waiting('ask', NOW + 20_000)], 3, { now: NOW });
    expect(machine.update(again, NOW + 20_000)).toMatchObject({ mode: 'named', title: 'ask' });
  });

  it('hands the name to a newer transition mid-hold', () => {
    const machine = new StripStateMachine();
    machine.update(deriveFleetSnapshot([waiting('first', NOW)], 1, { now: NOW }), NOW);

    const both = deriveFleetSnapshot([waiting('first', NOW), waiting('second', NOW + 2000)], 2, { now: NOW });
    expect(machine.update(both, NOW + 2000)).toMatchObject({ mode: 'named', title: 'second' });
    // The hold restarts with the new name rather than finishing the old one.
    expect(machine.tick(NOW + STRIP_NAME_HOLD_MS + 1)).toMatchObject({ mode: 'named', title: 'second' });
  });

  it('drops a name as soon as that session stops wanting anything', () => {
    const machine = new StripStateMachine();
    machine.update(deriveFleetSnapshot([waiting('ask', NOW)], 1, { now: NOW }), NOW);

    const answered = deriveFleetSnapshot([session({ sessionId: 'ask' })], 2, { now: NOW });
    expect(machine.update(answered, NOW + 1000)).toMatchObject({ mode: 'counts' });
  });

  function finished(sessionId: string, at: number) {
    return session({ sessionId, title: sessionId, status: 'completed', completedAt: at, updatedAt: at });
  }

  it('holds a finished session name for the full timeout even after it stops being the priority', () => {
    // Clicking a finished session marks it read and navigates to it, which
    // knocks it out of the snapshot's priority slot. The announcement is about
    // something that already happened, so it should still finish its hold --
    // requiring the session to still *be* the priority made the name vanish the
    // instant the user acted on it.
    const machine = new StripStateMachine();
    machine.update(deriveFleetSnapshot([finished('done', NOW)], 1, { now: NOW }), NOW);

    const gone = deriveFleetSnapshot([session({ sessionId: 'other' })], 2, { now: NOW });
    expect(machine.update(gone, NOW + 1000)).toMatchObject({ mode: 'named', title: 'done', state: 'completed' });
    expect(machine.tick(NOW + STRIP_NAME_HOLD_MS - 1)).toMatchObject({ mode: 'named', title: 'done' });
    expect(machine.tick(NOW + STRIP_NAME_HOLD_MS)).toMatchObject({ mode: 'counts' });
  });

  it('lets something more urgent take the slot from a finished name, but not a session merely starting', () => {
    const machine = new StripStateMachine();
    machine.update(deriveFleetSnapshot([finished('done', NOW)], 1, { now: NOW }), NOW);

    // A session starting is less urgent than one finishing; it must not steal
    // the announcement the user is still reading.
    const started = deriveFleetSnapshot(
      [finished('done', NOW), session({ sessionId: 'fresh', startedAt: NOW + 1000 })],
      2, { now: NOW },
    );
    expect(machine.update(started, NOW + 1000)).toMatchObject({ mode: 'named', title: 'done' });

    // A session blocking on a prompt is more urgent, and takes it immediately.
    const asked = deriveFleetSnapshot(
      [finished('done', NOW), waiting('ask', NOW + 2000, 'decision')],
      3, { now: NOW },
    );
    expect(machine.update(asked, NOW + 2000)).toMatchObject({ mode: 'named', title: 'ask', state: 'decision' });
  });

  it('still drops a wanting name the moment that session stops wanting anything', () => {
    // The time-based hold above must not leak into wanting states: once a prompt
    // is answered the name is stale, and stale is worse than absent.
    const machine = new StripStateMachine();
    machine.update(deriveFleetSnapshot([waiting('ask', NOW)], 1, { now: NOW }), NOW);
    expect(machine.update(deriveFleetSnapshot([session({ sessionId: 'ask' })], 2, { now: NOW }), NOW + 1000))
      .toMatchObject({ mode: 'counts' });
  });

  it('ignores a snapshot that arrives out of order', () => {
    const machine = new StripStateMachine();
    machine.update(deriveFleetSnapshot([waiting('ask', NOW)], 5, { now: NOW }), NOW);
    machine.tick(NOW + STRIP_NAME_HOLD_MS);

    const stale = deriveFleetSnapshot([session({ sessionId: 'busy' })], 4, { now: NOW });
    expect(machine.update(stale, NOW + STRIP_NAME_HOLD_MS)).toMatchObject({
      mode: 'counts',
      needsApproval: 1,
      running: 0,
    });
  });

  it('ages the oldest waiting session, and escalates past an hour', () => {
    const machine = new StripStateMachine();
    const snapshot = deriveFleetSnapshot(
      [waiting('old', NOW - 72 * 60_000), waiting('new', NOW - 60_000)],
      1, { now: NOW },
    );
    machine.update(snapshot, NOW);

    expect(machine.tick(NOW + STRIP_NAME_HOLD_MS)).toMatchObject({
      mode: 'counts',
      age: { label: '1h12m', hot: true },
    });
  });

  // These two used to assert the opposite. The strip showed the time since the
  // last activity whenever the fleet was quiet, which put an unlabeled,
  // unactionable duration in the slot reserved for "how long has something been
  // waiting on you" -- and on a fresh launch its value came from a
  // `MAX(updated_at)` over rows the user had long since finished with. Reported
  // as "it shows 3h28m and hovering says nothing needs my attention; what am I
  // supposed to do with that". Inverted rather than deleted: they are the guard
  // against a second informational duration finding its way back into the slot.
  it('shows no age at all when nothing is running or waiting', () => {
    const machine = new StripStateMachine();
    const snapshot = deriveFleetSnapshot(
      [session({ sessionId: 'done', status: 'completed', updatedAt: NOW - 5 * 60_000 })],
      1, { now: NOW },
    );

    expect(machine.update(snapshot, NOW)).toMatchObject({
      mode: 'counts',
      running: 0,
      age: null,
    });
  });

  it('does not surface lastActivityAt on the strip, however long it has been quiet', () => {
    const machine = new StripStateMachine();
    // `lastActivityAt` still rides on the snapshot -- the *panel's* idle header
    // labels it and puts the recent sessions underneath it. It just never
    // reaches the menu bar.
    const snapshot = deriveFleetSnapshot([], 1, { now: NOW, lastActivityAt: NOW - 42 * 60_000 });

    const view = machine.update(snapshot, NOW);
    expect(view).toMatchObject({ mode: 'counts', age: null });
    expect(isIdleView(view)).toBe(true);
  });

  it('is not idle while anything at all is on the strip', () => {
    const machine = new StripStateMachine();
    const unreadOnly = deriveFleetSnapshot(
      [session({ sessionId: 'done', status: 'completed', hasUnread: true })],
      1, { now: NOW },
    );

    expect(isIdleView(machine.update(unreadOnly, NOW))).toBe(false);
  });

  // The island hides when idle, so this is what stops it snapping away the
  // instant the last session settles: a completion is still being announced.
  it('is not idle while a completion is still being announced', () => {
    const machine = new StripStateMachine();
    const done = deriveFleetSnapshot(
      [session({ sessionId: 'work', title: 'Work', status: 'completed', completedAt: NOW })],
      1, { now: NOW },
    );

    expect(isIdleView(machine.update(done, NOW))).toBe(false);
    expect(isIdleView(machine.tick(NOW + STRIP_NAME_HOLD_MS))).toBe(true);
  });

  it('names a session when it starts, then settles to the running count', () => {
    const machine = new StripStateMachine();
    const started = deriveFleetSnapshot(
      [session({ sessionId: 'work', title: 'Work', status: 'running', startedAt: NOW })],
      1, { now: NOW },
    );

    expect(machine.update(started, NOW)).toMatchObject({
      mode: 'named',
      title: 'Work',
      state: 'running',
    });
    expect(machine.tick(NOW + STRIP_NAME_HOLD_MS)).toMatchObject({ mode: 'counts', running: 1 });
  });

  // `startedAt` is stamped on the transition into running, not per streaming
  // tick, so a session that works for an hour is announced once.
  it('does not re-name a session that keeps running', () => {
    const machine = new StripStateMachine();
    const running = (revision: number) => deriveFleetSnapshot(
      [session({ sessionId: 'work', title: 'Work', status: 'running', startedAt: NOW })],
      revision, { now: NOW },
    );

    machine.update(running(1), NOW);
    machine.tick(NOW + STRIP_NAME_HOLD_MS);
    expect(machine.update(running(2), NOW + STRIP_NAME_HOLD_MS + 1)).toMatchObject({
      mode: 'counts',
      running: 1,
    });
  });

  it('names a session when it finishes, then settles to the unread count', () => {
    const machine = new StripStateMachine();
    machine.update(deriveFleetSnapshot([session({ sessionId: 'work', title: 'Work' })], 1, { now: NOW }), NOW);

    // Finished while the user was away, so it is also unread.
    const finished = deriveFleetSnapshot([
      session({ sessionId: 'work', title: 'Work', status: 'completed', completedAt: NOW, hasUnread: true }),
    ], 2, { now: NOW });

    expect(machine.update(finished, NOW)).toMatchObject({
      mode: 'named',
      title: 'Work',
      state: 'completed',
    });
    expect(machine.tick(NOW + STRIP_NAME_HOLD_MS)).toMatchObject({ mode: 'counts', unread: 1 });
  });

  it('shows no age while sessions run and nothing wants anything', () => {
    const machine = new StripStateMachine();
    const snapshot = deriveFleetSnapshot([session({ sessionId: 'busy' })], 1, { now: NOW });
    expect(machine.update(snapshot, NOW)).toMatchObject({ mode: 'counts', running: 1, age: null });
  });
});

describe('deriveFleetSnapshot: complete-phase session still running', () => {
  // Same rule as groupTraySessions: `complete` takes a running session out of
  // the running count, not out of the unread one.
  it('counts a running complete-phase session with unread output as unread', () => {
    const snapshot = deriveFleetSnapshot([
      session({ sessionId: 'done-working', phase: 'complete', hasUnread: true }),
    ], 1, { now: NOW });

    expect(snapshot).toMatchObject({ running: 0, stalled: 0, unread: 1 });
  });

  it('does not count a running complete-phase session with nothing unread at all', () => {
    const snapshot = deriveFleetSnapshot([
      session({ sessionId: 'done-working', phase: 'complete' }),
    ], 1, { now: NOW });

    expect(snapshot).toMatchObject({ running: 0, stalled: 0, unread: 0, needsApproval: 0, needsDecision: 0, failed: 0 });
  });
});
