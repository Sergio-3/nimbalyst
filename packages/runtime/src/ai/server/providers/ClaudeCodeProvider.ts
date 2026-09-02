/**
 * Claude Code provider using claude-agent-sdk with MCP support
 * Uses bundled SDK from package dependencies
 */

import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

// Query interface not properly exported by SDK, so we define it inline
interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<void>;
  setPermissionMode(mode: string): Promise<void>;
  setModel(model?: string): Promise<void>;
  streamInput(stream: AsyncIterable<any>): Promise<void>;
  mcpServerStatus(): Promise<McpServerStatusInfo[]>;
  reconnectMcpServer(serverName: string): Promise<void>;
  /** Close the query and terminate the underlying CLI subprocess. */
  close(): void;
}

/** MCP server status as reported by the SDK */
export interface McpServerStatusInfo {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  error?: string;
  /** project | user | local | claudeai | managed */
  scope?: string;
  serverInfo?: { name: string; version: string };
  tools?: { name: string; description?: string }[];
}
import { parse as parseShellCommand } from 'shell-quote';

import { BaseAgentProvider } from './BaseAgentProvider';
import {
  AIProviderType,
  DocumentContext,
  ProviderConfig,
  ProviderCapabilities,
  StreamChunk,
  AIModel,
  PermissionRequestContent,
  PermissionResponseContent,
  CLAUDE_CODE_VARIANTS,
  ModelIdentifier,
  resolveClaudeCodeModelVariant,
} from '../types';
import {
  CLAUDE_CODE_VARIANT_VERSIONS,
  CLAUDE_CODE_MODEL_LABELS,
  CLAUDE_CODE_VARIANTS_WITH_1M,
  CLAUDE_CODE_SAFE_FALLBACK_MODEL,
  baseContextWindowForVariant,
} from '../../modelConstants';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { InterruptTurnResult, TurnHandoverCandidate } from '../AIProvider';
import { isBedrockToolSearchError } from '../utils/errorDetection';
import { AgentMessagesRepository } from '../../../storage/repositories/AgentMessagesRepository';
import { TranscriptMigrationRepository } from '../../../storage/repositories/TranscriptMigrationRepository';
import { TeammateManager, buildInjectedUserMessage, type TeammateToLeadMessage } from './TeammateManager';
import path from 'path';
import { buildClaudeCodeSystemPrompt, buildMetaAgentSystemPrompt, type MetaAgentWorkflowPreset } from '../../prompt';

import { SessionManager } from '../SessionManager';
import { parseBashForFileOps, hasShellChainingOperators, splitOnShellOperators } from '../permissions/BashCommandAnalyzer';

import { ToolPermissionService } from '../permissions/ToolPermissionService';
import { AgentToolHooks } from '../permissions/AgentToolHooks';
import { McpConfigService } from '../services/McpConfigService';
import { getMcpConfigService, isInternalMcpServerEnabled, areTrackerToolsEnabled, resolveTrackersWorkspacePath } from '../services/mcpServerConfig';
import {
  applyToolResultToToolCall,
  isSearchableAssistantChunk,
  isTransientClaudeCodeChunk,
  slimClaudeCodeChunkForStorage,
} from './claudeCode/toolChunkUtils';
import { capClaudeCodeChunkForStorage } from '../../../storage/toolOutputBudget';
import {
  INTERNAL_MCP_TOOLS,
  NIMBALYST_HANDLED_TOOLS,
  SDK_NATIVE_TOOLS,
  TEAM_TOOLS,
} from './claudeCode/toolPolicy';
import {
  buildBedrockToolErrorGuidance,
  detectResultChunkErrorFlags,
  extractResultChunkErrorMessage,
} from './claudeCode/resultChunkUtils';

import {
  handleAskUserQuestionTool,
  pollForAskUserQuestionResponse,
  type PendingAskUserQuestionEntry,
} from './claudeCode/askUserQuestion';

import {
  resolveImmediateToolDecision as resolveImmediateToolDecisionHelper,
} from './claudeCode/immediateToolDecision';
import {
  authorizeCompoundBashCommand,
  createCompoundPartPreApprovalCheck,
  handleToolPermissionFallback as handleToolPermissionFallbackHelper,
  handleToolPermissionWithService as handleToolPermissionWithServiceHelper,
  type ToolPermissionOptions,
} from './claudeCode/toolAuthorization';
import { ClaudeCodeDeps, type HistoryManagerPort } from './claudeCode/dependencyInjection';
import { buildQueryOptionsSignature, resolvePermissionMode, type PromptStreamController } from './claudeCode/sdkOptionsBuilder';
import { resolveEffectiveSessionMode } from './claudeCode/resolveEffectiveSessionMode';
import { resolveClaudeConfigDir } from './claudeCode/claudeConfigDir';
import {
  hasRunningTasks as computeHasRunningTasks,
  countRunningTasks,
  reapRunningTasks,
  resolvePromptEndDelay,
  resolveShellDrainMs,
  shouldDeferTeardownForSubagents,
  shouldExitDrain,
  classifyDrainOutcome,
  shouldReapAdoptedTasks,
  resolveHandoverPark,
  resolveParkedLeaseMaxAgeMs,
  createChunkReader,
  findForeignRunningTasks,
  shouldSettleTaskFromToolResult,
  isBackgroundLaunchAcknowledgement,
  shouldFinalizeForSettledBackgroundTasks,
  extractToolResultText,
  isNotificationFlushResult,
  shouldArmGraceTimerForResult,
  shouldContinueWithTaskResults,
  buildTaskResultContinuationMessage,
  summarizeBackgroundWait,
  type DrainExitCause,
  type HandoverState,
  type TaskTerminalNotification,
} from './claudeCode/subagentDrain';
import { applySystemTaskChunk, recordBackgroundEvidence, type TrackedSystemTask } from './claudeCode/systemTaskChunks';
import {
  raceNextChunkWithStallWatchdog,
  resolveStreamStallMs,
  shouldArmStreamStallWatchdog,
} from './claudeCode/streamStallWatchdog';
import {
  buildStreamClosedContinuationMessage,
  classifyStreamClosedContinuation,
  extractStreamClosedToolName,
} from './claudeCode/streamClosedRecovery';
import { normalizeStructuredContextUsage } from '../utils/contextUsage';
import { createTurnState } from './claudeCode/turnState';
import { buildTurnQuery, prepareTurnAttachments, resolveTurnPaths } from './claudeCode/turnPrologue';
import { buildTurnCompleteUsage, finishTurn, handleTurnError, type TurnEpilogueHost } from './claudeCode/turnEpilogue';
import { fromDbBoolean } from '../../../core/dbBoolean';
import { applyTaskListMutation, sortTaskList, type TaskListItem } from './claudeCode/taskListReconstruct';


/**
 * Track changes in the agent-sdk and claude-code itself here:
 * https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md
 * https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
 */
// CLAUDE_CODE_VARIANT_VERSIONS and CLAUDE_CODE_MODEL_LABELS now live in
// `modelConstants.ts` so the renderer can share them — see comment there.

export interface ScheduleWakeupRequest {
  sessionId: string;
  workspacePath: string;
  delaySeconds: number;
  prompt: string;
  reason: string;
}


export class ClaudeCodeProvider extends BaseAgentProvider {
  private currentMode?: 'planning' | 'agent' | 'auto'; // Track session mode for prompt customization and tool filtering
  // The mode the UI asked for, before the bypass-all -> auto classifier upgrade.
  // Kept separate from `currentMode` so a mid-turn permission change can redo the
  // upgrade decision without clobbering an explicitly-picked 'auto'/'planning'.
  private requestedMode?: 'planning' | 'agent' | 'auto';
  // Path whose stored project permissions govern this turn (worktrees resolve to
  // the parent project). Recorded so a permission change can re-evaluate it.
  private pathForTrust?: string;
  private slashCommands: string[] = []; // Available slash commands from SDK
  private skills: string[] = []; // Available user-invocable skills from SDK

  // Providers with a live `leadQuery`. Registered when a turn starts and removed
  // in the turn's finally block, so this never accumulates idle instances.
  // Drives `applyPermissionChange`, which is how a project permission change
  // reaches a turn that is already in flight (NIM-2403).
  private static readonly streamingInstances = new Set<ClaudeCodeProvider>();

  // Static cache of SDK-reported skills/commands so they survive across provider instances.
  // Once any session receives the init chunk, new sessions can use the cached list as a
  // fallback before their own init chunk arrives.
  private static cachedSdkSkills: string[] = [];
  private static cachedSdkSlashCommands: string[] = [];

  // Per-process guard for the best-effort default phase fallback.
  private sessionPhaseFallbackAppliedFor: Set<string> = new Set();

  // Session-naming mode, decided ONCE per session (this provider instance is
  // per-session) and then frozen. See buildSystemPrompt for the full rationale.
  // DO NOT recompute this per turn from the live hasBeenNamed flag — that flag
  // flips false->true when the agent names itself in-band on turn 1, which would
  // flip the appended system prompt on turn 2 and bust the whole prompt cache.
  private outOfBandNamingDecision: boolean | undefined = undefined;

  // Git snapshot stated in the system prompt, resolved ONCE per session and then
  // frozen — same invariant as outOfBandNamingDecision above, same reason
  // (#1177). `gitContextFrozen` covers the failure case too: if the first
  // resolve times out we freeze to "no git context" rather than acquiring one on
  // turn 2, because adding the section later is the same cache miss.
  private gitContextFrozen = false;
  private frozenGitContext: string | undefined = undefined;
  // `metadata.sessionDirective`, frozen by BaseAgentProvider.getSessionDirective
  // and copied here because buildSystemPrompt is synchronous.
  private frozenSessionDirective: string | undefined = undefined;

  private markMessagesAsHidden: boolean = false; // Flag to mark next messages as hidden
  private helperMethod: 'native' | 'custom' = 'native';

  // Lead query reference for interruptWithMessage support
  private leadQuery: Query | null = null;
  // The abort controller the SDK was handed for `leadQuery`, recorded as a pair
  // with it. `this.abortController` cannot serve: sendMessage replaces that
  // field at its entry, so a turn unwinding later would hand its lease a
  // controller no query ever received — one that looks perfectly healthy and
  // whose abort reaches nothing, leaving the parked query beyond any Stop.
  // Identity is the only thing that catches that. #1269.
  private leadQueryAbortController: AbortController | null = null;
  // Flag: set when a teammate:messageWhileIdle has been emitted but sendMessage hasn't
  // started yet. Prevents interruptWithMessage from emitting duplicate events.
  private teammateIdleMessagePending: boolean = false;
  // Flag: set when streamInput fails due to dead transport, used in finally block
  private transportDied: boolean = false;
  // Flag: set when interrupt() is called on the lead query. After interrupt(),
  // the transport is dead and streamInput will always fail, so skip the while loop.
  private wasInterrupted: boolean = false;
  // Guard: prevents infinite continuation loops when the lead's turn keeps ending
  // with active teammates. Incremented on each continuation, reset when a real
  // teammate message arrives or teammates complete. Abandon after MAX_CONTINUATIONS.
  private continuationCount: number = 0;
  private static readonly MAX_CONTINUATIONS = 3;
  private sawStreamClosedThisTurn = false;
  private streamClosedTranscriptLoggedThisTurn = false;
  private streamClosedToolName: string | undefined;
  private streamClosedRetryCount = 0;
  private streamClosedContinuationPrepared = false;
  private streamClosedContinuationMessagePending: string | null = null;
  private static readonly MAX_STREAM_CLOSED_RETRIES = 2;
  // #1361: native subprocess crashes (access violation / segfault) are retried
  // once, and only before anything has been streamed. Reset on a completed turn
  // and on abort -- deliberately NOT at turn start, or a crash-retry chain
  // would clear its own budget on every attempt and never terminate.
  private abnormalExitRetryCount = 0;
  private static readonly MAX_ABNORMAL_EXIT_RETRIES = 1;
  // Resolve function to break the for-await loop immediately when interrupt is called.
  // Racing this against .next() lets us unblock without waiting for the SDK transport.
  private interruptResolve: (() => void) | null = null;
  // Controller for the persistent prompt AsyncIterable. Ending it lets the
  // SDK's streamInput generator return and close the binary's stdin pipe.
  // Must be ended in the finally block of sendMessage and on abort.
  // See sdkOptionsBuilder.ts for why we always use a persistent AsyncIterable.
  private promptController: PromptStreamController | null = null;
  // Timer that fires controller.end() after a grace period following the first
  // `result` chunk. Reset on every subsequent chunk so multi-result turns
  // (compaction, etc.) keep stdin open until the binary truly stops emitting.
  private promptEndTimer: ReturnType<typeof setTimeout> | null = null;
  // True once the lead turn's `complete` has been emitted but the streaming loop
  // is still iterating to drain background sub-agents that outlived the turn.
  // See subagentDrain.ts and NIM-1344 / GitHub #732.
  private drainingBackgroundTasks: boolean = false;
  // Task ids last published as the session's background wait, so unchanged
  // task_progress chunks do not re-broadcast.
  private publishedBackgroundWaitKey = '';
  // Why the current streaming loop stopped iterating. Set at each loop-exit point
  // so finalizeBackgroundDrain() can tell a user stop / supersede (no continuation)
  // apart from an unexpected sub-agent death (auto-continue). Reset each turn.
  private drainExitCause: DrainExitCause = 'resolved';
  // Handover: once the lead turn is over and only background sub-agents keep the
  // query open (the drain), interrupting destroys exactly the work the drain
  // exists for. interruptCurrentTurn() parks the live query as a lease instead
  // and the follow-up turn adopts it — same subprocess, same running sub-agents,
  // fresh generator (so its output reaches the UI, which a post-`complete` yield
  // never could). Query, abort controller and prompt controller park as ONE
  // lease because they only work together, and a lease always has an owner: an
  // adopting turn, disposeParkedLease(), or the watchdog below.
  //
  // A state machine, not a request flag: the loop moves `requested` to
  // `accepted` when it actually leaves the drain, and only `accepted` may park.
  // A bare flag let the request time out after the loop had committed, closing a
  // query whose sub-agents were still reported running. resolveHandoverPark()
  // holds the decision. #1269.
  private handover: {
    state: HandoverState;
    /**
     * Settles requestQueryHandover(). Called on EVERY teardown outcome, with
     * whether the query was actually parked.
     */
    resolveParked: ((parked: boolean) => void) | null;
  } | null = null;
  private parkedLease: {
    query: Query;
    promptController: PromptStreamController;
    abortController: AbortController;
    /**
     * The tool hooks the parked query's subprocess calls. Part of the lease
     * because buildSdkOptions binds them as closures over the instance that
     * existed when the query was created: an adopting turn's own instance is
     * never wired to anything, so its file edits are recorded on this one. The
     * adopting turn reads it to decide whether it edited files at all — with a
     * fresh instance that check saw nothing and skipped createTurnEndSnapshots,
     * leaving the turn's restore points missing from the file history. #1269.
     */
    toolHooksService: AgentToolHooks;
    generation: number;
    /**
     * The session the parking turn ran for. Every disposal exit emits
     * `drainSettled` and a task update for a session, and `currentSessionId`
     * cannot serve: it is written only from `system/init` of a query that had
     * MCP servers, an ADOPTED query never sends `system/init` again, and abort()
     * clears it — so both emits bailed out on their `!sessionId` guard and the
     * user watched killed sub-agents run. #1269.
     */
    sessionId: string | undefined;
    /**
     * Fingerprint of the options the parked query was started with, so a turn
     * that resolved different ones opens its own query instead. The running
     * subprocess cannot change the model, effort, thinking mode or tool
     * restrictions it was spawned with; it would answer from the previous
     * configuration while the options logged beside it describe the new one — a
     * divergence nothing downstream can see. The PR states the boundary: a
     * handover carries a turn over only while the model settings stay put. #1269.
     */
    optionsSignature: string;
    /**
     * The read still in flight when the loop left the drain. Part of the lease
     * because the SDK hands every caller the same generator: whoever adopts the
     * query must consume this promise as its first chunk, or the next message
     * goes to a promise nobody awaits. #1269.
     */
    pendingChunk: Promise<IteratorResult<any>> | null;
    /**
     * Terminal task_notifications from the parked turn's drain. Parking skips
     * finalizeBackgroundDrain, so dropping them would swallow the results of
     * sub-agents that finished just before the handover. #1269.
     */
    terminalNotifications: TaskTerminalNotification[];
  } | null = null;
  private static readonly HANDOVER_PARK_TIMEOUT_MS = 5000;
  private parkedLeaseWatchdog: ReturnType<typeof setTimeout> | null = null;
  // Identity of the query this provider currently owns. Bumped for every query
  // it starts AND every lease it adopts; tasks are stamped with it when they
  // start. A running task carrying any other generation belongs to a query that
  // is gone — see findForeignRunningTasks(). #1269.
  private queryGeneration = 0;

  // Teammate management: spawning, messaging, lifecycle, config I/O
  private teammateManager: TeammateManager;

  // SDK-native sub-agent task tracking (task_started/task_progress/task_notification)
  // Shape and lifecycle rules live in claudeCode/systemTaskChunks.ts, which is
  // the only writer.
  private activeTasks = new Map<string, TrackedSystemTask>();

  // Terminal task_notification chunks for background tasks — recorded while
  // draining after the lead turn ended (NIM-1470), and also when a backgrounded
  // task settles DURING the turn (#1410). Consumed by finalizeBackgroundDrain to
  // wake the session with a visible continuation turn carrying the results.
  private drainTerminalNotifications: TaskTerminalNotification[] = [];

  // A backgrounded task reported terminally during this turn, so the turn ended
  // without ever draining. The CLI has a continuation turn queued for that
  // notification which would run against the control channel we are about to
  // tear down — every permission-requiring tool call in it denied before
  // canUseTool is reached. Makes the finally close the subprocess and deliver
  // the results as a visible turn instead. See #1410.
  private settledBackgroundTasksThisTurn = false;

  // The drain grace timer expired while background tasks were still running, so
  // we closed the prompt stream and the CLI killed them along with its process.
  // Any 'stopped' that lands after this is OUR kill, not a user stop — without
  // the distinction both took the same silent path and the agent could not tell
  // "killed" from "stopped". See GitHub #1355.
  private drainGraceExpired = false;

  // SDK-native task-list tracking (TaskCreate/TaskUpdate tools — the shared,
  // dependency-aware work queue, distinct from the sub-agent telemetry above).
  // Reconstructed incrementally from tool args/results because TaskUpdate only
  // sends the changed fields, never the full board. Surfaced to the UI via
  // metadata.currentTaskList. Keyed by the SDK-assigned task id ("1", "2", ...).
  private taskListItems = new Map<string, TaskListItem>();

  // MCP server status tracking: last known statuses for change detection
  private mcpServerStatuses: Map<string, McpServerStatusInfo> = new Map();
  // Epoch ms of the last poll that actually returned. Null means never polled,
  // which the UI must distinguish from "polled and found nothing" — before the
  // first poll every configured server looks absent.
  private mcpStatusesLastCheckedAt: number | null = null;
  // Interval handle for periodic MCP health checks during active sessions
  private mcpHealthCheckInterval: ReturnType<typeof setInterval> | null = null;
  // Session ID for the current streaming session (needed for health check emissions)
  private currentSessionId: string | undefined;
  // Persistent query reference for MCP operations (survives between turns).
  // Unlike leadQuery which is nulled after each turn, this stays set as long as
  // the SDK subprocess is alive (i.e. the session has MCP servers).
  private mcpQuery: Query | null = null;

  // Permission service for tool permission handling
  private permissionService: ToolPermissionService | null = null;

  // Tool hooks service for pre/post tool execution and file tracking
  private toolHooksService: AgentToolHooks | null = null;

  // MCP configuration service for loading and processing MCP server configs
  private mcpConfigService: McpConfigService;

  // MCP configuration, decided ONCE per session (this provider instance is
  // per-session) at the first SDK options build and then frozen as serialized
  // bytes. The SDK re-sends its tool prefix on every resumed turn; re-reading
  // the live Electron map lets extension/server readiness change membership or
  // ordering mid-session and forces a tools_changed miss over the entire cached
  // conversation. DO NOT replace this with a per-turn config read. Parsing a
  // fresh object from the frozen bytes also prevents SDK mutation from changing
  // later turns. See NIM-1988 and ClaudeCodeProvider.mcpSnapshot.test.ts.
  private mcpServersSnapshotJsonPromise: Promise<string> | undefined;

  // Server NAMES from the snapshot above, recorded as a side effect when that
  // promise settles on its own. This is the comparison set that lets the UI say
  // "configured but never reached this session" — mcpServerStatus() reports
  // what the CLI has, never what the user expected.
  //
  // Names only, and never awaited from the accessor: reading this must not
  // force the snapshot to resolve early or trigger a live config read, or
  // NIM-1988 regresses. The snapshot itself holds credentials in server env and
  // headers and must not cross the IPC boundary at all.
  private mcpSnapshotServerNames: string[] | null = null;
  /** Configured servers withheld from this session for failing the OAuth check. */
  private mcpWithheldServerNames: string[] | null = null;

  // ---- Static dependency forwarding ----
  // All static fields and setters live in ClaudeCodeDeps.
  // These forwarding setters maintain backward compatibility for callers.

  public static setCustomClaudeCodePathLoader(loader: ((workspacePath: string) => string) | null): void { ClaudeCodeDeps.setCustomClaudeCodePathLoader(loader); }

  constructor() {
    super();
    this.teammateManager = new TeammateManager({
      logNonBlocking: (sessionId, source, direction, content, metadata) =>
        this.logAgentMessageNonBlocking(sessionId, source, direction, content, metadata),
      emit: (event, payload) => this.emit(event, payload),
      createPreToolUseHook: (cwd, sessionId, permissionsPath, context) => {
        // Create AgentToolHooks instance for teammate
        const teammateHooks = this.createTeammateToolHooksService(cwd, sessionId, permissionsPath, context?.isTeammateSession || false);
        return teammateHooks.createPreToolUseHook();
      },
      createPostToolUseHook: (cwd, sessionId) => {
        // Create AgentToolHooks instance for teammate
        const teammateHooks = this.createTeammateToolHooksService(cwd, sessionId, undefined, true);
        return teammateHooks.createPostToolUseHook();
      },
      getAbortSignal: () => this.abortController?.signal,
      interruptWithMessage: (message) => this.interruptWithMessage(message),
      createCanUseToolHandler: (sessionId, workspacePath, permissionsPath, teammateName) =>
        this.createCanUseToolHandler(sessionId, workspacePath, permissionsPath, teammateName),
    });

    // Initialize permission service if all dependencies are available
    // For Claude Code, these dependencies are optional since permission handling
    // can fall back to inline logic if not configured (e.g., in tests)
    if (
      BaseAgentProvider.trustChecker &&
      ClaudeCodeDeps.claudeSettingsPatternSaver &&
      ClaudeCodeDeps.claudeSettingsPatternChecker
    ) {
      this.permissionService = new ToolPermissionService({
        trustChecker: BaseAgentProvider.trustChecker,
        patternSaver: ClaudeCodeDeps.claudeSettingsPatternSaver,
        patternChecker: ClaudeCodeDeps.claudeSettingsPatternChecker,
        securityLogger: BaseAgentProvider.securityLogger ?? undefined,
        emit: this.emit.bind(this),
      });
    }

    // Initialize MCP configuration service from the shared registry + the
    // provider-owned config/env loaders.
    this.mcpConfigService = getMcpConfigService({
      mcpConfigLoader: ClaudeCodeDeps.mcpConfigLoader,
      claudeSettingsEnvLoader: ClaudeCodeDeps.claudeSettingsEnvLoader,
      shellEnvironmentLoader: ClaudeCodeDeps.shellEnvironmentLoader,
    });
  }

  private async getMcpServersSnapshot(options: {
    sessionId?: string;
    workspacePath: string;
    profile?: 'standard' | 'meta-agent';
  }): Promise<Record<string, any>> {
    if (!this.mcpServersSnapshotJsonPromise) {
      this.mcpServersSnapshotJsonPromise = this.mcpConfigService
        .getMcpServersConfig(options)
        .then((mcpServers) => {
          // Record names for the absent-server diff. Piggybacking on the
          // existing resolution keeps the accessor free of any await.
          this.mcpSnapshotServerNames = Object.keys(mcpServers ?? {});
          // Read in the same continuation as the loader that produced them, so
          // the two always describe one pass (GH #1057).
          this.mcpWithheldServerNames =
            ClaudeCodeDeps.mcpWithheldNamesLoader?.(options.workspacePath) ?? null;
          return JSON.stringify(mcpServers);
        });
    }

    const snapshotJson = await this.mcpServersSnapshotJsonPromise;
    return JSON.parse(snapshotJson) as Record<string, any>;
  }

  getProviderName(): AIProviderType {
    return 'claude-code';
  }

  /**
   * Create AgentToolHooks service for teammate sessions
   * Teammates need separate hook instances with isTeammateSession: true
   */
  private createTeammateToolHooksService(
    workspacePath: string,
    sessionId: string | undefined,
    permissionsPath: string | undefined,
    isTeammateSession: boolean
  ): AgentToolHooks {
    return this.createToolHooksService(workspacePath, sessionId, permissionsPath, isTeammateSession);
  }

  private createToolHooksService(
    workspacePath: string,
    sessionId: string | undefined,
    permissionsPath: string | undefined,
    isTeammateSession: boolean
  ): AgentToolHooks {
    return new AgentToolHooks({
      workspacePath: workspacePath,
      sessionId,
      emit: this.emit.bind(this),
      logAgentMessage: this.logAgentMessage.bind(this),
      logSecurity: this.logSecurity.bind(this),
      trustChecker: BaseAgentProvider.trustChecker || undefined,
      patternSaver: ClaudeCodeDeps.claudeSettingsPatternSaver || undefined,
      getCurrentMode: () => this.currentMode,
      setCurrentMode: (mode) => { this.currentMode = mode; },
      getPendingExitPlanModeConfirmations: () => this.pendingExitPlanModeConfirmations,
      getSessionApprovedPatterns: () => this.permissions.sessionApprovedPatterns,
      getPendingToolPermissions: () => this.permissions.pendingToolPermissions,
      teammatePreToolHandler: async (toolName, toolInput, toolUseID, sessionId) =>
        this.teammateManager.handlePreToolUse(toolName, toolInput, toolUseID, sessionId),
      isTeammateSession: !!isTeammateSession,
      permissionsPath,
      // Undefined on a host with no document history; AgentToolHooks guards
      // every call site and skips snapshotting rather than failing.
      historyManager: ClaudeCodeDeps.historyManager ?? undefined,
    });
  }

  // ExitPlanMode confirmation response type
  private pendingExitPlanModeConfirmations: Map<string, {
    resolve: (response: { approved: boolean; clearContext?: boolean; feedback?: string }) => void;
    reject: (error: Error) => void;
  }> = new Map();

  // AskUserQuestion tool - stores pending question resolvers
  // When Claude calls AskUserQuestion, we block until the UI provides answers via IPC
  private pendingAskUserQuestions: Map<string, PendingAskUserQuestionEntry> = new Map();

  static readonly DEFAULT_MODEL = ClaudeCodeDeps.DEFAULT_MODEL;

  // Internal MCP-server ports / kill-switches / loaders / auth token are
  // configured once via `configureMcpServers` (shared registry), not per-provider.
  public static setMCPConfigLoader(loader: ((workspacePath?: string) => Promise<Record<string, any>>) | null): void { ClaudeCodeDeps.setMCPConfigLoader(loader); }
  public static setMcpWithheldNamesLoader(loader: ((workspacePath?: string) => string[]) | null): void { ClaudeCodeDeps.setMcpWithheldNamesLoader(loader); }
  public static setExtensionPluginsLoader(loader: ((workspacePath?: string) => Promise<Array<{ type: 'local'; path: string }>>) | null): void { ClaudeCodeDeps.setExtensionPluginsLoader(loader); }
  public static setClaudeCodeSettingsLoader(loader: (() => Promise<{ projectCommandsEnabled: boolean; userCommandsEnabled: boolean }>) | null): void { ClaudeCodeDeps.setClaudeCodeSettingsLoader(loader); }
  public static setClaudeSettingsEnvLoader(loader: (() => Promise<Record<string, string>>) | null): void { ClaudeCodeDeps.setClaudeSettingsEnvLoader(loader); }
  public static setShellEnvironmentLoader(loader: (() => Record<string, string> | null) | null): void { ClaudeCodeDeps.setShellEnvironmentLoader(loader); }
  public static setEnhancedPathLoader(loader: (() => string) | null): void { ClaudeCodeDeps.setEnhancedPathLoader(loader); }
  public static setAdditionalDirectoriesLoader(loader: ((workspacePath: string) => string[]) | null): void { ClaudeCodeDeps.setAdditionalDirectoriesLoader(loader); }
  public static setGitContextLoader(loader: ((workspacePath: string) => Promise<string | null>) | null): void { ClaudeCodeDeps.setGitContextLoader(loader); }
  public static setAttachmentStagingLoader(loader: ((workspacePath: string) => { root: string; mode: 'temp' | 'workspace' | 'custom' }) | null): void { ClaudeCodeDeps.setAttachmentStagingLoader(loader); }
  public static setAttachmentDenyRulesLoader(loader: ((workspacePath: string) => Promise<string[]>) | null): void { ClaudeCodeDeps.setAttachmentDenyRulesLoader(loader); }
  public static setSecurityLogger(logger: ((message: string, data?: any) => void) | null): void { BaseAgentProvider.setSecurityLogger(logger); }
  public static setHistoryManager(historyManager: HistoryManagerPort | null): void { ClaudeCodeDeps.setHistoryManager(historyManager); }
  public static setImageCompressor(compressor: ((buffer: Buffer, mimeType: string, options?: { targetSizeBytes?: number }) => Promise<{ buffer: Buffer; mimeType: string; wasCompressed: boolean }>) | null): void { ClaudeCodeDeps.setImageCompressor(compressor); }
  public static setClaudeSettingsPatternSaver(saver: ((workspacePath: string, pattern: string) => Promise<void>) | null): void { ClaudeCodeDeps.setClaudeSettingsPatternSaver(saver); }
  public static setClaudeSettingsPatternChecker(checker: ((workspacePath: string, pattern: string) => Promise<boolean>) | null): void { ClaudeCodeDeps.setClaudeSettingsPatternChecker(checker); }
  public static setTrustChecker(checker: ((workspacePath: string) => { trusted: boolean; mode: 'ask' | 'allow-all' | 'bypass-all' | null; allowAllUsesClassifier?: boolean }) | null): void { BaseAgentProvider.setTrustChecker(checker); }
  public static setExtensionFileTypesLoader(loader: (() => Set<string>) | null): void { ClaudeCodeDeps.setExtensionFileTypesLoader(loader); }

  /**
   * Push a project permission change into every turn that is already in flight.
   *
   * A turn snapshots the effective session mode once (see sendMessage) and hands
   * the derived `permissionMode` to `query()` for the life of that turn, so
   * without this a user who switches to "Allow everything" mid-turn keeps being
   * asked until the agent stops. Re-running the bypass-all -> auto upgrade against
   * the fresh trust status and pushing the result through the SDK's
   * `Query.setPermissionMode` makes the change land on the very next tool call.
   *
   * `requestedMode` (not `currentMode`) is the input, so an explicitly-picked
   * 'auto' or 'planning' session is never silently downgraded.
   *
   * Every in-flight turn re-reads trust for its OWN path rather than the caller
   * filtering by the changed path: worktrees, the subfolder trust cascade, and
   * `permissionsPath` all mean the changed path and a session's trust path are
   * often related but not equal. A turn whose effective mode did not move is a
   * no-op, so the broad sweep is safe.
   */
  public static async applyPermissionChange(): Promise<void> {
    for (const provider of [...ClaudeCodeProvider.streamingInstances]) {
      await provider.applyPermissionChange();
    }
  }

  private async applyPermissionChange(): Promise<void> {
    const leadQuery = this.leadQuery;
    if (!leadQuery || typeof leadQuery.setPermissionMode !== 'function') return;
    if (this.requestedMode !== 'agent' || !this.pathForTrust || !BaseAgentProvider.trustChecker) return;

    const trustStatus = BaseAgentProvider.trustChecker(this.pathForTrust);
    // An untrusted workspace is handled by canUseTool's deny path, which already
    // reads the live trust status. Nothing to re-negotiate with the SDK here.
    if (!trustStatus.trusted) return;

    const nextMode = resolveEffectiveSessionMode('agent', trustStatus);
    if (nextMode === this.currentMode) return;

    const previousMode = this.currentMode;
    this.currentMode = nextMode;
    try {
      await leadQuery.setPermissionMode(resolvePermissionMode(nextMode));
    } catch (error) {
      // The transport can die between the permission change and this call. Roll
      // back so canUseTool keeps honouring the mode the turn actually runs under.
      this.currentMode = previousMode;
      console.warn('[CLAUDE-CODE] Failed to apply permission change to in-flight turn:', error);
    }
  }

  private static scheduleWakeupHandler: ((request: ScheduleWakeupRequest) => Promise<void>) | null = null;
  public static setScheduleWakeupHandler(handler: ((request: ScheduleWakeupRequest) => Promise<void>) | null): void {
    ClaudeCodeProvider.scheduleWakeupHandler = handler;
  }

  async initialize(config: ProviderConfig): Promise<void> {
    const safeConfig = { ...config, apiKey: config.apiKey ? '***' : undefined };
    //   model: config.model,
    //   configKeys: Object.keys(config),
    //   config: safeConfig
    // }, null, 2));

    this.config = config;

    // Claude Code manages its own authentication - do not require or use API key
  }

  /**
   * Mark the next sendMessage call's logged messages as hidden
   * Used for auto-triggered commands like /context that shouldn't appear in UI
   * Flag is automatically reset after sendMessage completes
   */
  public setHiddenMode(hidden: boolean): void {
    this.markMessagesAsHidden = hidden;
  }

  private resolveModelVariant(): string {
    // Fallback safety (#631 / NIM-848): when no explicit model is set, fall back
    // to plain `claude-code:opus`, never a `-1m` variant, so `[1m]` is only ever
    // emitted for an explicitly-selected `-1m` model. On the current CLI this no
    // longer changes cost for current-gen models (1M is flat-priced and `[1m]`
    // is a no-op — GitHub #825), but it stays defensive for any legacy variant.
    return resolveClaudeCodeModelVariant(this.config.model, CLAUDE_CODE_SAFE_FALLBACK_MODEL);
  }



  /**
   * The provider surface both epilogue paths share (see turnEpilogue.ts).
   * Built fresh per use so it always reads the current `toolHooksService`,
   * which is replaced at the start of every turn.
   */
  private epilogueHost(): TurnEpilogueHost {
    return {
      flushPendingWrites: () => this.flushPendingWrites(),
      processTranscriptMessages: (sid) => this.processTranscriptMessages(sid),
      logError: (sid, provider, error, source, errorType, hidden) =>
        this.logError(sid, provider, error, source, errorType, hidden),
      toolHooksService: this.toolHooksService,
      prepareStreamClosedContinuation: (sid, hidden) => this.prepareStreamClosedContinuation(sid, hidden),
    };
  }

  async *sendMessage(
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    messages?: any[],
    workspacePath?: string,
    attachments?: any[]
  ): AsyncIterableIterator<StreamChunk> {
    const startTime = Date.now();

    // CRITICAL: Capture hidden mode flag at START and reset immediately
    // This prevents race conditions when concurrent sendMessage calls overlap
    // (e.g., auto-context /context command running while a queued prompt fires)
    const hideMessages = this.markMessagesAsHidden;
    this.markMessagesAsHidden = false;
    this.resetStreamClosedTurnState();

    // Everything this turn mutates and later reads lives in one object passed by
    // reference (see turnState.ts). `state.originalMessage` is the caller's
    // message before the rewrites below; the crash-retry path replays it (#1361).
    const state = createTurnState({ startTime, hideMessages, originalMessage: message });

    // Session mode (incl. the trust-level upgrade) and the worktree-aware paths.
    // Track session mode for MCP server configuration and tool filtering.
    const paths = resolveTurnPaths({
      documentContext,
      workspacePath,
      trustChecker: BaseAgentProvider.trustChecker,
    });
    this.currentMode = paths.currentMode;
    this.requestedMode = paths.currentMode;
    this.pathForTrust = paths.pathForTrust;

    // Deliberately outside the try, as before: a failure staging attachments
    // throws to the caller rather than becoming an error chunk.
    const prepared = await prepareTurnAttachments({ sessionId, workspacePath, attachments });

    // Abort any existing request before starting a new one
    if (this.abortController) {
      this.abortController.abort();
    }

    // Create abort controller for this request. Kept in a turn-local as well, so
    // it stays reachable as the query's controller even after a later
    // sendMessage entry has replaced the field with one of its own. #1269.
    const turnAbortController = new AbortController();
    this.abortController = turnAbortController;

    // Create tool hooks service for this turn
    // This service manages pre/post hooks, file tagging, and snapshot creation
    //
    // Turn-local as well as an instance field, and reassigned to the lease's
    // instance on an adoption below — see parkedLease.toolHooksService for why
    // an adopted query's edits land on the PARKED instance. #1269.
    let turnToolHooks = this.createToolHooksService(
      workspacePath!,
      sessionId,
      paths.permissionsPath,
      false
    );
    this.toolHooksService = turnToolHooks;

    // Clear edited files tracker for new turn
    turnToolHooks.clearEditedFiles();

    try {
      // Prompt rewriting, system prompt, SDK options, input logging and the
      // transcript adapter. Inside the try, as before: `buildTurnQuery` throws
      // on an unusable workspace and the catch below turns that into the
      // error/complete pair the consumer expects.
      const {
        options,
        promptInput,
        initialUserContent,
        transcriptAdapter,
        queryStartTime,
      } = await buildTurnQuery(
        {
          getAgentRole: (sid) => this.getAgentRole(sid),
          getWorkflowPreset: (sid) => this.getWorkflowPreset(sid),
          ensureGitContext: (wp) => this.ensureGitContext(wp),
          ensureSessionDirective: async (sid) => { this.frozenSessionDirective = await this.getSessionDirective(sid); },
          buildSystemPrompt: (dc, teams, meta, preset) => this.buildSystemPrompt(dc, teams, meta, preset),
          emit: (event, payload) => { this.emit(event, payload); },
          withPromptProvenanceMetadata: (dc) => this.withPromptProvenanceMetadata(dc),
          logAgentMessage: (...args) => this.logAgentMessage(...args),
          resolveModelVariant: () => this.resolveModelVariant(),
          getMcpServersSnapshot: (o) => this.getMcpServersSnapshot(o),
          createCanUseToolHandler: (sid, wp, pp) => this.createCanUseToolHandler(sid, wp, pp),
          toolHooksService: this.toolHooksService!,
          teammateManager: this.teammateManager,
          sessions: this.sessions,
          config: this.config,
          // The controller the SDK actually receives, kept turn-local: a later
          // sendMessage entry replaces `this.abortController`, so a turn
          // unwinding after that would hand its lease a controller no query
          // ever saw — healthy-looking and reaching nothing. #1269.
          abortController: turnAbortController,
          currentMode: this.currentMode,
          metaAgentAllowedTools: BaseAgentProvider.META_AGENT_ALLOWED_TOOLS,
          publishSdkResult: (result) => {
            this.helperMethod = result.helperMethod;
            this.promptController = result.promptController;
          },
        },
        state,
        { documentContext, sessionId, workspacePath, attachments, paths, prepared },
      );

      // Taken from the options the query is actually created with, meta-agent
      // restrictions included. A follow-up turn may adopt this query only if its
      // own options produce the same fingerprint. #1269.
      state.queryOptionsSignature = buildQueryOptionsSignature(
        options as Parameters<typeof buildQueryOptionsSignature>[0],
      );

      const queryCallStart = Date.now();

      // Adopt a query parked by a previous turn's handover: the SAME subprocess,
      // so the background sub-agents still running inside it survive this turn
      // and their task_notifications land in this generator. Attachments are no
      // obstacle — they ride in the message, not in the options the process was
      // started with, which is why the adopting turn pushes the very content
      // its own first message would have carried. #1269.
      //
      // Four behaviours of @anthropic-ai/claude-agent-sdk are load-bearing
      // here, and none is a documented contract. The dependency is pinned
      // exactly to 0.3.241 in the root, `runtime` and `electron` package.json,
      // so a version bump is visible in review — re-verify all four then:
      //   1. A message written to a live query's prompt stream starts a new
      //      user turn on it, rather than being rejected because the previous
      //      turn already produced its `result` — including one whose content is
      //      image or document blocks rather than text.
      //   2. The AbortController handed to `query({ options })` governs that
      //      query's lifetime, so whoever holds it can stop the subprocess.
      //      Everything the lease does with ownership rests on this.
      //   3. `streamInput` closes stdin when its input stream ends — an
      //      unconditional transport.endInput() after the last message. That is
      //      why the follow-up prompt goes onto the persistent prompt stream
      //      (promptController.push) instead of a second streamInput call: a
      //      one-shot stream would shut the pipe the drain still needs.
      //   4. A `push()` that reports success got the message to the subprocess.
      //      It really only reports OUR end() of the generator, not the state of
      //      the pipe, so a transport that died on the SDK side stays unseen and
      //      the adoption looks final while the message never left the process.
      //      Deliberately not guarded: never observed, and the one signal that
      //      would show it, `Query.isClosed()`, is absent from the exported type.
      const adopted = this.adoptParkedLeaseFor(initialUserContent, state.queryOptionsSignature);
      if (adopted) {
        console.log('[CLAUDE-CODE] SUBAGENT_DRAIN: adopting parked query for follow-up turn; background sub-agents preserved');
        // This turn built its own prompt stream before it knew a lease was
        // waiting. Nothing was ever written to it and no query holds it, so end
        // it before taking the lease's — otherwise it stays open for the rest of
        // the process.
        this.promptController?.end('handover-unused');
        this.promptController = adopted.promptController;
        // Take over the lease's abort controller too: the SDK holds that one,
        // while this turn's own was never handed to any query, so leaving it in
        // place would make abort() fire into the void. #1269.
        this.abortController = adopted.abortController;
        // Same for the tool hooks. Cleared here, at the start of the adopting
        // turn, so the snapshot at its end covers its own edits and not the
        // parked turn's.
        turnToolHooks = adopted.toolHooksService;
        turnToolHooks.clearEditedFiles();
        this.toolHooksService = turnToolHooks;
        state.adoptedLease = true;
      }
      const leadQuery: AsyncIterable<any> = adopted
        ? (adopted.query as unknown as AsyncIterable<any>)
        : query({
          prompt: promptInput as any,
          options
        });

      this.leadQuery = leadQuery as unknown as Query;
      // Recorded in the same breath as the query it governs: the lease's on an
      // adoption, this turn's own otherwise.
      this.leadQueryAbortController = adopted ? adopted.abortController : turnAbortController;
      // The query this provider owns changed identity. The tasks that came with
      // the lease move to the new generation with it — anything else still
      // running belongs to a query that is gone. #1269.
      const inheritedGeneration = adopted?.generation;
      this.queryGeneration++;
      if (inheritedGeneration !== undefined) {
        for (const task of this.activeTasks.values()) {
          if (task.queryGeneration === inheritedGeneration) {
            task.queryGeneration = this.queryGeneration;
          }
        }
      }
      if (adopted) {
        this.releaseAdoptedLease();
      }
      ClaudeCodeProvider.streamingInstances.add(this);
      this.teammateIdleMessagePending = false;
      // Reset per-turn background-drain state (defensive; also reset in finally).
      this.drainingBackgroundTasks = false;
      // An adopted lease arrives with the flag still standing from the park,
      // and its wait list published; withdraw it now that a turn runs. #1269.
      if (adopted) {
        this.publishBackgroundWait(sessionId);
      }
      this.drainExitCause = 'resolved';
      // Resume from the parked turn's notifications, so this turn's drain
      // carries them into the continuation.
      this.drainTerminalNotifications = adopted ? adopted.terminalNotifications : [];
      this.drainGraceExpired = false;
      this.settledBackgroundTasksThisTurn = false;
      const queryIterator = leadQuery as AsyncIterable<any>;
      const queryCallDuration = Date.now() - queryCallStart;
      if (queryCallDuration > 5000) {
        console.warn(`[CLAUDE-CODE] SDK query() took ${queryCallDuration}ms to return iterator (>5s threshold) - possible Windows Defender/antivirus delay`);
      }


      // The chunk loop's counters, usage accumulators and `state.completeEmitted` all
      // live on `state` (created at the top of the turn) so the epilogue and the
      // catch block read the same values the loop wrote. See turnState.ts.
      //
      // On `state.completeEmitted` specifically: we yield `complete` as soon as the
      // SDK sends the `result` chunk so the UI flips to ready immediately,
      // rather than waiting for the post-result grace period to expire (~30s of
      // perceived "still running" with no new output). The for-await loop and
      // grace timer continue running so late can_use_tool control requests on
      // stdin still complete; subsequent chunks (rare -- teammate drainage, late
      // text) are still yielded to the consumer.
      //
      // Grace window after `type: 'result'` before the controller ends the
      // prompt iterable and the SDK closes the binary's stdin pipe.
      //
      // Originally 5 seconds. Bumped to 30 seconds in the #320 follow-up
      // after reporters hit "Tool permission request failed: Error: Stream
      // closed" on sessions with 15-25+ accumulated tracker tasks. The
      // binary's task-list `<system-reminder>` hook serializes that many
      // tasks slowly enough that the result chunk lands well before the
      // hook finishes; the hook then tries to write the reminder over a
      // stdin that the previous 5s timer had already closed and throws,
      // ending the prompt controller and turning every subsequent
      // permission-requiring tool into "Stream closed".
      //
      // The reset-on-activity branch below still resets the timer on every
      // post-result chunk, so a turn that genuinely keeps streaming work
      // never hits the timer. Interrupted / idle turns linger for the
      // grace window; 30s is the trade-off for the task-list-heavy case.
      // If diagnostic logs still show STREAM_CLOSED_DIAGNOSTIC after
      // RESULT_MESSAGE_RECEIVED on a session with this fix, bump further.
      //
      // CAVEAT (#1410) — on the ordinary path this window is worth ~0.3s, not
      // 30s. The same loop iteration that arms the timer yields `complete` and
      // breaks, and the finally clears the timer and ends the prompt controller
      // immediately after. Only the drain path (`willDrainSubagents`, which
      // `continue`s instead of breaking) keeps the window alive for its full
      // length. Do not reason about post-result timing from this constant
      // without checking which path the turn took. Whether #320's original
      // task-list-hook case is still covered is an open question and deserves
      // its own investigation; it is NOT what #1410 fixed.
      const PROMPT_GRACE_MS = 30_000;
      // While a background sub-agent is still running after the lead's turn ended,
      // stdin must stay open far longer than the 30s task-list grace window. The
      // timer still resets on every chunk (incl. task_progress), so this is a
      // no-activity STALL detector, not a blind fixed cap: an actively-working
      // sub-agent never trips it, while a genuinely stuck one is eventually reaped
      // (avoiding the #320 "Stream closed" hang). See NIM-1344 / GitHub #732.
      const SUBAGENT_DRAIN_GRACE_MS = 5 * 60_000;
      // Stall watchdog window (NIM-1481). If the SDK yields no chunk of ANY kind
      // for this long while the model -- not a tool -- is expected to be producing
      // output, the stream is wedged (e.g. a thinking phase whose upstream died
      // silently) and the turn is aborted instead of hanging forever. The
      // `thinking_tokens` chunk keeps a live thinking phase alive, but it is a
      // variable-cadence estimated-token progress tick (avg ~5s, observed intra-turn
      // gaps up to ~589s), NOT a ~1Hz keepalive -- so the window is sized generously
      // above that jitter to avoid reaping legitimate long rewrites (#802).
      const streamStallMs = resolveStreamStallMs();
      // A backgrounded shell (local_bash) streams no chunks while it runs, so it
      // can never reset the timer below and the 5-minute sub-agent window killed
      // every one that outran it. Silence from a shell is not a stall. See #1355.
      const shellDrainMs = resolveShellDrainMs();
      const armPromptEndTimer = (reason: string) => {
        if (this.promptEndTimer) {
          clearTimeout(this.promptEndTimer);
        }
        const delay = resolvePromptEndDelay(this.activeTasks.values(), {
          idle: PROMPT_GRACE_MS,
          subagent: SUBAGENT_DRAIN_GRACE_MS,
          shell: shellDrainMs,
        });
        this.promptEndTimer = setTimeout(() => {
          this.promptEndTimer = null;
          // Record that WE ended the stream on a still-running task. Ending it
          // closes the CLI's stdin, which kills every live background task with
          // the process — they then report 'stopped', indistinguishable from a
          // user stop unless we remember that we caused it. See #1355.
          if (this.hasRunningTasks()) {
            this.drainGraceExpired = true;
            console.warn(`[CLAUDE-CODE] SUBAGENT_DRAIN: grace window (${delay}ms) expired with ${countRunningTasks(this.activeTasks.values())} task(s) still running; ending stream will kill them`);
          }
          this.promptController?.end(reason);
        }, delay);
      };

      // Stream the response
      try {
        // Use manual iteration with Promise.race so interruptWithMessage() can
        // break the loop immediately without waiting for the SDK subprocess.
        const iterator = (queryIterator as AsyncIterable<any>)[Symbol.asyncIterator]();
        // On an adoption the lease's abandoned read is consumed first. #1269.
        const readNextChunk = createChunkReader<any>(iterator, adopted?.pendingChunk ?? null);
        let interruptPromise = new Promise<'interrupted'>(resolve => {
          this.interruptResolve = () => resolve('interrupted');
        });
        while (true) {
          // Check for abort signal before each iteration
          if (this.abortController?.signal.aborted) {
            console.log('[CLAUDE-CODE] Abort signal detected in streaming loop, breaking out');
            this.drainExitCause = 'aborted';
            break;
          }

          // Race the next chunk against the interrupt signal and, when armed, a
          // stall watchdog. The watchdog is only armed while the MODEL is
          // expected to be producing output: before any `result` chunk, with no
          // tool executing, no background sub-agent draining, and no pending user
          // prompt/permission request. In those states the SDK still emits
          // `thinking_tokens` progress ticks (bursty, not a fixed cadence), so total
          // silence for the full streamStallMs window means the stream is wedged.
          // During a long tool call, sub-agent drain, or user interaction, silence is
          // legitimate and the watchdog stays disarmed so real work is never reaped.
          // NIM-1481 / #802.
          const watchdogActive = shouldArmStreamStallWatchdog({
            resultReceivedTime: state.resultReceivedTime,
            outstandingToolCalls: state.outstandingToolCalls,
            hasRunningTasks: this.hasRunningTasks(),
            hasPendingUserInteraction: this.hasPendingUserInteraction(),
          });
          const nextPromise = readNextChunk();
          const raceResult = await raceNextChunkWithStallWatchdog<any>({
            nextPromise,
            interruptPromise,
            watchdogActive,
            stallMs: streamStallMs,
          });

          if (raceResult.kind === 'interrupted') {
            if (this.handover?.state === 'requested') {
              // Leave the drain WITHOUT interrupting; the teardown block parks
              // the query. The `handover` field explains why this transition is
              // the commitment. #1269.
              this.handover.state = 'accepted';
              console.log('[CLAUDE-CODE] SUBAGENT_DRAIN: handing the live query to the follow-up turn; sub-agents keep running');
              this.drainExitCause = 'handover';
              // Disarm the grace timer HERE, at the commitment, not in the
              // teardown block: between this break and that block lie a dozen
              // awaits (post-loop teardown has been measured at 152s in this
              // repo). A timer firing in that window calls promptController.end()
              // while the park still looks decidable, so the adoption would fail
              // at push() and kill the very sub-agents this handover preserves.
              // #1269.
              this.clearPromptEndTimer();
              // This read belongs to the query, not to this turn, so it goes with
              // the lease. Same no-op catch as the 'stalled' branch below: nobody
              // may end up awaiting it (disposed lease, or the adopting turn
              // throws first), and it stays awaitable regardless.
              void nextPromise.catch(() => {});
              state.handoverPendingChunk = nextPromise;
              break;
            }
            console.log('[CLAUDE-CODE] Interrupt signal received, breaking streaming loop');
            this.drainExitCause = 'interrupted';
            break;
          }

          if (raceResult.kind === 'stalled') {
            // Abandon the pending next() so its eventual (abort-induced) rejection
            // isn't an unhandled rejection, then tear down the wedged subprocess.
            void nextPromise.catch(() => {});
            const stalledAfterMs = Date.now() - queryStartTime;
            console.error(`[CLAUDE-CODE] STREAM_STALL_DETECTED: no chunk for ${streamStallMs}ms pre-result (chunkCount=${state.chunkCount}, turnElapsed=${stalledAfterMs}ms). Aborting wedged query.`);
            try { this.abortController?.abort(); } catch { /* best effort */ }
            // Throw so the existing catch path logs the error, yields it to the
            // UI, and emits the terminal `complete` -- unwinding the stuck spinner.
            throw new Error(
              `Claude Code stopped responding: no output for ${Math.round(streamStallMs / 1000)}s. `
              + `The model stream went silent (this can happen during a long thinking phase). `
              + `The turn was ended -- send your message again to retry.`,
            );
          }

          if (raceResult.kind === 'chunk-error') {
            // Preserve the pre-existing behavior: an iterator.next() rejection
            // propagates to the catch(iterError) handler below.
            throw raceResult.error;
          }

          const iterResult = raceResult.result;
          if (iterResult.done) {
            this.drainExitCause = 'iterator-done';
            break;
          }
          const rawChunk = iterResult.value;

          const chunk = rawChunk as any;
          state.chunkCount++;

          // Grace-period stdin-close logic. The SDK's `isSingleUserTurn` is
          // false because we always pass an AsyncIterable prompt -- so the
          // SDK does NOT close stdin on `type: 'result'` for us. Instead, we
          // arm a 5s timer on the first result chunk and reset it on every
          // subsequent chunk, ending the prompt controller only after the
          // binary has been silent for the grace period. This lets late
          // can_use_tool requests (the original "Stream closed" trigger)
          // complete on the still-open stdin while still letting the turn
          // finish in a bounded amount of time.
          if (typeof chunk === 'object' && chunk !== null) {
            // A notification-flush result (num_turns=0, no output, emitted on
            // resume before the real turn runs) is NOT end-of-turn. Arming the
            // grace timer on it starts a 5s-silence countdown while the CLI is
            // still working — during a long background sub-agent (minutes of
            // main-stream silence) the timer fires, ends the control channel,
            // and every later canUseTool/hook fails "Stream closed" while the
            // subprocess runs away. Only arm on the REAL result. See NIM-1470.
            const armsGraceTimer = shouldArmGraceTimerForResult(
              chunk,
              state.sawTaskNotificationThisTurn,
              state.sawAssistantOutputThisTurn,
            );
            if (armsGraceTimer && state.resultReceivedTime === null) {
              state.resultReceivedTime = Date.now();
              state.resultReceivedChunkCount = state.chunkCount;
              console.log(`[CLAUDE-CODE] RESULT_MESSAGE_RECEIVED: turnElapsed=${state.resultReceivedTime - queryStartTime}ms chunkCount=${state.chunkCount} subtype="${chunk.subtype}" isError=${chunk.is_error === true}`);
              armPromptEndTimer('grace-period-after-result');
            } else if (state.resultReceivedTime !== null) {
              // Activity continued after the real result -- reset the grace
              // timer so we don't kill stdin while the binary is still working.
              armPromptEndTimer('grace-period-reset-on-activity');
            }
          }

          // Diagnostic: detect a "Stream closed" tool_result at the raw chunk level.
          // Narrow match: only fires when the chunk is a user/tool_result with is_error=true
          // AND the content string contains "Stream closed". Avoids false positives from
          // successful Bash output that happens to contain the phrase (e.g., git log echoing
          // a commit message about the stream-close fix).
          if (typeof chunk === 'object' && chunk !== null && chunk.type === 'user' && Array.isArray(chunk.message?.content)) {
            const hasStreamClosedError = chunk.message.content.some((item: any) =>
              item?.type === 'tool_result'
              && item.is_error === true
              && typeof item.content === 'string'
              && item.content.includes('Stream closed')
            );
            if (hasStreamClosedError) {
              const streamClosedResult = chunk.message.content.find((item: any) =>
                item?.type === 'tool_result'
                && item.is_error === true
                && typeof item.content === 'string'
                && item.content.includes('Stream closed')
              );
              const rawToolUseId = typeof streamClosedResult?.tool_use_id === 'string'
                ? streamClosedResult.tool_use_id
                : undefined;
              const rawToolName = rawToolUseId ? state.toolCallsById.get(rawToolUseId)?.name : undefined;
              const chunkJson = JSON.stringify(chunk);
              const timeSinceResult = state.resultReceivedTime !== null
                ? `${Date.now() - state.resultReceivedTime}ms (result was chunk #${state.resultReceivedChunkCount})`
                : 'result not yet received';
              console.error(`[CLAUDE-CODE] STREAM_CLOSED_RAW_CHUNK: chunkType="${chunk.type}" chunkSubtype="${chunk.subtype}" chunkCount=${state.chunkCount} turnElapsed=${Date.now() - queryStartTime}ms stderrLines=${state.stderrLines.length} timeSinceResult=${timeSinceResult}`);
              console.error(`[CLAUDE-CODE] STREAM_CLOSED_RAW_CHUNK: ${chunkJson.substring(0, 500)}`);
              if (state.stderrLines.length > 0) {
                console.error(`[CLAUDE-CODE] STREAM_CLOSED_RAW_CHUNK stderr: ${state.stderrLines.join('').trim().substring(0, 500)}`);
              }
              this.recordStreamClosedToolFailure({
                sessionId,
                hideMessages,
                toolName: rawToolName,
                resultText: streamClosedResult?.content ?? 'Stream closed',
              });
            }
          }

          // Log raw SDK chunks to database (non-blocking for streaming performance)
          // Extract SDK-provided uuid for deduplication in sync.
          // Skip transient chunk types (hook lifecycle, task progress, tool_progress,
          // auth_status, rate_limit_event): the live dispatch loop above already
          // reacted to them, and the persistent reparse path (ClaudeCodeRawParser)
          // ignores them, so persisting just inflates ai_agent_messages + sync churn.
          if (sessionId && !isTransientClaudeCodeChunk(chunk)) {
            // Two storage passes, both on clones -- the live dispatch loop below
            // still uses the untouched `chunk`:
            //   1. slim: drop dead-weight fields (tool_use_result.originalFile/
            //      patch/etc and thinking signatures) that no consumer reads.
            //   2. cap:  bound oversized tool_result payloads head-and-tail.
            //      tool_use blocks and images pass through at any size.
            const rawChunkJson = typeof chunk === 'string'
              ? JSON.stringify({ type: 'text', content: chunk })
              : JSON.stringify(capClaudeCodeChunkForStorage(slimClaudeCodeChunkForStorage(chunk)));
            // Non-string chunks from SDK have a uuid field we can use for deduplication
            const providerMessageId = typeof chunk !== 'string' ? chunk.uuid : undefined;

            // Determine if this chunk should be searchable (assistant text without tool content)
            // Only assistant messages with text content (no tool_use/tool_result) are searchable
            const isSearchable = isSearchableAssistantChunk(chunk);

            this.logAgentMessageNonBlocking(sessionId, 'claude-code', 'output', rawChunkJson, undefined, hideMessages, providerMessageId, isSearchable);
            // Drive incremental transcript transformation. Without this, the
            // canonical store only advances on the next aiLoadSession from
            // the renderer, which never fires when the user's active session
            // isn't this one -- so widgets keyed on canonical events (e.g.
            // developer_git_commit_proposal's GitCommitConfirmationWidget)
            // never appear when a turn pauses mid-stream waiting on user
            // input. Fire-and-forget so the chunk loop stays responsive;
            // the per-session lock inside TranscriptTransformer serializes
            // concurrent calls and the next chunk picks up anything that
            // hadn't flushed in time.
            this.scheduleTranscriptProcessing(sessionId);
          }

          // if (state.chunkCount <= 5) {
          //     typeof chunk === 'string'
          //       ? { type: 'string', length: chunk.length, preview: chunk.substring(0, 100) }
          //       : JSON.stringify(chunk, null, 2)
          //   );
          // }

          if (!state.firstChunkTime) {
            state.firstChunkTime = Date.now();
            const timeToFirstChunk = state.firstChunkTime - queryStartTime;
            // console.log(`[CLAUDE-CODE] First chunk received in ${timeToFirstChunk}ms from query start`);
            if (timeToFirstChunk > 10000) {
              console.warn(`[CLAUDE-CODE] Time to first chunk was ${timeToFirstChunk}ms (>10s threshold) - possible Windows Defender/antivirus delay during subprocess spawn`);
            }
          }
          // All chunk types go through the adapter. Provider dispatches on parsed items
          // for side effects only -- the adapter owns all parsing and canonical event emission.
          const parsed = transcriptAdapter?.processChunk(chunk) ?? [];
          let breakOuter = false;
          for (const item of parsed) {
            // While draining background sub-agents AFTER the lead turn already
            // emitted `complete`, the only items we still act on are sub-agent
            // task lifecycle events (system_task → activeTasks). Everything else
            // here — sub-agent assistant text, tool calls, usage — must NOT be
            // yielded: the consumer already received isComplete:true and any further
            // text would mutate the finished parent response. See NIM-1344 / #732 (Medium).
            if (state.completeEmitted && this.drainingBackgroundTasks && item.kind !== 'system_task') {
              continue;
            }
            switch (item.kind) {
              case 'text':
                state.fullContent += item.text;
                state.sawAssistantOutputThisTurn = true;
                yield { type: 'text', content: item.text };
                break;

              case 'session_id':
                // Fail loud if we asked the SDK to resume session X and it reports a
                // different session Y. That means resume silently failed (the CLI
                // couldn't find the transcript, the file was corrupt, the --resume
                // flag never made it, etc.) and we'd otherwise happily start a new
                // conversation on top of what the user thinks is an existing thread.
                // Forked sessions are exempt: `forkSession: true` tells the CLI to
                // intentionally emit a new session ID from the source conversation.
                if (options.resume && !options.forkSession && item.id !== options.resume) {
                  const mismatchError = new Error(
                    `[CLAUDE-CODE] Session resume mismatch: requested resume of ` +
                    `"${options.resume}" but SDK reported session "${item.id}". ` +
                    `The prior conversation is not loaded. Aborting so the user sees ` +
                    `the failure rather than silently starting a fresh session.`
                  );
                  console.error(mismatchError.message);
                  throw mismatchError;
                }
                if (sessionId) {
                  this.sessions.captureSessionId(sessionId, item.id);
                }
                break;

              case 'usage':
                state.usageData = item.usage;
                if (item.isPerStep) {
                  state.lastAssistantUsage = item.usage;
                  // Surface context fill live, per assistant step, so the UI's
                  // context indicator updates throughout a long agentic turn
                  // instead of only at the `result` chunk (turn end). This is a
                  // mid-turn snapshot: contextFillTokens ONLY -- cumulative
                  // input/output usage stays on the `complete` chunk to avoid
                  // double-counting. See NIM-868.
                  const stepContextTokens =
                    (item.usage?.input_tokens || 0)
                    + (item.usage?.cache_read_input_tokens || 0)
                    + (item.usage?.cache_creation_input_tokens || 0);
                  if (stepContextTokens > 0) {
                    yield { type: 'context_usage', contextFillTokens: stepContextTokens };
                  }
                }
                if (item.modelUsage) state.modelUsageData = item.modelUsage;
                break;

              case 'context_report':
                // Only ever set on a /context turn. Carried to the `complete`
                // chunk so AIService can use the exact figures instead of
                // re-deriving them from the rendered markdown.
                state.structuredContextUsage = normalizeStructuredContextUsage(item.usage);
                break;

              case 'tool_use': {
                state.toolCallCount++;
                // A tool is now executing; disarm the stall watchdog until its
                // result comes back (main-stream silence is legitimate). NIM-1481.
                state.outstandingToolCalls++;
                state.sawAssistantOutputThisTurn = true;
                const { toolId, toolName, args, isMcp, isSubagent } = item;

                if (toolName === 'TodoWrite' && args?.todos) {
                  this.emitTodoUpdate(sessionId, args.todos as any[]).catch(() => {});
                }

                // The CLI emits ScheduleWakeup tool calls but its tool_result is informational only --
                // nothing in the SDK actually fires the wakeup. Route through Nimbalyst's
                // SessionWakeupScheduler so the prompt is re-queued at fire time.
                if (toolName === 'ScheduleWakeup' && sessionId && workspacePath) {
                  this.handleScheduleWakeupTool(sessionId, workspacePath, args || {}).catch(err => {
                    console.error('[CLAUDE-CODE] handleScheduleWakeupTool failed:', err);
                  });
                }

                const isSdkNativeTool = SDK_NATIVE_TOOLS.includes(toolName);
                const isNimbalystHandled = NIMBALYST_HANDLED_TOOLS.includes(toolName);
                if (!toolName || isMcp || isSdkNativeTool || isNimbalystHandled || isSubagent) {
                  // Handled by SDK, a subagent spawn, or a Nimbalyst side-effect handler above
                } else if (this.toolHandler) {
                  // Unknown, non-MCP, non-whitelisted tool. Almost always means Anthropic
                  // added a new CLI-native tool we haven't added to SDK_NATIVE_TOOLS yet.
                  // Log a warning and treat it as SDK-native rather than routing to our
                  // toolHandler (which will throw "Unknown tool" and can leave the CLI's
                  // control stream in a broken state -- see hook_0 "Stream closed" cascade).
                  console.warn(`[CLAUDE-CODE] Unrecognized tool "${toolName}" not in SDK_NATIVE_TOOLS whitelist; assuming CLI-native and skipping local execution.`);
                }

                const toolCall = { id: toolId, name: toolName, arguments: args };
                state.toolCallsById.set(toolId, toolCall);
                // Yield so AIService can track tool calls (notification text reset,
                // worktree inference, file tracking side effects). Parity with
                // Codex/OpenCode providers -- the result is attached later in
                // `tool_result` and picked up via state.toolCallsById.
                yield { type: 'tool_call', toolCall };
                break;
              }

              case 'tool_result': {
                const toolCall = state.toolCallsById.get(item.toolUseId);
                if (toolCall) {
                  const { isDuplicate, isBackgroundAck } = applyToolResultToToolCall(toolCall, item.content, item.isError);
                  if (isDuplicate) break;
                  // #1341: the harness backgrounded an interactive prompt that
                  // is still waiting on the user. The call is still outstanding
                  // -- don't decrement the watchdog's counter or settle
                  // anything on a result that hasn't arrived yet.
                  if (isBackgroundAck) break;
                  // Tool finished -- re-arm the stall watchdog for the model's
                  // next thinking/generation phase. NIM-1481.
                  state.outstandingToolCalls = Math.max(0, state.outstandingToolCalls - 1);

                  // The result is attached by mutating the object yielded at
                  // tool_use, which a consumer that already handled that chunk
                  // can never observe. Announce the completion so liveness
                  // tracking -- the Git journal behind the menu-bar indicator --
                  // can settle the call instead of spinning until turn end.
                  yield { type: 'tool_result', toolCall };

                  // Diagnostic: detect "Stream closed" errors from the native binary
                  const resultText = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
                  if (item.isError && resultText.includes('Stream closed')) {
                    this.recordStreamClosedToolFailure({
                      sessionId,
                      hideMessages,
                      toolName: extractStreamClosedToolName({
                        isError: item.isError,
                        resultText,
                        toolName: toolCall.name,
                      }) ?? toolCall.name,
                      resultText,
                    });
                    const timeSinceResult = state.resultReceivedTime !== null
                      ? `${Date.now() - state.resultReceivedTime}ms (result was chunk #${state.resultReceivedChunkCount})`
                      : 'result not yet received';
                    const controllerState = this.promptController
                      ? (this.promptController.isEnded() ? 'ended' : 'open')
                      : 'null';
                    console.error(`[CLAUDE-CODE] STREAM_CLOSED_DIAGNOSTIC: tool="${toolCall.name}" toolUseId="${item.toolUseId}" isError=${item.isError} stderrLines=${state.stderrLines.length} chunkCount=${state.chunkCount} turnElapsed=${Date.now() - queryStartTime}ms timeSinceResult=${timeSinceResult} promptController=${controllerState}`);
                    console.error(`[CLAUDE-CODE] STREAM_CLOSED_DIAGNOSTIC: resultText="${resultText.substring(0, 300)}"`);
                    if (state.stderrLines.length > 0) {
                      console.error(`[CLAUDE-CODE] STREAM_CLOSED_DIAGNOSTIC: stderr="${state.stderrLines.join('').trim().substring(0, 500)}"`);
                    }
                  }

                  this.processTeammateToolResult(sessionId, toolCall.name, toolCall.arguments, item.content, toolCall.isError === true, toolCall.id);

                  // Mirror SDK-native task-list mutations into session metadata so
                  // the UI can show the tasks for this session (TaskCreate id is
                  // only available in the result, so capture happens here).
                  if (!toolCall.isError) {
                    this.captureTaskListMutation(sessionId, toolCall.name, toolCall.arguments, item.content);
                  }

                  if (item.toolUseId) {
                    for (const task of this.activeTasks.values()) {
                      // Only settle FOREGROUND tasks here (the tool call blocked
                      // until completion). A backgrounded task's tool_result is a
                      // launch acknowledgement while it is still running; settling
                      // on it killed the task at turn-end teardown. NIM-1470.
                      if (task.toolUseId !== item.toolUseId) continue;
                      // A launch acknowledgement is positive evidence the task
                      // was backgrounded, whatever state it is in by now. The
                      // CLI does not always follow it with a task_updated patch,
                      // so this is how a command launched in the foreground and
                      // then auto-backgrounded gets promoted (#1493) — and, for
                      // a fast task that already reported terminally, it is the
                      // only thing that can release the notification held for
                      // it. Keyed off the content, not off a declined settle:
                      // a terminal task declines for that reason alone and says
                      // nothing about how it was launched. #1410 / #1470.
                      if (isBackgroundLaunchAcknowledgement(item.content)) {
                        if (recordBackgroundEvidence(task, this.drainTerminalNotifications)) {
                          this.emitTaskUpdate(sessionId).catch(() => {});
                        }
                      }
                      if (!shouldSettleTaskFromToolResult(task, item.content)) break;
                      task.status = toolCall.isError ? 'failed' : 'completed';
                      const summaryText = extractToolResultText(item.content);
                      if (summaryText) task.summary = summaryText.substring(0, 200);
                      this.emitTaskUpdate(sessionId).catch(() => {});
                      break;
                    }
                  }
                }
                break;
              }

              case 'error': {
                let errorMessage = item.message;
                const errorChunk = item.chunk;

                if (errorChunk?.type === 'assistant' && errorChunk?.error === 'authentication_failed') {
                  this.logError(sessionId, 'claude-code', new Error(errorMessage), 'assistant_chunk', 'authentication_error', hideMessages);
                  yield { type: 'error', error: errorMessage, isAuthError: true };
                  // No `complete` here -- finishTurn owns terminal completion.
                  breakOuter = true;
                  break;
                }

                if (errorChunk?.type === 'result') {
                  errorMessage = extractResultChunkErrorMessage(errorChunk);
                  const { isAuthError, isExpiredSessionError, isServerError } = detectResultChunkErrorFlags(errorMessage);

                  if (isExpiredSessionError && sessionId) {
                    this.sessions.expireSession(sessionId);
                    errorMessage = 'Your previous conversation session has expired and can no longer be resumed. Please send a new message to start a fresh conversation - your chat history is still visible but the AI will start with a clean context.';
                  }

                  const isBedrockToolError = isBedrockToolSearchError(errorMessage);
                  if (isServerError) errorMessage += '\n\nClaude may be experiencing issues. Check https://status.anthropic.com for service status.';
                  if (isBedrockToolError) errorMessage = buildBedrockToolErrorGuidance(errorMessage);

                  const isRateLimitError = /rate limit/i.test(errorMessage);
                  const is1mModel = this.config.model != null && this.config.model.includes('-1m');
                  if (isRateLimitError && is1mModel) errorMessage += '\n\nThis 1M context model may not be available on your plan.';

                  const errorType = isAuthError ? 'authentication_error' : isBedrockToolError ? 'bedrock_tool_error' : isExpiredSessionError ? 'expired_session_error' : 'api_error';
                  this.logError(sessionId, 'claude-code', new Error(errorMessage), 'result_chunk', errorType, hideMessages);
                  transcriptAdapter?.systemMessage(errorMessage, 'error');

                  yield {
                    type: 'error',
                    error: errorMessage,
                    ...(isAuthError && { isAuthError: true }),
                    ...(isBedrockToolError && { isBedrockToolError: true }),
                    ...(isExpiredSessionError && { isExpiredSessionError: true }),
                    ...(isServerError && { isServerError: true }),
                  };

                  // No `complete` here -- finishTurn owns terminal completion,
                  // and it flushes writes and processes the transcript first.
                  breakOuter = true;
                  break;
                }

                yield { type: 'error', error: errorMessage };
                break;
              }

              // -- Lifecycle items (side effects only, not transcript-relevant) --

              case 'system_init':
                yield* this.handleSystemInit(item.chunk, sessionId, hideMessages);
                break;

              case 'system_task':
                if (item.subtype === 'task_notification') {
                  state.sawTaskNotificationThisTurn = true;
                }
                this.handleSystemTask(item.subtype, item.chunk, sessionId);
                break;

              case 'system_compact':
                state.receivedCompactBoundary = true;
                state.lastAssistantUsage = undefined;
                yield { type: 'text', content: `Conversation compacted (was ${item.preTokens} tokens)` };
                break;

              case 'system_message':
                yield { type: 'text', content: item.text };
                break;

              case 'summary': {
                if (item.isAuthError) {
                  // console.error('[CLAUDE-CODE] Authentication error detected in summary:', item.text);
                  this.logError(sessionId, 'claude-code', new Error(item.text), 'summary_chunk', 'authentication_error', hideMessages);
                  yield { type: 'error', error: item.text, isAuthError: true };
                  // No `complete` here -- finishTurn owns terminal completion.
                  breakOuter = true;
                } else {
                  const displayMessage = item.text
                    ? `[Claude Agent]: ${item.text}`
                    : `[Claude Agent]: ${JSON.stringify(item.chunk)}`;
                  yield { type: 'text', content: displayMessage };
                }
                break;
              }

              case 'auth_status': {
                const authChunk = item.chunk;
                if (authChunk.error || authChunk.isAuthenticating === false) {
                  const errorMessage = authChunk.error || 'Authentication required';
                  // console.error('[CLAUDE-CODE] Auth status error:', errorMessage);
                  this.logError(sessionId, 'claude-code', new Error(errorMessage), 'auth_status_chunk', 'authentication_error', hideMessages);
                  yield { type: 'error', error: errorMessage, isAuthError: true };
                }
                if (authChunk.output?.length > 0) {
                  // console.log('[CLAUDE-CODE] Auth status output:', authChunk.output.join('\n'));
                }
                break;
              }

              case 'rate_limit': {
                const info = item.chunk.rate_limit_info;
                if (info && info.status !== 'allowed') {
                  const resetsAtUnix = info.resetsAt || null;
                  const limitType = info.rateLimitType === 'five_hour' ? '5-hour session' : info.rateLimitType || 'unknown';
                  const utilization = info.utilization != null ? Math.round(info.utilization * 100) : null;
                  const isWarning = info.status === 'allowed_warning';
                  const marker = isWarning ? '[RATE_LIMIT_WARNING]' : '[RATE_LIMIT]';
                  const utilizationStr = utilization != null ? ` usage=${utilization}` : '';
                  const modelStr = this.config.model ? ` model=${this.config.model}` : '';
                  yield { type: 'text', content: `\n\n<!-- ${marker} limitType=${limitType} resetsAtUnix=${resetsAtUnix || 'unknown'}${utilizationStr}${modelStr} -->\n\n` };
                }
                break;
              }

              case 'tool_progress':
              case 'tool_use_summary':
                // Informational only -- handled visually through transcript
                break;

              case 'unknown':
                if (item.extractedText) {
                  yield { type: 'text', content: item.extractedText };
                }
                break;
            }
          }
          if (breakOuter) break;

          // Yield `complete` as soon as the SDK reports the turn is done (`result`
          // chunk). state.usageData / state.lastAssistantUsage / state.modelUsageData were populated
          // by the parsed items above (via `usage` items from the result chunk).
          // The for-await keeps running so stdin stays open for late control
          // requests, but the consumer sees completion immediately.
          // Skip the CLI's "notification flush" result: on resume with pending
          // task notifications the CLI emits an empty success result (num_turns=0)
          // BEFORE processing the queued notification and the user's prompt.
          // Ending the turn here swallows the prompt — the real answer streams
          // afterward. Keep the loop (and the control channel) alive; the real
          // result completes the turn, and the post-loop fallback covers the
          // case where it never arrives. See NIM-1470.
          if (
            typeof chunk === 'object' && chunk !== null && !state.completeEmitted
            && isNotificationFlushResult(chunk, state.sawTaskNotificationThisTurn, state.sawAssistantOutputThisTurn)
          ) {
            console.log('[CLAUDE-CODE] Ignoring notification-flush result (num_turns=0, no output) — awaiting the real turn result');
            continue;
          }

          if (typeof chunk === 'object' && chunk !== null && chunk.type === 'result' && !state.completeEmitted) {
            await this.flushPendingWrites();
            if (sessionId) await this.processTranscriptMessages(sessionId);

            if (this.toolHooksService && this.toolHooksService.getEditedFiles().size > 0) {
              await this.toolHooksService.createTurnEndSnapshots();
            }

            const turnUsage = buildTurnCompleteUsage(state);

            const lastMessageContextTokens = state.lastAssistantUsage
              ? (state.lastAssistantUsage.input_tokens || 0)
                + (state.lastAssistantUsage.cache_read_input_tokens || 0)
                + (state.lastAssistantUsage.cache_creation_input_tokens || 0)
              : undefined;

            transcriptAdapter?.turnEnded(state.usageData, state.modelUsageData);

            // Decide BEFORE yielding `complete` whether background sub-agents will
            // keep this turn draining. The consumer runs willResumeAfterCompletion()
            // synchronously while handling `complete` to decide whether to end the
            // session; the flag must already be set or the deferral (and any later
            // continuation) is lost. See NIM-1344 / GitHub #732 (High).
            // Before that decision, drop tasks whose query is gone; left
            // registered they would open a drain that can never settle. #1269.
            this.reapForeignRunningTasks(sessionId);

            const willDrainSubagents = shouldDeferTeardownForSubagents(this.hasRunningTasks());
            if (willDrainSubagents) {
              this.drainingBackgroundTasks = true;
              this.publishBackgroundWait(sessionId);
            }
            // Same ordering constraint for the "settled during the turn" trigger:
            // willResumeAfterCompletion() reads it while the consumer handles the
            // `complete` yielded just below, and prepareStreamClosedContinuation
            // bails on it so the two paths can't both emit a continuation. #1410.
            this.settledBackgroundTasksThisTurn = shouldFinalizeForSettledBackgroundTasks({
              willDrainSubagents,
              terminalNotificationCount: this.drainTerminalNotifications.length,
            });
            this.prepareStreamClosedContinuation(sessionId, hideMessages);

            yield {
              type: 'complete',
              isComplete: true,
              ...(turnUsage ? { usage: turnUsage } : {}),
              ...(state.modelUsageData ? { modelUsage: state.modelUsageData } : {}),
              ...(lastMessageContextTokens !== undefined ? { contextFillTokens: lastMessageContextTokens } : {}),
              ...(state.structuredContextUsage ? { contextReport: state.structuredContextUsage } : {}),
              ...(state.receivedCompactBoundary ? { contextCompacted: true } : {})
            };
            state.completeEmitted = true;
            // The binary got a turn all the way through; give the next one a
            // fresh crash-retry budget (#1361).
            this.abnormalExitRetryCount = 0;

            // Break out of the chunk loop. The for-await would otherwise stay
            // alive indefinitely on sessions where the binary's task-list
            // `<system-reminder>` hook keeps trying can_use_tool requests over
            // closed stdin (each failure emits a tool_result(Stream closed)
            // chunk that resets the grace timer). Witnessed in the wild as
            // 13+ minute hangs after ScheduleWakeup-driven turns.
            //
            // Because this is a manual `while (true)` loop iterating via
            // iterator.next() (not for-await), `break` does NOT call
            // iterator.return(), so the SDK generator's internal state is
            // preserved for the next turn. The binary subprocess stays alive
            // for session resume (existing finally-block behavior).
            //
            // Teammate drainage at the next block reads from the same
            // leadQuery iterator if pending messages exist, so that flow
            // still works.
            //
            // EXCEPTION (NIM-1344 / #732): if a background sub-agent is still
            // running (activeTasks), do NOT break. The SDK streams that
            // sub-agent's task_progress/task_notification as later chunks on
            // this same iterator; breaking here would close stdin and kill it,
            // and its terminal notification would never reach handleSystemTask.
            // Keep draining until every task reports a terminal status (or the
            // loop exits for another reason, handled by finalizeBackgroundDrain).
            if (willDrainSubagents) {
              console.log(`[CLAUDE-CODE] SUBAGENT_DRAIN: lead turn complete but ${countRunningTasks(this.activeTasks.values())} sub-agent task(s) still running; deferring teardown to drain`);
              continue;
            }
            break;
          }

          // While draining background sub-agents after `complete` was emitted,
          // exit as soon as every task has reported a terminal status.
          if (shouldExitDrain(state.completeEmitted, this.drainingBackgroundTasks, this.hasRunningTasks())) {
            this.drainExitCause = 'resolved';
            console.log('[CLAUDE-CODE] SUBAGENT_DRAIN: all background sub-agent task(s) resolved; ending drain loop');
            break;
          }
        }
      } catch (iterError) {
        // Don't log abort errors - they're expected when user cancels
        const errMessage = (iterError as Error).message || '';
        const isAbort = (iterError as any).name === 'AbortError' || errMessage.includes('aborted');
        // Classify for finalizeBackgroundDrain: an abort/supersede while draining
        // is NOT an unexpected death (no continuation); any other throw is.
        this.drainExitCause = isAbort ? 'aborted' : 'iterator-error';
        if (!isAbort) {
          console.error('[CLAUDE-CODE] Error during iteration:', iterError);
          console.error('[CLAUDE-CODE] Error stack:', (iterError as Error).stack);
        }
        throw iterError;
      }

      // ── Process queued teammate messages via streamInput ──────────────
      // After the main loop exits naturally, drain any pending teammate-to-lead
      // messages. Each is injected as a new user turn on the existing query via
      // streamInput. Skip if the query was interrupted — after interrupt() the
      // transport is dead and streamInput will always fail. Messages stay queued
      // for the finally block to re-trigger via a fresh sendMessage.
      while (this.teammateManager.hasPendingTeammateMessages() && this.leadQuery && !this.wasInterrupted && !this.handover) {
        const nextMsg = this.teammateManager.drainNextTeammateMessage();
        if (!nextMsg) break;

        const formattedMessage = `[Teammate message from "${nextMsg.teammateName}"]\n\n${nextMsg.content}`;
        console.log(`[CLAUDE-CODE] Processing queued teammate message via streamInput: "${nextMsg.summary}"`);

        // Log the injected user message to the DB so the conversation is complete.
        // Uses non-blocking since we're mid-turn and don't need to await persistence.
        if (sessionId) {
          this.logAgentMessageNonBlocking(
            sessionId, 'claude-code', 'input',
            JSON.stringify({ prompt: formattedMessage }),
            { messageType: 'teammate_message_injected', teammateName: nextMsg.teammateName }
          );
        }

        try {
          await this.leadQuery.streamInput(
            this.teammateManager.createInjectedUserMessageStream(formattedMessage)
          );
        } catch (streamErr) {
          console.warn('[CLAUDE-CODE] streamInput failed for teammate message:', streamErr);
          // Lead transport is dead. Re-queue the message so the finally block
          // can re-trigger delivery via a fresh sendMessage call.
          this.teammateManager.requeueTeammateMessage(nextMsg);
          this.transportDied = true;
          break;
        }

        // Consume output from the new turn (same chunk processing)
        try {
          for await (const rawChunk of (this.leadQuery as AsyncIterable<any>)) {
            if (this.abortController?.signal.aborted) {
              console.log('[CLAUDE-CODE] Abort signal detected during teammate message processing');
              break;
            }
            const chunk = typeof rawChunk === 'string' ? rawChunk : rawChunk;

            if (typeof chunk === 'string') {
              state.fullContent += chunk;
              yield { type: 'text', content: chunk };
            } else if (chunk && typeof chunk === 'object') {
              if (chunk.type === 'result') {
                if (chunk.usage) {
                  state.usageData = {
                    ...(state.usageData || {}),
                    input_tokens: (state.usageData?.input_tokens || 0) + (chunk.usage.input_tokens || 0),
                    output_tokens: (state.usageData?.output_tokens || 0) + (chunk.usage.output_tokens || 0),
                  };
                }
              } else if (chunk.type === 'assistant' && chunk.message?.content) {
                for (const block of chunk.message.content) {
                  if (block.type === 'text' && block.text) {
                    state.fullContent += block.text;
                    yield { type: 'text', content: block.text };
                  } else if (block.type === 'tool_use') {
                    state.toolCallCount++;
                    if (sessionId) {
                      this.logAgentMessageNonBlocking(
                        sessionId, 'claude-code', 'output',
                        JSON.stringify(block),
                        { messageType: 'tool_use', toolName: block.name }
                      );
                    }
                  } else if (block.type === 'tool_result') {
                    if (sessionId) {
                      this.logAgentMessageNonBlocking(
                        sessionId, 'claude-code', 'output',
                        JSON.stringify(block),
                        { messageType: 'tool_result' }
                      );
                    }
                  }
                }
              }
            }
          }
        } catch (iterError) {
          const errMessage = (iterError as Error).message || '';
          const isAbort = (iterError as any).name === 'AbortError' || errMessage.includes('aborted');
          if (!isAbort) {
            console.error('[CLAUDE-CODE] Error during teammate message iteration:', iterError);
          }
          throw iterError;
        }
      }

      // Slash-command-produced-nothing check and the terminal `complete`
      // (skipped when the `result` chunk already emitted one).
      yield* finishTurn(this.epilogueHost(), state, { sessionId, transcriptAdapter });

    } catch (error: any) {
      const outcome = yield* handleTurnError(
        {
          ...this.epilogueHost(),
          getResumeSessionId: (sid) => this.sessions.getSessionId(sid),
          checkSessionExists: (claudeSessionId) => this.checkSessionExists(claudeSessionId),
          getAbnormalExitRetryCount: () => this.abnormalExitRetryCount,
          maxAbnormalExitRetries: ClaudeCodeProvider.MAX_ABNORMAL_EXIT_RETRIES,
          consumeAbnormalExitRetry: () => { this.abnormalExitRetryCount++; },
        },
        state,
        error,
        sessionId,
      );
      if (outcome.retry) {
        // sendMessage consumes this flag at entry, so restore it for the retry.
        this.markMessagesAsHidden = state.hideMessages;
        yield* this.sendMessage(
          state.originalMessage,
          documentContext,
          sessionId,
          messages,
          workspacePath,
          attachments,
        );
        return;
      }
    } finally {
      // Don't stop MCP health checks or clear mcpQuery between turns -
      // the SDK subprocess stays alive for session resume, so MCP operations
      // (health checks, reconnect) should keep working between turns.
      // They are cleaned up in abort() and when the provider is destroyed.
      // Kept for finalizeBackgroundDrain: after a drain, the subprocess must be
      // closed (not just stdin-ended) or it runs a doomed continuation turn
      // against the torn-down control channel and leaks. NIM-1470.
      // A handover parks these as a lease instead of tearing them down, so the
      // query and its controller come out together as the recorded pair. #1269.
      const { query: queryForDrainCleanup, abortController: abortControllerForLease } =
        this.takeOwnedQueryParts();
      ClaudeCodeProvider.streamingInstances.delete(this);
      this.abortController = null;
      // Captured before the reset below: the reap decision a few lines down
      // needs to know this turn was interrupted, and by then the field is gone.
      const interruptedThisTurn = this.wasInterrupted;
      this.wasInterrupted = false;
      this.interruptResolve = null;
      // End the persistent prompt stream so the SDK's streamInput generator
      // returns and closes the binary's stdin pipe cleanly. Safety net for
      // turns where the grace timer never armed (no result chunk received,
      // e.g. error path) or the controller is still open for some reason.
      // Idempotent inside the controller. Also clear the grace timer so it
      // can't fire after we're gone. (A handover exit already disarmed it; this
      // covers every other exit.)
      this.clearPromptEndTimer();
      const parkedThisTurn = this.settleHandover({
        query: queryForDrainCleanup,
        promptController: this.promptController,
        abortController: abortControllerForLease,
        toolHooksService: turnToolHooks,
        exitCause: this.drainExitCause,
        pendingChunk: state.handoverPendingChunk,
        sessionId,
        optionsSignature: state.queryOptionsSignature,
      });
      if (parkedThisTurn) {
        // The lease owns the prompt controller now; ending it here would close
        // the stdin the parked sub-agents are running on.
        this.promptController = null;
      } else if (this.promptController) {
        this.promptController.end('sendMessage-finally');
        this.promptController = null;
      }

      // Finalize any deferred background sub-agent drain. Runs here — AFTER
      // leadQuery is nulled and the prompt controller is ended — so the
      // subagents:drainSettled handler's isLeadBusy() check reads false and can
      // actually release the deferred session. Reads drainExitCause /
      // drainingBackgroundTasks, so reset those only afterward. NIM-1344 / #732.
      // Skipped when the query was parked: nothing to close, nothing to reap.
      if (!parkedThisTurn) {
        this.finalizeBackgroundDrain(sessionId, queryForDrainCleanup);
      }
      this.reapTasksOfEndedAdoptedTurn(
        { query: queryForDrainCleanup, abortController: abortControllerForLease, sessionId },
        {
          adoptedLease: state.adoptedLease,
          parkedForHandover: parkedThisTurn,
          wasDraining: this.drainingBackgroundTasks,
          wasInterrupted: interruptedThisTurn,
        },
      );
      // A parked query keeps its sub-agents running: only this TURN ended, the
      // drain did not. Clearing the flag here would claim the opposite for the
      // whole handover window. The adopting turn resets it for itself, and
      // disposeParkedLease() clears it when no turn ever adopts. #1269.
      if (!parkedThisTurn) {
        this.drainingBackgroundTasks = false;
      }
      this.publishBackgroundWait(sessionId);
      this.drainExitCause = 'resolved';
      this.drainTerminalNotifications = [];
      this.drainGraceExpired = false;
      this.settledBackgroundTasksThisTurn = false;

      // Note: markMessagesAsHidden is reset at the START of sendMessage to prevent race conditions

      // Skipped on a handover: this turn has not really ended, and the teammate
      // path delivers its own message from interruptWithMessage(). #1269.
      if (!parkedThisTurn) {
        this.handlePostLeadTurnTeammateState(sessionId, hideMessages);
      }
      this.emitPreparedStreamClosedContinuation(sessionId);
      this.finishStreamClosedTurnState();

      this.transportDied = false;
    }
  }

  abort(): void {
    console.log('[CLAUDE-CODE] Abort called, abortController:', this.abortController ? 'exists' : 'NULL');
    this.streamClosedRetryCount = 0;
    this.abnormalExitRetryCount = 0;
    this.resetStreamClosedTurnState();

    // Resolve the interrupt promise so the Promise.race in the streaming loop
    // settles immediately, preventing the loop from hanging on a dead transport.
    if (this.interruptResolve) {
      this.interruptResolve();
      this.interruptResolve = null;
    }

    // End the persistent prompt stream so the SDK can close stdin. The finally
    // block in sendMessage will also handle this, but aborts can fire while
    // the for-await is mid-iteration -- if we don't end the controller here,
    // the SDK's streamInput stays blocked on its endPromise and the for-await
    // can hang waiting for chunks that never come from the dead transport.
    this.clearPromptEndTimer();
    if (this.promptController) {
      this.promptController.end('abort');
    }

    // A parked lease holds a query the user cannot see and super.abort() cannot
    // reach — its abort controller is the lease's, not this.abortController.
    // Stop means stop, so tear it down here. #1269.
    this.disposeParkedLease('abort');

    // Call base class abort (handles abortController and rejectAllPendingPermissions)
    super.abort();

    // Clean up Claude Code-specific pending user interactions
    this.rejectAllPendingConfirmations();
    this.rejectAllPendingQuestions();

    // Abort all managed teammates
    this.teammateManager.killAll();

    // Background sub-agent tasks run inside the subprocess we just killed, so
    // their terminal task_notification can never arrive. Left 'running', they
    // make the NEXT turn's `result` defer teardown and burn the whole drain
    // grace on work nobody is waiting for -- the session sits 'running' and
    // its queued prompts stall behind it. NIM-2458.
    const orphanedTasks = reapRunningTasks(this.activeTasks.values());
    if (orphanedTasks.length > 0) {
      console.warn(`[CLAUDE-CODE] SUBAGENT_TASK: abort orphaned ${orphanedTasks.length} running task(s); marking stopped. tasks=[${orphanedTasks.join(', ')}]`);
      this.emitTaskUpdate(this.currentSessionId).catch(() => {});
    }

    // Clean up MCP health checks and persistent query reference
    this.stopMcpHealthChecks();
    this.mcpQuery = null;
    this.currentSessionId = undefined;
  }

  // Per-session "transcript processing already scheduled" flag. The streaming
  // chunk loop fires scheduleTranscriptProcessing per chunk, so without this
  // we'd queue one processNewMessages run per chunk; the per-session lock
  // inside TranscriptTransformer would serialize them, but we'd still pay N
  // DB roundtrips for what could have been one. Setting the flag at schedule
  // time and clearing it when the run starts coalesces bursts of chunks into
  // at most one in-flight run + one queued run per session.
  private transcriptProcessingScheduled: Set<string> = new Set();

  /**
   * Schedule a non-blocking pass over any unprocessed rows in
   * ai_agent_messages for this session. Mirrors what OpenCodeProvider,
   * CopilotCLIProvider, and OpenAICodexACPProvider do synchronously, but
   * fired-and-forgotten so the high-throughput Claude Code chunk loop stays
   * responsive. End-of-turn callers should still `await
   * processTranscriptMessages` directly to guarantee post-flush consistency.
   */
  private scheduleTranscriptProcessing(sessionId: string): void {
    if (!TranscriptMigrationRepository.hasService()) return;
    if (this.transcriptProcessingScheduled.has(sessionId)) return;
    this.transcriptProcessingScheduled.add(sessionId);
    queueMicrotask(() => {
      this.transcriptProcessingScheduled.delete(sessionId);
      void this.processTranscriptMessages(sessionId);
    });
  }

  /**
   * Drive the canonical transcript transformer forward for this session.
   * Best-effort: failures here must not abort the streaming turn, and the
   * next call (or end-of-turn aiLoadSession from the renderer) will catch
   * up. Without this, canonical events only get materialized when the
   * renderer's active session is read, so mid-turn widgets (the commit
   * proposal pending widget, AskUserQuestion, ExitPlanMode) never appear
   * when the user is viewing a different session.
   */
  private async processTranscriptMessages(sessionId: string): Promise<void> {
    try {
      if (TranscriptMigrationRepository.hasService()) {
        await TranscriptMigrationRepository.getService().processNewMessages(
          sessionId,
          'claude-code',
        );
      }
    } catch {
      // Best effort -- next chunk or post-flush call will catch up.
    }
  }

  private async maybeApplyDefaultSessionPhase(sessionId: string): Promise<void> {
    if (this.sessionPhaseFallbackAppliedFor.has(sessionId)) return;

    try {
      const { AISessionsRepository } = await import('../../../storage/repositories/AISessionsRepository');
      const session = await AISessionsRepository.get(sessionId);
      if (!session) return;
      // Raw store row: SQLite returns the flag as 0/1.
      if (fromDbBoolean(session.hasBeenNamed)) return;

      // Default phase fallback — only if the metadata tool or a prior turn has
      // not set a phase. Tags remain owned by the required metadata-tool call;
      // a second paid SDK side request duplicated that work and disturbed the
      // main conversation's prompt-cache policy.
      this.sessionPhaseFallbackAppliedFor.add(sessionId);
      const existingPhase = (session.metadata as any)?.phase;
      if (!existingPhase) {
        const fallbackMetadata = { phase: 'planning' };
        await AISessionsRepository.updateMetadata(sessionId, {
          metadata: fallbackMetadata,
        });
        // Mirror the broadcast/sync that SessionNamingService does for the
        // MCP-tool path so the kanban and iOS pick up the phase write.
        this.emit('session:metadata-updated', { sessionId, metadata: fallbackMetadata });
      }
    } catch (error) {
      // Best-effort -- never let fallback metadata disrupt the main session.
      console.warn('[CLAUDE-CODE] Session phase fallback failed:', (error as Error)?.message ?? error);
    }
  }

  /**
   * Interrupt the current turn so the session completes early.
   * The streaming loop breaks, the 'complete' chunk is still yielded,
   * and the AIService completion handler runs normally (including queue processing).
   * This is a graceful stop — unlike abort(), it doesn't kill the SDK subprocess.
   *
   * If there is no active lead query, defer to the BaseAIProvider default
   * (hard abort) so the caller still gets a sensible signal back, and report
   * `hadActiveTurn: false` — with no query and (usually) no abortController
   * that abort is a no-op, so the caller has to clear the session's live state
   * itself or a stuck-running session strands its queue forever (NIM-2434).
   */
  async interruptCurrentTurn(followUp?: TurnHandoverCandidate | null): Promise<InterruptTurnResult> {
    if (!this.leadQuery) {
      console.log('[CLAUDE-CODE] interruptCurrentTurn: no active lead query, falling back to abort');
      const outcome = await super.interruptCurrentTurn();
      return { ...outcome, hadActiveTurn: false };
    }

    // With only background sub-agents keeping the query open there is no lead
    // generation to interrupt — an interrupt would merely destroy them and lose
    // their results. Park the query for the follow-up turn instead; `followUp`
    // is what proves such a turn is actually coming. #1269.
    if (await this.requestQueryHandover('interruptCurrentTurn', followUp)) {
      return { method: 'handover' };
    }

    // The handover request can outlive the turn it was made against: the wait
    // ends when the teardown settles it, and by then the `finally` has nulled
    // leadQuery. Interrupting anyway would set wasInterrupted for a turn that no
    // longer exists — it survives into the NEXT turn's finally and suppresses
    // that turn's teammate delivery. `hadActiveTurn: false` instead lets the
    // caller force the session idle, so a prompt waiting behind `session-busy`
    // can dispatch. #1269.
    if (!this.leadQuery) {
      console.warn('[CLAUDE-CODE] interruptCurrentTurn: the turn ended while the handover was in flight; nothing left to interrupt');
      return { method: 'interrupt', hadActiveTurn: false };
    }

    console.log('[CLAUDE-CODE] interruptCurrentTurn: interrupting active lead query');
    this.abandonHandoverForInterrupt('interruptCurrentTurn');
    this.wasInterrupted = true;

    // Resolve the interrupt promise so the Promise.race in the streaming loop
    // settles immediately without waiting for the SDK subprocess.
    if (this.interruptResolve) {
      this.interruptResolve();
      this.interruptResolve = null;
    }

    try {
      await this.leadQuery.interrupt();
    } catch (err) {
      console.warn('[CLAUDE-CODE] interruptCurrentTurn: interrupt() failed (transport may be closed):', err);
    }

    // Background sub-agent tasks stream their task_notification on the query we
    // just interrupted, and the streaming loop breaks on that interrupt, so a
    // terminal status can no longer reach handleSystemTask -- the same reason
    // abort() reaps them. Left 'running', they make the NEXT turn's `result`
    // defer teardown to the drain loop: the session sits 'running' with its
    // queued prompts stalled behind it, and a silent drain then tells the
    // session a sub-agent was interrupted when none was. #1269.
    const orphanedTasks = reapRunningTasks(this.activeTasks.values());
    if (orphanedTasks.length > 0) {
      console.warn(`[CLAUDE-CODE] SUBAGENT_TASK: interrupt orphaned ${orphanedTasks.length} running task(s); marking stopped. tasks=[${orphanedTasks.join(', ')}]`);
      this.emitTaskUpdate(this.currentSessionId).catch(() => {});
    }

    return { method: 'interrupt' };
  }

  /**
   * Ask the streaming loop to leave its drain WITHOUT interrupting, so the
   * `finally` block parks the live query as a lease for the follow-up turn.
   *
   * Returns false when there is nothing to hand over, or when the loop did not
   * reach its finally in time — the caller then falls back to a real interrupt.
   * Waiting is not cosmetic: callers dispatch the follow-up turn as soon as this
   * resolves, and a turn that starts before the park would open a second query
   * while the first one has no owner. #1269.
   */
  private async requestQueryHandover(
    caller: string,
    followUp: TurnHandoverCandidate | null | undefined,
  ): Promise<boolean> {
    if (!this.leadQuery || !this.drainingBackgroundTasks) return false;
    // Only park when the adopting turn is already known to exist and to be
    // adoptable. Parking speculatively meant every case where no adopting turn
    // followed had to be caught afterwards. #1269.
    if (followUp?.canAdoptQuery !== true) return false;
    // A handover already in flight owns the loop's exit; a second requester
    // would overwrite its resolver and leave it waiting for a settle that never
    // comes. Let it fall back to a real interrupt instead.
    if (this.handover) return false;

    console.log(`[CLAUDE-CODE] ${caller}: only background sub-agents hold the query open; handing it to the follow-up turn instead of interrupting`);
    let settle!: (parked: boolean) => void;
    const parked = new Promise<boolean>(resolve => { settle = resolve; });
    this.handover = { state: 'requested', resolveParked: settle };
    // Wake the loop's race so it leaves the drain now instead of waiting for the
    // next chunk — a quiet sub-agent can be silent for minutes.
    if (this.interruptResolve) {
      this.interruptResolve();
      this.interruptResolve = null;
    }
    const raced = await Promise.race([
      parked.then(didPark => ({ timedOut: false, didPark })),
      new Promise<{ timedOut: true; didPark: false }>(resolve =>
        setTimeout(() => resolve({ timedOut: true, didPark: false }),
          ClaudeCodeProvider.HANDOVER_PARK_TIMEOUT_MS)),
    ]);

    if (!raced.timedOut) {
      if (!raced.didPark) {
        console.warn(`[CLAUDE-CODE] ${caller}: the turn ended without parking (cause=${this.drainExitCause}); falling back to interrupt`);
      }
      return raced.didPark;
    }

    // Timed out. Whether that means "fall back" depends on how far the loop got:
    // once it ACCEPTED, interrupting now would destroy exactly the sub-agents
    // the handover preserves, and post-loop teardown routinely outlasts this
    // budget. The teardown always settles the promise, so waiting terminates.
    if (this.handover?.state === 'accepted') {
      console.warn(`[CLAUDE-CODE] ${caller}: park timeout elapsed but the loop already accepted the handover; waiting for teardown instead of interrupting`);
      return await parked;
    }

    console.warn(`[CLAUDE-CODE] ${caller}: handover did not park in time; falling back to interrupt`);
    if (this.handover) this.handover = { state: 'abandoned', resolveParked: null };
    return false;
  }

  /**
   * A second interrupt is about to kill the query an earlier handover is still
   * waiting to park. Post-loop teardown has been measured at 152s here, and a
   * request arriving inside that window is turned away by the single-slot guard
   * above, so its caller falls back to a real interrupt on a query the teardown
   * still intends to hand on. Parking it then leaves the lease holding a dead
   * transport that `push()` reports success on anyway (SDK assumption 4 at the
   * adoption site) — the follow-up turn adopts and the user's message is gone
   * without a trace, unnoticed because `wasInterrupted` is reset in the
   * `finally` before the park is decided and the abort controller never fired.
   * Marking the handover abandoned routes settleHandover() through its teardown
   * branch instead; the waiter's resolver stays in place because it is still
   * owed an answer. #1269.
   */
  private abandonHandoverForInterrupt(caller: string): void {
    if (!this.handover || this.handover.state === 'abandoned') return;
    console.warn(`[CLAUDE-CODE] ${caller}: interrupting while a handover was ${this.handover.state}; abandoning the park so the query's sub-agents are reaped`);
    this.handover = { state: 'abandoned', resolveParked: this.handover.resolveParked };
  }

  /** Release the query this provider owns with its abort controller, clearing both slots. */
  private takeOwnedQueryParts(): { query: Query | null; abortController: AbortController | null } {
    const query = this.leadQuery;
    const abortController = this.leadQueryAbortController;
    this.leadQuery = null;
    this.leadQueryAbortController = null;
    return { query, abortController };
  }

  /**
   * Teardown half of the handover: park the query as a lease, or leave it to
   * normal teardown, and settle whoever is waiting on the answer — on every
   * outcome, carrying whether the park really happened, so a waiter can never
   * block on a park that was decided against. resolveHandoverPark() holds the
   * whole decision. #1269.
   *
   * @returns whether the query was parked; the caller keeps the prompt
   *   controller alive in that case, because the lease now owns it.
   */
  private settleHandover(parts: {
    query: Query | null;
    promptController: PromptStreamController | null;
    abortController: AbortController | null;
    toolHooksService: AgentToolHooks;
    exitCause: DrainExitCause;
    pendingChunk?: Promise<IteratorResult<any>> | null;
    sessionId?: string | undefined;
    optionsSignature?: string;
  }): boolean {
    const decision = resolveHandoverPark({
      state: this.handover?.state ?? null,
      exitCause: parts.exitCause,
      hasLiveQuery: !!parts.query,
      hasPromptController: !!parts.promptController,
      promptStreamEnded: parts.promptController?.isEnded() === true,
      hasAbortController: !!parts.abortController,
      abortSignalFired: parts.abortController?.signal.aborted === true,
    });

    let parked = false;
    if (decision === 'park') {
      // Ending the prompt stream, aborting or closing here would kill the
      // background sub-agents this handover exists to preserve. The assertions
      // restate for the type checker what 'park' already guarantees.
      this.parkedLease = {
        query: parts.query!,
        promptController: parts.promptController!,
        abortController: parts.abortController!,
        toolHooksService: parts.toolHooksService,
        generation: this.queryGeneration,
        sessionId: parts.sessionId,
        optionsSignature: parts.optionsSignature ?? '',
        pendingChunk: parts.pendingChunk ?? null,
        terminalNotifications: this.drainTerminalNotifications,
      };
      this.armParkedLeaseWatchdog();
      parked = true;
    } else if (parts.exitCause === 'handover') {
      // The loop committed to a handover, but the park could not happen. Leaving
      // the cause at 'handover' would run the normal teardown with
      // classifyDrainOutcome('handover'), which closes the query while reporting
      // its sub-agents as still running — the pinned "Thinking…" from a second
      // door. Name the exit for what it was so they are reaped. #1269.
      console.warn(`[CLAUDE-CODE] SUBAGENT_DRAIN: the loop left the drain for a handover but the lease could not be parked (query=${!!parts.query} promptController=${!!parts.promptController} promptStreamEnded=${parts.promptController?.isEnded() === true} abortController=${!!parts.abortController} aborted=${parts.abortController?.signal.aborted === true}); tearing the query down as an interrupt instead`);
      this.drainExitCause = 'interrupted';
    }

    const resolveParked = this.handover?.resolveParked ?? null;
    this.handover = null;
    resolveParked?.(parked);
    return parked;
  }

  /**
   * Take the parked lease for this turn, but only if the turn's prompt actually
   * lands on it. The delivery IS the adoption: going ahead after a failed push
   * would run the turn on a query that never received the user's message — lost
   * in silence, the failure class this whole change exists to remove. Disposing
   * instead is safe only because nothing has been committed yet here: the turn's
   * own query, prompt stream and abort controller are all still untouched.
   *
   * The slot is cleared by the caller once it has taken ownership, not here:
   * clearing at read time left a window in which the lease was referenced by
   * nothing but a local, so a throw before the new owner was wired up lost the
   * query and its sub-agents outright. #1269.
   */
  private adoptParkedLeaseFor(
    content: string | ContentBlockParam[],
    optionsSignature: string,
  ): ClaudeCodeProvider['parkedLease'] {
    const candidate = this.parkedLease;
    if (!candidate) return null;

    if (candidate.optionsSignature !== optionsSignature) {
      console.warn(`[CLAUDE-CODE] SUBAGENT_DRAIN: the follow-up turn runs with different query options than the parked query (parked="${candidate.optionsSignature}" now="${optionsSignature}"); disposing the lease and opening a fresh query so the new settings actually apply`);
      this.disposeParkedLease('follow-up turn changed the query options', false);
      return null;
    }

    if (!candidate.promptController.push(buildInjectedUserMessage(content))) {
      console.warn('[CLAUDE-CODE] SUBAGENT_DRAIN: the parked prompt stream was closed before the follow-up prompt could be delivered; disposing the lease and opening a fresh query so the message still arrives');
      this.disposeParkedLease('prompt stream closed before adoption', false);
      return null;
    }

    return candidate;
  }

  /** Hand the lease slot over to the turn that has just taken ownership. */
  private releaseAdoptedLease(): void {
    this.clearParkedLeaseWatchdog();
    this.parkedLease = null;
  }

  /** Give the parked lease an expiry date; see resolveParkedLeaseMaxAgeMs(). */
  private armParkedLeaseWatchdog(): void {
    this.clearParkedLeaseWatchdog();
    this.parkedLeaseWatchdog = setTimeout(() => {
      this.parkedLeaseWatchdog = null;
      this.disposeParkedLease('never adopted');
    }, resolveParkedLeaseMaxAgeMs());
  }

  private clearParkedLeaseWatchdog(): void {
    if (this.parkedLeaseWatchdog) {
      clearTimeout(this.parkedLeaseWatchdog);
      this.parkedLeaseWatchdog = null;
    }
  }

  /**
   * Report and reap running tasks that belong to a query this provider no
   * longer owns. Loud on purpose: reaching this means some exit path closed a
   * query without reaping its tasks, and the log line names what to fix. #1269.
   */
  private reapForeignRunningTasks(sessionId: string | undefined): void {
    const foreign = findForeignRunningTasks(this.activeTasks.values(), this.queryGeneration);
    if (foreign.length === 0) return;

    for (const task of foreign) {
      console.warn(`[CLAUDE-CODE] SUBAGENT_TASK: task ${task.taskId ?? 'unknown'} ("${task.description || 'unknown task'}") is still running under query generation ${task.queryGeneration ?? 'none'} while this turn owns generation ${this.queryGeneration}; its query is gone, so no notification can settle it. Marking stopped.`);
      task.status = 'stopped';
    }
    this.emitTaskUpdate(sessionId).catch(() => {});
  }

  /**
   * Tear down a parked lease that no turn will adopt. Every exit that ends a
   * handover without an adopting turn routes through here: a follow-up prompt
   * that cannot adopt, abort(), destroy(), and the expiry watchdog. #1269.
   */
  private disposeParkedLease(reason: string, announceDrainSettled = true): void {
    this.clearParkedLeaseWatchdog();
    const lease = this.parkedLease;
    if (!lease) return;
    this.parkedLease = null;

    console.warn(`[CLAUDE-CODE] SUBAGENT_DRAIN: disposing parked query (${reason}); its background sub-agents go with it`);
    this.tearDownOwnedQuery(lease, `parked query disposed (${reason})`);

    // The park left the drain flag standing because the sub-agents were still
    // running. They just died with the query, so withdraw the claim here —
    // otherwise the next turn defers its teardown for work that is gone.
    this.drainingBackgroundTasks = false;
    this.publishBackgroundWait(lease.sessionId);

    // The park had skipped finalizeBackgroundDrain, so this is the last exit and
    // nobody else announces it; consumers waiting on the deferred session end
    // (see MessageStreamingHandler) hang otherwise. Suppressed when the caller
    // is starting a turn of its own right now: that turn owns the end. #1269.
    if (announceDrainSettled) {
      this.emitDrainSettled(lease.sessionId, `parked query disposed (${reason})`);
    }
  }

  /**
   * Announce that the background drain has finished for this session. Kept in
   * one place because every exit that ends a drain must announce it the same
   * way: the consumer defers the session end while sub-agents run and only
   * releases it on this event. Teammate work still in flight keeps the session
   * alive on its own path (teammates:allCompleted), so it suppresses the
   * release here. See #732 and #1269.
   */
  private emitDrainSettled(sessionId: string | undefined, reason: string): void {
    if (!sessionId) return;
    if (
      this.teammateManager.hasActiveTeammates()
      || this.teammateManager.hasPendingTeammateMessages()
    ) {
      return;
    }
    console.log(`[CLAUDE-CODE] SUBAGENT_DRAIN: drain settled (${reason}); releasing deferred session end for ${sessionId}`);
    this.emit('subagents:drainSettled', { sessionId });
  }

  /**
   * The last step of a turn's teardown: a turn that adopted a lease inherited
   * background tasks older than itself, and see shouldReapAdoptedTasks() for
   * when nothing else reaps them. Reads `drainingBackgroundTasks`, so the caller
   * runs it before resetting the per-turn drain state. #1269.
   */
  private reapTasksOfEndedAdoptedTurn(
    parts: {
      query: Query | null;
      abortController: AbortController | null;
      sessionId: string | undefined;
    },
    // `wasDraining` and `wasInterrupted` are passed in, not read from `this`:
    // the finally resets both around this call, so reading them here would make
    // correctness depend on that ordering. #1269.
    turn: {
      adoptedLease: boolean;
      parkedForHandover: boolean;
      wasDraining: boolean;
      wasInterrupted: boolean;
    },
  ): void {
    const reap = shouldReapAdoptedTasks({
      adoptedLease: turn.adoptedLease,
      parkedForHandover: turn.parkedForHandover,
      wasDraining: turn.wasDraining,
      ownsQuery: !!parts.query,
      // The interrupt leaves no owner for this query, and it has already
      // stopped the tasks that would otherwise ask for the teardown. #1269.
      wasInterrupted: turn.wasInterrupted,
      // With nothing left running there is nothing to reap, and the query is
      // healthy: tearing it down would cold-start the subprocess after every
      // handover turn. #1269.
      hasRunningTasks: this.hasRunningTasks(),
    });
    if (!reap) return;
    this.tearDownOwnedQuery(parts, 'adopted turn ended outside a drain');
  }

  /**
   * Close a query this provider owns and reap the background tasks that were
   * running inside it. The reap is the point: those tasks ran in the subprocess
   * being closed, so their terminal `task_notification` can never arrive — left
   * registered they pin the next turn in a drain that can never settle, same
   * reasoning as abort(). #1269.
   */
  private tearDownOwnedQuery(
    parts: {
      query?: Query | null;
      promptController?: PromptStreamController | null;
      abortController?: AbortController | null;
      /**
       * The session the torn-down query belonged to. Passed in because
       * `currentSessionId` is routinely empty on the paths that reach here, and
       * the task update would then never reach the UI. #1269.
       */
      sessionId?: string | undefined;
    },
    reason: string,
  ): void {
    try {
      parts.promptController?.end(`query-teardown:${reason}`);
    } catch { /* best effort — the controller may already be closed */ }
    try {
      parts.abortController?.abort();
    } catch { /* best effort */ }
    try {
      parts.query?.close?.();
    } catch { /* best effort — the process may already have exited */ }

    const stranded = reapRunningTasks(this.activeTasks.values());
    if (stranded.length > 0) {
      console.warn(`[CLAUDE-CODE] SUBAGENT_TASK: ${reason} left ${stranded.length} running task(s) with no live query; marking stopped. tasks=[${stranded.join(', ')}]`);
      this.emitTaskUpdate(parts.sessionId ?? this.currentSessionId).catch(() => {});
    }
  }

  /**
   * Interrupt the lead agent's current turn and queue a teammate message
   * to be delivered as a new user turn via streamInput.
   *
   * - If the lead is idle (no active query): stores the message for the next
   *   sendMessage() call and emits an event so AIService can trigger processing.
   * - If the lead has an active query: attempts interrupt() so the sendMessage()
   *   loop can inject the message via streamInput on the live transport. If the
   *   transport is already dead (turn finished but generator hasn't reached
   *   finally yet), interrupt() will fail gracefully and the message stays
   *   queued for the finally block to handle via resume.
   */
  async interruptWithMessage(message: string): Promise<void> {
    // A real teammate message arrived — reset the continuation guard so
    // the lead can get another continuation if its next turn also ends
    // with active teammates.
    this.continuationCount = 0;

    if (!this.leadQuery) {
      // Guard against duplicate idle triggers: if a teammate:messageWhileIdle event
      // was already emitted but sendMessage hasn't started yet, don't drain another.
      // The pending sendMessage will process the queue via its while loop.
      if (this.teammateIdleMessagePending) {
        console.log('[CLAUDE-CODE] interruptWithMessage: idle message already pending, skipping duplicate trigger');
        return;
      }

      const pendingMessageBatch = this.drainAndFormatPendingTeammateMessages();
      if (!pendingMessageBatch) return;

      console.log(`[CLAUDE-CODE] interruptWithMessage: lead is idle, triggering sendMessage for ${pendingMessageBatch.count} message(s): "${pendingMessageBatch.summaries}"`);
      this.emitTeammateMessageWhileIdle(pendingMessageBatch.formattedMessage);
      return;
    }

    // While only background sub-agents hold the query open, interrupting
    // destroys them. Hand the query over and deliver the teammate message
    // through the idle path instead. The delivery has to happen here: the
    // finally block skips handlePostLeadTurnTeammateState() on a handover, and
    // the lease would sit unclaimed — which is why a park is only requested once
    // something is known to be waiting. Asking rather than draining leaves the
    // batch where the interrupt path below looks for it, and nothing can take it
    // in the meantime: the other two consumers (the streamInput loop after the
    // drain, and handlePostLeadTurnTeammateState in the `finally`) both stand
    // down for a handover, and `this.handover` is set before this method first
    // yields. The follow-up turn is this provider's own doing (message in hand,
    // no attachments), so the candidate is stated directly rather than looked
    // up. #1269.
    if (!this.teammateManager.hasPendingTeammateMessages()) return;

    if (await this.requestQueryHandover('interruptWithMessage', { canAdoptQuery: true })) {
      const parkedBatch = this.drainAndFormatPendingTeammateMessages();
      if (!parkedBatch) {
        console.warn('[CLAUDE-CODE] interruptWithMessage: the query was parked but the teammate queue came up empty; nothing will claim the lease before its watchdog');
        return;
      }
      this.emitTeammateMessageWhileIdle(parkedBatch.formattedMessage);
      return;
    }

    // The handover wait can end after the turn's `finally` has run: nothing left
    // to interrupt, and the finally may or may not have re-delivered the queue
    // already — whoever finds the batch still in it delivers it. #1269.
    if (!this.leadQuery) {
      const lateBatch = this.drainAndFormatPendingTeammateMessages();
      if (lateBatch) {
        console.warn('[CLAUDE-CODE] interruptWithMessage: the turn ended while the handover was in flight; delivering the teammate message through the idle path');
        this.emitTeammateMessageWhileIdle(lateBatch.formattedMessage);
      }
      return;
    }

    // No handover: interrupt the lead query. After interrupt(), the transport is
    // dead and streamInput will always fail. Set wasInterrupted so the while
    // loop after the for-await skips streamInput; the batch is still queued, so
    // the finally block re-triggers delivery via a fresh sendMessage call.
    console.log('[CLAUDE-CODE] interruptWithMessage: interrupting active lead query');
    this.abandonHandoverForInterrupt('interruptWithMessage');
    this.wasInterrupted = true;

    // Resolve the interrupt promise FIRST so the Promise.race in the streaming
    // loop settles immediately — this unblocks the JS side without waiting for
    // the SDK subprocess to acknowledge the interrupt.
    if (this.interruptResolve) {
      this.interruptResolve();
      this.interruptResolve = null;
    }

    try {
      await this.leadQuery.interrupt();
    } catch (err) {
      console.warn('[CLAUDE-CODE] interruptWithMessage: interrupt() failed (transport may be closed):', err);
    }
  }

  private handlePostLeadTurnTeammateState(sessionId: string | undefined, hideMessages: boolean): void {
    // If teammate messages are still queued (e.g. streamInput failed for a drained
    // message), re-trigger delivery now that leadQuery is null. This mirrors the
    // "lead is idle" path in interruptWithMessage.
    if (this.teammateManager.hasPendingTeammateMessages()) {
      const pendingMessageBatch = this.drainAndFormatPendingTeammateMessages();
      if (pendingMessageBatch) {
        console.log(`[CLAUDE-CODE] Re-triggering ${pendingMessageBatch.count} teammate message(s) after sendMessage exit: "${pendingMessageBatch.summaries}"`);
        this.emitTeammateMessageWhileIdle(pendingMessageBatch.formattedMessage);
      }
    } else if (this.transportDied) {
      // Transport died and no pending messages to re-trigger.
      // Abandon idle teammates since they can't be resumed.
      this.teammateManager.abandonIdleTeammates(sessionId);
    } else if (this.teammateManager.hasActiveTeammates() && !hideMessages) {
      // Skip for hidden commands (e.g., /context auto-fetch) — those are internal
      // bookkeeping calls that shouldn't drive teammate lifecycle.
      if (this.teammateManager.hasOnlyBackgroundAgents()) {
        // Only background agents (sub-agents) remain — no idle teammates to manage.
        // Don't trigger a continuation; the lead can't do anything useful for sub-agents.
        // The session stays deferred; teammates:allCompleted will fire when they finish
        // and deliverMessageToLead will restart the lead if there are results to deliver.
        console.log(`[CLAUDE-CODE] Lead turn ended with ${this.teammateManager.getActiveAgentCount()} background agent(s) still running, waiting for completion`);
        this.continuationCount = 0;
      } else if (this.teammateManager.hasPendingTeammateMessages()) {
        // Messages arrived while we were in the finally block (race between
        // streaming loop exit and interruptWithMessage). Drain and deliver them
        // instead of triggering a continuation or abandoning.
        const pendingMessageBatch = this.drainAndFormatPendingTeammateMessages();
        if (pendingMessageBatch) {
          console.log(`[CLAUDE-CODE] Finally block found ${pendingMessageBatch.count} pending teammate message(s), delivering: "${pendingMessageBatch.summaries}"`);
          this.continuationCount = 0;
          this.emitTeammateMessageWhileIdle(pendingMessageBatch.formattedMessage);
        }
      } else if (this.continuationCount < ClaudeCodeProvider.MAX_CONTINUATIONS) {
        // The lead's turn ended naturally but idle teammates exist that need managing.
        // Trigger a continuation so the lead gets another turn.
        // Guard: continuationCount prevents infinite loops if the lead's
        // continuation turns keep ending without resolving agents.
        console.log(`[CLAUDE-CODE] Lead turn ended with active agents, triggering continuation (${this.continuationCount + 1}/${ClaudeCodeProvider.MAX_CONTINUATIONS})`);
        this.continuationCount++;
        this.emitTeammateMessageWhileIdle('[System: Your previous turn ended but you still have active agents. Wait for their results, or take other actions as needed.]');
      } else {
        // Max continuations exhausted and the lead still didn't resolve teammates.
        // Abandon idle teammates to unstick the session.
        console.log(`[CLAUDE-CODE] Lead exhausted ${ClaudeCodeProvider.MAX_CONTINUATIONS} continuations without resolving teammates, abandoning idle teammates`);
        this.teammateManager.abandonIdleTeammates(sessionId);
        this.continuationCount = 0;
      }
    }
  }

  private resetStreamClosedTurnState(): void {
    this.sawStreamClosedThisTurn = false;
    this.streamClosedTranscriptLoggedThisTurn = false;
    this.streamClosedToolName = undefined;
    this.streamClosedContinuationPrepared = false;
    this.streamClosedContinuationMessagePending = null;
  }

  private finishStreamClosedTurnState(): void {
    if (!this.sawStreamClosedThisTurn) {
      this.streamClosedRetryCount = 0;
    }
    this.resetStreamClosedTurnState();
  }

  private recordStreamClosedToolFailure(params: {
    sessionId?: string;
    hideMessages: boolean;
    toolName?: string;
    resultText: string;
  }): void {
    const narrowedToolName = extractStreamClosedToolName({
      isError: true,
      resultText: params.resultText,
      toolName: params.toolName,
    });

    this.sawStreamClosedThisTurn = true;
    if (narrowedToolName) {
      this.streamClosedToolName = narrowedToolName;
    }

    if (
      params.sessionId
      && !params.hideMessages
      && !this.streamClosedTranscriptLoggedThisTurn
    ) {
      const message = buildStreamClosedContinuationMessage(this.streamClosedToolName);
      this.logError(
        params.sessionId,
        'claude-code',
        new Error(message),
        'stream_closed_tool_result',
        'stream_closed_transport',
        false,
      );
      this.streamClosedTranscriptLoggedThisTurn = true;
    }
  }

  private prepareStreamClosedContinuation(
    sessionId: string | undefined,
    hideMessages: boolean,
  ): void {
    if (this.streamClosedContinuationPrepared) return;
    this.streamClosedContinuationPrepared = true;

    const decision = classifyStreamClosedContinuation({
      sawStreamClosed: this.sawStreamClosedThisTurn,
      retryCount: this.streamClosedRetryCount,
      maxRetries: ClaudeCodeProvider.MAX_STREAM_CLOSED_RETRIES,
      drainExitCause: this.drainExitCause,
      hasPendingUserStop: hideMessages,
    });

    if (!decision.continue) {
      if (decision.reason === 'aborted' || decision.reason === 'not-applicable') {
        this.streamClosedRetryCount = 0;
      }
      if (decision.reason === 'exhausted') {
        console.warn(`[CLAUDE-CODE] Stream-closed recovery exhausted after ${this.streamClosedRetryCount}/${ClaudeCodeProvider.MAX_STREAM_CLOSED_RETRIES} retries`);
      }
      return;
    }

    if (
      !sessionId
      || this.teammateIdleMessagePending
      || this.teammateManager.hasPendingTeammateMessages()
      || this.teammateManager.hasActiveTeammates()
      || this.drainingBackgroundTasks
      || this.settledBackgroundTasksThisTurn
      || this.hasRunningTasks()
    ) {
      return;
    }

    this.streamClosedRetryCount++;
    this.streamClosedContinuationMessagePending = buildStreamClosedContinuationMessage(this.streamClosedToolName);
    // Set before yielding `complete`; AIService checks willResumeAfterCompletion()
    // while handling that chunk, before this generator reaches finally.
    this.teammateIdleMessagePending = true;
    console.warn(`[CLAUDE-CODE] Stream-closed recovery scheduled (${this.streamClosedRetryCount}/${ClaudeCodeProvider.MAX_STREAM_CLOSED_RETRIES})`);
  }

  private emitPreparedStreamClosedContinuation(sessionId: string | undefined): void {
    if (!sessionId || !this.streamClosedContinuationMessagePending) return;
    this.emit('teammate:messageWhileIdle', {
      sessionId,
      message: this.streamClosedContinuationMessagePending,
    });
  }

  private drainAndFormatPendingTeammateMessages(): {
    formattedMessage: string;
    summaries: string;
    count: number;
  } | null {
    const pendingMessages: TeammateToLeadMessage[] = [];
    while (this.teammateManager.hasPendingTeammateMessages()) {
      const message = this.teammateManager.drainNextTeammateMessage();
      if (message) {
        pendingMessages.push(message);
      } else {
        break;
      }
    }

    if (pendingMessages.length === 0) {
      return null;
    }

    return {
      formattedMessage: pendingMessages
        .map(message => `[Teammate message from "${message.teammateName}"]\n\n${message.content}`)
        .join('\n\n---\n\n'),
      summaries: pendingMessages.map(message => message.summary).join(', '),
      count: pendingMessages.length,
    };
  }

  private emitTeammateMessageWhileIdle(message: string): void {
    this.teammateIdleMessagePending = true;
    this.emit('teammate:messageWhileIdle', {
      sessionId: this.teammateManager.lastUsedSessionId,
      message,
    });
  }

  /**
   * Clean up provider resources including active subprocess
   * Called when provider is destroyed (e.g., app quit, session cleanup)
   */
  destroy(): void {
    console.log('[CLAUDE-CODE] Destroying provider');

    // No turn will ever adopt a lease parked on a provider that is going away.
    // super.destroy() calls abort(), which disposes it too — this is here so the
    // ordering is explicit rather than incidental. #1269.
    this.disposeParkedLease('provider destroyed');

    // Clean up permission service
    if (this.permissionService) {
      this.permissionService.clearSessionCache();
      this.permissionService.rejectAllPending();
    }

    // Abort any active SDK subprocess and reject all pending user interactions
    // Base class destroy() calls abort(), sessions.clear(), permissions.clearSessionCache(), and removeAllListeners()
    super.destroy();
  }

  /**
   * Stop a specific managed teammate by name
   */
  public stopManagedTeammate(name: string): boolean {
    return this.teammateManager.stop(name);
  }

  /**
   * Check if any teammates are still active (running or idle).
   * Used by AIService to decide whether to defer endSession().
   */
  public hasActiveTeammates(): boolean {
    return this.teammateManager.hasActiveTeammates();
  }

  /**
   * Check if the lead is currently processing or about to process a message.
   * True when leadQuery is set (actively streaming) or when a
   * teammate:messageWhileIdle event was emitted but sendMessage hasn't started yet.
   * Used by the teammates:allCompleted handler to avoid ending the session
   * while the lead is mid-turn.
   */
  public isLeadBusy(): boolean {
    return this.leadQuery !== null || this.teammateIdleMessagePending;
  }

  /**
   * True while this provider holds a parked query for a follow-up turn on
   * `sessionId` that has been promised but has not started yet.
   *
   * A handover deliberately leaves the session idle: `interruptCurrentTurn`
   * reports `'handover'`, the caller forces the session out of `running` so the
   * waiting prompt can dispatch, and only that prompt's `startSession()` closes
   * the gap again. In between an IPC round trip, a queue pass and a window
   * lookup, a session that is idle in the state manager while a live subprocess
   * and a promised turn still belong to it — so "the session is not active"
   * does not mean "the session is over" here, and anything delivered in that
   * window must not be dropped as if it were. #1269.
   */
  public hasParkedLeaseForSession(sessionId: string): boolean {
    return this.parkedLease !== null && this.parkedLease.sessionId === sessionId;
  }

  /**
   * Check if the lead will resume after the current query completes.
   * Unlike isLeadBusy(), this does NOT check leadQuery (which is still set
   * when called from inside the generator's for-await loop). Checks both:
   * - teammateIdleMessagePending: a re-trigger event was already emitted
   * - hasPendingTeammateMessages: messages are queued but not yet triggered
   *   (e.g., interruptWithMessage queued a message and called interrupt(),
   *   but the finally block hasn't run yet to re-trigger delivery)
   * Used by AIService's 'complete' chunk handler.
   */
  public willResumeAfterCompletion(): boolean {
    return this.teammateIdleMessagePending
      || this.teammateManager.hasPendingTeammateMessages()
      // A background sub-agent is still running (or being drained) after the lead's
      // turn ended. endSession must be deferred so finalizeBackgroundDrain()'s later
      // continuation / settle isn't dropped for an inactive session. NIM-1344 / #732.
      || this.drainingBackgroundTasks
      // A backgrounded task settled during the turn: finalizeBackgroundDrain will
      // deliver its result as a continuation from the finally block, which runs
      // after this is read. #1410.
      || this.settledBackgroundTasksThisTurn
      || this.hasRunningTasks();
  }

  /**
   * Process teammate-related side-effects after a tool_result is received.
   * Called from both chunk-processing paths to avoid duplication.
   */

  /** Handle system init chunk -- capture slash commands, skills, MCP health, etc. */
  private *handleSystemInit(
    chunk: any,
    sessionId: string | undefined,
    hideMessages: boolean,
  ): Generator<StreamChunk> {
    // Clean up stale "running" tasks from previous sessions/restarts
    if (sessionId && this.activeTasks.size === 0) {
      (async () => {
        try {
          const { AISessionsRepository } = await import('../../../storage/repositories/AISessionsRepository');
          const currentSession = await AISessionsRepository.get(sessionId);
          const tasks = currentSession?.metadata?.currentTasks;
          if (Array.isArray(tasks) && tasks.some((t: any) => t.status === 'running')) {
            const cleaned = tasks.map((t: any) =>
              t.status === 'running' ? { ...t, status: 'stopped' } : t
            );
            await AISessionsRepository.updateMetadata(sessionId, {
              metadata: { ...currentSession?.metadata, currentTasks: cleaned }
            });
            this.emit('message:logged', { sessionId, direction: 'output' });
            // console.log(`[CLAUDE-CODE] Cleaned up ${tasks.filter((t: any) => t.status === 'running').length} stale running tasks`);
          }
        } catch {
          // Non-critical cleanup
        }
      })();
    }

    // Hydrate the in-memory task-list map from persisted metadata so TaskUpdate
    // deltas in a resumed session merge onto the existing board instead of
    // creating stubs (the map is per-provider-instance and starts empty).
    if (sessionId && this.taskListItems.size === 0) {
      (async () => {
        try {
          const { AISessionsRepository } = await import('../../../storage/repositories/AISessionsRepository');
          const currentSession = await AISessionsRepository.get(sessionId);
          const persisted = currentSession?.metadata?.currentTaskList;
          if (Array.isArray(persisted)) {
            for (const item of persisted as TaskListItem[]) {
              if (item && typeof item.id === 'string') this.taskListItems.set(item.id, item);
            }
          }
        } catch {
          // Non-critical hydration
        }
      })();
    }

    if (chunk.slash_commands && Array.isArray(chunk.slash_commands)) {
      this.slashCommands = chunk.slash_commands;
      ClaudeCodeProvider.cachedSdkSlashCommands = chunk.slash_commands;
    }
    if (chunk.skills && Array.isArray(chunk.skills)) {
      this.skills = chunk.skills;
      ClaudeCodeProvider.cachedSdkSkills = chunk.skills;
    }

    const mcpServerCount = Array.isArray(chunk.mcp_servers) ? chunk.mcp_servers.length : 0;
    (this as any)._initData = {
      mcpServerCount,
      slashCommandCount: Array.isArray(chunk.slash_commands) ? chunk.slash_commands.length : 0,
      agentCount: Array.isArray(chunk.agents) ? chunk.agents.length : 0,
      skillCount: Array.isArray(chunk.skills) ? chunk.skills.length : 0,
      pluginCount: Array.isArray(chunk.plugins) ? chunk.plugins.length : 0,
      toolCount: chunk.tools?.length || 0,
    };

    if (mcpServerCount > 0) {
      this.currentSessionId = sessionId;
      this.mcpQuery = this.leadQuery;
      this.checkMcpServerStatuses().catch(() => {});
      this.startMcpHealthChecks();
    }

    // The host has already persisted a provisional first-prompt title before
    // the provider starts. Do not also call Query.generateSessionTitle here:
    // NIM-1988 measured it as a byte-identical paid auxiliary request. Keep the
    // independent phase fallback without making another model call.
    if (sessionId) {
      this.maybeApplyDefaultSessionPhase(sessionId).catch(() => {});
    }
  }

  /** Disarm the drain grace timer so it cannot end the prompt stream later. */
  private clearPromptEndTimer(): void {
    if (this.promptEndTimer) {
      clearTimeout(this.promptEndTimer);
      this.promptEndTimer = null;
    }
  }

  /** True if any tracked SDK-native sub-agent task is still running. */
  private hasRunningTasks(): boolean {
    return computeHasRunningTasks(this.activeTasks.values());
  }

  private hasPendingUserInteraction(): boolean {
    return this.pendingExitPlanModeConfirmations.size > 0
      || this.pendingAskUserQuestions.size > 0
      || this.permissions.pendingToolPermissions.size > 0
      || (this.permissionService?.hasPendingPermissions() ?? false);
  }

  /**
   * Called from the sendMessage finally block. When we deferred teardown to drain
   * background sub-agents (drainingBackgroundTasks) but the loop exited with tasks
   * still running, mark those tasks stopped and — only when the death was
   * unexpected (the SDK iterator ended/threw, not a user stop or supersede) —
   * nudge the orchestrator with a VISIBLE continuation turn so it doesn't idle
   * forever waiting for a result that will never arrive. See NIM-1344 / #732.
   */
  private finalizeBackgroundDrain(
    sessionId: string | undefined,
    query?: { close?: () => void } | null,
  ): void {
    // Two triggers: we deferred teardown to drain sub-agents, or a backgrounded
    // task reported terminally during the turn (#1410) — that one never drains,
    // but it leaves the CLI holding a queued continuation turn just the same.
    // Turns with neither never enter this branch (zero behavior change).
    if (!this.drainingBackgroundTasks && !this.settledBackgroundTasksThisTurn) return;

    // Close the drained subprocess outright. Ending stdin is not enough: the
    // CLI queues its own task-notification continuation turn, which would run
    // against the torn-down control channel (every canUseTool/hook request
    // fails with "Stream closed") and the process leaks. The continuation is
    // delivered by Nimbalyst below instead. NIM-1470.
    if (query && typeof query.close === 'function') {
      try {
        query.close();
      } catch {
        // Best effort — the process may already have exited.
      }
      if (this.mcpQuery === (query as unknown as Query)) {
        this.stopMcpHealthChecks();
        this.mcpQuery = null;
      }
    }

    const outcome = classifyDrainOutcome({
      wasDraining: this.drainingBackgroundTasks,
      hasRunningTasks: this.hasRunningTasks(),
      cause: this.drainExitCause,
    });

    if (outcome.markStopped) {
      const stranded = reapRunningTasks(this.activeTasks.values());
      console.warn(`[CLAUDE-CODE] SUBAGENT_DRAIN: loop exited (cause=${this.drainExitCause}) with ${stranded.length} unresolved sub-agent task(s); marking stopped. autoContinue=${outcome.autoContinue}. tasks=[${stranded.join(', ')}]`);
      this.emitTaskUpdate(sessionId).catch(() => {});
    }

    if (outcome.autoContinue && sessionId) {
      // Visible continuation: delivered as a fresh user turn via the idle-message
      // path, so both the orchestrator and the user see why delegation was
      // abandoned. teammateIdleMessagePending keeps the (deferred) session alive
      // until that turn runs and ends it. Not a silent internal nudge.
      this.teammateIdleMessagePending = true;
      this.emit('teammate:messageWhileIdle', {
        sessionId,
        message:
          '[System: A sub-agent you launched did not finish — its process was interrupted before returning results. Do not keep waiting for it; continue without it, or retry the delegation if the work still matters.]',
      });
      return;
    }

    // Clean resolve with results: a background task finished AFTER the lead
    // turn ended. Wake the session with a visible continuation turn carrying
    // the task outcome — this is what makes "you will be notified when it
    // completes" actually true. (The drained CLI's own continuation turn was
    // discarded by the post-complete filter and its process closed above.)
    // See NIM-1470.
    if (
      sessionId
      && shouldContinueWithTaskResults(this.drainExitCause, this.drainTerminalNotifications)
    ) {
      const message = buildTaskResultContinuationMessage(this.drainTerminalNotifications);
      console.log(`[CLAUDE-CODE] SUBAGENT_DRAIN: waking session ${sessionId} with ${this.drainTerminalNotifications.length} background task result(s)`);
      this.teammateIdleMessagePending = true;
      this.emit('teammate:messageWhileIdle', { sessionId, message });
      return;
    }

    // No continuation (clean resolve, or a user stop / supersede). endSession was
    // deferred while draining (willResumeAfterCompletion), so release it now that
    // the drain has settled — unless teammate work is still keeping the session
    // alive (that path ends it via teammates:allCompleted). Emitted from the
    // finally block AFTER leadQuery is nulled, so the handler's isLeadBusy() check
    // reads false. See NIM-1344 / GitHub #732 (High).
    this.emitDrainSettled(sessionId, `cause=${this.drainExitCause}`);
  }

  /** Handle system task chunks (task_started, task_progress, task_notification). */
  private handleSystemTask(subtype: string, chunk: any, sessionId: string | undefined): void {
    const changed = applySystemTaskChunk({
      subtype,
      chunk,
      tasks: this.activeTasks,
      draining: this.drainingBackgroundTasks,
      graceExpired: this.drainGraceExpired,
      notifications: this.drainTerminalNotifications,
      queryGeneration: this.queryGeneration,
      log: (message) => console.log(message),
    });
    if (changed) {
      this.emitTaskUpdate(sessionId).catch(() => {});
      this.publishBackgroundWait(sessionId);
    }
  }

  /**
   * Tell the renderer which background tasks the session is waiting on after the
   * lead's turn ended (an empty list clears it). Rides the metadata-updated
   * forwarder to `sessions:session-updated`; not persisted, since the tasks die
   * with the process.
   */
  private publishBackgroundWait(sessionId: string | undefined): void {
    if (!sessionId) return;
    const backgroundTasks = summarizeBackgroundWait(this.drainingBackgroundTasks, this.activeTasks.values());
    const key = backgroundTasks.map((t) => t.taskId).join(',');
    if (key === this.publishedBackgroundWaitKey) return;
    this.publishedBackgroundWaitKey = key;
    this.emit('session:metadata-updated', { sessionId, metadata: { backgroundTasks } });
  }

  private processTeammateToolResult(
    sessionId: string | undefined,
    toolName: string,
    toolArguments: Record<string, unknown> | undefined,
    toolResult: unknown,
    isError: boolean,
    toolUseId?: string,
  ): void {
    // Detect shutdown_request results from SDK-handled SendMessage.
    // Skip if handlePreToolUse already handled this shutdown (resumed the teammate
    // for approval handshake) — otherwise we'd redundantly abort the just-resumed teammate.
    if (toolName === 'SendMessage' && toolArguments?.type === 'shutdown_request') {
      if (!this.teammateManager.consumeHandledShutdown(toolUseId)) {
        const shutdownRecipient = toolArguments.recipient;
        if (typeof shutdownRecipient === 'string' && shutdownRecipient) {
          this.teammateManager.handleShutdownResult(sessionId, shutdownRecipient);
        }
      }
    }

    // Track team context from TeamCreate/TeamDelete results
    this.teammateManager.updateTeamContextFromToolResult(
      toolName,
      toolArguments,
      toolResult,
      isError,
    );
  }

  /**
   * Update session metadata with current todos
   * Uses the existing metadata update mechanism instead of custom IPC events
   */
  private async handleScheduleWakeupTool(
    sessionId: string,
    workspacePath: string,
    args: { delaySeconds?: unknown; prompt?: unknown; reason?: unknown }
  ): Promise<void> {
    const rawDelay = args.delaySeconds;
    const delaySeconds = typeof rawDelay === 'number' ? rawDelay : Number(rawDelay);
    const prompt = typeof args.prompt === 'string' ? args.prompt : '';
    const reason = typeof args.reason === 'string' ? args.reason : '';

    if (!Number.isFinite(delaySeconds) || delaySeconds < 60 || delaySeconds > 604800) {
      console.warn(`[CLAUDE-CODE] ScheduleWakeup ignored: invalid delaySeconds=${rawDelay}`);
      return;
    }
    if (!prompt) {
      console.warn('[CLAUDE-CODE] ScheduleWakeup ignored: missing prompt');
      return;
    }

    const handler = ClaudeCodeProvider.scheduleWakeupHandler;
    if (!handler) {
      console.warn('[CLAUDE-CODE] ScheduleWakeup ignored: no handler registered');
      return;
    }

    await handler({ sessionId, workspacePath, delaySeconds, prompt, reason });
  }

  private async emitTodoUpdate(sessionId: string | undefined, todos: any[]): Promise<void> {

    if (!sessionId) {
      return;
    }

    try {
      // Update session metadata with the current todos
      // This will trigger session reloads which will update the UI

      // Import AISessionsRepository dynamically
      const { AISessionsRepository } = await import('../../../storage/repositories/AISessionsRepository');

      // Get current session to merge metadata
      const currentSession = await AISessionsRepository.get(sessionId);

      const currentMetadata = currentSession?.metadata || {};

      await AISessionsRepository.updateMetadata(sessionId, {
        metadata: {
          ...currentMetadata,
          currentTodos: todos
        }
      });


      // Emit message:logged event to trigger UI reload
      // This will cause the AgenticPanel to reload the session and pick up the new todos
      this.emit('message:logged', {
        sessionId,
        direction: 'output'
      });
    } catch (error) {
      console.error('[CLAUDE-CODE] Failed to update session metadata with todos:', error);
      console.error('[CLAUDE-CODE] Error stack:', error instanceof Error ? error.stack : 'No stack trace');
    }
  }

  private async emitTaskUpdate(sessionId: string | undefined): Promise<void> {
    if (!sessionId) return;

    try {
      const { AISessionsRepository } = await import('../../../storage/repositories/AISessionsRepository');
      const currentSession = await AISessionsRepository.get(sessionId);
      const currentMetadata = currentSession?.metadata || {};

      await AISessionsRepository.updateMetadata(sessionId, {
        metadata: {
          ...currentMetadata,
          currentTasks: Array.from(this.activeTasks.values()),
        }
      });

      this.emit('message:logged', { sessionId, direction: 'output' });
    } catch (error) {
      console.error('[CLAUDE-CODE] Failed to update session metadata with tasks:', error);
    }
  }

  /**
   * Reconstruct the SDK-native task list from TaskCreate/TaskUpdate tool calls.
   * TaskUpdate only carries the changed fields, so we keep a running map keyed by
   * the SDK-assigned id and merge each mutation. TaskCreate does not echo the id
   * in its args — it appears only in the result text ("Task #3 created ...") — so
   * this must run on tool_result, not tool_use.
   */
  private captureTaskListMutation(
    sessionId: string | undefined,
    toolName: string,
    args: Record<string, unknown> | undefined,
    resultContent: unknown,
  ): void {
    if (!sessionId) return;
    const resultText = typeof resultContent === 'string' ? resultContent : '';
    const changed = applyTaskListMutation(this.taskListItems, toolName, args, resultText);
    if (changed) {
      this.emitTaskListUpdate(sessionId).catch(() => {});
    }
  }

  private async emitTaskListUpdate(sessionId: string | undefined): Promise<void> {
    if (!sessionId) return;
    try {
      const { AISessionsRepository } = await import('../../../storage/repositories/AISessionsRepository');
      const currentSession = await AISessionsRepository.get(sessionId);
      const currentMetadata = currentSession?.metadata || {};

      await AISessionsRepository.updateMetadata(sessionId, {
        metadata: {
          ...currentMetadata,
          // Sorted by numeric id so the board renders in creation order.
          currentTaskList: sortTaskList(this.taskListItems.values()),
        }
      });

      this.emit('message:logged', { sessionId, direction: 'output' });
    } catch (error) {
      console.error('[CLAUDE-CODE] Failed to update session metadata with task list:', error);
    }
  }

  /**
   * Start periodic MCP server health checks during an active session.
   * Polls the SDK for server status and emits events when servers disconnect.
   */
  private startMcpHealthChecks(): void {
    this.stopMcpHealthChecks();
    // Poll once immediately so the in-session status surface has something to
    // show during the first 30 seconds. Without this the UI cannot tell an
    // unpolled session from one whose servers all vanished.
    this.checkMcpServerStatuses().catch(() => {});
    // Poll every 30 seconds
    this.mcpHealthCheckInterval = setInterval(() => {
      this.checkMcpServerStatuses().catch(() => {});
    }, 30_000);
  }

  private stopMcpHealthChecks(): void {
    if (this.mcpHealthCheckInterval) {
      clearInterval(this.mcpHealthCheckInterval);
      this.mcpHealthCheckInterval = null;
    }
  }

  /**
   * Query MCP server status from the SDK and emit events for any changes.
   * Uses mcpQuery (persistent across turns) rather than leadQuery (per-turn).
   */
  private async checkMcpServerStatuses(): Promise<void> {
    const q = this.mcpQuery;
    if (!q) return;
    if (
      this.permissions.pendingToolPermissions.size > 0
      || (this.permissionService?.hasPendingPermissions() ?? false)
    ) {
      return;
    }

    try {
      const statuses: McpServerStatusInfo[] = await q.mcpServerStatus();
      const changes: McpServerStatusInfo[] = [];

      for (const server of statuses) {
        const prev = this.mcpServerStatuses.get(server.name);
        if (!prev || prev.status !== server.status) {
          changes.push(server);
          if (prev && prev.status === 'connected' && server.status === 'failed') {
            console.warn(`[CLAUDE-CODE] MCP server "${server.name}" disconnected: ${server.error || 'unknown reason'}`);
          }
        }
      }

      // A server that drops out of the list entirely is a change too. Keeping
      // the stale entry would leave the UI claiming it is still connected.
      const reported = new Set(statuses.map((s) => s.name));
      let removed = false;
      for (const name of Array.from(this.mcpServerStatuses.keys())) {
        if (!reported.has(name)) {
          this.mcpServerStatuses.delete(name);
          removed = true;
        }
      }

      for (const server of statuses) {
        this.mcpServerStatuses.set(server.name, server);
      }
      this.mcpStatusesLastCheckedAt = Date.now();

      if (changes.length > 0 || removed) {
        this.emit('mcpServerStatus:changed', {
          sessionId: this.currentSessionId,
          servers: Array.from(this.mcpServerStatuses.values()),
          changes,
          lastCheckedAt: this.mcpStatusesLastCheckedAt,
          configuredNames: this.mcpSnapshotServerNames,
          withheldNames: this.mcpWithheldServerNames,
        });
      }
    } catch {
      // Query may be closing, ignore
    }
  }

  /**
   * Reconnect a disconnected MCP server by name.
   * Can be called from the UI via IPC.
   * Uses mcpQuery (persistent across turns) so reconnect works between turns.
   */
  async reconnectMcpServer(serverName: string): Promise<void> {
    const q = this.mcpQuery;
    if (!q) {
      throw new Error('No active session to reconnect MCP server');
    }
    console.log(`[CLAUDE-CODE] Reconnecting MCP server: ${serverName}`);
    await q.reconnectMcpServer(serverName);
    // Re-check statuses immediately after reconnect attempt
    await this.checkMcpServerStatuses();
  }

  /**
   * Get current MCP server statuses (cached from last health check).
   */
  getMcpServerStatuses(): McpServerStatusInfo[] {
    return Array.from(this.mcpServerStatuses.values());
  }

  /**
   * Server names from the frozen per-session MCP config snapshot, or null if
   * that snapshot has not settled yet.
   *
   * Synchronous by design. Awaiting `mcpServersSnapshotJsonPromise` here would
   * force the config read this session deliberately defers/freezes, so an
   * unsettled snapshot reports nothing rather than triggering one. Names only —
   * the snapshot values hold credentials. See NIM-1988.
   */
  getMcpConfiguredServerNames(): string[] | null {
    return this.mcpSnapshotServerNames ? [...this.mcpSnapshotServerNames] : null;
  }

  /**
   * Servers configured for this session but withheld from the CLI for failing
   * the OAuth check. Names only, same as above — the config values hold
   * credentials.
   */
  getMcpWithheldServerNames(): string[] | null {
    return this.mcpWithheldServerNames ? [...this.mcpWithheldServerNames] : null;
  }

  /** Epoch ms of the last poll that returned, or null if never polled. */
  getMcpStatusLastCheckedAt(): number | null {
    return this.mcpStatusesLastCheckedAt;
  }

  /**
   * Everything the in-session MCP status surface needs, in one call.
   * Read-only: no SDK round trip, no config read, no prompt bytes.
   */
  getMcpSessionStatus(): {
    servers: McpServerStatusInfo[];
    configuredNames: string[] | null;
    withheldNames: string[] | null;
    lastCheckedAt: number | null;
  } {
    return {
      servers: this.getMcpServerStatuses(),
      configuredNames: this.getMcpConfiguredServerNames(),
      withheldNames: this.getMcpWithheldServerNames(),
      lastCheckedAt: this.mcpStatusesLastCheckedAt,
    };
  }

  getCapabilities(): ProviderCapabilities {
    return {
      streaming: true,
      tools: true,
      mcpSupport: true,  // Full MCP support
      edits: true,
      resumeSession: true,  // Can resume Claude Code sessions
      supportsFileTools: true  // Uses tools to access files (Read, Glob, etc.)
    };
  }

  getProviderSessionData(sessionId: string): any {
    const { providerSessionId } = this.sessions.getProviderSessionData(sessionId);
    return {
      claudeSessionId: providerSessionId,
    };
  }

  /**
   * Handle ExitPlanMode in canUseTool - blocks until user approves or denies.
   * This is the primary mechanism for ExitPlanMode confirmation since the Claude Agent SDK
   * does not support the `hooks` option. The canUseTool callback is the only way to block
   * tool execution from the SDK.
   */
  private async handleExitPlanMode(
    sessionId: string | undefined,
    input: any,
    options: { signal: AbortSignal; toolUseID?: string },
  ): Promise<{ behavior: 'allow' | 'deny'; updatedInput?: any; message?: string }> {
    // If not in planning mode, allow immediately (no confirmation needed)
    if (this.currentMode !== 'planning') {
      return { behavior: 'allow', updatedInput: input };
    }

    const planFilePath = input?.planFilePath || '';
    if (!planFilePath) {
      return {
        behavior: 'deny',
        message: 'ExitPlanMode requires the planFilePath argument. Try ExitPlanMode again and include the fully qualified plan file path.',
      };
    }

    const requestId = options.toolUseID || `exit-plan-${sessionId}-${Date.now()}`;
    const planSummary = input?.plan || '';

    // Create a promise that will be resolved when user responds via the widget
    const confirmationPromise = new Promise<{ approved: boolean; clearContext?: boolean; feedback?: string }>((resolve, reject) => {
      this.pendingExitPlanModeConfirmations.set(requestId, { resolve, reject });

      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          this.pendingExitPlanModeConfirmations.delete(requestId);
          // Persist cancellation to DB so orphaned requests don't appear as perpetually pending
          if (sessionId) {
            const cancelContent = {
              type: 'exit_plan_mode_response' as const,
              requestId,
              approved: false,
              cancelled: true,
              respondedAt: Date.now(),
              respondedBy: 'system',
            };
            this.logAgentMessage(
              sessionId, 'claude-code', 'output',
              JSON.stringify(cancelContent),
              { messageType: 'exit_plan_mode_response' }
            ).catch(() => {});
          }
          reject(new Error('Request aborted'));
        }, { once: true });
      }
    });

    // Persist the request as a durable prompt
    const exitPlanModeContent = {
      type: 'exit_plan_mode_request' as const,
      requestId,
      planSummary,
      planFilePath,
      timestamp: Date.now(),
      status: 'pending' as const,
    };

    if (sessionId) {
      await this.logAgentMessage(
        sessionId, 'claude-code', 'output',
        JSON.stringify(exitPlanModeContent),
        { messageType: 'exit_plan_mode_request' }
      );
    }

    // Emit event to notify renderer to show confirmation UI
    this.emit('exitPlanMode:confirm', {
      requestId,
      sessionId,
      planSummary,
      planFilePath,
      timestamp: Date.now(),
    });

    try {
      const response = await confirmationPromise;

      if (response.approved) {
        this.currentMode = 'agent';
        return { behavior: 'allow', updatedInput: input };
      } else {
        const feedbackText = response.feedback
          ? `\n\nUser feedback: "${response.feedback}"`
          : '';
        return {
          behavior: 'deny',
          message: `The user chose to continue planning.${feedbackText}`,
        };
      }
    } catch (error) {
      return {
        behavior: 'deny',
        message: 'ExitPlanMode was cancelled or interrupted.',
      };
    }
  }

  /**
   * Resolve a pending ExitPlanMode confirmation request
   * Called by AIService when renderer responds to confirmation prompt
   * @param requestId - Unique ID for this confirmation request
   * @param response - User's response containing:
   *   - approved: Whether to exit plan mode
   *   - clearContext: If true, clear the session context for a fresh start
   *   - feedback: Optional feedback message when denying (continue planning)
   */
  public resolveExitPlanModeConfirmation(
    requestId: string,
    response: { approved: boolean; clearContext?: boolean; feedback?: string },
    sessionId?: string,
    respondedBy: 'desktop' | 'mobile' = 'desktop'
  ): void {
    const pending = this.pendingExitPlanModeConfirmations.get(requestId);
    if (pending) {
      pending.resolve(response);
      this.pendingExitPlanModeConfirmations.delete(requestId);

      // Mirror AskUserQuestion / ToolPermission semantics: emit a resolved
      // event so MessageStreamingHandler can flip the SessionStateManager
      // status back to 'running'. Without this, the multi-project rail
      // misses the resume transition after an ExitPlanMode denial and the
      // "Thinking…" spinner stays hidden until the rail is remounted.
      this.emit('exitPlanMode:resolved', {
        requestId,
        sessionId,
        approved: response.approved,
        respondedBy,
        timestamp: Date.now(),
      });

      // Mobile response handlers persist the durable response before invoking
      // the provider so stale-response cutoffs remain correct. Desktop callers
      // still rely on the provider-owned write here.
      if (sessionId && respondedBy !== 'mobile') {
        const responseContent = {
          type: 'exit_plan_mode_response' as const,
          requestId,
          approved: response.approved,
          clearContext: response.clearContext,
          feedback: response.feedback,
          respondedAt: Date.now(),
          respondedBy,
        };
        this.logAgentMessage(
          sessionId,
          'claude-code',
          'output',
          JSON.stringify(responseContent),
          { messageType: 'exit_plan_mode_response' }
        ).catch(err => {
          console.error('[CLAUDE-CODE] Failed to persist ExitPlanMode response:', err);
        });
      }
      // TODO: Debug logging - uncomment if needed
    } else {
      console.warn(`[CLAUDE-CODE] No pending ExitPlanMode confirmation found for requestId: ${requestId}`);
    }
  }

  /**
   * Reject all pending ExitPlanMode confirmations (e.g., on abort)
   */
  public rejectAllPendingConfirmations(): void {
    for (const [requestId, pending] of this.pendingExitPlanModeConfirmations) {
      pending.reject(new Error('Request aborted'));
    }
    this.pendingExitPlanModeConfirmations.clear();
  }

  /**
   * Resolve a pending AskUserQuestion request with user's answers
   * Called by IPC handler when renderer provides answers
   * @param sessionId - Session ID for persisting the response message
   * @param respondedBy - Device that responded ('desktop' or 'mobile')
   */
  public resolveAskUserQuestion(
    questionId: string,
    answers: Record<string, string>,
    sessionId?: string,
    respondedBy: 'desktop' | 'mobile' = 'desktop'
  ): boolean {
    const pending = this.pendingAskUserQuestions.get(questionId);
    if (pending) {
      pending.resolve(answers);
      this.pendingAskUserQuestions.delete(questionId);

      // Log as nimbalyst_tool_result to complete the tool call
      // This sets toolCall.result which changes widget from interactive to completed
      if (sessionId) {
        this.logAgentMessage(
          sessionId,
          'claude-code',
          'output',
          JSON.stringify({
            type: 'nimbalyst_tool_result',
            tool_use_id: questionId,
            result: JSON.stringify({ answers, respondedAt: Date.now(), respondedBy })
          })
        ).catch(err => {
          console.error('[CLAUDE-CODE] Failed to persist AskUserQuestion response:', err);
        });
      }
      return true;
    } else {
      console.warn(`[CLAUDE-CODE] No pending AskUserQuestion found for questionId: ${questionId}`);
      return false;
    }
  }

  /**
   * Reject a pending AskUserQuestion request (e.g., on cancel/abort)
   */
  public rejectAskUserQuestion(questionId: string, error: Error): void {
    const pending = this.pendingAskUserQuestions.get(questionId);
    if (pending) {
      pending.reject(error);
      this.pendingAskUserQuestions.delete(questionId);
      // The cancelled tool result is logged by handleAskUserQuestionTool's catch block,
      // which fires when the promise rejects. It correctly handles all questionId formats
      // (both legacy ask-{sessionId}-{timestamp} and new toolu_... Claude tool use IDs).
    }
  }

  /**
   * Reject all pending AskUserQuestion requests (e.g., on abort)
   */
  public rejectAllPendingQuestions(): void {
    for (const [questionId, pending] of this.pendingAskUserQuestions) {
      pending.reject(new Error('Request aborted'));
    }
    this.pendingAskUserQuestions.clear();
  }

  /**
   * Resolve a pending Bash permission request with user's response
   * Called by IPC handler when renderer provides a permission response
   * @param sessionId - Session ID for persisting the response message
   * @param respondedBy - Device that responded ('desktop' or 'mobile')
   */
  public resolveToolPermission(
    requestId: string,
    response: { decision: 'allow' | 'deny'; scope: 'once' | 'session' | 'always' | 'always-all' },
    sessionId?: string,
    respondedBy: 'desktop' | 'mobile' = 'desktop'
  ): void {
    // Try ToolPermissionService first (primary path when service is available)
    if (this.permissionService) {
      this.permissionService.resolvePermission(requestId, response);
    }

    // Also check the inline pending map (used by AgentToolHooks compound bash checks,
    // including those from teammate sessions which create promises in this map)
    if (this.permissions.pendingToolPermissions.has(requestId)) {
      this.permissions.resolveToolPermission(
        requestId,
        response,
        (_reqId, resp, by) => {
          if (sessionId) {
            this.logAgentMessage(
              sessionId,
              'claude-code',
              'output',
              this.createPermissionResultMessage(_reqId, resp, by)
            ).catch(err => {
              console.error('[CLAUDE-CODE] Failed to persist permission response:', err);
            });
          }
        },
        respondedBy
      );
      return;
    }

    // Persist the response as nimbalyst_tool_result for widget rendering
    if (this.permissionService && sessionId) {
      this.logAgentMessage(
        sessionId,
        'claude-code',
        'output',
        this.createPermissionResultMessage(requestId, response, respondedBy)
      ).catch(err => {
        console.error('[CLAUDE-CODE] Failed to persist permission response:', err);
      });
      return;
    }

    // Fallback: resolve via the mixin's pending map (for tests or when service not available)
    this.permissions.resolveToolPermission(
      requestId,
      response,
      (_reqId, resp, by) => {
        if (sessionId) {
          this.logAgentMessage(
            sessionId,
            'claude-code',
            'output',
            this.createPermissionResultMessage(_reqId, resp, by)
          ).catch(err => {
            console.error('[CLAUDE-CODE] Failed to persist permission response:', err);
          });
        }
      },
      respondedBy
    );
  }

  /**
   * Reject a pending tool permission request (e.g., on cancel/abort)
   * @param sessionId - Session ID for persisting the cancellation message
   */
  public rejectToolPermission(requestId: string, error: Error, sessionId?: string): void {
    // Try ToolPermissionService first (primary path)
    if (this.permissionService) {
      this.permissionService.rejectPermission(requestId, error);
      if (sessionId) {
        this.logAgentMessage(
          sessionId,
          'claude-code',
          'output',
          this.createPermissionCancellationMessage(requestId)
        ).catch(err => {
          console.error('[CLAUDE-CODE] Failed to persist permission cancellation:', err);
        });
      }
      return;
    }

    // Fallback: reject via the mixin's pending map
    this.permissions.rejectToolPermission(requestId, error, (_reqId) => {
      if (sessionId) {
        this.logAgentMessage(
          sessionId,
          'claude-code',
          'output',
          this.createPermissionCancellationMessage(_reqId)
        ).catch(err => {
          console.error('[CLAUDE-CODE] Failed to persist permission cancellation:', err);
        });
      }
    });
  }

  /**
   * Reject all pending tool permission requests (e.g., on abort)
   */
  public rejectAllPendingPermissions(): void {
    this.permissions.rejectAllPendingPermissions();
  }

  /**
   * Poll for a permission response message in the session.
   * This enables mobile and cross-session responses.
   * When a response is found, it resolves the pending permission promise.
   */
  protected async pollForPermissionResponse(
    sessionId: string,
    requestId: string,
    signal: AbortSignal
  ): Promise<void> {
    const pollInterval = 500; // ms
    const maxPollTime = 10 * 60 * 1000; // 10 minutes max
    const startTime = Date.now();

    while (!signal.aborted && Date.now() - startTime < maxPollTime) {
      // Check if request was already resolved (e.g., via IPC)
      if (!this.permissions.pendingToolPermissions.has(requestId)) {
        return; // Already resolved, stop polling
      }

      try {
        // Get recent messages for this session
        const messages = await AgentMessagesRepository.list(sessionId, { limit: 50 });

        // Look for a nimbalyst_tool_result that matches our requestId
        for (const msg of messages) {
          try {
            const content = JSON.parse(msg.content);
            // Check for new nimbalyst_tool_result format
            if (content.type === 'nimbalyst_tool_result' && content.tool_use_id === requestId) {
              // Found a response - parse the result and resolve
              const result = typeof content.result === 'string' ? JSON.parse(content.result) : content.result;
              const pending = this.permissions.pendingToolPermissions.get(requestId);
              if (pending && result.decision) {
                pending.resolve({
                  decision: result.decision,
                  scope: result.scope
                });
                this.permissions.pendingToolPermissions.delete(requestId);
                this.logSecurity('[pollForPermissionResponse] Found nimbalyst_tool_result:', {
                  requestId,
                  decision: result.decision,
                  scope: result.scope,
                  respondedBy: result.respondedBy
                });
              }
              return;
            }
            // Legacy: also check for permission_response (for backwards compatibility)
            if (content.type === 'permission_response' && content.requestId === requestId) {
              const pending = this.permissions.pendingToolPermissions.get(requestId);
              if (pending) {
                pending.resolve({
                  decision: content.decision,
                  scope: content.scope
                });
                this.permissions.pendingToolPermissions.delete(requestId);
                this.logSecurity('[pollForPermissionResponse] Found legacy permission_response:', {
                  requestId,
                  decision: content.decision,
                  scope: content.scope,
                  respondedBy: content.respondedBy
                });
              }
              return;
            }
          } catch {
            // Not valid JSON, skip
          }
        }
      } catch (error) {
        // Log but continue polling
        console.error('[CLAUDE-CODE] Error polling for permission response:', error);
      }

      // Wait before polling again
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    // Timeout - don't reject, let IPC path handle it or let it stay pending
    this.logSecurity('[pollForPermissionResponse] Polling timed out:', { requestId });
  }

  /**
   * Poll for an AskUserQuestion response message in the session.
   * This enables mobile and cross-session responses.
   * When a response is found, it resolves the pending question promise.
   */
  private async pollForAskUserQuestionResponse(
    sessionId: string,
    questionId: string,
    signal: AbortSignal
  ): Promise<void> {
    return pollForAskUserQuestionResponse(
      {
        pendingAskUserQuestions: this.pendingAskUserQuestions,
        listRecentMessages: async (resolvedSessionId, limit) =>
          AgentMessagesRepository.list(resolvedSessionId, { limit }),
        logTimeout: (resolvedQuestionId) =>
          this.logSecurity('[pollForAskUserQuestionResponse] Polling timed out:', { questionId: resolvedQuestionId }),
        logResolved: (resolvedQuestionId, answersCount, respondedBy) =>
          this.logSecurity('[pollForAskUserQuestionResponse] Found response message:', {
            questionId: resolvedQuestionId,
            answersCount,
            respondedBy
          }),
        logCancelled: (resolvedQuestionId, respondedBy) =>
          this.logSecurity('[pollForAskUserQuestionResponse] Question cancelled:', {
            questionId: resolvedQuestionId,
            respondedBy
          }),
        logError: (error) =>
          console.error('[CLAUDE-CODE] Error polling for AskUserQuestion response:', error),
      },
      {
        sessionId,
        questionId,
        signal,
      }
    );
  }


  /**
   * Build a human-readable description of a tool call for permission checking.
   * For Bash, the command itself is used. For other tools, we create a descriptive string.
   */

  /**
   * Create canUseTool handler for permission requests.
   * The SDK evaluates settings.json rules first. This handler is only called when:
   * 1. No matching rule was found in settings.json
   * 2. The tool needs user approval
   *
   * Our job is to show UI, wait for user response, and save patterns if "Always" is chosen.
   */
  private createCanUseToolHandler(sessionId?: string, workspacePath?: string, permissionsPath?: string, teammateName?: string) {
    // Use permissionsPath for trust checks (parent project for worktrees), workspacePath for everything else
    const pathForTrust = permissionsPath || workspacePath;

    let canUseToolCallCount = 0;

    const promptForTool = (
      toolName: string,
      input: any,
      options: ToolPermissionOptions,
      warnings?: string[]
    ) => (this.permissionService && sessionId && workspacePath)
      ? this.handleToolPermissionWithService(
          toolName,
          input,
          options,
          sessionId,
          workspacePath,
          permissionsPath,
          teammateName,
          warnings
        )
      : this.handleToolPermissionFallback(toolName, input, options, sessionId, workspacePath, warnings);

    return async (
      toolName: string,
      input: any,
      options: ToolPermissionOptions
    ): Promise<{ behavior: 'allow' | 'deny'; updatedInput?: any; message?: string }> => {
      const callNum = ++canUseToolCallCount;
      const callStart = Date.now();
      // console.log(`[canUseTool] #${callNum} ENTER tool="${toolName}" toolUseID=${options.toolUseID}`);

      let result: { behavior: 'allow' | 'deny'; updatedInput?: any; message?: string };

      try {
        const immediateDecision = await this.resolveImmediateToolDecision(
          toolName,
          input,
          options,
          sessionId,
          pathForTrust
        );
        // In Auto mode the SDK classifier escalated this call, so the user
        // decides on the command as a whole rather than part by part.
        const compoundDecision = !immediateDecision && toolName === 'Bash' && this.currentMode !== 'auto'
          ? await authorizeCompoundBashCommand(
              {
                isPartPreApproved: createCompoundPartPreApprovalCheck(
                  () => [this.permissions.sessionApprovedPatterns, this.permissionService?.getSessionApprovedPatterns()],
                  ClaudeCodeDeps.claudeSettingsPatternChecker ?? undefined,
                  workspacePath
                ),
                authorizePart: (partInput, warnings) => promptForTool(toolName, partInput, options, warnings),
                logSecurity: (message, data) => this.logSecurity(message, data),
              },
              input
            )
          : null;
        if (immediateDecision) {
          result = immediateDecision;
        } else if (compoundDecision) {
          result = compoundDecision;
        } else {
          result = await promptForTool(toolName, input, options);
        }
      } catch (error) {
        console.error(`[canUseTool] #${callNum} EXCEPTION tool="${toolName}" after ${Date.now() - callStart}ms:`, error);
        throw error;
      }

      // Normalize the response to satisfy the native binary's Zod schema:
      // - allow MUST have updatedInput (Record)
      // - deny MUST have message (string)
      if (result.behavior === 'allow' && result.updatedInput === undefined) {
        result.updatedInput = input;
      } else if (result.behavior === 'deny' && result.message === undefined) {
        result.message = 'Tool call denied';
      }

      // console.log(`[canUseTool] #${callNum} EXIT tool="${toolName}" -> ${result.behavior} (${Date.now() - callStart}ms)`);

      return result;
    };
  }

  private async resolveImmediateToolDecision(
    toolName: string,
    input: any,
    options: ToolPermissionOptions,
    sessionId: string | undefined,
    pathForTrust: string | undefined
  ): Promise<{ behavior: 'allow' | 'deny'; updatedInput?: any; message?: string } | null> {
    return resolveImmediateToolDecisionHelper(
      {
        internalMcpTools: INTERNAL_MCP_TOOLS,
        teamTools: TEAM_TOOLS,
        trustChecker: BaseAgentProvider.trustChecker ?? undefined,
        resolveTeamContext: (resolvedSessionId) => this.teammateManager.resolveTeamContext(resolvedSessionId),
        handleAskUserQuestion: (resolvedSessionId, resolvedInput, resolvedOptions, resolvedToolUseId) =>
          this.handleAskUserQuestion(resolvedSessionId, resolvedInput, resolvedOptions, resolvedToolUseId),
        handleExitPlanMode: (resolvedSessionId, resolvedInput, resolvedOptions) =>
          this.handleExitPlanMode(resolvedSessionId, resolvedInput, resolvedOptions),
        setCurrentMode: (mode) => { this.currentMode = mode; },
        getCurrentMode: () => this.currentMode,
        logSecurity: (message, data) => this.logSecurity(message, data),
      },
      {
        toolName,
        input,
        options,
        sessionId,
        pathForTrust,
      }
    );
  }

  private async handleToolPermissionWithService(
    toolName: string,
    input: any,
    options: ToolPermissionOptions,
    sessionId: string,
    workspacePath: string,
    permissionsPath: string | undefined,
    teammateName: string | undefined,
    warnings?: string[]
  ): Promise<{ behavior: 'allow' | 'deny'; updatedInput?: any; message?: string }> {
    return handleToolPermissionWithServiceHelper(
      {
        logSecurity: (message, data) => this.logSecurity(message, data),
        logAgentMessage: (resolvedSessionId, content) =>
          this.logAgentMessage(resolvedSessionId, 'claude-code', 'output', content),
        requestToolPermission: (request) => this.permissionService!.requestToolPermission(request),
      },
      {
        toolName,
        input,
        options,
        sessionId,
        workspacePath,
        permissionsPath,
        teammateName,
        warnings
      }
    );
  }

  private async handleToolPermissionFallback(
    toolName: string,
    input: any,
    options: ToolPermissionOptions,
    sessionId: string | undefined,
    workspacePath: string | undefined,
    warnings?: string[]
  ): Promise<{ behavior: 'allow' | 'deny'; updatedInput?: any; message?: string }> {
    return handleToolPermissionFallbackHelper(
      {
        permissions: this.permissions,
        logSecurity: (message, data) => this.logSecurity(message, data),
        logAgentMessage: (resolvedSessionId, content) =>
          this.logAgentMessage(resolvedSessionId, 'claude-code', 'output', content),
        emit: (event, payload) => this.emit(event, payload),
        pollForPermissionResponse: (resolvedSessionId, requestId, signal) =>
          this.pollForPermissionResponse(resolvedSessionId, requestId, signal),
        savePattern: ClaudeCodeDeps.claudeSettingsPatternSaver
          ? (path, pattern) => ClaudeCodeDeps.claudeSettingsPatternSaver!(path, pattern)
          : undefined,
        logError: (message, error) => console.error(message, error),
      },
      {
        toolName,
        input,
        options,
        sessionId,
        workspacePath,
        warnings,
      }
    );
  }

  /**
   * Handle AskUserQuestion tool - get user input for questions
   *
   * The toolUseID is the SDK's ID for this tool call. We use it so our synthetic
   * tool_use message has the same ID the SDK will use, allowing the widget to
   * correlate the pending question with the eventual tool_result.
   */
  private async handleAskUserQuestion(
    sessionId: string | undefined,
    input: any,
    options: { signal: AbortSignal },
    toolUseID?: string
  ): Promise<{ behavior: 'allow' | 'deny'; updatedInput?: any; message?: string }> {
    return handleAskUserQuestionTool(
      {
        sessionId,
        pendingAskUserQuestions: this.pendingAskUserQuestions,
        pollForResponse: (resolvedSessionId, questionId, signal) =>
          this.pollForAskUserQuestionResponse(resolvedSessionId, questionId, signal),
        emit: (event, payload) => this.emit(event, payload),
        logAgentMessage: async (resolvedSessionId, content) =>
          this.logAgentMessage(resolvedSessionId, 'claude-code', 'output', content),
        onError: (error) => {
          console.error('[CLAUDE-CODE] AskUserQuestion failed:', error);
        },
      },
      {
        input,
        signal: options.signal,
        toolUseID,
      }
    );
  }


  /**
   * Resolve the session's git snapshot on the first turn and freeze it.
   * `buildSystemPrompt` is synchronous, so this must be awaited before it runs.
   *
   * #1177: the frozen-ness is the whole point. We disable the CLI's own
   * git-status block because it is regenerated from the live working tree by
   * every resumed turn's process, invalidating the message prefix behind it.
   * Replacing it with a section that ALSO moves between turns would fix nothing.
   * The flag is set before the await so a concurrent second turn cannot resolve
   * a second value, and a rejected loader freezes to no context.
   */
  protected async ensureGitContext(workspacePath?: string): Promise<void> {
    if (this.gitContextFrozen) return;
    this.gitContextFrozen = true;
    if (!workspacePath || !ClaudeCodeDeps.gitContextLoader) return;
    try {
      this.frozenGitContext = (await ClaudeCodeDeps.gitContextLoader(workspacePath)) || undefined;
    } catch (error) {
      // Degrade to no git context for the life of the session. A hung `git
      // status` froze new agent sessions once already (#929) — never let this
      // block a turn, and never retry it later.
      console.warn('[CLAUDE-CODE] Failed to resolve git context:', error);
    }
  }

  protected buildSystemPrompt(documentContext?: DocumentContext, enableAgentTeams?: boolean, isMetaAgent: boolean = false, workflowPreset: MetaAgentWorkflowPreset = 'default'): string {
    if (isMetaAgent) {
      return buildMetaAgentSystemPrompt('claude', workflowPreset, {
        provider: 'claude-code',
        model: this.config.model ?? undefined,
        sessionDirective: this.frozenSessionDirective,
      });
    }

    const hasSessionNaming = isInternalMcpServerEnabled();
    const worktreePath = documentContext?.worktreePath;
    const isVoiceMode = (documentContext as any)?.isVoiceMode;
    const voiceModeCodingAgentPrompt = (documentContext as any)?.voiceModeCodingAgentPrompt;

    // ── Session naming: correctness AND prompt-cache invariant (NIM-1988) ──
    //
    // Behavior we want:
    //   - A session already named out-of-band (e.g. a spawn_session child titled
    //     by its parent, hasBeenNamed=true at creation) must NOT self-name, or it
    //     clobbers that title -> hasOutOfBandNaming = true ("do NOT set name").
    //   - Every other session names itself in-band via update_session_meta (the
    //     same call it already makes for tags/phase, so no extra paid request).
    //     We removed the SDK's generateSessionTitle side-call (NIM-1988: a
    //     byte-identical paid auxiliary request per first turn), so a fresh
    //     session MUST self-name in-band or it keeps only the host's provisional
    //     truncated first-prompt title -> hasOutOfBandNaming = false.
    //
    // Why this is memoized and NOT recomputed per turn (the part that keeps
    // biting us — do not "simplify" it back):
    //   This system prompt is sent as `--append-system-prompt` and re-sent on
    //   EVERY resumed turn (see sdkOptionsBuilder), sitting at the front of the
    //   prompt-cache prefix. `hasBeenNamed` is MUTABLE: a normal session is
    //   unnamed on turn 1 (false -> in-band variant), the agent names it, and
    //   turn 2 reads true. Gating on the live flag would flip the naming section
    //   between turns -> a full system_changed cache miss on turn 2 of every
    //   multi-turn session, re-billing the entire ~47k prefix uncached. That
    //   costs far more than the ~630 tokens the naming change saves.
    //   The first build happens BEFORE the agent's in-band naming runs, so
    //   hasBeenNamed here means "named by a caller", which is exactly the signal
    //   we want. Freeze it. Invariant covered by
    //   ClaudeCodeProvider.sessionNaming.test.ts ("stable after ... named
    //   mid-session" asserts turn2 === turn1 byte-for-byte).
    if (this.outOfBandNamingDecision === undefined) {
      this.outOfBandNamingDecision = documentContext?.hasBeenNamed === true;
    }
    const alreadyNamedOutOfBand = this.outOfBandNamingDecision;

    const prompt = buildClaudeCodeSystemPrompt({
      hasSessionNaming,
      hasOutOfBandNaming: alreadyNamedOutOfBand,
      worktreePath,
      gitContext: this.frozenGitContext,
      sessionDirective: this.frozenSessionDirective,
      isVoiceMode,
      voiceModeCodingAgentPrompt,
      enableAgentTeams,
      trackersEnabled: areTrackerToolsEnabled(resolveTrackersWorkspacePath(documentContext)),
    });

    // console.log('[CLAUDE-CODE] Built system prompt - length:', prompt.length, 'characters');
    return prompt;
  }

  /**
   * Get Claude Code models.
   * Returns standard models plus Sonnet 1M variant (access controlled by Anthropic).
   */
  static async getModels(): Promise<AIModel[]> {
    const models: AIModel[] = [];

    // Add models in desired order
    for (const variant of CLAUDE_CODE_VARIANTS) {
      // Base model. Current-gen variants run 1M natively at a flat price, so
      // their base window is 1M; legacy/haiku stay 200k (see
      // baseContextWindowForVariant / GitHub #825).
      models.push({
        id: ModelIdentifier.create('claude-code', variant).combined,
        name: `Claude Agent · ${CLAUDE_CODE_MODEL_LABELS[variant]} ${CLAUDE_CODE_VARIANT_VERSIONS[variant]}`,
        provider: 'claude-code' as const,
        maxTokens: 8192,
        contextWindow: baseContextWindowForVariant(variant)
      });

      // Add a separate 1M (`-1m`) row only for variants that still gate 1M
      // behind the suffix. Current-gen variants are excluded — their base row is
      // already 1M, so a `-1m` row would be a redundant duplicate.
      if ((CLAUDE_CODE_VARIANTS_WITH_1M as readonly string[]).includes(variant)) {
        models.push({
          id: ModelIdentifier.create('claude-code', `${variant}-1m`).combined,
          name: `Claude Agent · ${CLAUDE_CODE_MODEL_LABELS[variant]} ${CLAUDE_CODE_VARIANT_VERSIONS[variant]} (1M)`,
          provider: 'claude-code' as const,
          maxTokens: 8192,
          contextWindow: 1000000
        });
      }

    }

    return models;
  }

  /**
   * Get default model
   */
  static getDefaultModel(): string {
    return this.DEFAULT_MODEL;
  }

  /**
   * Get available slash commands discovered from the SDK.
   * Falls back to static cache from a previous session if this provider hasn't initialized yet.
   */
  getSlashCommands(): string[] {
    const commands = this.slashCommands.length > 0 ? this.slashCommands : ClaudeCodeProvider.cachedSdkSlashCommands;
    return [...commands];
  }

  /**
   * Get available skills discovered from the SDK init payload.
   * Falls back to static cache from a previous session if this provider hasn't initialized yet.
   */
  getSkills(): string[] {
    const skills = this.skills.length > 0 ? this.skills : ClaudeCodeProvider.cachedSdkSkills;
    return [...skills];
  }

  /**
   * Static accessors for the SDK cache - used by AIService when no provider instance exists.
   */
  static getCachedSdkSlashCommands(): string[] {
    return [...ClaudeCodeProvider.cachedSdkSlashCommands];
  }

  static getCachedSdkSkills(): string[] {
    return [...ClaudeCodeProvider.cachedSdkSkills];
  }

  /**
   * Get the known built-in Claude Code slash commands
   * These are always available, even before a session is initialized
   */
  static getKnownSlashCommands(): string[] {
    return [
      'compact',
      'clear',
      'context',
      'cost',
      'init',
      'output-style:new',
      'pr-comments',
      'release-notes',
      'todos',
      'review',
      'security-review'
    ];
  }

  /**
   * Get initialization data for analytics tracking
   * Returns counts for MCP servers, slash commands, agents, skills, plugins, tools, and helper method
   */
  getInitData(): {
    mcpServerCount: number;
    slashCommandCount: number;
    agentCount: number;
    skillCount: number;
    pluginCount: number;
    toolCount: number;
    helperMethod: 'native' | 'custom';
  } | null {
    const baseData = (this as any)._initData;
    if (!baseData) return null;
    return {
      ...baseData,
      helperMethod: this.helperMethod
    };
  }

  /**
   * Soft diagnostic: checks whether a session ID appears in ~/.claude/history.jsonl.
   * Not authoritative -- history.jsonl races with SDK writes and may not reflect
   * programmatic sessions at all. Callers must treat a false result as a hint, not
   * a decision. Fails open (returns true) when the file is missing or unreadable.
   */
  private async checkSessionExists(sessionId: string): Promise<boolean> {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');

      const historyPath = path.join(resolveClaudeConfigDir(), 'history.jsonl');

      let content: string;
      try {
        content = await fs.readFile(historyPath, 'utf-8');
      } catch {
        // File missing (e.g., Windows uses %APPDATA%\Claude, not ~/.claude) --
        // we can't tell whether the session exists, so fail open.
        return true;
      }

      return content.includes(sessionId);
    } catch (error) {
      console.warn('[CLAUDE-CODE] Failed to check session existence:', error);
      return true; // Assume it exists if we can't check (fail open)
    }
  }
}
