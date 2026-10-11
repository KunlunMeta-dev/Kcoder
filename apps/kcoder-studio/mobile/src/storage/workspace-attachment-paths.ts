import type { WorkspaceViewState } from "./workspace-preferences";

export function workspaceAttachmentPathsForThreadDeletion(
  state:
    | Pick<WorkspaceViewState, "queuedMessages" | "failedSubmissions">
    | null
    | undefined,
): string[] {
  return [
    ...new Set([
      ...(state?.queuedMessages ?? []).flatMap((message) =>
        message.attachments.map((attachment) => attachment.path),
      ),
      ...(state?.failedSubmissions ?? []).flatMap((submission) =>
        submission.attachments.map((attachment) => attachment.path),
      ),
    ]),
  ];
}
