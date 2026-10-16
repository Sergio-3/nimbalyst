/**
 * A form whose call dropped is closed with `reason: 'replaced'` once the agent
 * asks again. It must render as skipped, pointing at the newer form, and offer
 * nothing to submit.
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Provider as JotaiProvider } from 'jotai';
import { store } from '../../../../../store/store';
import { RequestUserInputWidget } from '../RequestUserInputWidget';

function renderWithResult(result: unknown) {
  const message = {
    toolCall: {
      providerToolCallId: 'toolu_replaced',
      arguments: {
        title: 'Pick one',
        fields: [{ type: 'singleSelect', id: 'farbe', label: 'Farbe', options: [{ id: 'rot', label: 'Rot' }] }],
      },
      result: JSON.stringify(result),
    },
  } as any;
  return render(
    <JotaiProvider store={store}>
      <RequestUserInputWidget message={message} sessionId="session-replaced" isExpanded onToggle={() => {}} />
    </JotaiProvider>,
  );
}

describe('RequestUserInputWidget replaced by a newer form', () => {
  it('renders as skipped and points at the newer form', () => {
    renderWithResult({ cancelled: true, answers: {}, reason: 'replaced', respondedBy: 'desktop' });

    expect(screen.getByTestId('request-user-input-widget').getAttribute('data-state')).toBe('skipped');
    expect(screen.getByTestId('request-user-input-skipped-note').textContent).toMatch(/asked again/i);
    expect(screen.queryByRole('button', { name: /submit/i })).toBeNull();
  });

  it('keeps the new-message note for a form skipped by a user turn', () => {
    renderWithResult({ cancelled: true, answers: {}, reason: 'superseded', respondedBy: 'desktop' });

    expect(screen.getByTestId('request-user-input-skipped-note').textContent).toMatch(/new message/i);
  });
});
