import type { WorkspaceFileDraft } from "@/storage/workspace-preferences";

/** A complete editable disk read can confirm that a retained edit is already saved. */
export function workspaceFileDraftForOpen(
  draft: WorkspaceFileDraft | undefined,
  opened: { path: string; revision: string; content: string; editable: boolean; truncated: boolean },
): WorkspaceFileDraft | undefined {
  if (!draft || draft.path !== opened.path) return undefined;
  if (opened.editable && !opened.truncated && draft.content === opened.content) return undefined;
  return draft;
}
