/**
 * #1183: a permission request dropped without an answer (query end, abort,
 * poll timeout) is closed with a terminal `reason: 'expired'` row. The widget
 * must read that as expired -- not cancelled, not granted -- and offer no
 * buttons; the banner must stop counting it.
 */

import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, renderHook, screen } from '@testing-library/react';
import { Provider as JotaiProvider } from 'jotai';
import { store } from '../../../../../store/store';
import { setInteractiveWidgetHost } from '../../../../../store/atoms/interactiveWidgetHost';
import { ToolPermissionWidget } from '../ToolPermissionWidget';
import { usePendingPermissionNavigation } from '../../usePendingPermissionNavigation';

const EXPIRED = JSON.stringify({ decision: 'deny', scope: 'once', cancelled: true, reason: 'expired', respondedAt: 1 });

function makeMessage(result: string | null) {
  return {
    type: 'tool_call',
    toolCall: {
      toolName: 'ToolPermission',
      providerToolCallId: 'auto-denied-1',
      arguments: { requestId: 'auto-denied-1', toolName: 'Bash', rawCommand: 'rm -rf build', pattern: 'Bash(rm:*)', workspacePath: '/tmp/ws' },
      result,
    },
  } as any;
}

function renderWidget(result: string | null) {
  return render(
    <JotaiProvider store={store}>
      <ToolPermissionWidget message={makeMessage(result)} sessionId="session-expired" isExpanded={false} onToggle={() => {}} />
    </JotaiProvider>,
  );
}

describe('ToolPermissionWidget — expired request (#1183)', () => {
  beforeEach(() => setInteractiveWidgetHost('session-expired', null));

  it('shows an expired request as expired, without buttons', () => {
    renderWidget(EXPIRED);
    expect(screen.getByTestId('tool-permission-widget').getAttribute('data-state')).toBe('expired');
    screen.getByText('Permission Expired');
    expect(screen.queryByText('Permission Cancelled')).toBeNull();
    expect(screen.queryByTestId('tool-permission-allow-once')).toBeNull();
    expect(screen.queryByTestId('tool-permission-deny')).toBeNull();
  });

  it('keeps a waiting request open', () => {
    renderWidget(null);
    screen.getByTestId('tool-permission-allow-once');
    screen.getByTestId('tool-permission-deny');
  });

  it('stops counting an expired request as pending, keeps counting a waiting one', () => {
    const count = (result: string | null) => renderHook(() => usePendingPermissionNavigation({
      messages: [makeMessage(result)], sessionId: 'session-expired', isProcessing: true, vlistRef: { current: null },
    })).result.current.pendingPermissionIndices.length;
    expect(count(EXPIRED)).toBe(0);
    expect(count(null)).toBe(1);
  });
});
