import { isAnswerForAnotherToolUse } from "./interactivePromptFallback";

type InteractiveResponseMessage = {
  content: string;
  createdAt?: Date | string;
};

export function findFreshInteractiveResponse(
  messages: InteractiveResponseMessage[],
  options: {
    expectedType: string;
    idFields: readonly string[];
    acceptedIds: ReadonlySet<string>;
    notBefore: number;
    // NIM-1981: when set, accept the freshest row of expectedType regardless of
    // its ids. Used only when a single interactive prompt is pending for the
    // session, where the persisted response is unambiguously ours even though the
    // Codex tool-call ids don't line up.
    matchAnyId?: boolean;
    // With matchAnyId, a row addressed to a different Claude tool-use id than
    // this waiter's is still skipped (see isAnswerForAnotherToolUse).
    waiterPromptId?: string;
  },
): Record<string, unknown> | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const createdAt = message.createdAt instanceof Date
      ? message.createdAt.getTime()
      : typeof message.createdAt === "string"
        ? Date.parse(message.createdAt)
        : Number.NaN;
    if (!Number.isFinite(createdAt) || createdAt < options.notBefore) continue;

    try {
      const content = JSON.parse(message.content) as Record<string, unknown>;
      if (content.type !== options.expectedType) continue;
      const rowIds = options.idFields
        .map((field) => content[field])
        .filter((value): value is string => typeof value === "string");
      if (rowIds.some((id) => options.acceptedIds.has(id))) return content;
      if (
        options.matchAnyId === true
        && !(options.waiterPromptId && isAnswerForAnotherToolUse(options.waiterPromptId, rowIds))
      ) {
        return content;
      }
    } catch {
      // Non-JSON transcript rows are unrelated to interactive responses.
    }
  }
  return null;
}
