/**
 * The status a sub-agent row shows: Running, Idle, Done, Errored, Stopped,
 * or Denied.
 *
 * Sources in order of trust: the live teammate/agent status from session
 * metadata, then the spawn acknowledgement, then the tool result. "Stopped"
 * needs positive evidence that nothing is still working on the session —
 * a lead turn handed over to the background drain keeps its sub-agents
 * running while the session reads idle.
 */
import type { TranscriptViewMessage } from '../../../ai/server/transcript/TranscriptProjector';
import { isBackgroundedToolAck } from '../../../ai/server/interactivePromptTools';

export type SubagentStatus = 'running' | 'idle' | 'done' | 'errored' | 'stopped' | 'denied';

export type TeammateStatus = 'running' | 'completed' | 'errored' | 'idle';

export interface SubagentStatusContext {
  currentTeammates?: ReadonlyArray<{ agentId: string; status: TeammateStatus }>;
  /**
   * Whether anything is still working on the session: the lead turn, the
   * background drain, or a running task. Undefined when the host does not
   * report it; then no row is called Stopped and a launch acknowledgement
   * reads as Done.
   */
  sessionActive?: boolean;
}

const FROM_TEAMMATE: Record<TeammateStatus, SubagentStatus> = {
  running: 'running',
  idle: 'idle',
  completed: 'done',
  errored: 'errored',
};

function agentIdOf(message: TranscriptViewMessage): string | null {
  if (message.subagentId) return message.subagentId;
  const result = message.toolCall?.result;
  const match = typeof result === 'string' ? result.match(/agent_id:\s*(\S+)/) : null;
  return match ? match[1].replace(/[.,]$/, '') : null;
}

export function subagentStatus(message: TranscriptViewMessage, context: SubagentStatusContext): SubagentStatus | null {
  const tool = message.toolCall;
  if (!tool) return null;

  const agentId = agentIdOf(message);
  const teammate = agentId ? context.currentTeammates?.find(t => t.agentId === agentId)?.status : undefined;
  if (teammate) return FROM_TEAMMATE[teammate];

  if (tool.result) {
    if (message.isError) {
      // A spawn intercepted by the host reports an error result naming the agent it started.
      if (typeof tool.result === 'string' && /agent_id:\s*\S+/.test(tool.result)) return 'running';
      // Refused before it started (user rejection, permission classifier): nothing ran.
      const started = (message.subagent?.childEvents?.length ?? 0) > 0 || tool.progress.length > 0;
      return started ? 'errored' : 'denied';
    }
    // A background agent's result is its launch acknowledgement; it finishes later.
    const launchAck = message.subagent?.isBackground === true || isBackgroundedToolAck(tool.result);
    if (launchAck && context.sessionActive !== false) return context.sessionActive ? 'running' : 'done';
    return 'done';
  }

  if (context.sessionActive === false) return 'stopped';
  if (context.sessionActive || tool.progress.length > 0) return 'running';
  return null;
}
