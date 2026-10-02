import { createHash } from "node:crypto";
import { BrowserWindow } from "electron";
import type { AgentMessage, DocumentContext } from "@nimbalyst/runtime/ai/server/types";
import { AgentMessagesRepository } from "@nimbalyst/runtime/storage/repositories/AgentMessagesRepository";
import { AISessionsRepository } from "@nimbalyst/runtime/storage/repositories/AISessionsRepository";
import { getSessionStateManager } from "@nimbalyst/runtime/ai/server/SessionStateManager";
import { toMillis } from "../../utils/timestampUtils";
import { buildInteractivePromptToolResultContent } from "../../mcp/tools/interactivePromptTranscript";
import { hasLiveInteractivePrompt } from "../../mcp/tools/interactivePromptLiveness";
import { getQueuedPromptsStore } from "../RepositoryManager";
import type { CreateQueuedPromptInput, QueuedPrompt } from "../PGLiteQueuedPromptsStore";
import type { DriveOutcome } from "./QueueDriveService";

/** Prefix of the message that resumes a session with a late PromptForUserInput answer. */
export const RESUME_PROMPT_PREFIX = "[Resuming after answering a prompt]";

export interface PromptAnswerResponse {
  answers: Record<string, unknown>;
  cancelled: boolean;
  respondedBy?: "desktop" | "mobile";
  /** Set only by desktop submissions that went through the resumption path. */
  attempt?: number;
  queuedPromptId?: string;
  createdAt: number | null;
}

/** What the raw log of one session says about one PromptForUserInput call. */
export interface PromptAnswerFacts {
  hasToolUse: boolean;
  toolUseCreatedAt: number | null;
  toolUseTitle?: string;
  /** The call was made by a sub-agent or a teammate, whose query can outlive the lead turn. */
  toolUseInSubagent?: true;
  hasToolResult: boolean;
  /** `request_user_input_response` rows for this call, oldest first. */
  responses: PromptAnswerResponse[];
  hasResumeInput: boolean;
  /** A visible user turn started after the form was shown. */
  hasLaterInput: boolean;
}

function parseContent(content: string): any {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/** The one place that says whether an input row is the resume turn for a call. */
export function isResumeInputRow(
  row: Pick<AgentMessage, "direction" | "content">,
  toolUseId: string,
): boolean {
  if (row.direction !== "input") return false;
  const prompt = parseContent(row.content)?.prompt;
  return typeof prompt === "string"
    && prompt.startsWith(RESUME_PROMPT_PREFIX)
    && prompt.includes(toolUseId);
}

function blocksOf(value: any): any[] {
  const content = value?.message?.content;
  return Array.isArray(content) ? content : [];
}

function isToolResultFor(value: any, toolUseId: string): boolean {
  if (value?.type === "nimbalyst_tool_result") {
    return (value.tool_use_id || value.id) === toolUseId;
  }
  if (value?.type === "user" || value?.type === "assistant") {
    return blocksOf(value).some(
      (block) => block?.type === "tool_result" && block.tool_use_id === toolUseId,
    );
  }
  return false;
}

/**
 * Read everything the raw log of a session says about one PromptForUserInput
 * call. Whole `content` values are parsed in JS, page by page: JSON
 * sub-extraction differs between SQLite and PGLite. Hidden rows are included
 * because the resume turn can be hidden. Tool-use ids are only unique within a
 * session, which is why the lookup is scoped to it.
 */
export async function loadPromptAnswerFacts(
  sessionId: string,
  toolUseId: string,
): Promise<PromptAnswerFacts> {
  const facts: PromptAnswerFacts = {
    hasToolUse: false,
    toolUseCreatedAt: null,
    hasToolResult: false,
    responses: [],
    hasResumeInput: false,
    hasLaterInput: false,
  };
  for (let offset = 0; ; offset += 500) {
    const rows = await AgentMessagesRepository.list(sessionId, {
      offset,
      limit: 500,
      includeHidden: true,
    });
    for (const row of rows) {
      const value = parseContent(row.content);
      if (!value) continue;
      // The CLI's own tool_result arrives as a user message in either direction.
      if (isToolResultFor(value, toolUseId)) {
        facts.hasToolResult = true;
        continue;
      }
      if (row.direction === "input") {
        if (isResumeInputRow(row, toolUseId)) {
          facts.hasResumeInput = true;
        } else if (
          facts.hasToolUse
          && !row.hidden
          && typeof value.prompt === "string"
        ) {
          facts.hasLaterInput = true;
        }
        continue;
      }
      if (value.type === "request_user_input_response") {
        if (value.promptId !== toolUseId && value.rawPromptId !== toolUseId) continue;
        facts.responses.push({
          answers: value.answers && typeof value.answers === "object" ? value.answers : {},
          cancelled: value.cancelled === true,
          respondedBy: value.respondedBy === "mobile" ? "mobile" : value.respondedBy === "desktop" ? "desktop" : undefined,
          attempt: typeof value.attempt === "number" ? value.attempt : undefined,
          queuedPromptId: typeof value.queuedPromptId === "string" ? value.queuedPromptId : undefined,
          createdAt: toMillis(row.createdAt),
        });
        continue;
      }
      if (facts.hasToolUse) continue;
      const toolUse = value.type === "assistant"
        ? blocksOf(value).find((block) => block?.type === "tool_use" && block.id === toolUseId)
        : value.type === "nimbalyst_tool_use" && value.id === toolUseId
          ? value
          : undefined;
      if (toolUse) {
        facts.hasToolUse = true;
        facts.toolUseCreatedAt = toMillis(row.createdAt);
        if (typeof toolUse.input?.title === "string") facts.toolUseTitle = toolUse.input.title;
        if (value.parent_tool_use_id || value._isTeammateOutput || toolUse.parent_tool_use_id) facts.toolUseInSubagent = true;
      }
    }
    if (rows.length < 500) return facts;
  }
}

/** True when the form was shown by an earlier run of the main process. */
export function isToolUseFromEarlierProcess(
  facts: Pick<PromptAnswerFacts, "toolUseCreatedAt">,
  processStart: number = performance.timeOrigin,
): boolean {
  return facts.toolUseCreatedAt !== null && facts.toolUseCreatedAt < processStart;
}

/**
 * True when a turn of the session ended after a lead call was shown: that call
 * never got a result, and no waiter can register for it anymore.
 */
export function isToolUseFromEndedTurn(
  facts: Pick<PromptAnswerFacts, "toolUseCreatedAt" | "toolUseInSubagent">,
  turnEndedAt: number | undefined,
): boolean {
  return !facts.toolUseInSubagent
    && turnEndedAt !== undefined
    && facts.toolUseCreatedAt !== null
    && facts.toolUseCreatedAt < turnEndedAt;
}

/** The answer a queued resume turn carries for the call it resumes. */
export interface AnsweredPrompt {
  toolUseId: string;
  answers: Record<string, unknown>;
  respondedBy?: "desktop" | "mobile";
}

interface ResumptionHost {
  drive(sessionId: string, workspacePath: string): Promise<DriveOutcome>;
  publish(sessionId: string): Promise<void>;
}
let host: ResumptionHost | undefined;
export function configureRequestUserInputResumption(value: ResumptionHost): void {
  host = value;
}

/** Queue-row id of the n-th resume submission for one call: its durable receipt. */
export const promptAnswerReceiptId = (
  sessionId: string,
  toolUseId: string,
  attempt: number,
) =>
  `prompt-answer-${createHash("sha256")
    .update(JSON.stringify([sessionId, toolUseId, attempt]))
    .digest("hex")}`;

const promptKey = (sessionId: string, toolUseId: string) =>
  JSON.stringify([sessionId, toolUseId]);

/** Calls whose MCP connection dropped in this process: nobody waits for them. */
const abandonedPromptIds = new Set<string>();
export function notePromptAbandoned(sessionId: string, toolUseId: string): void {
  abandonedPromptIds.add(promptKey(sessionId, toolUseId));
}
export function isPromptAbandoned(sessionId: string, toolUseId: string): boolean {
  return abandonedPromptIds.has(promptKey(sessionId, toolUseId));
}

/** When the last turn of each session ended in this process. */
const turnEndedAt = new Map<string, number>();
/** Record that a turn of a session ended: a lead call it left without a result gets no waiter anymore. */
export function notePromptTurnEnded(sessionId: string): void {
  turnEndedAt.set(sessionId, Date.now());
}
/** Forget every recorded turn end, so one test's turns do not decide the next test's forms. */
export function resetPromptTurnEndsForTests(): void {
  turnEndedAt.clear();
}

export interface PromptForUserInputAnswer {
  sessionId: string;
  toolUseId: string;
  answers: Record<string, unknown>;
  cancelled: boolean;
  respondedBy: "desktop" | "mobile";
  respondedAt: number;
  /** A waiter listens on this call's own channel. */
  hasLiveWaiter: boolean;
  /** Writes the `request_user_input_response` row, with the attempt fields when queued. */
  writeResponseRow(fields?: { attempt: number; queuedPromptId: string }): Promise<unknown>;
}

export type PromptAnswerOutcome = { success: true } | { success: false; error: string };

const ALREADY_ANSWERED = "This form was already answered.";
const ON_ITS_WAY = "This answer is already on its way to the session.";
const OTHER_WAITING = "Another question in this session is waiting for your answer. Answer that one first.";
const rejected = (error: string): PromptAnswerOutcome => ({ success: false, error });
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Same-process serialization of submissions and cancels for one form. */
const claims = new Map<string, Promise<unknown>>();
export async function claimPromptAnswer<T>(key: string, action: () => Promise<T>): Promise<T> {
  // A caller that waited starts over: the action reads the facts itself.
  for (let pending = claims.get(key); pending; pending = claims.get(key)) {
    await pending.catch(() => {});
  }
  const run = action();
  claims.set(key, run);
  void run
    .finally(() => {
      if (claims.get(key) === run) claims.delete(key);
    })
    .catch(() => {});
  return run;
}

const recoveries = new Map<string, Promise<void>>();
function recoverOnce(key: string, action: () => Promise<void>): Promise<void> {
  const existing = recoveries.get(key);
  if (existing) return existing;
  const pending = action();
  recoveries.set(key, pending);
  void pending
    .finally(() => {
      if (recoveries.get(key) === pending) recoveries.delete(key);
    })
    .catch(() => {});
  return pending;
}

export type PromptAnswerStep =
  | "current"
  | "already-answered"
  | "heal"
  | "on-its-way"
  | "withdraw"
  | "cancel"
  | "other-waiting"
  | "not-configured"
  | "enqueue";

/** What an answer to a PromptForUserInput form does, from what is stored about it. */
export function planPromptAnswer(input: {
  facts: Pick<PromptAnswerFacts, "hasToolResult" | "hasResumeInput" | "toolUseCreatedAt" | "toolUseInSubagent">;
  /** Status of the receipt of the latest submission, if there is one. */
  receiptStatus?: QueuedPrompt["status"] | null;
  cancelled: boolean;
  abandoned: boolean;
  configured: boolean;
  processStart?: number;
  /** When the last turn of the session ended in this process. */
  turnEndedAt?: number;
  /** Another interactive prompt of the session is blocking a turn right now. */
  otherPromptWaiting?: boolean;
}): PromptAnswerStep {
  const { facts, receiptStatus } = input;
  if (facts.hasToolResult) return "already-answered";
  if (facts.hasResumeInput) return "heal";
  if (receiptStatus === "pending") return input.cancelled ? "withdraw" : "on-its-way";
  if (receiptStatus === "executing") return "on-its-way";
  // Neither abandoned, nor shown by an earlier process, nor left behind by an
  // ended turn: the call may still be starting, and its waiter picks the stored
  // answer up when it registers.
  if (
    !input.abandoned
    && !isToolUseFromEarlierProcess(facts, input.processStart)
    && !isToolUseFromEndedTurn(facts, input.turnEndedAt)
  ) return "current";
  if (input.cancelled) return "cancel";
  // The session counts as free while a form waits: a resume turn would start
  // at once and end that form's turn, leaving it open without a result.
  if (input.otherPromptWaiting) return "other-waiting";
  if (!input.configured) return "not-configured";
  return "enqueue";
}

export function buildResumeMessage(input: {
  toolUseId: string;
  title?: string;
  answers: Record<string, unknown>;
  respondedBy?: "desktop" | "mobile";
  respondedAt: number;
  late: boolean;
}): string {
  const call = input.title ? `${input.toolUseId} (${JSON.stringify(input.title)})` : input.toolUseId;
  return [
    RESUME_PROMPT_PREFIX,
    "",
    `Your PromptForUserInput call ${call} ended before the user's answer could reach it: the turn was stopped or interrupted, the app restarted, or the connection dropped while the form was open. The user has now answered it. Treat the JSON below as that call's result.`
      + (input.late
        ? " This answer arrives late: the session continued after the question was asked. Check whether it still applies before acting on it."
        : ""),
    "",
    JSON.stringify({ answers: input.answers, respondedBy: input.respondedBy, respondedAt: input.respondedAt }),
  ].join("\n");
}

/**
 * Tell sync and every window's queue list that a session's pending prompts
 * changed. Failures are only logged: the queue row itself already stands.
 */
async function announceQueueChange(sessionId: string): Promise<void> {
  try {
    await host?.publish(sessionId);
  } catch (error) {
    console.warn(`[PromptAnswer] Failed to publish the queue of ${sessionId}:`, error);
  }
  try {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("ai:queuedPromptsReceived", { sessionId });
    }
  } catch (error) {
    console.warn(`[PromptAnswer] Failed to notify windows of the queue of ${sessionId}:`, error);
  }
}

/**
 * Queue a prompt under a deterministic id. An existing row is the receipt of an
 * earlier call and is not queued again.
 */
export async function enqueueWithReceipt(input: {
  id: string;
  sessionId: string;
  workspacePath: string;
  prompt: string;
  documentContext: CreateQueuedPromptInput["documentContext"];
}): Promise<{ created: false } | { created: true; outcome: DriveOutcome }> {
  if (!host) throw new Error("Prompt answer resumption is not initialized");
  const deliveryHost = host;
  const queue = getQueuedPromptsStore();
  if (await queue.get(input.id)) return { created: false };
  await queue.create({
    id: input.id,
    sessionId: input.sessionId,
    prompt: input.prompt,
    documentContext: input.documentContext,
  });
  await announceQueueChange(input.sessionId);
  return { created: true, outcome: await deliveryHost.drive(input.sessionId, input.workspacePath) };
}

// Same broadcast as claudeCliUserPromptLog's, which imports the runtime barrel.
function broadcastMessageLogged(sessionId: string, workspacePath: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("ai:message-logged", { sessionId, workspacePath });
  }
}

/** Write a terminal tool_result for one call and let the windows reload. Errors propagate. */
export async function writePromptAnswerResult(input: {
  sessionId: string;
  workspacePath: string;
  toolUseId: string;
  answers: Record<string, unknown>;
  cancelled: boolean;
  respondedBy?: "desktop" | "mobile";
  respondedAt: number;
}): Promise<void> {
  await AgentMessagesRepository.create({
    sessionId: input.sessionId,
    source: "claude-code",
    direction: "output",
    hidden: false,
    createdAt: new Date(),
    content: buildInteractivePromptToolResultContent({
      toolUseId: input.toolUseId,
      result: {
        cancelled: input.cancelled,
        answers: input.cancelled ? {} : input.answers,
        respondedBy: input.respondedBy,
        respondedAt: input.respondedAt,
      },
      isError: input.cancelled,
    }),
  });
  broadcastMessageLogged(input.sessionId, input.workspacePath);
}

/**
 * Write the tool_result for a resumed call once its resume turn has started,
 * and only then: a turn that never stored its input leaves the form open.
 */
export function persistClaimedPromptAnswer(input: {
  sessionId: string;
  workspacePath: string;
  answeredPrompt: AnsweredPrompt;
}): Promise<void> {
  const { sessionId, answeredPrompt } = input;
  return recoverOnce(promptKey(sessionId, answeredPrompt.toolUseId), async () => {
    const facts = await loadPromptAnswerFacts(sessionId, answeredPrompt.toolUseId);
    if (facts.hasToolResult || !facts.hasResumeInput) return;
    await writePromptAnswerResult({
      sessionId,
      workspacePath: input.workspacePath,
      toolUseId: answeredPrompt.toolUseId,
      answers: answeredPrompt.answers,
      cancelled: false,
      respondedBy: answeredPrompt.respondedBy,
      respondedAt: Date.now(),
    });
  });
}

/** Observer for `message:logged` of one turn that may resume an answered call. */
export function watchAnsweredPromptInput(
  sessionId: string,
  documentContext: DocumentContext | undefined,
  workspacePath: string | undefined,
): (event: { direction?: string }) => void {
  const answeredPrompt = documentContext?.answeredPrompt;
  let seen = false;
  return (event) => {
    if (!answeredPrompt || seen || event.direction !== "input") return;
    seen = true;
    persistClaimedPromptAnswer({ sessionId, workspacePath: workspacePath ?? "", answeredPrompt }).catch((error) =>
      console.warn(`[PromptAnswer] Failed to close answered prompt ${answeredPrompt.toolUseId}:`, error),
    );
  };
}

function isSessionBusy(sessionId: string): boolean {
  const state = getSessionStateManager().getSessionState(sessionId);
  return state?.status === "running" || state?.isStreaming === true;
}

/**
 * Answer a PromptForUserInput form of a `claude-code` session. `null` means
 * the answer takes the usual path: stored and emitted to the waiter. An answer
 * to a call that is gone resumes the session through the queue instead.
 */
export async function answerPromptForUserInput(
  input: PromptForUserInputAnswer,
): Promise<PromptAnswerOutcome | null> {
  if (input.hasLiveWaiter || !input.toolUseId.startsWith("toolu_")) return null;
  const session = await AISessionsRepository.get(input.sessionId);
  if (session?.provider !== "claude-code") return null;
  return claimPromptAnswer(promptKey(input.sessionId, input.toolUseId), () =>
    applyPromptAnswer(input, session.workspacePath),
  );
}

async function applyPromptAnswer(
  input: PromptForUserInputAnswer,
  workspacePath: string | undefined,
): Promise<PromptAnswerOutcome | null> {
  const { sessionId, toolUseId } = input;
  const facts = await loadPromptAnswerFacts(sessionId, toolUseId);
  const attempts = facts.responses.filter((response) => response.attempt !== undefined).length;
  const queue = getQueuedPromptsStore();
  const receipt = attempts > 0 ? await queue.get(promptAnswerReceiptId(sessionId, toolUseId, attempts)) : null;
  const step = planPromptAnswer({
    facts,
    receiptStatus: receipt?.status,
    cancelled: input.cancelled,
    abandoned: isPromptAbandoned(sessionId, toolUseId),
    configured: !!host && !!workspacePath,
    turnEndedAt: turnEndedAt.get(sessionId),
    otherPromptWaiting: hasLiveInteractivePrompt(sessionId),
  });
  console.info(`[PromptAnswer] ${step}: sessionId=${sessionId}, toolUseId=${toolUseId}, attempts=${attempts}`);

  switch (step) {
    case "current":
      return null;
    case "already-answered":
      return rejected(ALREADY_ANSWERED);
    case "on-its-way":
      return rejected(ON_ITS_WAY);
    case "heal": {
      const latest = [...facts.responses].reverse().find((response) => response.queuedPromptId);
      const answeredPrompt = receipt?.documentContext?.answeredPrompt
        ?? (latest && { toolUseId, answers: latest.answers, respondedBy: latest.respondedBy });
      if (answeredPrompt) {
        await persistClaimedPromptAnswer({ sessionId, workspacePath: workspacePath ?? "", answeredPrompt }).catch(
          (error) => console.warn(`[PromptAnswer] Failed to heal answered prompt ${toolUseId}:`, error),
        );
      }
      return rejected(ALREADY_ANSWERED);
    }
    case "withdraw":
    case "cancel":
      if (step === "withdraw") {
        try {
          await queue.delete(receipt!.id);
        } catch {
          return rejected(ON_ITS_WAY);
        }
        await announceQueueChange(sessionId);
      }
      try {
        await writePromptAnswerResult({
          sessionId,
          workspacePath: workspacePath ?? "",
          toolUseId,
          answers: {},
          cancelled: true,
          respondedBy: input.respondedBy,
          respondedAt: input.respondedAt,
        });
      } catch (error) {
        return rejected(`The cancellation could not be saved: ${reasonOf(error)}`);
      }
      await input.writeResponseRow();
      return { success: true };
    case "other-waiting":
      return rejected(OTHER_WAITING);
    case "not-configured":
      return rejected("The answer could not be queued: resuming this session is not available.");
    case "enqueue": {
      const attempt = attempts + 1;
      const id = promptAnswerReceiptId(sessionId, toolUseId, attempt);
      // The response row counts the submission before its receipt exists, so
      // a crash in between skips a number instead of reusing one.
      await input.writeResponseRow({ attempt, queuedPromptId: id });
      let queued;
      try {
        queued = await enqueueWithReceipt({
          id,
          sessionId,
          workspacePath: workspacePath!,
          prompt: buildResumeMessage({
            toolUseId,
            title: facts.toolUseTitle,
            answers: input.answers,
            respondedBy: input.respondedBy,
            respondedAt: input.respondedAt,
            late: facts.hasLaterInput || isSessionBusy(sessionId),
          }),
          documentContext: {
            promptOrigin: "interactive-question",
            answeredPrompt: { toolUseId, answers: input.answers, respondedBy: input.respondedBy },
          },
        });
      } catch (error) {
        return rejected(`The answer could not be queued: ${reasonOf(error)}`);
      }
      if (!queued.created) return rejected(ON_ITS_WAY);
      if (queued.outcome.kind === "failed") return rejected(`The answer could not start: ${queued.outcome.reason}`);
      return { success: true };
    }
  }
}
