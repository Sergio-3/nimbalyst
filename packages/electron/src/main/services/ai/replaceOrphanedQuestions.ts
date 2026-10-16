/**
 * Close the forms a newer question replaces.
 *
 * A form whose MCP call dropped stays answerable on purpose (see
 * interactivePromptAbandonment): the user has decided nothing, and a later
 * answer resumes the session with it. But the agent was told the call failed
 * ("Connection closed"), and when it asks again in the same session, the old
 * form is dead: nothing takes its answer. Left open, it invites the user to
 * fill in the wrong form, keeps "Jump to question" on it, and its submit is
 * refused because the newer form is waiting.
 *
 * So whenever a question opens, every orphaned PromptForUserInput of the
 * session -- unanswered, no live waiter, its call gone -- is closed with
 * `reason: 'replaced'`. A form whose call may still be starting (a sibling of
 * the same turn) or that has a stored answer is left alone; the criterion is
 * the answer path's own (`closeOrphanedPromptForUserInput`). AskUserQuestion is
 * not touched here, and Codex runs its own question lifecycle.
 */

import { BrowserWindow, ipcMain } from 'electron';
import { partitionUnansweredQuestions } from '@nimbalyst/runtime/ai/server/interactivePromptTools';
import { getCodexToolLookupAliases } from '@nimbalyst/runtime/ai/server/toolLookupIds';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { loadViewMessages } from '../../utils/transcriptHelpers';
import { getRequestUserInputResponseChannel } from '../../mcp/tools/interactivePromptFallback';
import { persistInteractivePromptTerminalResult } from './askUserQuestionFallbackResolution';
import { closeOrphanedPromptForUserInput } from './requestUserInputResumption';
import { logger } from '../../utils/logger';

/** Fire-and-forget: never throws, returns the ids it closed. */
export async function replaceOrphanedQuestions(sessionId: string, newPromptId: string): Promise<string[]> {
  const replaced: string[] = [];
  try {
    const session = await AISessionsRepository.get(sessionId);
    if (!session?.provider || session.provider === 'openai-codex') return replaced;
    const view = await loadViewMessages(sessionId, session.provider);
    if (!view.success) throw new Error(view.error);

    for (const question of partitionUnansweredQuestions(view.messages).open) {
      if (question.id === newPromptId || question.toolName === 'AskUserQuestion') continue;
      const hasWaiter = getCodexToolLookupAliases(question.id).some(
        (id) => ipcMain.listenerCount(getRequestUserInputResponseChannel(sessionId, id)) > 0,
      );
      if (hasWaiter) continue;
      const closed = await closeOrphanedPromptForUserInput(sessionId, question.id, () =>
        persistInteractivePromptTerminalResult({
          sessionId,
          questionId: question.id,
          answers: {},
          cancelled: true,
          reason: 'replaced',
        }),
      );
      if (closed) replaced.push(question.id);
    }

    if (replaced.length > 0) {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send('ai:message-logged', { sessionId, direction: 'output', workspacePath: session.workspacePath });
        }
      }
    }
  } catch (error) {
    // Cleanup only: the new question stands either way.
    logger.main.error(`[replaceOrphanedQuestions] failed for ${sessionId}:`, error);
  }
  logger.main.info(`[replaceOrphanedQuestions] session=${sessionId} new=${newPromptId} replaced=[${replaced.join(',')}]`);
  return replaced;
}
