// @vitest-environment node
/**
 * The PromptForUserInput answer lookup against the real write chain: SQLite
 * with the production schema, the SQLite store adapter and the agent messages
 * store, as RepositoryManager wires them. Rows go in through the repository.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AgentMessagesRepository } from "@nimbalyst/runtime/storage/repositories/AgentMessagesRepository";
import { SQLiteDatabase } from "../../../database/sqlite/SQLiteDatabase";
import { createSQLiteStoreAdapter } from "../../../database/sqlite/SQLiteStoreAdapter";
import { createPGLiteAgentMessagesStore } from "../../PGLiteAgentMessagesStore";
import {
  RESUME_PROMPT_PREFIX,
  isToolUseFromEarlierProcess,
  loadPromptAnswerFacts,
} from "../requestUserInputResumption";

const SCHEMA_DIR = path.resolve(__dirname, "../../../database/sqlite/schemas");
const SESSION = "session-a";
const OTHER_SESSION = "session-b";

let db: SQLiteDatabase;
let dbDir: string;
let clock = Date.parse("2026-09-23T07:00:00.000Z");

function row(
  sessionId: string,
  direction: "input" | "output",
  content: unknown,
  extra: { hidden?: boolean; source?: string; createdAt?: Date } = {},
) {
  clock += 1_000;
  return AgentMessagesRepository.create({
    sessionId,
    source: extra.source ?? "claude-code",
    direction,
    content: typeof content === "string" ? content : JSON.stringify(content),
    hidden: extra.hidden,
    createdAt: extra.createdAt ?? new Date(clock),
  });
}

const toolUse = (id: string, title = "Farbe waehlen") => ({
  type: "assistant",
  message: {
    id: `msg_${id}`,
    role: "assistant",
    model: "claude-opus-4-5",
    content: [{
      type: "tool_use",
      id,
      name: "mcp__nimbalyst__PromptForUserInput",
      input: { title, fields: [{ id: "farbe", type: "text", label: "Farbe" }] },
    }],
  },
});
const response = (promptId: string, extra: Record<string, unknown> = {}) => ({
  type: "request_user_input_response",
  promptId,
  answers: { farbe: "blau" },
  cancelled: false,
  respondedAt: clock,
  respondedBy: "desktop",
  ...extra,
});
const nimbalystToolResult = (id: string) => ({
  type: "nimbalyst_tool_result",
  tool_use_id: id,
  result: JSON.stringify({ cancelled: false, answers: { farbe: "blau" }, respondedBy: "desktop", respondedAt: clock }),
  is_error: false,
});
const cliToolResult = (id: string) => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "Connection closed", is_error: true }] },
});
const input = (prompt: string) => ({ prompt, options: {} });

beforeEach(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "rui-facts-"));
  db = new SQLiteDatabase({ dbDir, schemaDir: SCHEMA_DIR, log: () => {} });
  await db.initialize();
  const adapter = createSQLiteStoreAdapter(db);
  for (const id of [SESSION, OTHER_SESSION]) {
    await adapter.query(
      "INSERT INTO ai_sessions (id, workspace_id, title, provider) VALUES ($1, $2, $3, $4)",
      [id, "/ws", "t", "claude-code"],
    );
  }
  AgentMessagesRepository.setStore(createPGLiteAgentMessagesStore(adapter));
});

afterEach(async () => {
  AgentMessagesRepository.clearStore();
  await db.close();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

describe("loadPromptAnswerFacts", () => {
  it("reads the measured row forms of one call, including a hidden resume turn", async () => {
    await row(SESSION, "output", toolUse("toolu_X"));
    await row(SESSION, "output", response("toolu_X", { answers: {}, cancelled: true }), { source: "nimbalyst" });
    await row(SESSION, "input", input("und weiter"));
    await row(SESSION, "output", response("toolu_X", { attempt: 1, queuedPromptId: "prompt-answer-1" }), { source: "nimbalyst" });
    await row(SESSION, "input", input(`${RESUME_PROMPT_PREFIX}\n\nYour PromptForUserInput call toolu_X ("Farbe waehlen")`), { hidden: true });

    const facts = await loadPromptAnswerFacts(SESSION, "toolu_X");

    expect(facts).toMatchObject({
      hasToolUse: true,
      toolUseTitle: "Farbe waehlen",
      hasToolResult: false,
      hasResumeInput: true,
      hasLaterInput: true,
    });
    expect(facts.responses).toMatchObject([
      { cancelled: true, answers: {}, respondedBy: "desktop" },
      { cancelled: false, answers: { farbe: "blau" }, attempt: 1, queuedPromptId: "prompt-answer-1" },
    ]);
    expect(facts.responses[0].attempt).toBeUndefined();
  });

  it("finds a tool_result in either form, and one on the second page", async () => {
    await row(SESSION, "output", toolUse("toolu_X"));
    for (let i = 0; i < 510; i += 1) await row(SESSION, "output", { type: "text", content: `chunk ${i}` });
    await row(SESSION, "output", nimbalystToolResult("toolu_X"));
    await row(OTHER_SESSION, "output", toolUse("toolu_C"));
    await row(OTHER_SESSION, "output", cliToolResult("toolu_C"));
    await row(OTHER_SESSION, "output", toolUse("toolu_D"));
    await row(OTHER_SESSION, "input", cliToolResult("toolu_D"));

    expect(await loadPromptAnswerFacts(SESSION, "toolu_X")).toMatchObject({ hasToolUse: true, hasToolResult: true });
    expect(await loadPromptAnswerFacts(OTHER_SESSION, "toolu_C")).toMatchObject({ hasToolUse: true, hasToolResult: true });
    expect(await loadPromptAnswerFacts(OTHER_SESSION, "toolu_D")).toMatchObject({ hasToolUse: true, hasToolResult: true });
  });

  it("keeps rows of other sessions and other calls out", async () => {
    await row(SESSION, "output", toolUse("toolu_X"));
    await row(SESSION, "output", toolUse("toolu_Y"));
    await row(SESSION, "output", response("toolu_Y"), { source: "nimbalyst" });
    await row(SESSION, "output", nimbalystToolResult("toolu_Y"));
    await row(SESSION, "input", input(`${RESUME_PROMPT_PREFIX}\n\nYour PromptForUserInput call toolu_Y`), { hidden: true });
    await row(OTHER_SESSION, "output", response("toolu_X"), { source: "nimbalyst" });
    await row(OTHER_SESSION, "output", nimbalystToolResult("toolu_X"));

    expect(await loadPromptAnswerFacts(SESSION, "toolu_X")).toMatchObject({
      hasToolUse: true,
      hasToolResult: false,
      responses: [],
      hasResumeInput: false,
      hasLaterInput: false,
    });
    expect(await loadPromptAnswerFacts(OTHER_SESSION, "toolu_Z")).toMatchObject({ hasToolUse: false, toolUseCreatedAt: null });
  });

  it("tells a form of this process from one of an earlier process by its stored time", async () => {
    const now = Date.now();
    await row(SESSION, "output", toolUse("toolu_NOW"), { createdAt: new Date() });
    await row(SESSION, "output", toolUse("toolu_OLD"), { createdAt: new Date(now - 60_000) });

    const processStart = now - 1_000;
    expect(isToolUseFromEarlierProcess(await loadPromptAnswerFacts(SESSION, "toolu_NOW"), processStart)).toBe(false);
    expect(isToolUseFromEarlierProcess(await loadPromptAnswerFacts(SESSION, "toolu_OLD"), processStart)).toBe(true);
  });
});
