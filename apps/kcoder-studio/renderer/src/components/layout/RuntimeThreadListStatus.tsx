import type { RuntimeDeviceWorkspace } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'

export function RuntimeThreadListStatus({ workspaces }: { workspaces: RuntimeDeviceWorkspace[] }) {
  const { t } = useTranslation()
  return (
    <>
      {workspaces
        .filter(workspace => workspace.threadsComplete === false)
        .map(workspace => (
          <p
            key={`${workspace.deviceId}:${workspace.workspacePath}`}
            role="status"
            aria-live="polite"
            data-testid="runtime-thread-list-incomplete"
            className="break-words px-3 py-1 text-xs text-text-secondary"
          >
            {t(
              workspace.threadListSyncFailed
                ? 'workbench.thread_list_sync_failed'
                : (workspace.threadListIssueCount ?? 0) > 0
                  ? 'workbench.thread_list_incomplete_count'
                  : 'workbench.thread_list_incomplete',
              {
                workspace: workspace.label || workspace.workspacePath,
                count: workspace.threadListIssueCount ?? 0,
              }
            )}
          </p>
        ))}
    </>
  )
}
