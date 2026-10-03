/**
 * Which virtual-list row draws which transcript message.
 *
 * The transcript renders one row per message, but a tool call does not draw in
 * its own row: it draws before the content of the next assistant row (or in
 * its own row when none follows). Thinking blocks are rows of their own. A
 * bundle that spans tool calls and thinking blocks therefore spans several
 * rows; this plan picks one host row per bundle and hides the others, and it
 * is the single place every row decision and every scroll target comes from.
 *
 * With grouping off the plan reproduces the ungrouped transcript exactly.
 */
import type { TranscriptViewMessage } from '../../../ai/server/transcript/TranscriptProjector';
import { isInteractiveWidgetTool } from '../../../ai/server/interactivePromptTools';
import { isToolLikeMessage } from './messageTypeHelpers';
import { groupToolCalls, type ToolCallBundleSummary } from './toolCallBundles';

export type RowRole =
  /** Draws nothing (display:none, height 0). */
  | 'hidden'
  /** Its own message is a bundle member or invisible, but it draws cards or a bundle. */
  | 'host'
  /** Draws its own message (and, for assistant rows, the cards before it). */
  | 'self';

export interface PlannedBundle {
  /** Stable across streaming and event rebuilds (see bundleIdFor). */
  id: string;
  /** Message indices, in order. */
  members: number[];
  hostRow: number;
  summary: ToolCallBundleSummary;
}

export interface TurnEnd {
  /** The assistant message whose time ends the turn shown above. */
  endIndex: number;
  /** No visible row follows yet: the turn may still be running. */
  open: boolean;
}

export interface TranscriptRowPlan {
  grouping: boolean;
  /** Per message: the row that draws it. */
  renderRow: number[];
  /** Per row. */
  role: RowRole[];
  /**
   * Per row: messages drawn before the row's own content, in order. A bundle
   * appears once, as its first member; draw it where `bundleOf` says so.
   */
  carried: number[][];
  bundles: PlannedBundle[];
  /** Per message: index into `bundles`, when the message is a member. */
  bundleOf: Array<number | undefined>;
  /** Per row: whether the row starts a new speaker group (shows the header). */
  isNewGroup: boolean[];
  /** Per row: set where a turn ends and "Finished in" belongs. */
  turnEnd: Array<TurnEnd | null>;
  /** The first visible row at or after `row` (else the last one before it). */
  visibleRowAtOrAfter(row: number): number;
  /** Where to scroll to show message `index`: the host of its bundle, else its drawing row. */
  targetRow(index: number): number;
}

export interface RowPlanOptions {
  /** Bundle the agent's working steps (`collapseTools && showToolCalls`). */
  grouping: boolean;
  showToolCalls: boolean;
  showThinking: boolean;
  /** Tool rows superseded by a later event with the same provider id. */
  superseded: ReadonlySet<number>;
}

/** The provider id of a bundle's first member, else its sequence — never `id`, which is reissued on rebuild. */
export function bundleIdFor(first: TranscriptViewMessage): string {
  return `bundle:${first.toolCall?.providerToolCallId ?? `seq-${first.sequence}`}`;
}

/** Tool rows draw in the next assistant row after their block, when there is one. */
function computeRenderRows(messages: readonly TranscriptViewMessage[]): number[] {
  const rows = new Array<number>(messages.length);
  let next = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isToolLikeMessage(messages[i])) {
      rows[i] = i;
      next = i;
      continue;
    }
    rows[i] = next < messages.length && messages[next].type === 'assistant_message' ? next : i;
  }
  return rows;
}

/**
 * Empty assistant/tool rows after a teammate notification are the lead's
 * internal processing turns; they render nothing, unless they carry a prompt
 * the user has to act on.
 */
function computeTeammateHidden(messages: readonly TranscriptViewMessage[]): Set<number> {
  const hidden = new Set<number>();
  let lastUserIsTeammate = false;
  let interactiveInBlock = false;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.type === 'user_message') {
      lastUserIsTeammate = !!message.metadata?.isTeammateMessage;
      interactiveInBlock = false;
      continue;
    }
    const toolLike = isToolLikeMessage(message);
    const interactive = toolLike && isInteractiveWidgetTool(message.toolCall?.toolName);
    if (toolLike || message.type === 'assistant_message') {
      const carriesInteractive = message.type === 'assistant_message' && interactiveInBlock;
      if (!interactive && !carriesInteractive && lastUserIsTeammate && !message.text?.trim()) hidden.add(i);
    }
    interactiveInBlock = toolLike ? interactiveInBlock || interactive : false;
  }
  return hidden;
}

function finishPlan(
  base: Omit<TranscriptRowPlan, 'visibleRowAtOrAfter' | 'targetRow'>,
): TranscriptRowPlan {
  const { role, renderRow, bundleOf, bundles, grouping } = base;
  const visibleRowAtOrAfter = (row: number): number => {
    for (let r = Math.max(0, row); r < role.length; r++) if (role[r] !== 'hidden') return r;
    for (let r = Math.min(row, role.length) - 1; r >= 0; r--) if (role[r] !== 'hidden') return r;
    return row;
  };
  const targetRow = (index: number): number => {
    const bundle = bundleOf[index];
    if (grouping && bundle !== undefined) return bundles[bundle].hostRow;
    return visibleRowAtOrAfter(renderRow[index] ?? index);
  };
  return { ...base, visibleRowAtOrAfter, targetRow };
}

/** Speaker of a visible non-tool row: hosts draw agent work. */
function speakerOf(messages: readonly TranscriptViewMessage[], role: RowRole[], row: number): string {
  return role[row] === 'host' ? 'assistant_message' : messages[row].type;
}

function lastAssistantIndex(messages: readonly TranscriptViewMessage[], from: number, to: number): number {
  for (let i = to; i >= from; i--) if (messages[i].type === 'assistant_message') return i;
  return from;
}

/** The ungrouped transcript, row for row. */
function planUngrouped(messages: readonly TranscriptViewMessage[], options: RowPlanOptions): TranscriptRowPlan {
  const n = messages.length;
  const renderRow = computeRenderRows(messages);
  const teammateHidden = computeTeammateHidden(messages);
  const role: RowRole[] = new Array(n);
  const carried: number[][] = Array.from({ length: n }, () => []);
  const isNewGroup: boolean[] = new Array(n);
  const turnEnd: Array<TurnEnd | null> = new Array(n).fill(null);
  const shown = (i: number) => options.showToolCalls || isInteractiveWidgetTool(messages[i].toolCall?.toolName);

  for (let i = 0; i < n; i++) {
    const message = messages[i];
    let prev = i - 1;
    while (prev >= 0 && isToolLikeMessage(messages[prev])) prev--;
    isNewGroup[i] = prev < 0 || messages[prev].type !== message.type;

    if (options.superseded.has(i) || teammateHidden.has(i)) {
      role[i] = 'hidden';
    } else if (isToolLikeMessage(message)) {
      const orphan = renderRow[i] === i && !!message.toolCall && shown(i);
      role[i] = orphan ? 'self' : 'hidden';
      if (orphan) carried[i] = [i];
    } else if (message.type === 'system_message'
      && message.systemMessage?.systemType === 'permission_denied'
      && !message.systemMessage.isAttachmentStagingDenied
      && message.systemMessage.deniedReasonType === 'classifier') {
      role[i] = 'hidden';
    } else {
      role[i] = 'self';
      if (message.type === 'assistant_message') {
        for (let j = i - 1; j >= 0 && isToolLikeMessage(messages[j]); j--) if (shown(j)) carried[i].unshift(j);
      }
    }

    if (role[i] === 'self' && !isToolLikeMessage(message) && message.type !== 'user_message') {
      let next = i + 1;
      while (next < n && isToolLikeMessage(messages[next])) next++;
      if (next >= n || messages[next].type !== 'assistant_message') turnEnd[i] = { endIndex: i, open: next >= n };
    }
  }

  return finishPlan({
    grouping: false, renderRow, role, carried, bundles: [], bundleOf: new Array(n).fill(undefined), isNewGroup, turnEnd,
  });
}

export function planTranscriptRows(
  messages: readonly TranscriptViewMessage[],
  options: RowPlanOptions,
): TranscriptRowPlan {
  if (!options.grouping) return planUngrouped(messages, options);

  const n = messages.length;
  const renderRow = computeRenderRows(messages);
  const teammateHidden = computeTeammateHidden(messages);
  const invisible = new Set<number>([...options.superseded, ...teammateHidden]);
  const roleOpts = { showThinking: options.showThinking };

  const bundles: PlannedBundle[] = [];
  const bundleOf: Array<number | undefined> = new Array(n).fill(undefined);
  const carried: number[][] = Array.from({ length: n }, () => []);
  const separator: boolean[] = new Array(n).fill(false);

  for (const group of groupToolCalls(messages, { ...roleOpts, exclude: invisible })) {
    if (group.kind === 'item') {
      separator[group.index] = true;
      if (isToolLikeMessage(messages[group.index])) carried[renderRow[group.index]].push(group.index);
      continue;
    }
    const first = group.indices[0];
    const hostRow = renderRow[first];
    for (const index of group.indices) bundleOf[index] = bundles.length;
    bundles.push({ id: bundleIdFor(messages[first]), members: group.indices, hostRow, summary: group.summary });
    carried[hostRow].push(first);
  }
  for (const list of carried) list.sort((a, b) => a - b);

  const role: RowRole[] = new Array(n);
  for (let i = 0; i < n; i++) {
    if (isToolLikeMessage(messages[i])) {
      role[i] = renderRow[i] === i && carried[i].length > 0 ? 'self' : 'hidden';
    } else if (separator[i]) {
      role[i] = 'self';
    } else {
      role[i] = carried[i].length > 0 ? 'host' : 'hidden';
    }
  }

  // Header and turn end follow the speakers of the rows actually shown.
  const isNewGroup: boolean[] = new Array(n).fill(false);
  const turnEnd: Array<TurnEnd | null> = new Array(n).fill(null);
  const speakerRows: number[] = [];
  let prevSpeaker: string | null = null;
  for (let i = 0; i < n; i++) {
    if (role[i] === 'hidden') continue;
    const speaker = speakerOf(messages, role, i);
    isNewGroup[i] = prevSpeaker === null || prevSpeaker !== speaker;
    if (isToolLikeMessage(messages[i])) continue;
    prevSpeaker = speaker;
    speakerRows.push(i);
  }
  for (let k = 0; k < speakerRows.length; k++) {
    const row = speakerRows[k];
    const next = speakerRows[k + 1];
    if (speakerOf(messages, role, row) === 'user_message') continue;
    if (next !== undefined && speakerOf(messages, role, next) === 'assistant_message') continue;
    const end = next === undefined ? n - 1 : next - 1;
    turnEnd[row] = { endIndex: lastAssistantIndex(messages, row, end), open: next === undefined };
  }

  return finishPlan({ grouping: true, renderRow, role, carried, bundles, bundleOf, isNewGroup, turnEnd });
}

/**
 * The user message that starts the turn shown before `before`: the nearest
 * one that is not folded into a bundle (an automated message — child report,
 * system send, resume after an answer — does not start a turn the user sees).
 * -1 when there is none.
 */
export function turnStartIndex(
  messages: readonly TranscriptViewMessage[],
  plan: Pick<TranscriptRowPlan, 'bundleOf'>,
  before: number,
): number {
  for (let i = Math.min(before, messages.length) - 1; i >= 0; i--) {
    if (messages[i].type === 'user_message' && plan.bundleOf[i] === undefined) return i;
  }
  return -1;
}
