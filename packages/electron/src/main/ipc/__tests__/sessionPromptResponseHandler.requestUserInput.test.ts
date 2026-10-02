// @vitest-environment node

// A PromptForUserInput answer that reaches no waiter used to be stored and
// dropped: the agent never saw it, and the form said "Submitted". An answer to
// a call that is gone now resumes the session through the prompt queue, once,
// with a durable receipt per submission. Everything below the IPC handler runs
// for real except storage: the raw log is one array behind both write paths,
// and the queue store keeps the real store's contract (`create` rejects a
// duplicate id, `delete` removes only pending rows).

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  rows: [] as any[],
  events: [] as string[],
  windowSend: vi.fn(),
  windows: [] as any[],
  senderSend: vi.fn(),
  trayResolved: vi.fn(),
  setPendingPrompt: vi.fn(async (_sessionId: string, _pending: boolean) => {}),
  session: { provider: "claude-code", workspacePath: "/workspace" } as any,
  state: null as null | { status: string; isStreaming: boolean },
  queue: new Map<string, any>(),
  drive: vi.fn(async (_sessionId: string, _workspacePath: string): Promise<any> => ({ kind: "dispatched" })),
  publish: vi.fn(async (_sessionId: string) => {}),
}));

function pushRow(row: any) {
  const stored = { id: mocks.rows.length + 1, hidden: false, ...row };
  mocks.rows.push(stored);
  return stored;
}

const queueStore = vi.hoisted(() => ({
  get: vi.fn(async (id: string) => mocks.queue.get(id) ?? null),
  create: vi.fn(async (row: any) => {
    if (mocks.queue.has(row.id)) throw new Error("duplicate key value violates unique constraint");
    const stored = { ...row, status: "pending", createdAt: Date.now() };
    mocks.queue.set(row.id, stored);
    mocks.events.push("create");
    return stored;
  }),
  delete: vi.fn(async (id: string) => {
    if (mocks.queue.get(id)?.status !== "pending") {
      throw new Error("Queued prompt was already claimed or removed; refresh the queue before editing it");
    }
    mocks.queue.delete(id);
  }),
}));

vi.mock("electron", async () => ({
  app: (await import("../../../../test-stubs/privateUserData")).testApp,
  ipcMain: new EventEmitter(),
  BrowserWindow: {
    getAllWindows: () => mocks.windows,
    fromId: () => null,
  },
}));
vi.mock("../../utils/ipcRegistry", () => ({
  safeHandle: (name: string, fn: any) => mocks.handlers.set(name, fn),
  safeOn: () => {},
}));
vi.mock("@nimbalyst/runtime/storage/repositories/AgentMessagesRepository", () => ({
  AgentMessagesRepository: {
    create: vi.fn(async (row: any) => pushRow(row)),
    list: async (sessionId: string, options: { offset?: number; limit?: number } = {}) =>
      mocks.rows
        .filter((row) => row.sessionId === sessionId)
        .slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? Infinity)),
    listTail: async (sessionId: string, limit: number) =>
      mocks.rows.filter((row) => row.sessionId === sessionId).slice(-limit),
  },
}));
// The handler writes the response row with raw SQL; it lands in the same log.
vi.mock("../../database/PGLiteDatabaseWorker", () => ({
  database: {
    query: async (sql: string, params: any[]) => {
      if (/^\s*INSERT INTO ai_agent_messages/.test(sql)) {
        pushRow({
          sessionId: params[0],
          source: params[1],
          direction: params[2],
          content: params[3],
          createdAt: params[4],
          hidden: params[5],
        });
        mocks.events.push("response");
      }
      return { rows: [] };
    },
  },
}));
vi.mock("@nimbalyst/runtime/storage/repositories/AISessionsRepository", () => ({
  AISessionsRepository: { get: async () => mocks.session },
}));
vi.mock("@nimbalyst/runtime/ai/server/SessionStateManager", () => ({
  getSessionStateManager: () => ({
    getSessionState: () => mocks.state,
    updateActivity: async () => {},
    isSessionActive: () => false,
  }),
}));
vi.mock("../../services/RepositoryManager", () => ({
  getQueuedPromptsStore: () => queueStore,
}));
vi.mock("../../services/ai/pendingPromptPersistence", () => ({
  setSessionPendingPrompt: mocks.setPendingPrompt,
}));
vi.mock("../../tray/TrayManager", () => ({
  TrayManager: { getInstance: () => ({ onPromptResolved: mocks.trayResolved }) },
}));
vi.mock("../../services/NotificationService", () => ({
  notificationService: { showBlockedNotification: () => {} },
}));
vi.mock("../../services/SessionCommitService", () => ({
  SessionCommitService: {},
}));

import { ipcMain } from "electron";
import { AgentMessagesRepository } from "@nimbalyst/runtime/storage/repositories/AgentMessagesRepository";
import { registerSessionPromptResponseHandler } from "../sessionPromptResponseHandler";
import { handleRequestUserInput } from "../../mcp/tools/interactiveToolHandlers";
import {
  configureRequestUserInputResumption,
  isResumeInputRow,
  notePromptTurnEnded,
  promptAnswerReceiptId,
  resetPromptTurnEndsForTests,
} from "../../services/ai/requestUserInputResumption";

const SESSION = "session-late-answer";
const A = { farbe: { type: "singleSelect", selectedId: "rot" } };
const B = { farbe: { type: "singleSelect", selectedId: "blau" } };
const ALREADY_ANSWERED = "This form was already answered.";
const ON_ITS_WAY = "This answer is already on its way to the session.";
const OTHER_WAITING = "Another question in this session is waiting for your answer. Answer that one first.";
const receiptId = (attempt: number) => promptAnswerReceiptId(SESSION, "toolu_X", attempt);
const beforeThisProcess = () => new Date(performance.timeOrigin - 60_000);

function toolUseRow(id: string, createdAt: Date, parentToolUseId: string | null = null) {
  return {
    sessionId: SESSION,
    source: "claude-code",
    direction: "output",
    createdAt,
    content: JSON.stringify({
      type: "assistant",
      parent_tool_use_id: parentToolUseId,
      message: {
        content: [{
          type: "tool_use",
          id,
          name: "mcp__nimbalyst__PromptForUserInput",
          input: { title: "Farbe waehlen", fields: [{ type: "singleSelect", id: "farbe", label: "Farbe" }] },
        }],
      },
    }),
  };
}
const inputRow = (prompt: string) => ({
  sessionId: SESSION,
  source: "claude-code",
  direction: "input",
  createdAt: new Date(),
  content: JSON.stringify({ prompt }),
});
const responseRow = (fields: Record<string, unknown>) => ({
  sessionId: SESSION,
  source: "nimbalyst",
  direction: "output",
  createdAt: new Date(),
  content: JSON.stringify({ type: "request_user_input_response", promptId: "toolu_X", respondedBy: "desktop", cancelled: false, ...fields }),
});

function answer(promptId: string, response: Record<string, unknown>) {
  return mocks.handlers.get("messages:respond-to-prompt")!(
    { sender: { send: mocks.senderSend } },
    { sessionId: SESSION, promptId, promptType: "request_user_input_request", response, respondedBy: "desktop" },
  );
}
const submit = (answers: Record<string, unknown>) => answer("toolu_X", { answers });
const cancel = () => answer("toolu_X", { answers: {}, cancelled: true });

const parsed = () => mocks.rows.map((row) => ({ ...row, value: JSON.parse(row.content) }));
const responses = () => parsed().filter((row) => row.value.type === "request_user_input_response").map((row) => row.value);
const toolResults = () =>
  parsed()
    .filter((row) => row.value.type === "nimbalyst_tool_result")
    .map((row) => ({ ...row.value, result: JSON.parse(row.value.result) }));

function openWaiter(toolUseId: string) {
  return handleRequestUserInput(
    { fields: [{ type: "singleSelect", id: "farbe", label: "Farbe", options: [{ id: "rot", label: "Rot" }, { id: "blau", label: "Blau" }] }] },
    SESSION,
    undefined,
    { params: { _meta: { "claudecode/toolUseId": toolUseId } } },
  );
}
const within = <T>(promise: Promise<T>, ms = 300) =>
  Promise.race([promise, new Promise<"still waiting">((resolve) => setTimeout(() => resolve("still waiting"), ms))]);

beforeEach(() => {
  mocks.rows.length = 0;
  mocks.events.length = 0;
  mocks.queue.clear();
  mocks.handlers.clear();
  mocks.session = { provider: "claude-code", workspacePath: "/workspace" };
  mocks.state = { status: "idle", isStreaming: false };
  vi.clearAllMocks();
  mocks.windows = [{ isDestroyed: () => false, webContents: { send: mocks.windowSend } }];
  resetPromptTurnEndsForTests();
  mocks.drive.mockImplementation(async () => ({ kind: "dispatched" }));
  mocks.publish.mockImplementation(async () => {});
  configureRequestUserInputResumption({ drive: mocks.drive, publish: mocks.publish });
  registerSessionPromptResponseHandler();
  pushRow(toolUseRow("toolu_X", beforeThisProcess()));
});
afterEach(() => {
  ipcMain.removeAllListeners();
  vi.useRealTimers();
});

describe("PromptForUserInput answer to a call that is gone", () => {
  it("queues one resume turn behind a receipt written after the response row", async () => {
    expect(await submit(A)).toMatchObject({ success: true });

    expect(mocks.events).toEqual(["response", "create"]);
    expect(responses()).toEqual([
      expect.objectContaining({ answers: A, attempt: 1, queuedPromptId: receiptId(1) }),
    ]);
    const [created] = queueStore.create.mock.calls.map(([row]) => row);
    expect(created.id).toBe(receiptId(1));
    expect(created.prompt).toContain("toolu_X");
    expect(created.prompt).toContain("Farbe waehlen");
    expect(created.prompt).toContain(JSON.stringify(A));
    // The queued text is what the resume turn stores as its input row: the
    // observer, the delivery hook and the heal all recognize the turn by it.
    expect(isResumeInputRow({ direction: "input", content: JSON.stringify({ prompt: created.prompt }) }, "toolu_X")).toBe(true);
    expect(created.documentContext).toEqual({
      promptOrigin: "interactive-question",
      answeredPrompt: { toolUseId: "toolu_X", answers: A, respondedBy: "desktop" },
    });
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.windowSend).toHaveBeenCalledWith("ai:queuedPromptsReceived", expect.objectContaining({ sessionId: SESSION }));
    expect(mocks.drive).toHaveBeenCalledWith(SESSION, "/workspace");
    expect(toolResults()).toEqual([]);
    // Accepted: the form, the tray and the session's waiting state let go of it.
    expect(mocks.senderSend).toHaveBeenCalledWith("ai:requestUserInputResolved", { sessionId: SESSION, promptId: "toolu_X" });
    expect(mocks.trayResolved).toHaveBeenCalledWith(SESSION);
    expect(mocks.setPendingPrompt).toHaveBeenCalledWith(SESSION, false);
  });

  it("reports a resume turn that could not start and accepts the next submission", async () => {
    // As `failAllPending`: the drive marks the receipt failed before it reports.
    mocks.drive.mockImplementationOnce(async () => {
      mocks.queue.get(receiptId(1)).status = "failed";
      return { kind: "failed", reason: "workspace-missing" };
    });
    expect(await submit(A)).toEqual({ success: false, error: "The answer could not start: workspace-missing" });

    mocks.drive.mockImplementationOnce(async () => ({ kind: "nothing-pending" }));
    expect(await submit(A)).toMatchObject({ success: true });
    expect(queueStore.create.mock.calls.map(([row]) => row.id)).toEqual([receiptId(1), receiptId(2)]);
  });

  it("still drives the queue when publishing it fails", async () => {
    mocks.publish.mockRejectedValueOnce(new Error("sync down"));
    expect(await submit(A)).toMatchObject({ success: true });
    expect(mocks.drive).toHaveBeenCalledTimes(1);
  });

  it("queues despite a window that is gone or fails to take the queue signal", async () => {
    const goneSend = vi.fn();
    mocks.windows = [
      { isDestroyed: () => false, webContents: { send: mocks.windowSend } },
      { isDestroyed: () => true, webContents: { send: goneSend } },
      { isDestroyed: () => false, webContents: { send: () => { throw new Error("render frame disposed"); } } },
    ];
    expect(await submit(A)).toMatchObject({ success: true });
    expect(mocks.drive).toHaveBeenCalledTimes(1);
    expect(mocks.windowSend).toHaveBeenCalledWith("ai:queuedPromptsReceived", expect.objectContaining({ sessionId: SESSION }));
    expect(goneSend).not.toHaveBeenCalled();
  });

  it("rejects a second submission while the first is queued", async () => {
    await submit(A);
    mocks.senderSend.mockClear();
    expect(await submit(A)).toEqual({ success: false, error: ON_ITS_WAY });
    expect(queueStore.create).toHaveBeenCalledTimes(1);
    expect(mocks.senderSend).not.toHaveBeenCalled();
  });

  it.each([["the same", A], ["a different", B]])(
    "queues once for two concurrent submissions with %s answer",
    async (_label, second) => {
      // Hold the first receipt write past a timer tick, and send the second
      // submission only once the first is inside it: it arrives while the first
      // is still being queued. Started together, both would import the handler's
      // lazily loaded database module at once, and vitest hands one of two
      // overlapping imports of a mocked module the real one.
      const faithfulCreate = queueStore.create.getMockImplementation()!;
      let entered!: () => void;
      const inCreate = new Promise<void>((resolve) => { entered = resolve; });
      queueStore.create.mockImplementationOnce(async (row: any) => {
        entered();
        await new Promise((resolve) => setTimeout(resolve, 20));
        return faithfulCreate(row);
      });
      const first = submit(A);
      await inCreate;
      const results = await Promise.all([first, submit(second)]);
      expect(queueStore.create).toHaveBeenCalledTimes(1);
      // The rejected one counts no submission, or the next receipt is looked up under the wrong number.
      expect(responses().filter((response) => response.attempt)).toHaveLength(1);
      expect(results).toEqual([expect.objectContaining({ success: true }), { success: false, error: ON_ITS_WAY }]);
    },
  );

  it("queues a new answer as the next submission after the queued one was deleted", async () => {
    await submit(A);
    expect(mocks.queue.get(receiptId(1))?.status).toBe("pending");
    await queueStore.delete(receiptId(1));
    expect(await submit(B)).toMatchObject({ success: true });
    expect(queueStore.create.mock.calls.map(([row]) => row.id)).toEqual([receiptId(1), receiptId(2)]);
    expect(mocks.queue.get(receiptId(2)).documentContext.answeredPrompt.answers).toEqual(B);
  });

  it.each(["completed", "failed"])(
    "queues the next submission when the last one is %s without a resume turn",
    async (status) => {
      pushRow(responseRow({ answers: A, attempt: 1, queuedPromptId: receiptId(1) }));
      mocks.queue.set(receiptId(1), { id: receiptId(1), status, claimedAt: Date.now() });
      expect(await submit(B)).toMatchObject({ success: true });
      expect(queueStore.create.mock.calls.map(([row]) => row.id)).toEqual([receiptId(2)]);
      expect(responses().at(-1)).toMatchObject({ answers: B, attempt: 2, queuedPromptId: receiptId(2) });
    },
  );

  it.each(["openai-codex", "claude-code-cli"])("leaves a %s session on the usual path", async (provider) => {
    mocks.session = { provider, workspacePath: "/workspace" };
    expect(await submit(A)).toMatchObject({ success: true });
    expect(responses()).toEqual([expect.not.objectContaining({ attempt: expect.anything() })]);
    expect(queueStore.create).not.toHaveBeenCalled();
  });

  it("rejects the answer and writes nothing when resumption is not set up", async () => {
    configureRequestUserInputResumption(undefined as any);
    expect(await submit(A)).toEqual({
      success: false,
      error: "The answer could not be queued: resuming this session is not available.",
    });
    expect(responses()).toEqual([]);
    expect(queueStore.create).not.toHaveBeenCalled();
  });

  it("reports a failed queue write and takes a new answer as the next submission", async () => {
    queueStore.create.mockRejectedValueOnce(new Error("database is locked"));
    expect(await submit(A)).toEqual({ success: false, error: "The answer could not be queued: database is locked" });
    expect(responses()).toEqual([expect.objectContaining({ attempt: 1 })]);
    expect(mocks.drive).not.toHaveBeenCalled();

    expect(await submit(B)).toMatchObject({ success: true });
    expect(mocks.queue.has(receiptId(2))).toBe(true);
  });

  it("heals a resumed call without a result from its receipt, not from the new answer", async () => {
    pushRow(responseRow({ answers: A, attempt: 1, queuedPromptId: receiptId(1) }));
    mocks.queue.set(receiptId(1), {
      id: receiptId(1),
      status: "executing",
      documentContext: { answeredPrompt: { toolUseId: "toolu_X", answers: A, respondedBy: "desktop" } },
    });
    pushRow(inputRow("[Resuming after answering a prompt]\n\nYour PromptForUserInput call toolu_X ..."));

    expect(await submit(B)).toEqual({ success: false, error: ALREADY_ANSWERED });
    expect(toolResults()).toEqual([expect.objectContaining({ tool_use_id: "toolu_X", result: expect.objectContaining({ answers: A }) })]);
    expect(mocks.windowSend).toHaveBeenCalledWith("ai:message-logged", { sessionId: SESSION, workspacePath: "/workspace" });
  });

  it("rejects while a claimed resume turn has not started, without a result", async () => {
    pushRow(responseRow({ answers: A, attempt: 1, queuedPromptId: receiptId(1) }));
    mocks.queue.set(receiptId(1), { id: receiptId(1), status: "executing" });
    expect(await submit(B)).toEqual({ success: false, error: ON_ITS_WAY });
    expect(toolResults()).toEqual([]);
  });

  it("withdraws a queued answer on cancel, announces the queue and closes the form as cancelled", async () => {
    await submit(A);
    mocks.publish.mockClear();
    mocks.windowSend.mockClear();
    // A sync failure is only logged: the withdrawal stands either way.
    mocks.publish.mockRejectedValueOnce(new Error("sync down"));
    expect(await cancel()).toMatchObject({ success: true });
    expect(mocks.queue.size).toBe(0);
    expect(toolResults()).toEqual([expect.objectContaining({ is_error: true, result: expect.objectContaining({ cancelled: true }) })]);
    // Mobile and every window's queue list drop the withdrawn row.
    expect(mocks.publish).toHaveBeenCalledWith(SESSION);
    expect(mocks.publish.mock.invocationCallOrder[0]).toBeGreaterThan(queueStore.delete.mock.invocationCallOrder[0]);
    expect(mocks.windowSend).toHaveBeenCalledWith("ai:queuedPromptsReceived", expect.objectContaining({ sessionId: SESSION }));
  });

  it("refuses a cancel once the queued answer was claimed", async () => {
    await submit(A);
    expect(mocks.queue.has(receiptId(1))).toBe(true);
    mocks.queue.get(receiptId(1)).status = "executing";
    expect(await cancel()).toEqual({ success: false, error: ON_ITS_WAY });
    expect(toolResults()).toEqual([]);
  });

  it("refuses a cancel whose withdrawal loses the race to the queue", async () => {
    await submit(A);
    queueStore.delete.mockRejectedValueOnce(new Error("Queued prompt was already claimed or removed"));
    expect(await cancel()).toEqual({ success: false, error: ON_ITS_WAY });
    expect(toolResults()).toEqual([]);
  });

  it("makes a cancel wait for a submission that is still being queued", async () => {
    let release: (() => void) | undefined;
    queueStore.create.mockImplementationOnce(async (row: any) => {
      await new Promise<void>((resolve) => { release = resolve; });
      mocks.queue.set(row.id, { ...row, status: "pending" });
      return mocks.queue.get(row.id);
    });
    // An idle session claims the receipt as soon as the queue is driven.
    mocks.drive.mockImplementationOnce(async () => {
      mocks.queue.get(receiptId(1)).status = "executing";
      return { kind: "dispatched" };
    });
    const submitted = submit(A);
    try {
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      expect(responses()).toEqual([expect.objectContaining({ attempt: 1 })]);
      const cancelled = cancel();
      await new Promise((resolve) => setImmediate(resolve));
      release!();

      expect(await submitted).toMatchObject({ success: true });
      expect(await cancelled).toEqual({ success: false, error: ON_ITS_WAY });
      expect(toolResults()).toEqual([]);
      expect(mocks.queue.size).toBe(1);
    } finally {
      // A failing run must not leave this form's claim held for the next test.
      release?.();
      await submitted;
    }
  });

  it("closes a dead form on cancel without queueing, and reports a failed write", async () => {
    expect(await cancel()).toMatchObject({ success: true });
    expect(toolResults()).toEqual([expect.objectContaining({ result: expect.objectContaining({ cancelled: true }) })]);
    expect(queueStore.create).not.toHaveBeenCalled();

    mocks.rows.splice(1);
    vi.mocked(AgentMessagesRepository.create).mockRejectedValueOnce(new Error("disk full"));
    expect(await cancel()).toEqual({ success: false, error: "The cancellation could not be saved: disk full" });
  });

  it("does not count stored answers without an attempt as submissions", async () => {
    pushRow(responseRow({ answers: A }));
    pushRow(responseRow({ answers: A }));
    expect(await submit(B)).toMatchObject({ success: true });
    expect(queueStore.create.mock.calls.map(([row]) => row.id)).toEqual([receiptId(1)]);
    expect(queueStore.create.mock.calls[0][0].prompt).toContain(JSON.stringify(B));
  });

  it("queues the answer to a form whose turn ended without a result", async () => {
    // Stop, cancelling a permission question, or a send that interrupts the turn
    // can end it before the call ever reached the MCP server: no waiter comes.
    mocks.rows.length = 0;
    pushRow(toolUseRow("toolu_X", new Date(Date.now() - 1_000)));
    notePromptTurnEnded(SESSION);
    expect(await submit(A)).toMatchObject({ success: true });
    expect(queueStore.create.mock.calls.map(([row]) => row.id)).toEqual([receiptId(1)]);
    // The agent reads why its call ended; here nothing dropped, the turn was ended.
    expect(queueStore.create.mock.calls[0][0].prompt).not.toMatch(/because the connection dropped/);
  });

  // The session reports itself free while a form waits, so a resume turn
  // started at once and ended the live form's turn: that form never got a
  // result and stayed open for good.
  it("holds a late answer back while another form of the session waits", async () => {
    const other = openWaiter("toolu_Y");
    await vi.waitFor(() => expect(ipcMain.listenerCount(`request-user-input-response:${SESSION}:toolu_Y`)).toBe(1));
    mocks.setPendingPrompt.mockClear();
    try {
      expect(await submit(A)).toEqual({ success: false, error: OTHER_WAITING });
      expect(queueStore.create).not.toHaveBeenCalled();
      expect(responses()).toEqual([]);
      expect(mocks.senderSend).not.toHaveBeenCalledWith("ai:requestUserInputResolved", expect.anything());
      expect(mocks.setPendingPrompt).not.toHaveBeenCalledWith(SESSION, false);
    } finally {
      // A failing run must not leave the other form waiting for the next test.
      ipcMain.emit(`request-user-input-response:${SESSION}:toolu_Y`, {}, { answers: B });
      await other;
    }
    expect(await submit(A)).toMatchObject({ success: true });
    expect(queueStore.create.mock.calls.map(([row]) => row.id)).toEqual([receiptId(1)]);
  });

  it("closes a dead form on cancel while another form waits, keeping the pending bit", async () => {
    const other = openWaiter("toolu_Y");
    await vi.waitFor(() => expect(ipcMain.listenerCount(`request-user-input-response:${SESSION}:toolu_Y`)).toBe(1));
    mocks.setPendingPrompt.mockClear();
    try {
      expect(await cancel()).toMatchObject({ success: true });
      expect(toolResults()).toEqual([expect.objectContaining({ tool_use_id: "toolu_X" })]);
      expect(mocks.setPendingPrompt).not.toHaveBeenCalledWith(SESSION, false);
    } finally {
      ipcMain.emit(`request-user-input-response:${SESSION}:toolu_Y`, {}, { cancelled: true });
      await other;
    }
  });

  it("says the answer arrives late only when the session moved on", async () => {
    await submit(A);
    expect(queueStore.create).toHaveBeenCalledTimes(1);
    expect(queueStore.create.mock.calls[0][0].prompt).not.toContain("arrives late");

    mocks.queue.clear();
    mocks.rows.splice(1);
    pushRow(inputRow("mach weiter"));
    await submit(A);
    expect(queueStore.create.mock.calls[1][0].prompt).toContain("arrives late");
  });
});

describe("PromptForUserInput answer while its call lives or starts", () => {
  it("hands the answer to a live waiter and queues nothing", async () => {
    const call = openWaiter("toolu_X");
    await vi.waitFor(() => expect(ipcMain.listenerCount(`request-user-input-response:${SESSION}:toolu_X`)).toBe(1));

    expect(await submit(A)).toMatchObject({ success: true });
    expect(JSON.parse((await call).content[0].text).answers).toEqual(A);
    expect(queueStore.create).not.toHaveBeenCalled();
  });

  it("keeps a dead form's answer away from another live waiter of the session", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const other = openWaiter("toolu_Y");
    await vi.waitFor(() => expect(ipcMain.listenerCount(`request-user-input-response:${SESSION}:toolu_Y`)).toBe(1));

    await submit(A);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await within(other)).toBe("still waiting");

    ipcMain.emit(`request-user-input-response:${SESSION}:toolu_Y`, {}, { cancelled: true });
    await other;
  });

  it.each([
    // Shown in the very millisecond the last turn ended: still the running turn's.
    ["the running turn's form behind a permission question", null, 0],
    ["a sub-agent's form after the lead turn ended", "toolu_AGENT", -1_000],
  ])("stores the answer for %s without queueing it", async (_label, parent, offset) => {
    // Its call can still register a waiter that picks the stored answer up; a
    // queued resume turn on top would deliver the answer twice. The session
    // reports itself free here, as it does behind a permission question.
    mocks.rows.length = 0;
    mocks.state = { status: "waiting_for_input", isStreaming: false };
    vi.useFakeTimers({ toFake: ["Date"] });
    notePromptTurnEnded(SESSION);
    pushRow(toolUseRow("toolu_X", new Date(Date.now() + offset), parent));

    expect(await submit(A)).toMatchObject({ success: true });
    expect(queueStore.create).not.toHaveBeenCalled();
    expect(responses()).toEqual([expect.not.objectContaining({ attempt: expect.anything() })]);
  });

  it("stores an answer for a call that is still starting for its waiter to pick up", async () => {
    mocks.rows.length = 0;
    pushRow(toolUseRow("toolu_X", new Date()));

    expect(await submit(A)).toMatchObject({ success: true });
    const result: any = await within(openWaiter("toolu_X"));
    expect(result).not.toBe("still waiting");
    expect(JSON.parse(result.content[0].text).answers).toEqual(A);
    expect(queueStore.create).not.toHaveBeenCalled();
  });
});

