import type { InteractiveWidgetHost } from '@nimbalyst/runtime/ui/AgentTranscript/components/CustomToolWidgets/InteractiveWidgetHost';

/**
 * `messages:respond-to-prompt` reports a rejected answer as
 * `{ success: false, error }` instead of throwing. Turn that into a throw so the
 * widget keeps the form open and shows the reason. Hosts that return nothing
 * count as success.
 */
export function assertPromptResponseAccepted(result: unknown): void {
  if (result && typeof result === 'object' && (result as { success?: unknown }).success === false) {
    const error = (result as { error?: unknown }).error;
    throw new Error(typeof error === 'string' && error ? error : 'The answer was not accepted.');
  }
}

/**
 * The PromptForUserInput callbacks of the session transcript's widget host.
 * Both send the answer over `messages:respond-to-prompt` and throw when it is
 * rejected, so the widget stays open; telemetry and the pending-prompt refresh
 * run only for an accepted answer.
 */
export function createRequestUserInputHostActions(deps: {
  sessionId: string;
  invoke: (channel: string, payload: unknown) => Promise<unknown>;
  capture?: (event: string, properties?: Record<string, unknown>) => void;
  refreshPendingPrompts: (sessionId: string, settledPromptId?: string) => void;
}): Pick<InteractiveWidgetHost, 'requestUserInputSubmit' | 'requestUserInputCancel'> {
  const { sessionId, invoke, capture, refreshPendingPrompts } = deps;
  return {
    requestUserInputSubmit: async (promptId, answers) => {
      assertPromptResponseAccepted(await invoke('messages:respond-to-prompt', {
        sessionId,
        promptId,
        promptType: 'request_user_input_request' as const,
        response: { answers, cancelled: false },
        respondedBy: 'desktop' as const,
      }));
      // Counts of each field type, no PII.
      const fieldTypeCounts: Record<string, number> = {};
      for (const a of Object.values(answers)) {
        fieldTypeCounts[a.type] = (fieldTypeCounts[a.type] ?? 0) + 1;
      }
      capture?.('request_user_input_answered', {
        numFields: Object.keys(answers).length,
        fieldTypeCounts,
      });
      refreshPendingPrompts(sessionId, promptId);
    },
    requestUserInputCancel: async (promptId) => {
      assertPromptResponseAccepted(await invoke('messages:respond-to-prompt', {
        sessionId,
        promptId,
        promptType: 'request_user_input_request' as const,
        response: { answers: {}, cancelled: true },
        respondedBy: 'desktop' as const,
      }));
      capture?.('request_user_input_cancelled');
      refreshPendingPrompts(sessionId, promptId);
    },
  };
}
