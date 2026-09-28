// @vitest-environment node

// An AskUserQuestion answer that reaches no live handler resumes the session.
// Sent directly, the resume message aborted whatever turn was running; it now
// goes through the prompt queue under the question's durable receipt, behind
// the running turn, and is queued once however often the answer arrives.

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  session: { provider: "claude-code", workspacePath: "/workspace" } as any,
  queue: new Map<string, any>(),
  drive: vi.fn(async (..._args: unknown[]): Promise<any> => ({ kind: "deferred", reason: "session-busy" })),
  sendMessageHandler: vi.fn(async (..._args: unknown[]) => ({ content: "" })),
  publish: vi.fn(async (_sessionId: string) => {}),
  windowSend: vi.fn(),
}));
const queueStore = vi.hoisted(() => ({
  get: vi.fn(async (id: string) => mocks.queue.get(id) ?? null),
  create: vi.fn(async (row: any) => {
    if (mocks.queue.has(row.id)) throw new Error("duplicate key value violates unique constraint");
    mocks.queue.set(row.id, { ...row, status: "pending" });
    return mocks.queue.get(row.id);
  }),
}));

vi.mock("electron", async () => ({
  app: (await import("../../../../../../test-stubs/privateUserData")).testApp,
  ipcMain: new EventEmitter(),
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.windowSend } }] },
}));
vi.mock("../../../../utils/ipcRegistry", () => ({
  safeHandle: (name: string, fn: any) => mocks.handlers.set(name, fn),
  safeOn: () => {},
}));
vi.mock("@nimbalyst/runtime/storage/repositories/AgentMessagesRepository", () => ({
  AgentMessagesRepository: { create: async (row: any) => row, list: async () => [], listTail: async () => [] },
}));
vi.mock("@nimbalyst/runtime/storage/repositories/AISessionsRepository", () => ({
  AISessionsRepository: { get: async () => mocks.session },
}));
vi.mock("@nimbalyst/runtime/ai/server", () => ({
  ProviderFactory: { getProvider: () => undefined },
  isAskUserQuestionProvider: () => false,
}));
vi.mock("@nimbalyst/runtime/ai/server/SessionStateManager", () => ({
  getSessionStateManager: () => ({
    getSessionState: () => ({ status: "running", isStreaming: true }),
    updateActivity: async () => {},
    isSessionActive: () => true,
  }),
}));
vi.mock("../../../RepositoryManager", () => ({ getQueuedPromptsStore: () => queueStore }));
// The repeat guard also looks for a durable terminal row (questionTerminalResultLookup);
// these cases start with none stored.
vi.mock("../../../../database/PGLiteDatabaseWorker", () => ({
  database: { query: async () => ({ rows: [] }) },
}));
vi.mock("../../pendingPromptPersistence", () => ({ setSessionPendingPrompt: async () => {} }));
vi.mock("../../../SyncManager", () => ({ getSyncProvider: () => undefined }));
vi.mock("../../../../tray/TrayManager", () => ({
  TrayManager: { getInstance: () => ({ onPromptResolved() {} }) },
}));
vi.mock("../../../NotificationService", () => ({ notificationService: {} }));
vi.mock("../../../ClaudeSettingsManager", () => ({ ClaudeSettingsManager: {} }));
vi.mock("../../../PermissionService", () => ({ getPermissionService: vi.fn() }));
vi.mock("../../../SessionCommitService", () => ({ SessionCommitService: {} }));
vi.mock("../../../../window/WindowManager", () => ({}));
vi.mock("../../../../mcp/mcpWorkspaceResolver", () => ({ findWindowIdForWorkspacePath: vi.fn() }));

import { ipcMain } from "electron";
import { registerInteractivePromptHandlers } from "../registerInteractivePromptHandlers";
import { clearTerminalizedAskUserQuestions } from "../../askUserQuestionFallbackResolution";
import { codexQuestionRecoveryId } from "../../codexQuestionDelivery";

const SESSION = "session-running";
// Each case asks its own question: the answer reservation (upstream
// PromptAnswerReservation) is durable for the test module's profile, so a
// shared id would arrive already delivered in every case after the first.
let questionCount = 0;
let QUESTION = "toolu_question";

const answer = () =>
  mocks.handlers.get("claude-code:answer-question")!(
    {},
    { sessionId: SESSION, questionId: QUESTION, answers: { "Proceed?": "Design" } },
  );
// The old direct send ran in `setImmediate`; let it fire before asserting "never".
const afterDirectSend = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  mocks.handlers.clear();
  mocks.queue.clear();
  mocks.session = { provider: "claude-code", workspacePath: "/workspace" };
  vi.clearAllMocks();
  QUESTION = `toolu_question_${++questionCount}`;
  clearTerminalizedAskUserQuestions(SESSION);
  registerInteractivePromptHandlers({
    driveQueuedPrompts: mocks.drive,
    publishQueueStateToSync: mocks.publish,
    sendMessageHandler: mocks.sendMessageHandler,
  } as any);
});
afterEach(async () => {
  // A direct send left over from a failing test must not land in the next one.
  await afterDirectSend();
  ipcMain.removeAllListeners();
});

describe("AskUserQuestion answer without a live handler", () => {
  it("queues the resume behind the running turn instead of sending it", async () => {
    expect(await answer()).toEqual({ success: true });

    expect(queueStore.create).toHaveBeenCalledTimes(1);
    expect(queueStore.create.mock.calls[0][0]).toMatchObject({
      id: codexQuestionRecoveryId(SESSION, QUESTION),
      sessionId: SESSION,
      prompt: "[Resuming after answering a question]\n\nProceed?: Design",
      documentContext: { promptOrigin: "interactive-question" },
    });
    expect(mocks.drive).toHaveBeenCalledWith(SESSION, "/workspace", "session-idle");
    expect(mocks.publish).toHaveBeenCalledWith(SESSION);
    expect(mocks.windowSend).toHaveBeenCalledWith("ai:queuedPromptsReceived", expect.objectContaining({ sessionId: SESSION }));
    await afterDirectSend();
    expect(mocks.sendMessageHandler).not.toHaveBeenCalled();
  });

  it("queues one resume per question, also after a restart forgot the answer", async () => {
    await answer();
    // A restart empties the in-memory guard; the queue receipt survives it.
    clearTerminalizedAskUserQuestions(SESSION);
    await answer();

    expect(queueStore.create).toHaveBeenCalledTimes(1);
    await afterDirectSend();
    expect(mocks.sendMessageHandler).not.toHaveBeenCalled();
  });

  it("leaves a claude-code-cli session to its MCP handler", async () => {
    mocks.session = { provider: "claude-code-cli", workspacePath: "/workspace" };
    expect(await answer()).toEqual({ success: true });

    expect(queueStore.create).not.toHaveBeenCalled();
    await afterDirectSend();
    expect(mocks.sendMessageHandler).not.toHaveBeenCalled();
  });
});
