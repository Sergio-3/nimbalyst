// @vitest-environment node

import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
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
vi.mock("electron", () => ({
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
  toolCallMatcher: { matchSession: vi.fn() },
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
}));

vi.mock("../../SyncManager", () => ({
  getSyncProvider: vi.fn(() => null),
  isDesktopTrulyAway: vi.fn(() => false),
}));

vi.mock("../mobilePushRequest", () => ({
  requestMobilePush: vi.fn(),
}));

vi.mock("../pendingPromptPersistence", () => ({
  setSessionPendingPrompt: vi.fn(),
}));

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

import { MessageStreamingHandler } from "../MessageStreamingHandler";
import { findWindowByWorkspace } from "../../../window/WindowManager";

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
  service?: Record<string, unknown>;
}) {
  mocks.providerFactory.createProvider.mockReturnValue(options.provider);

  const service = {
    sessionManager: {
      loadSession: vi.fn(async () => options.session),
      addMessage: vi.fn(),
      ...options.sessionManager,
    },
    analytics: { sendEvent: vi.fn() },
    sendMessageHandler: null,
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
    ...options.service,
  };

  await new MessageStreamingHandler(service as never).handle(
    { sender: { id: 7, isDestroyed: vi.fn(() => false), send: vi.fn() } } as never,
    "Prompt",
    undefined,
    options.session.id as string,
    options.session.workspacePath as string
  );

  return service;
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

/**
 * `teammate:messageWhileIdle` is installed for every provider, so it is tested
 * here rather than in a second copy of this file's mock harness.
 */
describe("MessageStreamingHandler teammate delivery while the session is idle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providerFactory.getProvider.mockReturnValue(null);
  });

  // A handover forces the session idle so the waiting prompt can dispatch, and
  // that prompt's startSession() is an IPC round trip, a queue pass and a
  // window build away. A background agent finishing inside that gap reaches
  // this listener with its message already drained out of the teammate queue —
  // so before #1269 the guard below returned and the agent's result was gone
  // with nothing left holding it.
  it("keeps a message that lands while the query is parked for a follow-up turn", async () => {
    const session = openCodeSession({ id: "handover-session" });
    const provider = new RecordingProvider();
    const hasParkedLeaseForSession = vi.fn(() => false);
    (provider as unknown as Record<string, unknown>).hasParkedLeaseForSession = hasParkedLeaseForSession;
    const sendMessageHandler = vi.fn(async () => {});
    vi.mocked(findWindowByWorkspace).mockReturnValue({
      isDestroyed: () => false,
      webContents: { mainFrame: {} },
    } as never);

    await runTurn({ session, provider, service: { sendMessageHandler } });

    // The session is inactive throughout: isSessionActive() is false in both
    // acts, so the only thing that differs is whether a query is parked.
    expect(mocks.stateManager.isSessionActive()).toBe(false);

    provider.emit("teammate:messageWhileIdle", { sessionId: session.id, message: "sweep A finished" });
    await new Promise((resolve) => setImmediate(resolve));
    // Genuinely ended session — unchanged, the message is still dropped.
    expect(sendMessageHandler).not.toHaveBeenCalled();

    hasParkedLeaseForSession.mockReturnValue(true);
    provider.emit("teammate:messageWhileIdle", { sessionId: session.id, message: "sweep B finished" });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(sendMessageHandler.mock.calls.map((call) => (call as unknown as unknown[])[1]))
      .toEqual(["sweep B finished"]);
    expect(hasParkedLeaseForSession).toHaveBeenLastCalledWith("handover-session");
  });
});
