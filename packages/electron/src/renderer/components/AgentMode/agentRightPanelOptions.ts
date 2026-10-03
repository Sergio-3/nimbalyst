import type { AgentRightPanelMode } from "../../store/atoms/workstreamState";
import type { WindowTopBarPanelOption } from "../WindowTopBar/WindowTopBar";

const modes: Array<{ id: AgentRightPanelMode; label: string; icon: string }> = [
  { id: "edited-files", label: "Edited Files", icon: "description" },
  { id: "review", label: "Review", icon: "rate_review" },
  { id: "session-chat", label: "Chat with Session", icon: "forum" },
  { id: "file-viewer", label: "File viewer", icon: "tab" },
];

/**
 * "Tasks & Agents" is the 'edited-files' sidebar without its file list. The
 * list choice is app-wide (agent.sidebar.showSessionEdits), unlike the
 * per-workstream panel mode, so every sidebar shows the chosen variant.
 */
const TASKS_AGENTS_OPTION = { id: "tasks-agents", label: "Tasks & Agents", icon: "checklist" };

export function agentRightPanelOptions(
  selected: AgentRightPanelMode,
  showSessionEdits: boolean,
  onSelect: (mode: AgentRightPanelMode) => void,
  onShowSessionEditsChange: (show: boolean) => void
): WindowTopBarPanelOption[] {
  const sidebarOption = (show: boolean) => ({
    selected: selected === "edited-files" && showSessionEdits === show,
    onSelect: () => {
      onShowSessionEditsChange(show);
      onSelect("edited-files");
    },
  });
  return modes.flatMap((mode): WindowTopBarPanelOption[] => {
    if (mode.id !== "edited-files") {
      return [{ ...mode, selected: mode.id === selected, onSelect: () => onSelect(mode.id) }];
    }
    return [
      { ...mode, ...sidebarOption(true) },
      { ...TASKS_AGENTS_OPTION, ...sidebarOption(false) },
    ];
  });
}
