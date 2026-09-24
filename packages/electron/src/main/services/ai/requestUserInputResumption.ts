import type { AgentMessage } from "@nimbalyst/runtime/ai/server/types";
import { AgentMessagesRepository } from "@nimbalyst/runtime/storage/repositories/AgentMessagesRepository";
import { toMillis } from "../../utils/timestampUtils";

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
