import { managedClaudeEnvironment } from '../../../../electron/managedClaudeEnvironment';
/**
 * Builds the SDK options object for a Claude Code query() call.
 *
 * Consolidates all the configuration loading, environment setup, session
 * resumption, tool restrictions, and prompt construction that happens
 * before the streaming loop begins.
 */

import type { ContentBlockParam, TextBlockParam, MessageParam } from '@anthropic-ai/sdk/resources';
// Type-only, so it is erased at build time and the SDK stays dynamically
// loaded. #1361 shipped a 20-version SDK jump whose compatibility could only be
// verified by diffing the .d.ts by hand, because this object was `any`. Bound to
// the SDK's own type, a removed or renamed option fails typecheck at the next
// bump instead of silently becoming a no-op at runtime.
import type { Options as ClaudeAgentSdkOptions, SettingSource } from '@anthropic-ai/claude-agent-sdk';
import path from 'path';
import { createHash } from 'crypto';
import { getHostEnvironment } from '../../../../host/hostEnvironment';
import { ClaudeCodeDeps } from './dependencyInjection';
import { resolveClaudeAgentCliPath } from './cliPathResolver';
import { hasEnterpriseManagedMcpConfig } from './enterpriseMcpConfig';
import { type ThinkingMode } from '../../effortLevels';

type SessionMode = 'planning' | 'agent' | 'auto' | undefined;

type SDKUserMessage = {
  type: 'user';
  message: MessageParam;
  parent_tool_use_id: string | null;
};

export interface BuildSdkOptionsDeps {
  resolveModelVariant: () => string;
  getMcpServersSnapshot: (params: {
    sessionId?: string;
    workspacePath: string;
    profile?: 'standard' | 'meta-agent';
  }) => Promise<Record<string, any>>;
  createCanUseToolHandler: (sessionId?: string, workspacePath?: string, permissionsPath?: string) => any;
  toolHooksService: {
    createPreToolUseHook: () => any;
    createPostToolUseHook: () => any;
    createPermissionDeniedHook: () => any;
  };
  teammateManager: {
    lastUsedCwd?: string | undefined;
    lastUsedSessionId?: string | undefined;
    lastUsedPermissionsPath?: string | undefined;
    packagedBuildOptions?: any;
    resolveTeamContext: (sessionId?: string) => Promise<string | undefined>;
  };
  sessions: { getSessionId: (sessionId: string) => string | null | undefined };
  config: { model?: string; apiKey?: string; effortLevel?: string; thinkingMode?: ThinkingMode };
  abortController: AbortController;
  /**
   * True when an enterprise `managed-mcp.json` forbids passing MCP servers at
   * all (NIM-2372). Injectable for tests; defaults to the real filesystem probe.
   */
  hasEnterpriseMcpLockdown?: () => boolean;
}

export interface BuildSdkOptionsParams {
  message: string;
  workspacePath: string;
  sessionId?: string;
  documentContext?: any;
  settingsEnv: Record<string, string>;
  shellEnv: Record<string, string>;
  systemPrompt: string;
  currentMode: SessionMode;
  imageContentBlocks: ContentBlockParam[];
  documentContentBlocks: ContentBlockParam[];
  permissionsPath?: string;
  mcpConfigWorkspacePath?: string;
  isMetaAgent?: boolean;
}

/**
 * Controls the lifetime of the prompt AsyncIterable so the SDK keeps the
 * binary's stdin pipe open for the duration of the turn. Calling end() lets
 * the generator return, which in turn lets the SDK call transport.endInput()
 * and close stdin normally.
 *
 * We always use an AsyncIterable prompt (never a bare string) so the SDK
 * sets isSingleUserTurn=false and does NOT preemptively close stdin when
 * `type: 'result'` arrives -- that forced close is the root cause of the
 * "Tool permission request failed: Error: Stream closed" errors on turns
 * where the binary emits a late can_use_tool after result.
 *
 * See nimbalyst-local/plans/stream-closed-native-binary-investigation.md
 * for full root cause and history of the previous reverted attempt.
 */
export interface PromptStreamController {
  end(reason: string): void;
  isEnded(): boolean;
  /**
   * Queue a follow-up user turn on the live stream. Returns false if the
   * stream has already ended, in which case nothing was queued.
   *
   * This is the only way to start another user turn without closing stdin.
   * `Query.streamInput()` calls `transport.endInput()` unconditionally once
   * its input iterable ends, so delivering a single message through it shuts
   * the pipe the running sub-agents are still using. #1269.
   */
  push(message: SDKUserMessage): boolean;
}

export interface BuildSdkOptionsResult {
  options: ClaudeAgentSdkOptions;
  promptInput: AsyncIterable<SDKUserMessage>;
  promptController: PromptStreamController;
  /**
   * The content of the turn's first user message — a bare string, or the
   * attachment blocks followed by the text. Handed back so a turn that adopts
   * a parked query pushes the SAME content onto that query's stream instead of
   * rebuilding it, which is what kept attachments out of the handover while
   * two places disagreed about where they live. #1269.
   */
  initialUserContent: string | ContentBlockParam[];
  helperMethod: 'native' | 'custom';
}

function canDisableThinkingForModel(model: string | undefined): boolean {
  const normalized = model?.toLowerCase() ?? '';
  if (!normalized || normalized.includes('fable') || normalized.includes('haiku')) {
    return false;
  }
  return normalized.includes('opus') || normalized.includes('sonnet');
}

export function createPersistentPromptStream(
  initialMessage: SDKUserMessage,
): { iterable: AsyncIterable<SDKUserMessage>; controller: PromptStreamController } {
  let ended = false;
  let endResolve: (() => void) | null = null;
  const endPromise = new Promise<void>((resolve) => {
    endResolve = () => {
      ended = true;
      resolve();
    };
  });

  // Follow-up turns queued by push() while the generator is parked below.
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let wakePromise = new Promise<void>((resolve) => {
    wake = resolve;
  });

  async function* generator(): AsyncGenerator<SDKUserMessage> {
    yield initialMessage;
    // Never return before end(): the SDK's streamInput() calls
    // transport.endInput() the moment this generator finishes iterating, which
    // closes the binary's stdin. Follow-up user turns are yielded from the
    // queue instead, so the pipe survives them. The ClaudeCodeProvider arms a
    // grace-period timer on the first `result` chunk and calls
    // controller.end() to release us; safety nets in sendMessage's finally
    // block and abort() ensure we always exit. #1269.
    //
    // The queue is drained BEFORE the end check, not alongside it. push()
    // returning true is the caller's proof that the message was delivered — the
    // adoption path treats it as exactly that and commits the turn to the parked
    // query on the strength of it. An end() arriving between a successful push()
    // and the generator's next resumption must therefore still let the queued
    // turn out; dropping it would make that proof a lie and lose the user's
    // prompt in silence. end() still wins for everything after it: push()
    // refuses once ended, so the queue cannot grow past this point. #1269.
    while (true) {
      while (queue.length > 0) {
        yield queue.shift() as SDKUserMessage;
      }
      if (ended) break;
      await Promise.race([endPromise, wakePromise]);
    }
  }

  return {
    iterable: generator(),
    controller: {
      end: (reason: string) => {
        if (!ended && endResolve) {
          // console.log(`[CLAUDE-CODE] PromptStreamController.end(reason="${reason}")`);
          endResolve();
        }
      },
      isEnded: () => ended,
      push: (message: SDKUserMessage) => {
        if (ended) return false;
        queue.push(message);
        // Swap in the next wake promise BEFORE resolving the current one, so a
        // generator that re-enters the race parks on a fresh, unresolved one.
        const resolveCurrent = wake;
        wakePromise = new Promise<void>((resolve) => {
          wake = resolve;
        });
        resolveCurrent?.();
        return true;
      },
    },
  };
}

/**
 * Fingerprint of the options a live SDK subprocess was started with.
 *
 * A parked query keeps running under the options of the turn that created it.
 * Model, effort, thinking mode, tool restrictions, permission mode, the MCP
 * snapshot, the working directory and the system prompt are baked into that
 * subprocess and into the tool prefix it resumes with, so a follow-up turn that
 * adopts the query silently answers with the PREVIOUS settings while the
 * options logged next to it describe the new ones. Comparing fingerprints
 * before adopting turns that into a fresh query instead.
 *
 * `cwd` is in here because a session's working directory changes mid-session
 * without any user action: an agent running Bash inside a worktree makes
 * `adoptWorktreeForSession` persist `worktreePath`, and the next turn resolves
 * cwd from it. Adopting across that change leaves the subprocess writing to the
 * main checkout while the UI, the file watchers and the edit attribution all
 * describe the worktree.
 *
 * The system prompt travels as a HASH rather than as a list of the inputs that
 * produced it. Those inputs (worktree path, voice mode, tracker availability,
 * meta-agent role and its workflow preset) are turn-variable and keep growing;
 * hashing the resolved string means a new one is covered the day it is added,
 * without anyone remembering to extend this list. The hash is only ever
 * compared, never logged or displayed.
 *
 * `permissionMode` is in here despite `Query.setPermissionMode` existing: its
 * only caller, applyPermissionChange(), runs on a project trust change and
 * returns early unless the requested mode is 'agent', so nothing pushes the new
 * mode into an adopted query. Plan mode carries no allowedTools/disallowedTools
 * of its own either — `permissionMode: 'plan'` IS the enforcement — so leaving
 * it out gave agent, plan and auto one shared fingerprint, and a turn switched
 * to plan went on writing files.
 *
 * Deliberately shallow: no deep equality over the MCP maps or hook objects. A
 * fingerprint that is too strict only costs an adoption (the sub-agents die, the
 * user's prompt still lands), while one that misses a field lets the divergence
 * through — so it covers what a user actually switches, and nothing else. #1269.
 */
export function buildQueryOptionsSignature(options: {
  model?: string;
  thinking?: { type?: string };
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: string;
  mcpServers?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  cwd?: string;
  systemPrompt?: string | { type?: string; preset?: string; append?: string };
}): string {
  const toolList = (list?: string[]) => (list ? [...list].sort().join(',') : '');
  const prompt = options.systemPrompt;
  // A meta-agent passes a plain string that REPLACES the CC preset; everyone
  // else passes the preset object with an append block. Tagging the two shapes
  // apart keeps a bare string from colliding with an append of the same text.
  const promptSource =
    prompt === undefined
      ? ''
      : typeof prompt === 'string'
        ? `raw\u0000${prompt}`
        : `preset\u0000${prompt.type ?? ''}\u0000${prompt.preset ?? ''}\u0000${prompt.append ?? ''}`;
  const promptHash = promptSource
    ? createHash('sha256').update(promptSource).digest('hex').slice(0, 16)
    : '';
  return [
    `model=${options.model ?? ''}`,
    `effort=${options.env?.CLAUDE_CODE_EFFORT_LEVEL ?? ''}`,
    `thinking=${options.thinking?.type ?? ''}`,
    `allowed=${toolList(options.allowedTools)}`,
    `disallowed=${toolList(options.disallowedTools)}`,
    `permission=${options.permissionMode ?? ''}`,
    `mcp=${options.mcpServers ? Object.keys(options.mcpServers).sort().join(',') : ''}`,
    `cwd=${options.cwd ?? ''}`,
    `system=${promptHash}`,
  ].join('|');
}

/**
 * Resolve the SDK `permissionMode` from the session mode.
 *
 * - `planning` -> `plan` (SDK enforces read-only planning, scoped to plan file)
 * - `auto` -> `auto` (SDK classifier approves safe ops silently and escalates
 *   destructive or uncertain ones through `canUseTool` to the regular
 *   permission prompt; silent auto-deny only fires for SDK-level deny rules
 *   or `dontAsk` mode, not as the classifier's default response to risky tools)
 * - everything else (incl. `agent` and `undefined`) -> `default`
 *
 * See issue #371 and @anthropic-ai/claude-agent-sdk PermissionMode.
 */
export function resolvePermissionMode(
  currentMode: SessionMode
): 'plan' | 'auto' | 'default' {
  if (currentMode === 'planning') return 'plan';
  if (currentMode === 'auto') return 'auto';
  return 'default';
}

export async function buildSdkOptions(
  deps: BuildSdkOptionsDeps,
  params: BuildSdkOptionsParams
): Promise<BuildSdkOptionsResult> {
  const {
    resolveModelVariant,
    getMcpServersSnapshot,
    createCanUseToolHandler,
    toolHooksService,
    teammateManager,
    sessions,
    config,
    abortController,
    hasEnterpriseMcpLockdown = hasEnterpriseManagedMcpConfig,
  } = deps;

  const mcpLockdown = hasEnterpriseMcpLockdown();

  const {
    message,
    workspacePath,
    sessionId,
    documentContext,
    settingsEnv,
    shellEnv,
    systemPrompt,
    currentMode,
    imageContentBlocks,
    documentContentBlocks,
    permissionsPath,
    mcpConfigWorkspacePath,
    isMetaAgent,
  } = params;

  let helperMethod: 'native' | 'custom' = 'native';

  // Determine which settings sources to use based on user preferences
  let settingSources: SettingSource[] = ['local'];
  if (ClaudeCodeDeps.claudeCodeSettingsLoader) {
    try {
      const ccSettings = await ClaudeCodeDeps.claudeCodeSettingsLoader();
      if (ccSettings.userCommandsEnabled) {
        settingSources.push('user');
      }
      if (ccSettings.projectCommandsEnabled) {
        settingSources.push('project');
      }
    } catch (error) {
      console.warn('[CLAUDE-CODE] Failed to load Claude Code settings, using defaults:', error);
      settingSources = ['user', 'project', 'local'];
    }
  } else {
    settingSources = ['user', 'project', 'local'];
  }

  const enhancedPath = ClaudeCodeDeps.enhancedPathLoader?.() || undefined;
  const customPath = ClaudeCodeDeps.customClaudeCodePathLoader?.(workspacePath) || '';
  let resolvedBinaryPath: string | undefined;
  try {
    resolvedBinaryPath = await resolveClaudeAgentCliPath(enhancedPath);
  } catch (err) {
    // NIM-1573: In packaged builds there is no SDK self-resolve fallback --
    // letting pathToClaudeCodeExecutable become undefined makes the native SDK
    // emit a misleading "does not match this system's libc ... musl"
    // ReferenceError (e.g. after an interrupted CLI self-update orphaned the
    // bundled binary). Fail honestly with resolveClaudeAgentCliPath's
    // "repair Nimbalyst" message instead, so the provider's catch surfaces it
    // verbatim. In dev the SDK resolves its own native binary via
    // require.resolve, so a failure here is non-fatal; a user-configured custom
    // path also overrides.
    if (getHostEnvironment().isPackaged() && !customPath) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    resolvedBinaryPath = undefined;
  }
  const effectivePath = customPath || resolvedBinaryPath;
  // console.log(`[CLAUDE-CODE] Binary path: custom=${customPath || '(none)'} resolved=${resolvedBinaryPath ?? '(none)'} effective=${effectivePath ?? '(none)'}`);
  const resolvedModel = resolveModelVariant();

  const options: ClaudeAgentSdkOptions = {
    pathToClaudeCodeExecutable: effectivePath,
    // NOTE: this `append` string is re-sent on EVERY resumed turn and sits at
    // the front of the prompt-cache prefix. It MUST be byte-identical across a
    // session's turns — any per-turn variation (e.g. a naming section that flips
    // once the agent names the session) forces a system_changed cache miss on
    // the whole prefix. See ClaudeCodeProvider.buildSystemPrompt / NIM-1988.
    systemPrompt: isMetaAgent
      ? systemPrompt  // Plain string — fully replaces CC system prompt
      : {
          type: 'preset',
          preset: 'claude_code',
          append: systemPrompt
        },
    settingSources,
    // NIM-1988: this is the provider-owned, first-build snapshot, not a live
    // config read. The SDK rebuilds the API tool prefix on resumed turns, so a
    // server appearing/disappearing here would force a tools_changed miss over
    // the whole cached conversation. Do not move the live McpConfigService read
    // back into this per-turn builder; ClaudeCodeProvider freezes it once.
    // NIM-2372: no `strictMcpConfig`. It made the SDK ignore its own discovery
    // (~/.claude.json, project .mcp.json, enterprise config, claude.ai
    // connectors), which silently stripped every account connector and hard-
    // failed on managed machines. Nimbalyst's off-toggle is written into Claude
    // Code's own `disabledMcpServers` instead — see claudeCodeDisabledServers.ts.
    //
    // Under an enterprise MCP lockdown the binary rejects ANY dynamically-passed
    // server (the SDK serializes this map into `--mcp-config`), so we pass none
    // and the session runs on the enterprise's servers alone.
    mcpServers: mcpLockdown
      ? {}
      : await getMcpServersSnapshot({
          sessionId,
          workspacePath: mcpConfigWorkspacePath || workspacePath,
          profile: isMetaAgent ? 'meta-agent' : 'standard',
        }),
    cwd: workspacePath,
    abortController,
    model: resolvedModel,
    // IMPORTANT: Do NOT add manual tool restrictions or prompt injections for plan mode here.
    // The SDK's `permissionMode: 'plan'` natively enforces planning restrictions (scopes
    // Write to the plan file only). Manual filtering was removed in favour of this approach.
    //
    // `permissionMode: 'auto'` delegates decisions to the SDK's classifier. The
    // classifier approves safe operations silently and ESCALATES destructive or
    // uncertain ones to `canUseTool` (which renders the normal permission prompt
    // for the user). It does not silently deny destructive tools by default --
    // silent auto-deny is reserved for SDK-level deny rules / dontAsk mode.
    // Because escalation still hits `canUseTool`, Nimbalyst's workspace rules
    // (allow-all / bypass-all in immediateToolDecision.ts) continue to apply on
    // the escalation path.
    permissionMode: resolvePermissionMode(currentMode),
    // When plan tracking is enabled, direct plan files to the project's plans folder
    // (relative to cwd). This applies whenever the agent enters plan mode, even mid-session.
    settings: {
      ...(ClaudeCodeDeps.planTrackingEnabled && { plansDirectory: 'nimbalyst-local/plans' }),
    },
    canUseTool: createCanUseToolHandler(sessionId, workspacePath, permissionsPath),
    hooks: {
      'PreToolUse': [{ hooks: [toolHooksService.createPreToolUseHook()] }],
      'PostToolUse': [{ hooks: [toolHooksService.createPostToolUseHook()] }],
      // PermissionDenied fires when the SDK denies a tool call without
      // escalating through canUseTool (auto-mode classifier confident deny,
      // headless auto-deny, deny rules, dontAsk mode). In auto-mode sessions
      // we mirror the Claude Code CLI behaviour and re-prompt the user
      // instead of leaving the call dead -- returning `retry: true` from the
      // hook causes the SDK to re-run the original tool call.
      'PermissionDenied': [{ hooks: [toolHooksService.createPermissionDeniedHook()] }],
    },
  };

  if (config.thinkingMode === 'disabled') {
    if (canDisableThinkingForModel(resolvedModel)) {
      options.thinking = { type: 'disabled' as const };
    } else {
      console.warn(`[CLAUDE-CODE] Extended thinking cannot be disabled for model "${resolvedModel}"; omitting SDK thinking option.`);
    }
  }

  if (currentMode === 'planning') {
    console.log('[CLAUDE-CODE] Plan mode active: delegating tool restrictions to SDK permissionMode=plan');
  } else if (currentMode === 'auto') {
    console.log('[CLAUDE-CODE] Auto mode active: SDK classifier handling permission decisions');
  }

  // Capture lead config for teammate spawning
  teammateManager.lastUsedCwd = workspacePath;
  teammateManager.lastUsedSessionId = sessionId;
  teammateManager.lastUsedPermissionsPath = permissionsPath;

  // Load extension plugins
  if (ClaudeCodeDeps.extensionPluginsLoader) {
    try {
      const extensionPlugins = await ClaudeCodeDeps.extensionPluginsLoader(workspacePath);
      if (extensionPlugins.length > 0) {
        options.plugins = extensionPlugins;
      }
    } catch (error) {
      console.warn('[CLAUDE-CODE] Failed to load extension plugins:', error);
    }
  }

  // Add additional directories based on workspace context
  if (ClaudeCodeDeps.additionalDirectoriesLoader) {
    try {
      const additionalDirs = ClaudeCodeDeps.additionalDirectoriesLoader(workspacePath);
      if (additionalDirs.length > 0) {
        options.additionalDirectories = additionalDirs;
      }
    } catch (error) {
      console.warn('[CLAUDE-CODE] Failed to load additional directories:', error);
    }
  }

  // Set up environment variables.
  // Strip API keys from every env source we compose so we never silently use
  // a key the user didn't explicitly configure in Nimbalyst settings. A user's
  // .env file with ANTHROPIC_API_KEY was picked up here and billed their
  // personal Anthropic account $100+.
  //
  // Defense-in-depth: the main-process bootstrap already deletes these from
  // process.env before any code runs, and we also strip them from shell/settings
  // overlays here. Do not set ANTHROPIC_API_KEY='' for login-based sessions:
  // the Claude native binary treats the mere presence of that variable as an
  // API-key auth signal, which can shadow a valid OAuth/CLI login and produce
  // "Authentication failed" even though accountInfo() succeeds in settings.
  const { ANTHROPIC_API_KEY: _envAnthropicKey, OPENAI_API_KEY: _envOpenaiKey, ...sanitizedProcessEnv } = process.env;
  const { ANTHROPIC_API_KEY: _shellAnthropicKey, OPENAI_API_KEY: _shellOpenaiKey, ...sanitizedShellEnv } = shellEnv;
  const { ANTHROPIC_API_KEY: _settingsAnthropicKey, OPENAI_API_KEY: _settingsOpenaiKey, ...sanitizedSettingsEnv } = settingsEnv;

  const enableAgentTeams = sanitizedSettingsEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === '1';
  const env: any = managedClaudeEnvironment({
    ...sanitizedProcessEnv,
    ...sanitizedShellEnv,
    ...sanitizedSettingsEnv,
    // 'true' = unconditional tool-search deferral: every MCP tool defers
    // regardless of the model's context window, except the core subset marked
    // always-load via per-tool _meta (CORE_ALWAYS_LOAD_TOOLS). The CLI's `auto:N` mode is all-or-nothing against a
    // threshold of N% of the context window (integer N only), so the previous
    // `auto:2` default meant a 20K-token eager floor on 1M-context models —
    // any tool corpus under that loaded entirely upfront on every session.
    // Default only — a user-set ENABLE_TOOL_SEARCH (settings env vars, shell,
    // or process env) must win, otherwise the `ENABLE_TOOL_SEARCH = false`
    // remediation that buildBedrockToolErrorGuidance tells users to apply is
    // silently clobbered. (NIM-1475)
    ...(sanitizedProcessEnv.ENABLE_TOOL_SEARCH == null &&
      sanitizedShellEnv.ENABLE_TOOL_SEARCH == null &&
      sanitizedSettingsEnv.ENABLE_TOOL_SEARCH == null && {
        ENABLE_TOOL_SEARCH: 'true',
      }),
    // The bundled SDK at assistant.mjs sets CLAUDE_CODE_ENTRYPOINT to "sdk-ts"
    // when not already set in the environment. Anthropic's backend treats
    // `cli` traffic as first-party and `sdk-ts` traffic as third-party,
    // which puts the latter into a deprioritized lane that gets throttled
    // first under load. Users on Pro/Max OAuth report rate-limit errors when
    // running Nimbalyst alongside the standalone Claude Code CLI even at low
    // usage; setting this to `cli` aligns Nimbalyst's classification with
    // the official CLI and removes that asymmetry. The user can still
    // override via their own env var if they want the original sdk-ts label.
    ...(process.env.CLAUDE_CODE_ENTRYPOINT == null && { CLAUDE_CODE_ENTRYPOINT: 'cli' }),
    // The Claude CLI currently defaults to xhigh when this variable is absent.
    // Always forward a resolved Nimbalyst selection, including "high", so the
    // effort shown in the selector matches the request sent to the CLI.
    ...(config.effortLevel && {
      CLAUDE_CODE_EFFORT_LEVEL: config.effortLevel
    }),
    // The bundled claude binary runs a per-tool idle-timeout watchdog (default
    // 300s) over MCP servers whose transport is http/sse/ws. ALL Nimbalyst
    // in-app MCP servers use SSE, and the interactive input tools
    // (PromptForUserInput, AskUserQuestion) block indefinitely waiting for the
    // human — so the watchdog aborts them at 300s and the prompt collapses
    // (#758). Our SSE servers are local in-process, so a "hung" tool is our own
    // bug rather than a flaky network the watchdog guards against; disable it
    // by default. A user-set value (settings/shell/process env) still wins.
    ...(sanitizedProcessEnv.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT == null &&
      sanitizedShellEnv.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT == null &&
      sanitizedSettingsEnv.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT == null && {
        CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: '0',
      }),
    // #1177: Suppress the CLI's own "git status at the start of the
    // conversation" block. That block is rebuilt from the LIVE working tree by
    // every CLI process and injected at the head of the conversation, and it is
    // never persisted to the transcript, so `--resume` always regenerates it.
    // Nimbalyst runs each user turn as a separate process, so in an agentic
    // session -- where the agent itself edits files between turns -- the block
    // differs on most turns and every message block behind it is a cache miss.
    // Measured over 19,073 local turns: 62.8% full-prefix rewrite on resume
    // turns against 0.4% on in-process turns, carrying ~63% of all cache-write
    // tokens. Cache writes bill at 1.25x base input where reads bill at 0.1x.
    // The equivalent context is re-added as a FROZEN section resolved once per
    // session (see buildClaudeCodeSystemPrompt's gitContext) so it cannot move
    // between turns. Default only -- a user-set value (settings/shell/process
    // env) still wins, so anyone who wants the CLI's live snapshot back can
    // have it.
    ...(sanitizedProcessEnv.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS == null &&
      sanitizedShellEnv.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS == null &&
      sanitizedSettingsEnv.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS == null && {
        CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
      }),
  });

  // NIM-376: Overlay enhanced PATH so the Claude Code SDK can find stdio MCP
  // subprocess binaries (`npx`, `uvx`, `docker`, ...) when Nimbalyst is launched
  // from Dock/Finder. GUI-launched Electron on macOS has a minimal PATH
  // (/usr/bin:/bin:/usr/sbin:/sbin) that doesn't include Homebrew/nvm/volta,
  // and CLIManager's cachedShellEnvironment deliberately strips PATH so
  // shellEnv can't contribute it either.
  if (enhancedPath) {
    env.PATH = enhancedPath;
  }

  // NIM-838: On Windows, force HOME to mirror USERPROFILE so the native binary
  // resolves the same ~/.claude root on every spawn, regardless of whether its
  // internal logic prefers HOME (Unix-style) or USERPROFILE. process.env on
  // Windows usually has USERPROFILE but no HOME, leaving the binary to make a
  // platform-specific choice; a mismatch between turn-1 write and turn-2 read
  // would manifest exactly as the resume failures we're seeing.
  if (process.platform === 'win32') {
    const winHome = env.USERPROFILE || process.env.USERPROFILE;
    if (winHome) {
      env.HOME = winHome;
      env.USERPROFILE = winHome;
    }
  }

  if (enableAgentTeams) {
    env.CLAUDE_CODE_ENABLE_TASKS = '1';
  }

  const effectiveTeamContext = enableAgentTeams
    ? await teammateManager.resolveTeamContext(sessionId)
    : undefined;

  if (effectiveTeamContext) {
    env.CLAUDE_CODE_TEAM_NAME = effectiveTeamContext;
    env.CLAUDE_CODE_TASK_LIST_ID = effectiveTeamContext;
    env.CLAUDE_CODE_AGENT_ID = `team-lead@${effectiveTeamContext}`;
    env.CLAUDE_CODE_AGENT_NAME = 'team-lead';
    env.CLAUDE_CODE_AGENT_TYPE = 'team-lead';
  }

  // Production packaged build setup.
  // The env built above already starts from process.env (with API keys stripped).
  // The native binary only needs HOME/USERPROFILE (already in process.env) to
  // find ~/.claude/. We no longer overlay setupClaudeCodeEnvironment() because
  // it was designed for the old Node.js execution path and its Object.assign
  // clobbered our sanitized env.
  if (getHostEnvironment().isPackaged()) {
    if (customPath) {
      helperMethod = 'custom';
    } else {
      console.log(`[ClaudeCodeProvider] Pre-resolved native binary for packaged build: ${resolvedBinaryPath ?? '(resolveClaudeAgentCliPath returned undefined)'}`);
    }

    teammateManager.packagedBuildOptions = {
      env: env as Record<string, string | undefined>,
      pathToClaudeCodeExecutable: customPath || resolvedBinaryPath,
    };
  }

  // Per-session API key
  if (config.apiKey) {
    env.ANTHROPIC_API_KEY = config.apiKey;
    if (teammateManager.packagedBuildOptions?.env) {
      teammateManager.packagedBuildOptions.env.ANTHROPIC_API_KEY = config.apiKey;
    }
  }

  options.env = env;

  // Handle session resumption and branching
  if (sessionId) {
    const claudeSessionId = sessions.getSessionId(sessionId);
    if (claudeSessionId) {
      options.resume = claudeSessionId;
    } else {
      const branchedFromSessionId = documentContext?.branchedFromSessionId;
      const branchedFromProviderSessionId = documentContext?.branchedFromProviderSessionId;
      if (branchedFromSessionId && branchedFromProviderSessionId) {
        options.resume = branchedFromProviderSessionId;
        options.forkSession = true;
      } else if (branchedFromSessionId) {
        const sourceClaudeSessionId = sessions.getSessionId(branchedFromSessionId);
        if (sourceClaudeSessionId) {
          options.resume = sourceClaudeSessionId;
          options.forkSession = true;
        } else {
          console.warn('[CLAUDE-CODE] Cannot branch: source provider session ID not available. branchedFromSessionId:', branchedFromSessionId);
        }
      }
    }
  }

  // Build prompt input. Always use a persistent AsyncIterable (never a bare
  // string) so isSingleUserTurn=false in the SDK -- this prevents the SDK
  // from closing the binary's stdin pipe on `type: 'result'` and avoids the
  // "Stream closed" tool permission errors on long turns.
  const hasAttachmentBlocks = imageContentBlocks.length > 0 || documentContentBlocks.length > 0;
  const userContent: string | ContentBlockParam[] = hasAttachmentBlocks
    ? [
        ...imageContentBlocks,
        ...documentContentBlocks,
        { type: 'text', text: message } as TextBlockParam,
      ]
    : message;

  const initialMessage: SDKUserMessage = {
    type: 'user',
    message: { role: 'user', content: userContent as any },
    parent_tool_use_id: null,
  };

  const { iterable: promptInput, controller: promptController } =
    createPersistentPromptStream(initialMessage);

  return { options, promptInput, promptController, initialUserContent: userContent, helperMethod };
}
