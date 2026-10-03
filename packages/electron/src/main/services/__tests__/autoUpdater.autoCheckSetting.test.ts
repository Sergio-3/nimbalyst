// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const send = vi.fn();
const fakeWindow = { isDestroyed: () => false, isVisible: () => true, webContents: { send, getURL: () => '' } };

vi.mock('../../utils/store', () => ({ getReleaseChannel: () => 'stable', store: {} }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn(), safeOn: vi.fn() }));
vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => '/nonexistent-nimbalyst-test',
    removeAllListeners: vi.fn(),
    relaunch: vi.fn(),
    exit: vi.fn(),
  },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => fakeWindow },
  dialog: {},
}));
vi.mock('electron-log/main', () => ({ default: { transports: { file: {} }, info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../analytics/AnalyticsService', () => ({ AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) } }));
vi.mock('../../ipc/SessionStateHandlers', () => ({ hasActiveStreamingSessions: vi.fn() }));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({ getSessionStateManager: vi.fn() }));
vi.mock('../../database/initialize', () => ({ getDatabase: vi.fn() }));
vi.mock('../../index', () => ({ setRestarting: vi.fn() }));
vi.mock('../../session/SessionState', () => ({ saveSessionState: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../electronUpdaterPatch', () => ({ installAtomFeedFilter: vi.fn() }));
vi.mock('electron-updater', () => ({
  autoUpdater: {
    on: vi.fn(),
    setFeedURL: vi.fn(),
    checkForUpdatesAndNotify: vi.fn().mockResolvedValue(null),
    checkForUpdates: vi.fn().mockResolvedValue(null),
    quitAndInstall: vi.fn(),
  },
}));

import { autoUpdater } from 'electron-updater';
import { safeOn } from '../../utils/ipcRegistry';
import { AutoUpdaterService } from '../autoUpdater';

const HOUR = 60 * 60 * 1000;
const check = autoUpdater.checkForUpdatesAndNotify as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  check.mockClear();
  send.mockClear();
  (autoUpdater.quitAndInstall as unknown as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

// The newest service's handler for an electron-updater event or an IPC channel.
function lastHandler(mock: unknown, name: string): (...args: any[]) => any {
  const calls = (mock as ReturnType<typeof vi.fn>).mock.calls.filter(([n]) => n === name);
  return calls[calls.length - 1][1];
}

// #1339: "Automatically check for updates" off means no background check at all
// -- no launch check, no hourly poll, so no download and no toast either.
it('never checks in the background while the setting is off, and follows a runtime toggle', async () => {
  const service = new AutoUpdaterService();

  service.setAutoCheckEnabled(false);
  await vi.advanceTimersByTimeAsync(3 * HOUR);
  expect(check).not.toHaveBeenCalled();

  service.setAutoCheckEnabled(true);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(check).toHaveBeenCalledTimes(1);
  service.setAutoCheckEnabled(true); // repeated "on" must not stack a second timer
  await vi.advanceTimersByTimeAsync(HOUR);
  expect(check).toHaveBeenCalledTimes(2);

  service.setAutoCheckEnabled(false);
  await vi.advanceTimersByTimeAsync(3 * HOUR);
  expect(check).toHaveBeenCalledTimes(2);
});

it('cancels the pending launch check when switched off before it fires', async () => {
  const service = new AutoUpdaterService();
  service.setAutoCheckEnabled(true);
  await vi.advanceTimersByTimeAsync(10_000);
  service.setAutoCheckEnabled(false);
  await vi.advanceTimersByTimeAsync(3 * HOUR);
  expect(check).not.toHaveBeenCalled();
});

// Switching off while the background poll is already downloading: electron-updater
// never cancels that download on its own, and on macOS it hands the finished file
// straight to Squirrel when autoInstallOnAppQuit is set -- the toast the user just
// turned the setting off to avoid. Off cancels the download and install-on-quit;
// the cancellation stays silent; the manual menu check still installs.
it('switching off cancels a running background download without a toast, and the manual check still installs', async () => {
  const token = { cancel: vi.fn() };
  let rejectDownload!: (err: Error) => void;
  const downloadPromise = new Promise<string[]>((_, reject) => { rejectDownload = reject; });
  check.mockResolvedValueOnce({ isUpdateAvailable: true, cancellationToken: token, downloadPromise });

  const service = new AutoUpdaterService();
  service.setAutoCheckEnabled(true);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(check).toHaveBeenCalledTimes(1);
  expect(autoUpdater.autoInstallOnAppQuit).toBe(true);

  service.setAutoCheckEnabled(false);
  expect(token.cancel).toHaveBeenCalledTimes(1);
  expect(autoUpdater.autoInstallOnAppQuit).toBe(false);

  // What a cancelled download looks like (builder-util-runtime CancellationError).
  const cancelled = new Error('cancelled');
  rejectDownload(cancelled);
  lastHandler(autoUpdater.on, 'error')(cancelled);
  await vi.advanceTimersByTimeAsync(0);
  expect(send.mock.calls.filter(([channel]) => channel === 'update-toast:error')).toEqual([]);

  // Manual "Check for Updates" while off: still checks, and "Restart to install" still installs.
  await service.checkForUpdatesWithUI();
  expect(autoUpdater.checkForUpdates).toHaveBeenCalled();
  lastHandler(safeOn, 'update-toast:install')();
  await vi.advanceTimersByTimeAsync(0);
  expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);

  service.setAutoCheckEnabled(true);
  expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
});

// The wiring in main/index.ts: start value from the setting, then follow changes.
it('follows the setting: reads the start value and reacts only to its own key', async () => {
  let value: unknown = false;
  const subscribers: Array<(key: string, value: unknown) => void> = [];
  const settings = {
    get: (key: string) => (key === 'app.autoUpdateCheckEnabled' ? value : undefined) as boolean,
    subscribe: (fn: (key: string, value: unknown) => void) => { subscribers.push(fn); return () => {}; },
  };
  const emit = (key: string, next: unknown) => subscribers.forEach((fn) => fn(key, next));

  const service = new AutoUpdaterService();
  service.followAutoCheckSetting(settings);
  await vi.advanceTimersByTimeAsync(3 * HOUR);
  expect(check).not.toHaveBeenCalled();

  emit('app.releaseChannel', true); // a different key must not switch checks on
  await vi.advanceTimersByTimeAsync(HOUR);
  expect(check).not.toHaveBeenCalled();

  value = true;
  emit('app.autoUpdateCheckEnabled', true);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(check).toHaveBeenCalledTimes(1);

  emit('app.autoUpdateCheckEnabled', false);
  await vi.advanceTimersByTimeAsync(3 * HOUR);
  expect(check).toHaveBeenCalledTimes(1);

  // A missing value counts as on (the registry default).
  value = undefined;
  const fresh = new AutoUpdaterService();
  fresh.followAutoCheckSetting(settings);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(check).toHaveBeenCalledTimes(2);
  fresh.setAutoCheckEnabled(false);
});
