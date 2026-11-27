import { ConversationWidgetsContext } from '@/components/chat/widgets/widgetContext'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { WorkflowRunPanel } from '@/features/workflows/WorkflowRunPanel'
import { fixedWorkflowDefinition, type FixedWorkflowRun } from '@/features/workflows/fixedWorkflowRun'
import type { TaskWorkspaceTarget } from '@/kcoder/taskWorkspaceTransport'
import { useCallback, useState } from 'react'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { requestWorkflowComposerIntent } from '@/features/workflows/useWorkflowComposerIntent'
import type { WorkflowRun } from '@/features/workflows/workflowApi'

export interface TaskWorkflowViewerProps {
  target: TaskWorkspaceTarget
  reference: FixedWorkflowRun
  onClose: () => void
  onOpenThread?: () => void
}

/** Reuse the ordinary run inspector with a fixed original selector and no execution controls. */
export function TaskWorkflowViewer({ target, reference, onClose, onOpenThread }: TaskWorkflowViewerProps) {
  const { t } = useTranslation('taskWorkspace')
  const definitionId = fixedWorkflowDefinition(reference)
  const scope = usePluginTargetScope(target.serverId, target.workspacePath)
  const key = JSON.stringify([scope.key, reference])
  const [observation, setObservation] = useState<{ key: string; run: WorkflowRun }>()
  const observe = useCallback((run: WorkflowRun | null) => {
    setObservation(run ? { key, run } : undefined)
  }, [key])
  const recovery = observation?.key === key && observation.run.runId === reference.runId
    && observation.run.threadId === reference.threadId
    && ['failed', 'interrupted', 'cancelled'].includes(observation.run.status)
    && scope.isCurrent() && Boolean(definitionId && onOpenThread)
  return (
    <section className="space-y-5 p-5" data-testid="task-workflow-viewer">
      <Button className="min-h-11 md:min-h-0" variant="ghost" onClick={onClose}>{t('back')}</Button>
      <p className="text-sm text-text-secondary">{t('readOnly')}</p>
      {recovery && <Button variant="outline" data-testid="task-workflow-prepare-recovery" onClick={() => {
        if (!scope.isCurrent() || !definitionId || !onOpenThread || observation?.key !== key) return
        // Prepare the ordinary original-run composer; this never executes a task.
        requestWorkflowComposerIntent({ active: false, recovery: {
          runId: reference.runId, threadId: reference.threadId, deviceId: target.serverId, definitionId,
        } })
        onOpenThread()
      }}>{t('continueOriginalRun')}</Button>}
      {definitionId ? (
        <ConversationWidgetsContext.Provider value={null}>
          <WorkflowRunPanel
            serverId={target.serverId}
            workspacePath={target.workspacePath}
            definitionId={definitionId}
            fixedRun={reference}
            readOnly
            onOpenThread={onOpenThread}
            onSnapshot={observe}
          />
        </ConversationWidgetsContext.Provider>
      ) : <p role="alert" className="text-sm text-text-secondary">{t('errors.unavailable')}</p>}
    </section>
  )
}
