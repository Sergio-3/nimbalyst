// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { agentRightPanelOptions } from '../agentRightPanelOptions';
import type { AgentRightPanelMode } from '../../../store/atoms/workstreamState';

function build(mode: AgentRightPanelMode, showSessionEdits: boolean) {
  const onSelect = vi.fn();
  const onShowSessionEditsChange = vi.fn();
  const options = agentRightPanelOptions(mode, showSessionEdits, onSelect, onShowSessionEditsChange);
  const pick = (id: string) => {
    const option = options.find((o) => o.id === id);
    if (!option) throw new Error(`no option ${id}`);
    return option;
  };
  return { options, pick, onSelect, onShowSessionEditsChange };
}

describe('agentRightPanelOptions', () => {
  it.each([
    // [option id, showSessionEdits written]
    ['edited-files', true],
    ['tasks-agents', false],
  ] as const)('selecting %s shows the sidebar mode and stores the list choice app-wide (%s)', (id, expected) => {
    // Start from the opposite choice in another mode so both writes are observable.
    const { pick, onSelect, onShowSessionEditsChange } = build('review', !expected);
    pick(id).onSelect();
    expect(onShowSessionEditsChange).toHaveBeenCalledWith(expected);
    expect(onSelect).toHaveBeenCalledWith('edited-files');
  });

  it('leaves the stored list choice alone for the other modes', () => {
    const { pick, onSelect, onShowSessionEditsChange } = build('edited-files', false);
    pick('review').onSelect();
    expect(onSelect).toHaveBeenCalledWith('review');
    expect(onShowSessionEditsChange).not.toHaveBeenCalled();
  });

  it.each([
    // [mode, showSessionEdits, expected selected id]
    ['edited-files', true, 'edited-files'],
    ['edited-files', false, 'tasks-agents'],
    ['review', true, 'review'],
    ['review', false, 'review'],
    ['file-viewer', false, 'file-viewer'],
  ] as const)('marks exactly one entry for mode %s with list %s', (mode, show, expected) => {
    const { options } = build(mode, show);
    expect(options.filter((o) => o.selected).map((o) => o.id)).toEqual([expected]);
  });
});
