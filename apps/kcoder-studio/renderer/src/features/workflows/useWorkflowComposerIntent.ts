import { useEffect, useState } from 'react'
import { listenAccountContextChanges } from '@/kcoder/accountContextEvents'
export function requestWorkflowComposerIntent(intent: WorkflowComposerIntent) {
  window.dispatchEvent(new CustomEvent('kcoder:workflow-composer-intent', { detail: intent }))
}
export interface WorkflowComposerIntent {
  active: boolean
  definitionId?: string
  run?: { id: string; version: number; args?: unknown; deviceId?: string; workspacePath?: string }
}
/** Owned by the workbench pane, so choosing a project may remount its composer without losing the user's mode. */
export function useWorkflowComposerIntent(taskId?: string) {
  const [value, setValue] = useState<WorkflowComposerIntent>({ active: false })
  const [previousTaskId, setPreviousTaskId] = useState(taskId)
  if (taskId !== previousTaskId) {
    setPreviousTaskId(taskId)
    if (taskId && value.active) setValue({ active: false })
  }
  useEffect(() => {
    const select = () => {
      const params = new URLSearchParams(window.location.search)
      if (params.has('workflowRun')) {
        try {
          const run = JSON.parse(params.get('workflowRun')!) as WorkflowComposerIntent['run']
          if (
            run &&
            typeof run.id === 'string' &&
            /^[a-zA-Z0-9_-]{1,128}$/.test(run.id) &&
            Number.isSafeInteger(run.version) &&
            run.version > 0
          )
            setValue({ active: false, run })
        } catch {
          /* Invalid navigation never submits a turn. */
        }
        return
      }
      if (params.get('workflow') !== 'new') return
      const id = params.get('workflowDraft')
      setValue({
        active: true,
        ...(id && /^[a-zA-Z0-9_-]{1,128}$/.test(id) ? { definitionId: id } : {}),
      })
    }
    select()
    const requested = (event: Event) =>
      setValue((event as CustomEvent<WorkflowComposerIntent>).detail)
    window.addEventListener('kcoder:workflow-composer-intent', requested)
    window.addEventListener('popstate', select)
    const stop = listenAccountContextChanges(() => setValue({ active: false }))
    return () => {
      window.removeEventListener('popstate', select)
      window.removeEventListener('kcoder:workflow-composer-intent', requested)
      stop()
    }
  }, [])
  return { ...value, onChange: setValue }
}
