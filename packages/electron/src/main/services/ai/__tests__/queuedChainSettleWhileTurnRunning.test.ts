// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A queued-prompt chain that settles while a *new* turn is already running for
 * the same session must not evict that session from SessionStateManager.
 *
 * The sub-agent drain wakes a session and starts a turn; ~20ms later the
 * dispatcher's `finally` reports the chain settled and `onChainSettled` runs
 * `endSession` unconditionally. `endSession` deletes the entry from
 * `activeSessions`, so `getRunningSessionIds()` stops reporting the session
 * even though its turn runs on for minutes — the renderer's periodic reconcile
 * then pins the session to "idle", the stop button turns back into a send
 * arrow, and the next message lands inside the live turn instead of the queue.
 *
 * The sister path for the same event (`subagents:drainSettled` in
 * MessageStreamingHandler) already defers `endSession` while the provider
 * reports `isLeadBusy()`; this one does not. That asymmetry is the bug, so the
 * live turn is expressed here through the same `isLeadBusy()` signal.
 *
 * Kept out of queuedPromptDispatcher.test.ts on purpose: this case needs the
 * real `onChainSettled` closure from AIService (the dispatcher only forwards
 * the callback it is handed), which costs an electron mock and the service's
 * module graph.
 */

vi.mock('electron', () => {
  const noop = () => {};
  return {
    app: {
      on: noop,
      once: noop,
      getPath: () => '/tmp',
      getName: () => 'nimbalyst-test',
      getVersion: () => '0.0.0-test',
      getAppPath: () => '/tmp',
      isPackaged: false,
      whenReady: async () => {},
    },
    ipcMain: { on: noop, once: noop, handle: noop, removeHandler: noop, removeAllListeners: noop },
    BrowserWindow: Object.assign(function () {}, {
      getAllWindows: () => [],
      fromWebContents: () => null,
    }),
    shell: { openExternal: noop },
    dialog: { showMessageBox: noop },
    nativeTheme: { on: noop },
    session: { defaultSession: {} },
    clipboard: {},
    Menu: { setApplicationMenu: noop, buildFromTemplate: () => ({}) },
    Notification: Object.assign(function () {}, { isSupported: () => false }),
    safeStorage: { isEncryptionAvailable: () => false },
    powerMonitor: { on: noop },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1, height: 1 } }) },
  };
});

vi.mock('../../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

const SESSION_ID = 'session-drain-wake';
const WORKSPACE = '/workspace/project';

const queuedPrompt = {
  id: 'prompt-1',
  prompt: 'continue',
  attachments: null,
  documentContext: null,
};

let pending: Array<typeof queuedPrompt> = [];

vi.mock('../../RepositoryManager', () => ({
  getQueuedPromptsStore: () => ({
    listPending: async () => pending,
    claim: async (id: string) => (id === queuedPrompt.id ? queuedPrompt : null),
    complete: async () => {},
    fail: async () => {},
  }),
}));

vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: {
    // Not 'claude-code-cli': that provider takes the PTY rails instead.
    get: async () => ({ id: SESSION_ID, provider: 'claude-code', workspacePath: WORKSPACE }),
  },
}));

describe('queued chain settling while a turn is running', () => {
  beforeEach(() => {
    pending = [queuedPrompt];
  });

  it('keeps the session tracked when the chain settles under a live turn', async () => {
    const { AIService } = await import('../AIService');
    const { SessionProcessingGuard } = await import('../queuedPromptDispatcher');
    const { SessionStateManager, setSessionStateManager } = await import(
      '@nimbalyst/runtime/ai/server/SessionStateManager'
    );
    const { ProviderFactory } = await import('@nimbalyst/runtime/ai/server/ProviderFactory');

    const stateManager = new SessionStateManager();
    setSessionStateManager(stateManager);

    // The drain's wake turn is the thing that must not be swept away. It is
    // visible to the main process exactly as the sister path sees it: the
    // provider for this session reports a busy lead.
    let leadBusy = false;
    (ProviderFactory as unknown as { providers: Map<string, unknown> }).providers.set(
      `claude-code-${SESSION_ID}`,
      { isLeadBusy: () => leadBusy },
    );

    const targetWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn(), mainFrame: {} },
    } as unknown as Electron.BrowserWindow;

    const scheduleStop = vi.fn();
    let trackedAtWake = false;

    const svc = {
      sessionsProcessingQueue: new SessionProcessingGuard(),
      hooklessWatcher: { scheduleStop },
      sendMessageHandler: async () => {
        // The queued prompt's own turn runs and finishes.
        pending = [];
        return { content: 'ok' };
      },
      continueQueuedPromptChain: async () => {
        // No follow-on row, so the chain is about to settle. This is the
        // 20ms window the log captured: the sub-agent drain wakes the session
        // and MessageStreamingHandler.sendMessage marks it running again.
        leadBusy = true;
        await stateManager.startSession({ sessionId: SESSION_ID, workspacePath: WORKSPACE });
        trackedAtWake = stateManager.getRunningSessionIds().includes(SESSION_ID);
      },
      requestQueueDrive: vi.fn(),
      publishQueueStateToSync: async () => {},
    };

    await AIService.prototype.tryDispatchNextQueuedPrompt.call(
      svc as never,
      SESSION_ID,
      WORKSPACE,
      targetWindow,
      'test queue',
    );

    // onChainSettled schedules the watcher stop immediately after endSession,
    // so reaching this proves the settle path ran rather than never firing.
    await vi.waitFor(() => expect(scheduleStop).toHaveBeenCalledWith(SESSION_ID, 500));

    // Guards the assertion below against a silent setup failure: the session
    // has to have been running when the chain settled for its absence to mean
    // anything.
    expect(trackedAtWake).toBe(true);
    expect(stateManager.getRunningSessionIds()).toContain(SESSION_ID);
  });

  it('still ends the session when the chain settles with no turn running', async () => {
    // The counterpart to the case above: deferring on a busy lead must not
    // leave an idle session parked as running. Nothing would clear it then --
    // the busy-turn completion handler that owns the deferred end never runs --
    // and the session would show a stop button forever.
    const { AIService } = await import('../AIService');
    const { SessionProcessingGuard } = await import('../queuedPromptDispatcher');
    const { SessionStateManager, setSessionStateManager } = await import(
      '@nimbalyst/runtime/ai/server/SessionStateManager'
    );
    const { ProviderFactory } = await import('@nimbalyst/runtime/ai/server/ProviderFactory');

    const stateManager = new SessionStateManager();
    setSessionStateManager(stateManager);

    (ProviderFactory as unknown as { providers: Map<string, unknown> }).providers.set(
      `claude-code-${SESSION_ID}`,
      { isLeadBusy: () => false },
    );

    const targetWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn(), mainFrame: {} },
    } as unknown as Electron.BrowserWindow;

    const scheduleStop = vi.fn();
    let trackedBeforeSettle = false;

    const svc = {
      sessionsProcessingQueue: new SessionProcessingGuard(),
      hooklessWatcher: { scheduleStop },
      sendMessageHandler: async () => {
        pending = [];
        return { content: 'ok' };
      },
      continueQueuedPromptChain: async () => {
        trackedBeforeSettle = stateManager.getRunningSessionIds().includes(SESSION_ID);
      },
      requestQueueDrive: vi.fn(),
      publishQueueStateToSync: async () => {},
    };

    await AIService.prototype.tryDispatchNextQueuedPrompt.call(
      svc as never,
      SESSION_ID,
      WORKSPACE,
      targetWindow,
      'test queue',
    );

    await vi.waitFor(() => expect(scheduleStop).toHaveBeenCalledWith(SESSION_ID, 500));

    expect(trackedBeforeSettle).toBe(true);
    expect(stateManager.getRunningSessionIds()).not.toContain(SESSION_ID);
  });
});
