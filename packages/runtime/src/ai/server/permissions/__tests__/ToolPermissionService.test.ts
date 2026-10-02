// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { ToolPermissionService } from '../ToolPermissionService';

vi.mock('../../../../storage/repositories/AgentMessagesRepository', () => ({ AgentMessagesRepository: class {} }));

describe('SDK permission prompt constraints', () => {
  it.each(['session', 'always', 'always-all'] as const)('does not cache or persist a constrained %s response', async (scope) => {
    const emit = vi.fn();
    const patternSaver = vi.fn();
    const service = new ToolPermissionService({
      trustChecker: () => ({ trusted: true, mode: 'ask' }),
      patternSaver,
      patternChecker: async () => false,
      emit,
    });
    vi.spyOn(service as any, 'pollForPermissionResponse').mockResolvedValue(undefined);
    const hints = { defaultToNo: true, suppressAlwaysAllowRule: true };
    const pending = service.requestToolPermission({
      requestId: 'request', sessionId: 'session', workspacePath: '/fixture', permissionsPath: '/fixture',
      toolName: 'Bash', toolInput: { command: 'npm test' }, pattern: 'Bash(npm test:*)',
      patternDisplayName: 'npm test', toolDescription: 'Run tests', isDestructive: false,
      signal: new AbortController().signal, ...hints,
    });
    await vi.waitFor(() => expect(service.hasPendingPermissions()).toBe(true));
    service.resolvePermission('request', { decision: 'allow', scope });
    expect(await pending).toEqual({ decision: 'allow', scope: 'once' });
    expect(patternSaver).not.toHaveBeenCalled();
    expect(service.getSessionApprovedPatterns().size).toBe(0);
    expect(emit).toHaveBeenCalledWith('toolPermission:pending', expect.objectContaining({ request: expect.objectContaining(hints) }));
  });
});

describe('dropped permission requests (#1183)', () => {
  function startRequest(signal: AbortSignal) {
    const emit = vi.fn();
    const service = new ToolPermissionService({
      trustChecker: () => ({ trusted: true, mode: 'ask' }),
      patternSaver: vi.fn(),
      patternChecker: async () => false,
      emit,
    });
    vi.spyOn(service as any, 'pollForPermissionResponse').mockResolvedValue(undefined);
    const pending = service.requestToolPermission({
      requestId: 'request', sessionId: 'session', workspacePath: '/fixture', permissionsPath: '/fixture',
      toolName: 'Bash', toolInput: { command: 'npm test' }, pattern: 'Bash(npm test:*)',
      patternDisplayName: 'npm test', toolDescription: 'Run tests', isDestructive: false, signal,
    });
    return { emit, service, pending };
  }

  it('marks a request expired once it is aborted, and not while it waits', async () => {
    const controller = new AbortController();
    const { emit, service, pending } = startRequest(controller.signal);
    await vi.waitFor(() => expect(service.hasPendingPermissions()).toBe(true));
    expect(emit).not.toHaveBeenCalledWith('toolPermission:resolved', expect.anything());

    controller.abort();

    await expect(pending).rejects.toThrow('Request aborted');
    expect(emit).toHaveBeenCalledWith('toolPermission:resolved', expect.objectContaining({ requestId: 'request', expired: true }));
  });

  it('does not mark an answered request expired', async () => {
    const { emit, service, pending } = startRequest(new AbortController().signal);
    await vi.waitFor(() => expect(service.hasPendingPermissions()).toBe(true));
    service.resolvePermission('request', { decision: 'deny', scope: 'once' });
    await pending;
    expect(emit).not.toHaveBeenCalledWith('toolPermission:resolved', expect.objectContaining({ expired: true }));
  });
});
