// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Provider } from 'jotai';
import { store } from '@nimbalyst/runtime/store';

vi.mock('@nimbalyst/runtime', () => ({
  FileEditsSidebar: () => <div data-testid="file-list" />,
  MaterialSymbol: () => null,
}));
vi.mock('../../../store/listeners/fileStateListeners', () => ({
  registerSessionWorkspace: vi.fn(),
  registerWorktreePath: vi.fn(),
  loadInitialSessionFileState: vi.fn(),
}));
vi.mock('../ShellTrackingNotice', () => ({ ShellTrackingNotice: () => null }));
vi.mock('../FilesScopeDropdown', () => ({ FilesScopeDropdown: () => <div data-testid="scope-dropdown" /> }));
vi.mock('../GitOperationsPanel', () => ({ GitOperationsPanel: () => <div data-testid="git-panel" /> }));
vi.mock('../TodoPanel', () => ({ TodoPanel: () => <div data-testid="todo-panel" /> }));
vi.mock('../TaskListPanel', () => ({ TaskListPanel: () => null }));
vi.mock('../TeammatePanel', () => ({ TeammatePanel: () => null }));
vi.mock('../TrackerPanel', () => ({ TrackerPanel: () => null }));

import { FilesEditedSidebar } from '../FilesEditedSidebar';
import { hydrateSettingsAtoms } from '../../../store/atoms/settingAtomFamily';

afterEach(cleanup);

async function renderSidebar(showSessionEdits: boolean, showCommitPanel: boolean) {
  hydrateSettingsAtoms({
    'agent.sidebar.showSessionEdits': showSessionEdits,
    'agent.sidebar.showCommitPanel': showCommitPanel,
  });
  await act(async () => {
    render(
      <Provider store={store}>
        <FilesEditedSidebar workstreamId="ws-1" activeSessionId="ws-1" workspacePath="/repo" onFileClick={() => {}} isGitRepo />
      </Provider>,
    );
  });
}

it.each([
  [true, true],
  [false, true],
  [true, false],
  [false, false],
])('renders the session edits list (%s) and the commit panel (%s) only when enabled', async (edits, commit) => {
  // showSessionEdits is the app-wide menu choice: true = "Edited Files", false = "Tasks & Agents".
  await renderSidebar(edits, commit);
  // The scope header belongs to the list and goes with it.
  expect(screen.queryByTestId('file-list') !== null).toBe(edits);
  expect(screen.queryByTestId('scope-dropdown') !== null).toBe(edits);
  expect(screen.queryByTestId('git-panel') !== null).toBe(commit);
  screen.getByTestId('todo-panel');
});
