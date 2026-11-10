import { expertConversationTasks, expertTaskConversationScope } from './expertTaskProjection'
import { expertConversationRoute } from './conversationRoutes'
import { useState } from 'react'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import type { AgentTaskBinding } from '../../../../shared/generated/contracts'

/** Native work-list projections locate the original thread; this view creates no sessions. */
export function ExpertTaskHistory({
  deviceId,
  workspacePath,
  expertId,
  channelId,
}: {
  deviceId: string
  workspacePath: string
  expertId?: string
  channelId?: string
}) {
  const { t } = useTranslation('experts')
  const { state, refreshWorkLists, openRuntimeTask } = useWorkbench()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const work = state.runtimeWork
  const spaces = [
    ...(work?.chats ?? []),
    ...(work?.projects.flatMap(project => project.deviceWorkspaces) ?? []),
  ].filter(
    space => space.deviceId === deviceId && sameWorkspacePath(space.workspacePath, workspacePath)
  )
  const tasks = expertConversationTasks(work, { deviceId, workspacePath, expertId, channelId })
  const partial =
    !work ||
    !spaces.length ||
    spaces.some(space => space.threadsComplete === false || space.threadListSyncFailed)
  return (
    <section className="space-y-2" data-testid="expert-task-history">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">{t('task.history')}</h3>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setError(false)
            try {
              await refreshWorkLists()
            } catch {
              setError(true)
            } finally {
              setBusy(false)
            }
          }}
        >
          {t('refresh')}
        </Button>
      </div>
      {(partial || error) && (
        <p role="status" className="text-sm text-text-secondary">
          {t('task.historyPartial')}
        </p>
      )}
      {!partial && !error && !tasks.length && (
        <p className="text-sm text-text-secondary">{t('task.historyEmpty')}</p>
      )}
      {tasks.map(({ task, space }) => {
        const binding = task.runtimeHandle?.agentDefinition as AgentTaskBinding | undefined
        return (
          <Button
            key={`${space.deviceId}:${task.threadId ?? task.taskId}`}
            variant="ghost"
            className="h-auto w-full justify-start text-left"
            onClick={async () => {
              setError(false)
              try {
                await openRuntimeTask(
                  {
                    deviceId: space.deviceId,
                    taskId: task.taskId,
                    workspacePath: space.workspacePath,
                    threadId: task.threadId ?? undefined,
                    runtimeHandle: task.runtimeHandle,
                  },
                  { navigate: false }
                )
                navigateTo(
                  expertConversationRoute(
                    expertTaskConversationScope({
                      deviceId: space.deviceId,
                      workspacePath: space.workspacePath,
                    }, task),
                    { deviceId: space.deviceId, taskId: task.taskId }
                  )
                )
              } catch {
                setError(true)
              }
            }}
          >
            <span className="min-w-0">
              <span className="block truncate">{task.title}</span>
              <span className="block text-xs text-text-secondary">
                {binding?.title ?? t('channelTitle')} · {binding?.definition.version}
              </span>
            </span>
          </Button>
        )
      })}
    </section>
  )
}
