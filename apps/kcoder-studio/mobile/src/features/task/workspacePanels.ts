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
      title: "变更",
    });
    return next;
  }
  return [
    { id: "agent", kind: "agent", title: "智能体" },
    { id: "changes", kind: "changes", title: "变更" },
    { id: "terminal-1", kind: "terminal", title: "终端 1" },
    {
      id: "browser-1",
      kind: "browser",
      title: "浏览器 1",
      browserUrl: state?.browserUrl,
    },
    {
      id: "files-1",
      kind: "files",
      title: "文件 1",
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
