import { t } from "@/i18n";
import {
  type WorkspacePanelState,
  type WorkspaceViewState,
} from "@/storage/workspace-preferences";

export function defaultWorkspacePanels(
  state?: WorkspaceViewState,
): WorkspacePanelState[] {
  if (state?.panels?.length) {
    if (state.panels.some((panel) => panel.kind === "changes"))
      return state.panels;
    const agentIndex = state.panels.findIndex(
      (panel) => panel.kind === "agent",
    );
    const next = [...state.panels];
    next.splice(agentIndex >= 0 ? agentIndex + 1 : 0, 0, {
      id: "changes",
      kind: "changes",
      title: t("task.changes"),
    });
    return next;
  }
  return [
    { id: "agent", kind: "agent", title: t("task.agent") },
    { id: "changes", kind: "changes", title: t("task.changes") },
    { id: "terminal-1", kind: "terminal", title: t("task.terminal_1") },
    {
      id: "browser-1",
      kind: "browser",
      title: t("task.browser_1"),
      browserUrl: state?.browserUrl,
    },
    {
      id: "files-1",
      kind: "files",
      title: t("task.files_1"),
      directoryPath: state?.directoryPath,
      fileDraft: state?.fileDraft,
    },
  ];
}

export function initialPanelId(
  state: WorkspaceViewState,
  panels: readonly WorkspacePanelState[],
): string {
  return state.activePanelId &&
    panels.some((panel) => panel.id === state.activePanelId)
    ? state.activePanelId
    : (panels.find((panel) => panel.kind === state.activeTab)?.id ?? "agent");
}
