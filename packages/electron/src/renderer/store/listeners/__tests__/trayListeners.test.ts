// @vitest-environment node
import { store } from '@nimbalyst/runtime/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  activeWorkspacePathAtom,
  openProjectsAtom,
} from '../../atoms/openProjects';
import { initAgentModeLayout } from '../../atoms/agentMode';
import { selectedWorkstreamAtom } from '../../atoms/sessions';
import { initWorkstreamState } from '../../atoms/workstreamState';
import { initTrayListeners } from '../trayListeners';

const PROJECT_A = '/Users/dev/project-a';
const PROJECT_B = '/Users/dev/project-b';

function openProject(path: string) {
  return { path, name: path.split('/').pop()!, openedAt: 0 };
}

/**
 * Minimal main process: each project owns a disjoint set of sessions, and
 * every other invoke succeeds with an empty payload.
 */
function installWindow(
  sessionsByProject: Record<string, string[]>,
  getState: (workspacePath: string) => Promise<unknown> = async () => ({}),
) {
  const listeners = new Map<string, (data: unknown) => unknown>();
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'sessions:list') {
      const ids = sessionsByProject[args[0] as string] ?? [];
      return {
        success: true,
        sessions: ids.map((id) => ({ id, title: id, createdAt: 0, updatedAt: 0 })),
      };
    }
    if (channel === 'workspace:get-state') return getState(args[0] as string);
    return { success: true };
  });

  (globalThis as any).window = {
    electronAPI: {
      invoke,
      on: vi.fn((channel: string, handler: (data: unknown) => unknown) => {
        listeners.set(channel, handler);
        return () => listeners.delete(channel);
      }),
    },
  };

  return {
    invoke,
    async navigate(data: { sessionId: string; workspacePath: string }) {
      listeners.get('tray:navigate-to-session')?.(data);
      // The navigation awaits several already-resolved IPC round trips; a
      // macrotask turn lets the whole chain settle before asserting.
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    },
  };
}

describe('tray:navigate-to-session', () => {
  let cleanup: () => void;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.set(openProjectsAtom, [openProject(PROJECT_A), openProject(PROJECT_B)]);
    store.set(activeWorkspacePathAtom, PROJECT_B);
    // AgentMode does this when the visible project mounts.
    initWorkstreamState(PROJECT_B);
  });

  afterEach(() => {
    cleanup?.();
    errorSpy.mockRestore();
    delete (globalThis as any).window;
  });

  it('switches to the session project when it is hidden in the rail', async () => {
    // A menu-bar-island / tray / voice click lands in a window that shows
    // Project-B while the session belongs to Project-A. Selecting inside the
    // hidden project alone changes nothing on screen.
    const { navigate } = installWindow({ [PROJECT_A]: ['session-a'], [PROJECT_B]: [] });
    cleanup = initTrayListeners();

    await navigate({ sessionId: 'session-a', workspacePath: PROJECT_A });

    expect(store.get(activeWorkspacePathAtom)).toBe(PROJECT_A);
    expect(store.get(selectedWorkstreamAtom(PROJECT_A))).toEqual({ type: 'session', id: 'session-a' });
  });

  it('selects a session of the visible project without switching', async () => {
    const { navigate } = installWindow({ [PROJECT_A]: [], [PROJECT_B]: ['session-b'] });
    cleanup = initTrayListeners();

    await navigate({ sessionId: 'session-b', workspacePath: PROJECT_B });

    expect(store.get(activeWorkspacePathAtom)).toBe(PROJECT_B);
    expect(store.get(selectedWorkstreamAtom(PROJECT_B))).toEqual({ type: 'session', id: 'session-b' });
  });

  it('keeps the clicked session open when the rail switch restores the project late', async () => {
    // Project-A was open before with session-a-old, and that is what its
    // persisted state still says. The rail switch restores it asynchronously
    // (App.tsx and AgentMode both call initAgentModeLayout on the new path);
    // when that restore answers after the click selected session-a, the main
    // view showed session-a-old while the list already marked session-a.
    store.set(selectedWorkstreamAtom(PROJECT_A), { type: 'session', id: 'session-a-old' });
    let answerRestore: () => void = () => {};
    const persisted = new Promise((resolve) => {
      answerRestore = () => resolve({
        agenticCodingWindowState: { selectedWorkstream: { type: 'session', id: 'session-a-old' } },
      });
    });
    const { navigate } = installWindow(
      { [PROJECT_A]: ['session-a', 'session-a-old'], [PROJECT_B]: [] },
      (workspacePath) => (workspacePath === PROJECT_A ? persisted : Promise.resolve({})),
    );
    cleanup = initTrayListeners();
    const restores: Promise<void>[] = [];
    const stopRailEffect = store.sub(activeWorkspacePathAtom, () => {
      restores.push(initAgentModeLayout(store.get(activeWorkspacePathAtom)!));
    });

    try {
      await navigate({ sessionId: 'session-a', workspacePath: PROJECT_A });
      expect(store.get(selectedWorkstreamAtom(PROJECT_A))).toEqual({ type: 'session', id: 'session-a' });

      answerRestore();
      await Promise.all(restores);

      expect(restores.length).toBeGreaterThan(0);
      expect(store.get(selectedWorkstreamAtom(PROJECT_A))).toEqual({ type: 'session', id: 'session-a' });
    } finally {
      stopRailEffect();
    }
  });
});
