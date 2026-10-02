// @vitest-environment node

import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pushChange: vi.fn(),
  providerFactory: {
    getProvider: vi.fn(),
    createProvider: vi.fn(),
  },
  stateManager: {
    startSession: vi.fn(),
    updateActivity: vi.fn(),
    endSession: vi.fn(),
    isSessionActive: vi.fn(() => false),
  },
}));

// MessageStreamingHandler pulls in most of the main process. Everything below
// exists only to let it import; nothing here is under test.
vi.mock("electron", async () => ({
  app: (await import('../../../../../test-stubs/privateUserData')).testApp,
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
  },
}));

vi.mock("@nimbalyst/runtime/ai/server", () => ({
  ProviderFactory: mocks.providerFactory,
  ModelRegistry: {
    getModelsForProvider: vi.fn(async () => []),
    getDefaultModel: vi.fn(),
  },
  OpenAICodexProvider: {
    normalizeModelSelection: vi.fn((model: string) => model),
  },
  isAgentProvider: vi.fn((provider: string) => provider === "opencode"),
  onAgentMessageBatch: vi.fn(() => vi.fn()),
  buildMetaAgentSystemPrompt: vi.fn(),
  buildDevAgentSystemPrompt: vi.fn(),
}));

vi.mock("@nimbalyst/runtime/ai/server/SessionStateManager", () => ({
  getSessionStateManager: vi.fn(() => mocks.stateManager),
}));

vi.mock("@nimbalyst/runtime/ai/server/utils/errorDetection", () => ({
  isBedrockToolSearchError: vi.fn(() => false),
}));

vi.mock("@nimbalyst/runtime/ai/server/effortLevels", () => ({
  resolveEffortLevel: vi.fn(() => undefined),
  resolveThinkingMode: vi.fn(() => undefined),
}));

vi.mock("@nimbalyst/runtime/storage/repositories/AISessionsRepository", () => ({
  AISessionsRepository: { get: vi.fn() },
}));

vi.mock("@nimbalyst/runtime/ai/modelConstants", () => ({
  resolveClaudeCodeParentContextWindow: vi.fn(),
}));

vi.mock("@nimbalyst/runtime/types/MCPServerConfig", () => ({
  buildMcpSessionStatusSnapshot: vi.fn(() => ({})),
}));

vi.mock("../tools", () => ({
  toolRegistry: { getAll: vi.fn(() => []) },
}));

vi.mock("../providerResolution", () => ({
  resolveExtensionAgentRef: vi.fn(() => null),
  // OpenCode discovers its tools over MCP, so it is not a tool-loop provider.
  usesHostSuppliedToolLoop: vi.fn(() => false),
}));

vi.mock("../../../extensions/AgentProviderRegistry", () => ({
  getAgentProviderRegistry: vi.fn(),
}));

vi.mock("../../SoundNotificationService", () => ({
  SoundNotificationService: {
    getInstance: vi.fn(() => ({ playCompletionSound: vi.fn() })),
  },
}));

vi.mock("../../NotificationService", () => ({
  notificationService: { showNotification: vi.fn() },
}));

vi.mock("../../../../shared/notificationTitle", () => ({
  composeNotificationTitle: vi.fn(),
}));

vi.mock("../../../utils/logger", () => ({
  logger: {
    ai: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    main: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

vi.mock("../../../window/WindowManager", () => ({
  windowStates: new Map(),
  findWindowByWorkspace: vi.fn(() => null),
}));

vi.mock("../../SessionFileTracker", () => ({
  sessionFileTracker: { trackUserMessage: vi.fn() },
}));

vi.mock("../../CodexEditWindowRegistry", () => ({
  codexEditWindowRegistry: { clearSession: vi.fn() },
  shouldOpenCodexEditWindow: vi.fn(() => false),
}));

vi.mock("../../ToolCallMatcher", () => ({
  toolCallMatcher: { matchSession: vi.fn(async () => 0) },
  unwrapShellCommand: vi.fn(),
}));

vi.mock("../../FeatureUsageService.ts", () => ({
  FeatureUsageService: {
    getInstance: vi.fn(() => ({ recordUsage: vi.fn() })),
  },
  FEATURES: {
    AI_PROMPT_SUBMITTED: "ai_prompt_submitted",
  },
}));

vi.mock("../../ToolUsageService", () => ({
  ToolUsageService: { getInstance: vi.fn() },
}));

vi.mock("../../../HistoryManager", () => ({
  historyManager: {},
}));

vi.mock("../../../file/WorkspaceEventBus", () => ({
  addGitignoreBypass: vi.fn(),
  // requestUserInputResumption reaches codexShellTrackingHost through
  // RepositoryManager, and that module reads this export at load.
  drainWorkspaceEvents: vi.fn(),
}));

vi.mock("../../SyncManager", () => ({
  getSyncProvider: vi.fn(() => ({ pushChange: mocks.pushChange })),
  isDesktopTrulyAway: vi.fn(() => false),
}));

vi.mock("../mobilePushRequest", () => ({
  requestMobilePush: vi.fn(),
}));

vi.mock("../supersedeOpenQuestions", () => ({
  supersedeOpenQuestions: vi.fn(async () => ({ superseded: [], skipped: [] })),
}));
vi.mock("../pendingPromptPersistence", () => ({
  setSessionPendingPrompt: vi.fn(),
}));
vi.mock('../sessionInboxService', () => ({
  sessionInbox: { current: vi.fn(), begin: vi.fn(), end: vi.fn(async () => {}) },
}));
vi.mock('../../../mcp/httpServer', () => ({ updateDocumentState: vi.fn(), registerWorkspaceWindow: vi.fn() }));

vi.mock("../../AgentWorkflowService", () => ({
  getAgentWorkflowService: vi.fn(),
}));

vi.mock("../../../mcp/metaAgentServer", () => ({
  getMetaAgentOpenAITools: vi.fn(),
}));

vi.mock("../../../mcp/devAgentTools", () => ({
  getDevAgentOpenAITools: vi.fn(),
  resolveDevToolScope: vi.fn(),
}));

vi.mock("../../MetaAgentService", () => ({
  MetaAgentService: { getInstance: vi.fn() },
}));

vi.mock("../../../utils/store", () => ({
  getDefaultEffortLevel: vi.fn(() => undefined),
  getDefaultThinkingMode: vi.fn(() => undefined),
  getAppSetting: vi.fn(() => undefined),
  shouldShowCommunityPopup: vi.fn(() => false),
  markCommunityPopupShown: vi.fn(),
  wasCommunityPopupShownThisLaunch: vi.fn(() => false),
  incrementCompletedSessionsWithTools: vi.fn(),
}));

vi.mock("../childSessionTakeover", () => ({
  disableParentNotificationsAfterDirectTakeover: vi.fn(),
}));

vi.mock("../sessionSettlePolicy", () => ({
  shouldSettleUnterminatedTurn: vi.fn(() => false),
}));

vi.mock("../../tutorial/tutorialAnalytics", () => ({
  captureTutorialMilestone: vi.fn(),
}));

vi.mock("../requestUserInputResumption", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../requestUserInputResumption")>()),
  notePromptTurnEnded: vi.fn(),
}));

// The Super Loop listener writes loop state into the renderer store; only its
// sends are under test.
vi.mock("../../../../renderer/store/index", () => ({ store: { set: vi.fn() } }));
vi.mock("../../../../renderer/store/atoms/superLoop", () => ({ processSuperEventAtom: {} }));

import { AgentMessagesRepository } from "@nimbalyst/runtime/storage/repositories/AgentMessagesRepository";
import { MessageStreamingHandler } from "../MessageStreamingHandler";
import { logger } from '../../../utils/logger';
import { resolveClaudeCodeParentContextWindow } from '@nimbalyst/runtime/ai/modelConstants';
import { resetPushOutcomeWarnings } from '@nimbalyst/runtime/sync/pushOutcome';
import { buildResumeMessage, notePromptTurnEnded } from "../requestUserInputResumption";
import { findWindowByWorkspace } from "../../../window/WindowManager";
import { partitionUnansweredQuestions } from "@nimbalyst/runtime/ai/server/interactivePromptTools";
import { stampPromptSource } from "@nimbalyst/runtime/ai/server/transcript/processDescriptor";
import { BaseAIProvider } from "@nimbalyst/runtime/ai/server/AIProvider";
import { dispatchClaimedQueuedPrompt, SessionProcessingGuard } from "../queuedPromptDispatcher";
import { buildRestartContinuationPrompt } from "../../../mcp/restartContinuationPrompt";
import { initSuperLoopListeners } from "../../../../renderer/store/listeners/superLoopListeners";

/**
 * OpenCode replaces its whole config on every `initialize`, which is how the
 * session model was lost in #730. This records both the initialize calls and
 * the config in force at the request boundary, which is what the turn runs.
 */
class RecordingProvider extends EventEmitter {
  config: Record<string, unknown> = {};
  initializeConfigs: Array<Record<string, unknown>> = [];
  requestConfigs: Array<Record<string, unknown>> = [];

  constructor(private readonly chunks: Array<Record<string, unknown>> = []) {
    super();
  }

  async initialize(config: Record<string, unknown>) {
    this.initializeConfigs.push(config);
    this.config = config;
  }

  registerToolHandler() {}

  getCapabilities() {
    return { supportsFileTools: true };
  }

  async *sendMessage() {
    this.requestConfigs.push(this.config);
    for (const chunk of this.chunks) yield chunk;
  }
}

function openCodeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "opencode-session",
    provider: "opencode",
    model: "opencode:anthropic/claude-sonnet-4",
    providerConfig: {},
    messages: [{ role: "assistant", content: "Existing turn", timestamp: 1 }],
    workspacePath: "/workspace",
    ...overrides,
  };
}

async function runTurn(options: {
  session: Record<string, unknown>;
  provider: RecordingProvider;
  sessionManager?: Record<string, unknown>;
  documentContext?: Record<string, unknown>;
  sendMessageHandler?: (...args: any[]) => Promise<unknown>;
}) {
  mocks.providerFactory.createProvider.mockReturnValue(options.provider);

  const service = {
    sessionManager: {
      loadSession: vi.fn(async () => options.session),
      addMessage: vi.fn(),
      ...options.sessionManager,
    },
    analytics: { sendEvent: vi.fn() },
    sendMessageHandler: options.sendMessageHandler ?? null,
    processingQueuedPromptIds: new Set(),
    matchDebounceTimers: new Map(),
    sessionsProcessingQueue: new Set(),
    documentContextService: {
      prepareContext: vi.fn(() => ({ documentContext: {}, userMessageAdditions: {} })),
    },
    hooklessWatcher: {
      ensureForSession: vi.fn(),
      stopForSession: vi.fn(),
      scheduleStop: vi.fn(),
    },
    getSettingsStore: vi.fn(),
    getApiKeyForProvider: vi.fn(() => undefined),
    buildClaudeCodeRuntimeConfig: vi.fn(),
    tryDispatchNextQueuedPrompt: vi.fn(async () => false),
    requestQueueDrive: vi.fn(),
    createToolHandler: vi.fn(() => vi.fn()),
  };

  await new MessageStreamingHandler(service as never).handle(
    { sender: { id: 7, isDestroyed: vi.fn(() => false), send: vi.fn() } } as never,
    "Prompt",
    options.documentContext as never,
    options.session.id as string,
    options.session.workspacePath as string
  );
}

describe("MessageStreamingHandler OpenCode turn config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providerFactory.getProvider.mockReturnValue(null);
  });

  it("keeps the selected model through the final per-turn provider initialization", async () => {
    // #730 regressed because #800's final shared refresh replaced OpenCode's
    // whole config without the model.
    const provider = new RecordingProvider();
    const session = openCodeSession({ providerConfig: { maxTokens: 4096, temperature: 0.2 } });

    await runTurn({ session, provider });

    const expectedConfig = {
      apiKey: undefined,
      model: "anthropic/claude-sonnet-4",
      maxTokens: 4096,
      temperature: 0.2,
    };
    expect(provider.initializeConfigs).toEqual([expectedConfig, expectedConfig]);
    expect(provider.config).toBe(provider.initializeConfigs[1]);
    expect(provider.requestConfigs).toEqual([expectedConfig]);
    expect(mocks.providerFactory.createProvider).toHaveBeenCalledWith("opencode", session.id);
  });

  it("carries the session role into the config the turn actually runs with", async () => {
    const provider = new RecordingProvider();

    await runTurn({
      session: openCodeSession({
        id: "opencode-role-session",
        metadata: { opencodeAgent: "plan" },
      }),
      provider,
    });

    expect(provider.requestConfigs).toEqual([
      expect.objectContaining({ model: "anthropic/claude-sonnet-4", agentRole: "plan" }),
    ]);
  });
});

describe("MessageStreamingHandler provisional title", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providerFactory.getProvider.mockReturnValue(null);
  });

  it("titles a fresh session from its first prompt but keeps a title its caller assigned", async () => {
    const updateSessionTitle = vi.fn();
    for (const [id, hasBeenNamed] of [["fresh-session", false], ["caller-named-session", true]] as const) {
      await runTurn({
        session: openCodeSession({ id, messages: [], hasBeenNamed }),
        provider: new RecordingProvider(),
        sessionManager: { updateSessionTitle },
      });
    }

    expect(updateSessionTitle.mock.calls).toEqual([
      ["fresh-session", "Prompt", { force: true, markAsNamed: false }],
    ]);
  });
});

describe("MessageStreamingHandler OpenCode context usage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providerFactory.getProvider.mockReturnValue(null);
  });

  it("persists usage with the resolved model context denominator", async () => {
    const updateSessionTokenUsage = vi.fn();

    await runTurn({
      session: openCodeSession({ id: "opencode-usage-session" }),
      provider: new RecordingProvider([{
        type: "complete",
        isComplete: true,
        usage: { input_tokens: 1_000, output_tokens: 200, total_tokens: 1_200 },
        contextFillTokens: 12_500,
        contextWindow: 200_000,
      }]),
      sessionManager: { updateSessionTokenUsage },
    });

    expect(updateSessionTokenUsage).toHaveBeenCalledWith("opencode-usage-session", {
      inputTokens: 1_000,
      outputTokens: 200,
      totalTokens: 1_200,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      contextWindow: 200_000,
      currentContext: { tokens: 12_500, contextWindow: 200_000 },
    });
  });

  it("drops the context reading that a compaction just invalidated", async () => {
    // The fill this turn reports is measured on the pre-boundary conversation,
    // so it is as stale as the stored one. Showing nothing until a turn
    // measures the summary beats leaving the session reading 90% after the one
    // action whose purpose is reducing context.
    const updateSessionTokenUsage = vi.fn();

    await runTurn({
      session: openCodeSession({
        id: "opencode-compaction-session",
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          contextWindow: 200_000,
          currentContext: { tokens: 180_000, contextWindow: 200_000 },
        },
      }),
      provider: new RecordingProvider([{
        type: "complete",
        isComplete: true,
        usage: { input_tokens: 100, output_tokens: 20 },
        contextFillTokens: 180_000,
        contextWindow: 200_000,
        contextCompacted: true,
      }]),
      sessionManager: { updateSessionTokenUsage },
    });

    const persisted = updateSessionTokenUsage.mock.calls[0][1];
    expect(persisted.currentContext).toBeUndefined();
    // The denominator goes too, or the meter divides cumulative spend by the
    // window and reports a confident percentage that was never measured.
    expect(persisted.contextWindow).toBeUndefined();
    // Compaction reset the context, not what the session has spent.
    expect(persisted.totalTokens).toBe(132);
  });
});

describe('stream publication warnings', () => {
  class MetadataProvider extends RecordingProvider {
    async *sendMessage() {
      this.emit('session:metadata-updated', { sessionId: 'sync-session', metadata: { phase: 'implementing' } });
      yield* super.sendMessage();
    }
  }
  class RejectingProvider extends MetadataProvider {
    async *sendMessage(): AsyncGenerator<Record<string, unknown>> {
      yield* super.sendMessage();
      throw new Error('stream rejected');
    }
  }
  const chunks = [
    { type: 'context_usage', contextFillTokens: 100, contextWindow: 200000 },
    { type: 'complete', isComplete: true, usage: { input_tokens: 100, output_tokens: 10 },
      modelUsage: { sonnet: { contextWindow: 200000 } }, contextFillTokens: 110, contextWindow: 200000 },
  ];
  function turn(provider: RecordingProvider, providerType = 'opencode') {
    return runTurn({
      session: openCodeSession({ id: 'sync-session', provider: providerType,
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextWindow: 200000 } }),
      provider, sessionManager: { updateSessionTokenUsage: vi.fn() },
    });
  }
  function expectWarnings(count: number) {
    expect(mocks.pushChange).toHaveBeenCalledTimes(count);
    expect(logger.main.warn).toHaveBeenCalledTimes(count);
    for (let i = 1; i <= count; i++) {
      expect(logger.main.warn).toHaveBeenCalledWith(expect.stringContaining(`session sync-session: disconnected-${i}`));
    }
  }
  beforeEach(() => {
    vi.clearAllMocks();
    resetPushOutcomeWarnings();
    mocks.providerFactory.getProvider.mockReturnValue(null);
    vi.mocked(resolveClaudeCodeParentContextWindow).mockReturnValue(200000);
    let publication = 0;
    mocks.pushChange.mockImplementation(async () => ({ published: false, reason: `disconnected-${++publication}` }));
  });
  it('reports all five publications during an OpenCode turn', async () => {
    await turn(new MetadataProvider(chunks));
    expectWarnings(5);
  });
  it('reports all five publications during a Claude turn', async () => {
    await turn(new MetadataProvider(chunks), 'claude-code');
    expectWarnings(5);
  });
  it('reports three publications when the provider emits an error', async () => {
    await turn(new MetadataProvider([{ type: 'error', error: 'turn failed' }]));
    expectWarnings(3);
  });
  it('reports three publications and preserves the stream rejection', async () => {
    await expect(turn(new RejectingProvider())).rejects.toThrow('stream rejected');
    expectWarnings(3);
  });
  it('does not block provider execution or chunks behind execution-state and live-context publishes', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    mocks.pushChange.mockImplementation(async (_id, change) => {
      if (change.metadata.isExecuting === true || change.metadata.currentContext) await pending;
      return { published: true };
    });
    let finished = false;
    const running = turn(new RecordingProvider([chunks[0]])).then(() => { finished = true; });
    await vi.waitFor(() => expect(finished).toBe(true));
    expect(mocks.pushChange).toHaveBeenCalledTimes(3);
    release();
    await running;
  });
});

describe("MessageStreamingHandler turn end", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providerFactory.getProvider.mockReturnValue(null);
  });

  it("records the end of every turn once its stream is over, also of one that fails", async () => {
    // A form its turn left without a result gets no waiter anymore; the answer
    // path reads this record to resume the session instead. Recorded while the
    // stream still runs, it would declare the turn's own starting forms dead.
    const notedDuringStream: boolean[] = [];
    const noted = (sessionId: string) => vi.mocked(notePromptTurnEnded).mock.calls.some(([id]) => id === sessionId);

    const ending = new RecordingProvider();
    ending.sendMessage = async function* () {
      notedDuringStream.push(noted("ended-session"));
    };
    await runTurn({ session: openCodeSession({ id: "ended-session" }), provider: ending });
    expect(notePromptTurnEnded).toHaveBeenCalledWith("ended-session");

    const failing = new RecordingProvider();
    failing.sendMessage = async function* () {
      notedDuringStream.push(noted("failed-session"));
      throw new Error("provider died");
    };
    await runTurn({ session: openCodeSession({ id: "failed-session" }), provider: failing }).catch(() => {});
    expect(notePromptTurnEnded).toHaveBeenCalledWith("failed-session");
    expect(notedDuringStream).toEqual([false, false]);
  });
});

describe("MessageStreamingHandler resume turn of an answered form", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providerFactory.getProvider.mockReturnValue(null);
  });

  it("closes the form once the turn's input row is stored, hidden or not", async () => {
    const answers = { farbe: { type: "singleSelect", selectedId: "rot" } };
    const rows: Array<{ sessionId: string; direction: string; hidden?: boolean; content: string }> = [
      {
        sessionId: "resume-session",
        direction: "input",
        hidden: true,
        content: JSON.stringify({ prompt: buildResumeMessage({ toolUseId: "toolu_X", answers, respondedAt: 1, late: false }) }),
      },
    ];
    const create = vi.fn(async (row: (typeof rows)[number]) => {
      rows.push(row);
    });
    AgentMessagesRepository.setStore({
      create,
      list: async (sessionId: string) => rows.filter((row) => row.sessionId === sessionId),
    } as never);
    try {
      const provider = new RecordingProvider();
      provider.sendMessage = async function* () {
        provider.emit("message:logged", { sessionId: "resume-session", direction: "input", hidden: true });
      };
      await runTurn({
        session: openCodeSession({ id: "resume-session" }),
        provider,
        documentContext: { answeredPrompt: { toolUseId: "toolu_X", answers, respondedBy: "desktop" } },
      });

      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      const result = JSON.parse(create.mock.calls[0][0].content);
      expect(result).toMatchObject({ type: "nimbalyst_tool_result", tool_use_id: "toolu_X", is_error: false });
      expect(JSON.parse(result.result).answers).toEqual(answers);
    } finally {
      AgentMessagesRepository.clearStore();
    }
  });
});

// A finished background task or teammate wakes the idle lead with a system
// message. It is not the user moving on, so a question still waiting for an
// answer must stay open after it. The wake turn's document context decides how
// its input row is labelled, and the transcript reads that label.
describe("MessageStreamingHandler wake turn after background work", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providerFactory.getProvider.mockReturnValue(null);
  });

  it("leaves an open question open when only a wake message follows it", async () => {
    mocks.stateManager.isSessionActive.mockReturnValue(true);
    vi.mocked(findWindowByWorkspace).mockReturnValue({
      isDestroyed: () => false,
      webContents: { mainFrame: {} },
    } as never);
    const wakeSends: Array<Record<string, unknown> | undefined> = [];
    const sendMessageHandler = vi.fn(async (_event: unknown, _message: string, context?: Record<string, unknown>) => {
      wakeSends.push(context);
    });
    try {
      // The lead's turn ends while a background task runs; the task settles
      // later and the provider wakes the idle lead.
      const lead = new RecordingProvider();
      lead.sendMessage = async function* () {
        lead.emit("teammate:messageWhileIdle", {
          sessionId: "wake-session",
          message: "[System: background task(s) you launched have settled: done]",
        });
      };
      await runTurn({ session: openCodeSession({ id: "wake-session" }), provider: lead, sendMessageHandler });
      await vi.waitFor(() => expect(sendMessageHandler).toHaveBeenCalledTimes(1));

      // Run the wake turn with the context it was sent with and record what
      // the provider logs its input row with.
      let wakeTurnContext: Record<string, unknown> | undefined;
      const wakeTurn = new RecordingProvider();
      wakeTurn.sendMessage = async function* (_message: string, context?: Record<string, unknown>) {
        wakeTurnContext = context;
      } as never;
      await runTurn({ session: openCodeSession({ id: "wake-session" }), provider: wakeTurn, documentContext: wakeSends[0] });

      const wakeRow = stampPromptSource(
        { type: "user_message", text: "[System: background task(s) you launched have settled: done]" } as never,
        {
          metadata: {
            ...(wakeTurnContext?.promptProvenance ? { promptProvenance: wakeTurnContext.promptProvenance } : {}),
            ...(wakeTurnContext?.promptOrigin ? { promptOrigin: wakeTurnContext.promptOrigin } : {}),
          },
        } as never,
      ) as never;
      const question = { type: "tool_call", toolCall: { toolName: "mcp__nimbalyst__PromptForUserInput", providerToolCallId: "toolu_open" } };
      const { open, superseded } = partitionUnansweredQuestions([{ type: "user_message" }, question, wakeRow]);

      expect(superseded).toEqual([]);
      expect(open.map((q) => q.id)).toEqual(["toolu_open"]);
    } finally {
      mocks.stateManager.isSessionActive.mockReturnValue(false);
      vi.mocked(findWindowByWorkspace).mockReturnValue(null as never);
    }
  });
});

/**
 * Runs the turn a send starts with `documentContext` and returns its input row
 * the way the transcript reads it: the provider's own helper turns the context
 * the turn received into the row's metadata, `stampPromptSource` reads it back.
 */
async function storedInputRow(sessionId: string, text: string, documentContext: Record<string, unknown> | undefined) {
  let turnContext: Record<string, unknown> | undefined;
  const turn = new RecordingProvider();
  turn.sendMessage = async function* (_message: string, context?: Record<string, unknown>) {
    turnContext = context;
  } as never;
  await runTurn({ session: openCodeSession({ id: sessionId }), provider: turn, documentContext });
  const metadata = (BaseAIProvider.prototype as any).withPromptProvenanceMetadata.call({}, turnContext);
  return stampPromptSource({ type: "user_message", text } as never, { metadata } as never) as never;
}

/** Who `row` is stored as, and which question asked before it the transcript still offers to answer. */
function questionAfter(row: never) {
  const question = { type: "tool_call", toolCall: { toolName: "mcp__nimbalyst__PromptForUserInput", providerToolCallId: "toolu_open" } };
  const { open, superseded } = partitionUnansweredQuestions([{ type: "user_message" }, question, row]);
  return {
    actor: (row as { promptActor?: string }).promptActor,
    open: open.map((q) => q.id),
    superseded: superseded.map((q) => q.id),
  };
}

const STAYS_OPEN = { actor: "system", open: ["toolu_open"], superseded: [] };

// The app, not the user, sends these. Each must leave a question that was
// waiting for an answer open, like the wake message above.
describe("MessageStreamingHandler automatic sends after an open question", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providerFactory.getProvider.mockReturnValue(null);
  });

  it("leaves it open after the continuation that resumes a session after an app restart", async () => {
    const queued = buildRestartContinuationPrompt("restart-session", 1);
    const sent: Array<Record<string, unknown> | undefined> = [];
    await dispatchClaimedQueuedPrompt({
      claimed: queued,
      continueQueuedPromptChain: vi.fn(async () => {}),
      logError: vi.fn(),
      onPromptClaimed: vi.fn(),
      processingSet: new SessionProcessingGuard(),
      queueStore: { listPending: vi.fn(), claim: vi.fn(), complete: vi.fn(async () => {}), fail: vi.fn(async () => {}) },
      sendMessageHandler: vi.fn(async (_event, _message, context) => {
        sent.push(context as Record<string, unknown> | undefined);
        return { content: "" };
      }),
      sessionId: queued.sessionId,
      source: "restart-continuation",
      startSession: vi.fn(async () => {}),
      targetWindow: { webContents: { mainFrame: {} } } as never,
      workspacePath: "/workspace",
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    const row = await storedInputRow(queued.sessionId, queued.prompt, sent[0]);

    expect(questionAfter(row)).toEqual(STAYS_OPEN);
  });

  it("leaves it open after a Super Loop iteration prompt and its progress reminder", async () => {
    const listeners = new Map<string, (data: any) => unknown>();
    const sent: Array<{ message: string; context: Record<string, unknown> | undefined }> = [];
    let progressChecks = 0;
    const completed = vi.fn();
    (globalThis as any).window = {
      electronAPI: {
        on: vi.fn((channel: string, handler: (data: any) => unknown) => {
          listeners.set(channel, handler);
          return () => listeners.delete(channel);
        }),
        invoke: vi.fn(async (channel: string, ...args: any[]) => {
          if (channel === "ai:sendMessage") {
            sent.push({ message: args[0], context: args[1] });
            setImmediate(() => listeners.get("ai:streamResponse")?.({ sessionId: args[2], isComplete: true }));
            return undefined;
          }
          // The first iteration forgets the progress tool, so the loop reminds it once.
          if (channel === "super-loop:was-progress-tool-called") return { called: ++progressChecks > 1 };
          return undefined;
        }),
        send: completed,
      },
    };
    const cleanup = initSuperLoopListeners();
    try {
      await listeners.get("super-loop:iteration-prompt")!({
        superLoopId: "loop-1",
        sessionId: "loop-session",
        prompt: "Iteration 1: continue the plan",
        worktreePath: "/workspace",
        workspaceId: "/workspace",
      });
      expect(completed).toHaveBeenCalledWith("super-loop:session-complete", "loop-session", true);
      expect(sent).toHaveLength(2);

      const outcomes = [];
      for (const { message, context } of sent) {
        outcomes.push(questionAfter(await storedInputRow("loop-session", message, context)));
      }
      expect(outcomes).toEqual([STAYS_OPEN, STAYS_OPEN]);
    } finally {
      cleanup();
      delete (globalThis as any).window;
    }
  });
});
