// @vitest-environment node

// The tool_result that closes a resumed PromptForUserInput form. It is written
// once the resume turn's input row is stored -- by the turn's observer, by the
// queue's delivered hook, or by the heal on a later submission -- and only then.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [] as any[],
  windowSend: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.windowSend } }],
  },
}));
vi.mock("@nimbalyst/runtime/storage/repositories/AgentMessagesRepository", () => ({
  AgentMessagesRepository: { list: mocks.list, create: mocks.create },
}));
vi.mock("../../RepositoryManager", () => ({ getQueuedPromptsStore: () => ({}) }));

import { promptToolResultRow } from "@nimbalyst/runtime/ai/server/transcript/__tests__/fixtures/requestUserInputRows";
import {
  RESUME_PROMPT_PREFIX,
  persistClaimedPromptAnswer,
  watchAnsweredPromptInput,
} from "../requestUserInputResumption";

const SESSION = "session-resumed";
const answeredPrompt = {
  toolUseId: "toolu_X",
  answers: { farbe: { type: "singleSelect", selectedId: "blau" } },
  respondedBy: "desktop" as const,
};
const row = (direction: string, content: unknown) => ({
  sessionId: SESSION,
  direction,
  createdAt: new Date(),
  content: JSON.stringify(content),
});
const resumeInput = () => row("input", { prompt: `${RESUME_PROMPT_PREFIX}\n\nYour PromptForUserInput call toolu_X ...` });
const toolResults = () =>
  mocks.rows.map((r) => JSON.parse(r.content)).filter((value) => value.type === "nimbalyst_tool_result");
const persist = () => persistClaimedPromptAnswer({ sessionId: SESSION, workspacePath: "/workspace", answeredPrompt });
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** Row content with `result` parsed and its timestamp left out. */
function shape(content: string) {
  const value = JSON.parse(content);
  const { respondedAt: _respondedAt, ...result } = JSON.parse(value.result);
  return { ...value, result };
}

beforeEach(() => {
  mocks.rows.length = 0;
  vi.clearAllMocks();
  mocks.list.mockImplementation(async (_sessionId: string, options: { offset?: number; limit?: number } = {}) =>
    mocks.rows.slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? Infinity)));
  mocks.create.mockImplementation(async (value: any) => {
    mocks.rows.push(value);
    return value;
  });
});

describe("persistClaimedPromptAnswer", () => {
  it("writes the result in the shared row form once the resume turn has started, and tells the windows", async () => {
    mocks.rows.push(resumeInput());
    await persist();

    expect(toolResults()).toHaveLength(1);
    expect(shape(mocks.rows.at(-1).content)).toEqual(shape(promptToolResultRow(SESSION, "toolu_X").content));
    expect(mocks.windowSend).toHaveBeenCalledWith("ai:message-logged", { sessionId: SESSION, workspacePath: "/workspace" });
  });

  it("writes nothing before the resume turn has started", async () => {
    await persist();
    expect(toolResults()).toEqual([]);
  });

  it("writes nothing when the call already has a result", async () => {
    mocks.rows.push(resumeInput(), row("output", JSON.parse(promptToolResultRow(SESSION, "toolu_X").content)));
    await persist();
    expect(toolResults()).toHaveLength(1);
  });

  it("passes a failed write on", async () => {
    mocks.rows.push(resumeInput());
    mocks.create.mockRejectedValueOnce(new Error("disk full"));
    await expect(persist()).rejects.toThrow("disk full");
  });

  it("writes one result for two concurrent callers", async () => {
    mocks.rows.push(resumeInput());
    await Promise.all([persist(), persist()]);
    expect(toolResults()).toHaveLength(1);
  });
});

describe("watchAnsweredPromptInput", () => {
  beforeEach(() => {
    mocks.rows.push(resumeInput());
  });

  it("persists on the first input of a resuming turn and never again", async () => {
    const observe = watchAnsweredPromptInput(SESSION, { answeredPrompt }, "/workspace");
    observe({ direction: "output" });
    await settle();
    expect(mocks.list).not.toHaveBeenCalled();

    observe({ direction: "input" });
    await vi.waitFor(() => expect(toolResults()).toHaveLength(1));
    const reads = mocks.list.mock.calls.length;
    observe({ direction: "input" });
    observe({ direction: "output" });
    await settle();
    expect(mocks.list).toHaveBeenCalledTimes(reads);
  });

  it("ignores a turn that resumes no answer", async () => {
    watchAnsweredPromptInput(SESSION, { promptOrigin: "interactive-question" }, "/workspace")({ direction: "input" });
    await settle();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(toolResults()).toEqual([]);
  });
});
