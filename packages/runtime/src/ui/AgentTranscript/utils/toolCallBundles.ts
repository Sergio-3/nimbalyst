/**
 * Folds the agent's working steps in a transcript into collapsible bundles
 * ("5 tool calls · 3 commands, 2 file edits · 1 thinking block"), so a turn
 * that runs a dozen commands between two sentences reads as one line instead
 * of a dozen cards.
 *
 * What stays visible is the lead agent's own text and whatever is meant for
 * the user or waits on them; every other step is a bundle member. Pure: takes
 * a message list, returns render groups. The transcript view decides where
 * each group lands (see transcriptRowPlan).
 */
import type { TranscriptViewMessage } from '../../../ai/server/transcript/TranscriptProjector';
import { isAutomatedPrompt, isInteractiveWidgetTool, stripMcpPrefix } from '../../../ai/server/interactivePromptTools';
import { isToolLikeMessage } from './messageTypeHelpers';

export type ToolCallCategory = 'commands' | 'fileEdits' | 'reads' | 'searches' | 'other' | 'denied';

export interface ToolCallBundleSummary {
  /** Tool calls, denied ones included. */
  total: number;
  counts: Record<ToolCallCategory, number>;
  thinking: number;
  /** Messages sent by automation or other sessions. */
  messages: number;
  notices: number;
  /** Members still waiting for a result. */
  running: number;
  /** Members that finished with an error. A denial is counted, not failed. */
  failed: number;
}

export type ToolCallGroup =
  /** Rendered exactly as without bundling: a separator such as agent text, an interactive prompt or a sub-agent. */
  | { kind: 'item'; index: number }
  /** A run of bundle members. `indices` point into the input list. */
  | { kind: 'bundle'; indices: number[]; summary: ToolCallBundleSummary };

export type BundleMemberKind = 'tool' | 'thinking' | 'message' | 'denied' | 'notice';

export type BundleRole =
  | { kind: 'member'; member: BundleMemberKind }
  /** Stays visible and ends a run. */
  | { kind: 'separator' }
  /** Renders nothing; neither ends a run nor counts. */
  | { kind: 'invisible' };

export interface BundleRoleOptions {
  /** Whether thinking blocks are shown at all (default true). */
  showThinking?: boolean;
}

export interface GroupToolCallsOptions extends BundleRoleOptions {
  /**
   * Whether non-tool separators end a bundle and appear as items (default
   * true). Pass false where they are not rendered at all, so an invisible
   * message never leaves two bundles touching.
   */
  textSeparates?: boolean;
  /** Indices to drop entirely (e.g. superseded duplicates): they neither count nor split. */
  exclude?: ReadonlySet<number>;
}

const MIN_BUNDLE_SIZE = 1;

const COMMAND_TOOLS = new Set(['bash', 'bashoutput', 'command_execution', 'shell', 'exec_command', 'powershell']);
const FILE_EDIT_TOOLS = new Set([
  'edit', 'write', 'multiedit', 'multi-edit', 'multi_edit', 'notebookedit',
  'applypatch', 'apply_patch', 'file_change',
]);
const READ_TOOLS = new Set(['read', 'read_file', 'notebookread']);
const SEARCH_TOOLS = new Set(['grep', 'glob', 'websearch', 'web_search']);

export function categorizeToolCall(toolName: string | null | undefined): ToolCallCategory {
  if (!toolName) return 'other';
  const name = stripMcpPrefix(toolName).toLowerCase();
  if (COMMAND_TOOLS.has(name)) return 'commands';
  if (FILE_EDIT_TOOLS.has(name)) return 'fileEdits';
  if (READ_TOOLS.has(name)) return 'reads';
  if (SEARCH_TOOLS.has(name)) return 'searches';
  return 'other';
}

/**
 * Tools outside the interactive-prompt list whose card the user still has to
 * see: a feedback draft waiting for the author's review before it is sent, and
 * content the agent shows the user (charts, images).
 */
const NEVER_BUNDLED_TOOLS = new Set(['RequestFeedback', 'display_to_user']);

/** A super-loop progress update asks the user for an answer only when blocked. */
function isBlockedSuperLoopUpdate(bareName: string, message: TranscriptViewMessage): boolean {
  return bareName === 'super_loop_progress_update'
    && (message.toolCall?.arguments as { status?: unknown } | undefined)?.status === 'blocked';
}

const SIBLING_CANCELLED = /^\s*(<tool_use_error>)?\s*Sibling tool call errored\s*(<\/tool_use_error>)?\s*$/;

/**
 * A Task call cancelled as the sibling of a parallel spawn: it was never
 * started and renders nothing.
 */
export function isCancelledSiblingTask(message: TranscriptViewMessage): boolean {
  if (message.toolCall?.toolName !== 'Task' || !message.isError) return false;
  const result = message.toolCall.result;
  return SIBLING_CANCELLED.test(typeof result === 'string' ? result : '');
}

/**
 * A tool call may join a bundle unless the user has to act on it (prompts,
 * permissions, feedback drafts, blocked super-loops), it shows the user
 * something meant for them, or it is a sub-agent, whose row carries its own
 * live status and child list.
 */
export function isBundleableToolCall(message: TranscriptViewMessage): boolean {
  if (!isToolLikeMessage(message) || !message.toolCall) return false;
  if (message.type !== 'tool_call') return false;
  const name = message.toolCall.toolName;
  if (isInteractiveWidgetTool(name)) return false;
  const bare = stripMcpPrefix(name ?? '');
  if (bare === 'Task' || bare === 'Agent') return false;
  if (NEVER_BUNDLED_TOOLS.has(bare) || isBlockedSuperLoopUpdate(bare, message)) return false;
  return true;
}

const MEMBER = (member: BundleMemberKind): BundleRole => ({ kind: 'member', member });
const SEPARATOR: BundleRole = { kind: 'separator' };
const INVISIBLE: BundleRole = { kind: 'invisible' };

/** Whether the transcript renders this system row as a reminder/status card. */
function isNoticeRow(message: TranscriptViewMessage): boolean {
  return (message.type === 'system_message' && message.systemMessage?.systemType !== 'error')
    || message.metadata?.promptType === 'system_reminder';
}

/** Where a top-level message stands in a bundle (see the table in the tests). */
export function bundleRole(message: TranscriptViewMessage, options: BundleRoleOptions = {}): BundleRole {
  if (isToolLikeMessage(message)) {
    if (isCancelledSiblingTask(message)) return INVISIBLE;
    return isBundleableToolCall(message) ? MEMBER('tool') : SEPARATOR;
  }

  if (message.type === 'assistant_message') {
    if (message.text?.trim() || message.isError || message.isAuthError || message.isCodexAuthRequired) return SEPARATOR;
    const showThinking = options.showThinking ?? true;
    return showThinking && message.thinking?.trim() ? MEMBER('thinking') : INVISIBLE;
  }

  if (message.type === 'system_message' && message.systemMessage?.systemType === 'permission_denied') {
    if (message.systemMessage.isAttachmentStagingDenied) return SEPARATOR;
    if (message.systemMessage.deniedReasonType === 'classifier') return INVISIBLE;
    return MEMBER('denied');
  }

  if (isNoticeRow(message)) {
    return message.text?.trim() ? MEMBER('notice') : INVISIBLE;
  }

  if (message.type === 'user_message') {
    return isAutomatedPrompt(message) || message.metadata?.isTeammateMessage ? MEMBER('message') : SEPARATOR;
  }

  return SEPARATOR;
}

function isFailed(message: TranscriptViewMessage): boolean {
  return message.isError === true
    || message.toolCall?.isError === true
    || message.toolCall?.status === 'error';
}

function isRunning(message: TranscriptViewMessage): boolean {
  const tool = message.toolCall;
  return !!tool && tool.status === 'running' && (tool.result === undefined || tool.result === null);
}

function emptySummary(): ToolCallBundleSummary {
  return {
    total: 0,
    counts: { commands: 0, fileEdits: 0, reads: 0, searches: 0, other: 0, denied: 0 },
    thinking: 0,
    messages: 0,
    notices: 0,
    running: 0,
    failed: 0,
  };
}

function addMember(summary: ToolCallBundleSummary, message: TranscriptViewMessage, member: BundleMemberKind): void {
  switch (member) {
    case 'tool':
      summary.total++;
      summary.counts[categorizeToolCall(message.toolCall?.toolName)]++;
      if (isFailed(message)) summary.failed++;
      else if (isRunning(message)) summary.running++;
      return;
    case 'denied':
      summary.total++;
      summary.counts.denied++;
      return;
    case 'thinking':
      summary.thinking++;
      return;
    case 'message':
      summary.messages++;
      return;
    case 'notice':
      summary.notices++;
  }
}

function summarize(
  messages: readonly TranscriptViewMessage[],
  indices: number[],
  options: BundleRoleOptions,
): ToolCallBundleSummary {
  const summary = emptySummary();
  for (const index of indices) {
    const role = bundleRole(messages[index], options);
    if (role.kind === 'member') addMember(summary, messages[index], role.member);
  }
  return summary;
}

/** Counts every member of a list regardless of runs (a sub-agent's child list). */
export function summarizeBundleMembers(
  messages: readonly TranscriptViewMessage[],
  options: BundleRoleOptions = {},
): ToolCallBundleSummary {
  return summarize(messages, messages.map((_, index) => index), options);
}

export function groupToolCalls(
  messages: readonly TranscriptViewMessage[],
  options: GroupToolCallsOptions = {},
): ToolCallGroup[] {
  const textSeparates = options.textSeparates ?? true;
  const exclude = options.exclude;
  const groups: ToolCallGroup[] = [];
  let run: number[] = [];

  const flush = () => {
    if (run.length >= MIN_BUNDLE_SIZE) {
      groups.push({ kind: 'bundle', indices: run, summary: summarize(messages, run, options) });
    } else {
      for (const index of run) groups.push({ kind: 'item', index });
    }
    run = [];
  };

  for (let index = 0; index < messages.length; index++) {
    if (exclude?.has(index)) continue;
    const message = messages[index];
    const role = bundleRole(message, options);
    if (role.kind === 'invisible') continue;
    if (role.kind === 'member') {
      run.push(index);
      continue;
    }
    if (!isToolLikeMessage(message) && !textSeparates) continue;
    flush();
    groups.push({ kind: 'item', index });
  }
  flush();
  return groups;
}

const CATEGORY_LABELS: Array<[ToolCallCategory, string, string]> = [
  ['commands', 'command', 'commands'],
  ['fileEdits', 'file edit', 'file edits'],
  ['reads', 'read', 'reads'],
  ['searches', 'search', 'searches'],
  ['other', 'other', 'other'],
  ['denied', 'denied', 'denied'],
];

const plural = (count: number, singular: string, pluralForm = `${singular}s`) =>
  `${count} ${count === 1 ? singular : pluralForm}`;

export function formatToolCallBundleSummary(summary: ToolCallBundleSummary): string {
  const sections: string[] = [];
  if (summary.total > 0) {
    const kinds = CATEGORY_LABELS
      .filter(([key]) => summary.counts[key] > 0)
      .map(([key, singular, pluralForm]) => plural(summary.counts[key], singular, pluralForm));
    sections.push(`${plural(summary.total, 'tool call')} · ${kinds.join(', ')}`);
  }
  const steps = [
    summary.thinking > 0 ? plural(summary.thinking, 'thinking block') : null,
    summary.messages > 0 ? plural(summary.messages, 'message') : null,
    summary.notices > 0 ? plural(summary.notices, 'notice') : null,
  ].filter((part): part is string => part !== null);
  if (steps.length > 0) sections.push(steps.join(', '));
  return sections.join(' · ');
}
