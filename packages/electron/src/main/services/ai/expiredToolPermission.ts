import { reservePromptAnswer } from './PromptAnswerReservation';
import { persistInteractivePromptToolResult } from '../../mcp/tools/interactivePromptTranscript';

/**
 * Close a permission request that was dropped without an answer -- the turn was
 * aborted, the query ended, or the poll timed out (#1183). The provider only
 * reports this after the waiting promise was rejected, so a live prompt is never
 * closed here.
 *
 * Without a terminal row the widget stays clickable, keeps the pending banner
 * and the waiting indicator, and a late click persists an "allow" that nothing
 * acts on. Reserving first makes the race with a click explicit: whoever
 * reserves first wins, and the reservation refuses every later answer, also
 * across a restart.
 */
export async function closeExpiredToolPermission(sessionId: string, requestId: string): Promise<boolean> {
  if (!reservePromptAnswer(sessionId, 'permission', requestId, { decision: 'expired' })) return false;
  await persistInteractivePromptToolResult({
    sessionId,
    toolUseId: requestId,
    result: { decision: 'deny', scope: 'once', cancelled: true, reason: 'expired', respondedAt: Date.now() },
    isError: true,
  });
  return true;
}
