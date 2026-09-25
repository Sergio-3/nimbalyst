// IPC channels a PromptForUserInput waiter listens on. Kept apart from
// interactiveToolHandlers so the answer handler can name them without loading
// the tool handlers.

export function getRequestUserInputResponseChannel(
  sessionId: string,
  promptId: string,
): string {
  return `request-user-input-response:${sessionId || "unknown"}:${promptId}`;
}

export function getRequestUserInputFallbackResponseChannel(
  sessionId: string,
): string {
  return `request-user-input-response:${sessionId || "unknown"}:__fallback__`;
}
