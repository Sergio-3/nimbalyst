import type { CreateQueuedPromptInput } from '../services/PGLiteQueuedPromptsStore';

/**
 * The prompt that resumes a session after `restart_nimbalyst` brought the app
 * back. The app sends it, not the user: without provenance the queued row is
 * stored unlabelled, and the transcript treats an unlabelled user message as
 * the user moving past every open question (NIM-7240).
 */
export function buildRestartContinuationPrompt(sessionId: string, now: number): CreateQueuedPromptInput {
  return {
    id: `restart-continuation-${sessionId}-${now}`,
    sessionId,
    prompt: 'Nimbalyst has restarted. Please continue with your work.',
    documentContext: { promptProvenance: { actor: 'system', origin: 'automation' } },
  };
}
